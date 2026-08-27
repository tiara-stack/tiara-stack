import { Array, Chunk, Effect, HashSet, Option, Predicate, String } from "effect";
import { PlayerTeam, Room } from "../calculations/calculationModel";

// These primitives intentionally mirror the legacy calculator until its production caller moves.
// fallow-ignore-next-line code-duplication
const encFactor = 2;

// The independent workflow runtime cannot import the removed sheet API runtime.
// fallow-ignore-next-line code-duplication
const samePlayerReference = (left: PlayerTeam, right: PlayerTeam) =>
  Option.makeEquivalence(String.Equivalence)(left.playerId, right.playerId) &&
  Option.makeEquivalence(String.Equivalence)(left.playerName, right.playerName);

// Fixed-team selection is copied exactly for legacy parity until caller cutover.
// fallow-ignore-next-line code-duplication
const filterFixedTeams = (playerTeams: ReadonlyArray<PlayerTeam>) => {
  const fixedTeams = playerTeams
    .filter(({ tags }) => HashSet.has(tags, "fixed"))
    .map((playerTeam) =>
      HashSet.has(playerTeam.tags, "tierer_hint")
        ? PlayerTeam.addTags(HashSet.make("tierer"))(playerTeam)
        : playerTeam,
    );
  return fixedTeams.length > 0 ? fixedTeams : playerTeams;
};

const baseRoom = (teams: ReadonlyArray<PlayerTeam>) =>
  new Room({
    enced: false,
    tiererEnced: false,
    healed: teams.reduce((total, team) => total + (HashSet.has(team.tags, "heal") ? 1 : 0), 0),
    talent: teams.reduce((total, team) => total + team.talent, 0),
    effectValue: teams.reduce((total, team) => total + PlayerTeam.getEffectValue(team), 0),
    teams: Chunk.fromIterable(teams),
  });

// Legacy parity keeps the selection loop explicit and independently testable during migration.
// fallow-ignore-next-line complexity
const applyRoomEncAndDoormat = (room: Room): Room => {
  const teams = Chunk.toArray(room.teams);
  const tierers = teams.filter((team) => HashSet.has(team.tags, "tierer"));
  const tiererTalent =
    tierers.length === 0
      ? 0
      : Array.max(tierers as Array.NonEmptyArray<PlayerTeam>, PlayerTeam.byTalent).talent;

  let encIndex = -1;
  let bestEffectValue = -Infinity;
  for (const [index, team] of teams.entries()) {
    const effectValue = PlayerTeam.getEffectValue(team);
    if (
      HashSet.has(team.tags, "encable") &&
      effectValue > bestEffectValue &&
      team.talent >= tiererTalent
    ) {
      encIndex = index;
      bestEffectValue = effectValue;
    }
  }

  let tiererOverride = false;
  if (encIndex === -1) {
    let bestTalent = -Infinity;
    for (const [index, team] of teams.entries()) {
      if (HashSet.has(team.tags, "tierer") && team.talent > bestTalent) {
        encIndex = index;
        bestTalent = team.talent;
        tiererOverride = true;
      }
    }
  }

  const encTeam = teams[encIndex];
  if (Predicate.isUndefined(encTeam)) return room;
  const updatedTeams = teams.map((team, index) => {
    if (index === encIndex) {
      return PlayerTeam.addTags(HashSet.make(tiererOverride ? "tierer_enc_override" : "enc"))(team);
    }
    return team.talent >= encTeam.talent && !HashSet.has(team.tags, "tierer")
      ? PlayerTeam.addTags(HashSet.make("not_enc"))(team)
      : team;
  });
  return new Room({
    enced: true,
    tiererEnced: tiererOverride,
    healed: room.healed,
    talent: room.talent,
    effectValue: room.effectValue + encFactor * PlayerTeam.getEffectValue(encTeam),
    teams: Chunk.fromIterable(updatedTeams),
  });
};

const placeholder = (playerId: Option.Option<string>, playerName: Option.Option<string>) =>
  new PlayerTeam({
    type: "Placeholder",
    playerId,
    playerName,
    teamName: Option.match(playerName, {
      onNone: () => "Placeholder",
      onSome: (name) => `${name} | placeholder`,
    }),
    lead: 0,
    backline: 0,
    talent: 0,
    tags: HashSet.make("placeholder"),
  });

const cartesianHeadTeams = (teams: ReadonlyArray<PlayerTeam>): ReadonlyArray<PlayerTeam> =>
  teams.length === 0 ? [placeholder(Option.none(), Option.some("Placeholder"))] : teams;

const cartesianRoomOrderTeams = (
  playerTeams: ReadonlyArray<ReadonlyArray<PlayerTeam>>,
): ReadonlyArray<ReadonlyArray<PlayerTeam>> => {
  const [head, ...tail] = playerTeams;
  if (Predicate.isUndefined(head)) return [];
  if (tail.length === 0) return cartesianHeadTeams(head).map((team) => [team]);
  const products = cartesianRoomOrderTeams(tail);
  return products.flatMap((product) => {
    const candidates = cartesianHeadTeams(head).filter(
      (candidate) => !product.some((team) => samePlayerReference(team, candidate)),
    );
    const effectiveCandidates =
      candidates.length > 0
        ? candidates
        : [
            placeholder(
              cartesianHeadTeams(head)[0]!.playerId,
              cartesianHeadTeams(head)[0]!.playerName,
            ),
          ];
    return effectiveCandidates.map((candidate) => [candidate, ...product]);
  });
};

export interface RoomOrderCalculationTeam {
  readonly playerId: string;
  readonly playerName: string;
  readonly teamName: string;
  readonly tags: ReadonlyArray<string>;
  readonly lead: number;
  readonly backline: number;
  readonly talent: number;
  readonly encable: boolean;
  readonly tierer: boolean;
}

export interface CalculatedRoomOrderEntry {
  readonly rank: number;
  readonly position: number;
  readonly hour: number;
  readonly team: string;
  readonly tags: ReadonlyArray<string>;
  readonly effectValue: number;
}

const toPlayerTeam = (team: RoomOrderCalculationTeam) =>
  new PlayerTeam({
    type: "RunnerLocal",
    playerId: Option.some(team.playerId),
    playerName: Option.some(team.playerName),
    teamName: team.teamName,
    lead: team.lead,
    backline: team.backline,
    talent: team.talent,
    tags: HashSet.fromIterable([
      ...team.tags,
      ...(team.tierer ? ["tierer"] : []),
      ...(team.encable ? ["encable"] : []),
    ]),
  });

export const calculateRoomOrderEntries = (options: {
  readonly teamsByPlayer: ReadonlyArray<ReadonlyArray<RoomOrderCalculationTeam>>;
  readonly healNeeded: number;
  readonly hour: number;
}): Effect.Effect<ReadonlyArray<CalculatedRoomOrderEntry>> =>
  Effect.sync(() => {
    const fixed = options.teamsByPlayer.map((teams) => filterFixedTeams(teams.map(toPlayerTeam)));
    if (fixed.length === 0) return [];
    const rooms = cartesianRoomOrderTeams(fixed)
      .map((teams) => applyRoomEncAndDoormat(baseRoom(teams)))
      .filter(({ healed }) => healed >= options.healNeeded);
    const sorted = Chunk.toArray(Chunk.sort(Room.Order)(Chunk.fromIterable(rooms)));
    let bestEffectValue = Option.none<number>();
    const bestRooms: Array<Room> = [];
    for (const room of sorted) {
      if (Option.isNone(bestEffectValue) || room.effectValue > bestEffectValue.value) {
        bestEffectValue = Option.some(room.effectValue);
        bestRooms.push(room);
      }
    }
    return bestRooms.reverse().flatMap((room, rank) =>
      Chunk.toArray(room.teams).map(
        (team, position): CalculatedRoomOrderEntry => ({
          rank,
          position,
          hour: options.hour,
          team: team.teamName,
          tags: globalThis.Array.from(team.tags),
          effectValue: PlayerTeam.getEffectValue(team),
        }),
      ),
    );
  }).pipe(Effect.withSpan("roomOrders.create.calculate"));
