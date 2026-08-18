import {
  Array,
  Chunk,
  Effect,
  Function,
  HashSet,
  Match,
  Option,
  Predicate,
  String,
  pipe,
} from "effect";
import { PlayerTeam, Room, Team } from "sheet-ingress-api/schemas/sheet";
import {
  type CalculationDeclaredFailure,
  type CalculationsRecalculateSheetInput,
} from "sheet-workflow-contracts";
import { calculationResultRange } from "./range";
import {
  calculationBusinessRuleRejected,
  calculationBusinessRuleCodes,
  calculationInvalidRequest,
  calculationInvalidRequestCodes,
} from "./failure";
import type { CalculationProjection, CalculationSource, CalculationSourceTeam } from "./schema";

const encoreFactor = 2;
// Inputs above this cap now fail explicitly instead of allocating an unbounded cartesian product.
// The candidate bound is conservative: it is checked before duplicate-player filtering, which can
// replace a slot with its placeholder and reduce the executed product. Requests can still be
// rejected using the raw bound, keeping memory usage safe. Five requested players with seven
// candidates each stays under the 20,000-room expansion cap.
// The selected frontier is independently capped at 10,000 increasing-effect rooms below.
const maximumCalculationRoomCandidates = 20_000;
const maximumCalculationRoomFrontier = 10_000;

const invalidSource = (): CalculationDeclaredFailure =>
  calculationInvalidRequest(
    calculationInvalidRequestCodes.invalidSource,
    "The calculation source does not match the requested players",
  );

const playerReferenceEquivalence = Option.makeEquivalence(String.Equivalence);

const samePlayerReference = (left: PlayerTeam, right: PlayerTeam): boolean =>
  playerReferenceEquivalence(left.playerId, right.playerId) &&
  playerReferenceEquivalence(left.playerName, right.playerName);

const addTags = (team: PlayerTeam, tags: ReadonlyArray<string>): PlayerTeam =>
  PlayerTeam.addTags(HashSet.fromIterable(tags))(team);

const sourceTeam = (cc: boolean, team: CalculationSourceTeam): Option.Option<PlayerTeam> =>
  PlayerTeam.fromTeam(
    cc,
    new Team({
      type: team.type,
      playerId: Option.fromNullishOr(team.playerId),
      playerName: Option.fromNullishOr(team.playerName),
      teamName: Option.fromNullishOr(team.teamName),
      tags: [...team.tags],
      lead: team.lead,
      backline: team.backline,
      talent: Option.fromNullishOr(team.talent),
    }),
  );

const fixedTeamsFor = (playerTeams: ReadonlyArray<PlayerTeam>): ReadonlyArray<PlayerTeam> => {
  const fixed = playerTeams
    .filter(({ tags }) => HashSet.has(tags, "fixed"))
    .map((team) => (HashSet.has(team.tags, "tierer_hint") ? addTags(team, ["tierer"]) : team));
  // Preserve legacy behavior: players without a matching fixed team keep all candidate teams.
  return fixed.length > 0 ? fixed : playerTeams;
};

// This block intentionally mirrors the legacy room-order calculation while callers migrate.
// fallow-ignore-next-line code-duplication
const baseRoom = (teams: ReadonlyArray<PlayerTeam>): Room =>
  new Room({
    enced: false,
    tiererEnced: false,
    healed: teams.reduce((total, team) => total + (HashSet.has(team.tags, "heal") ? 1 : 0), 0),
    talent: teams.reduce((total, team) => total + team.talent, 0),
    effectValue: teams.reduce((total, team) => total + PlayerTeam.getEffectValue(team), 0),
    teams: Chunk.fromIterable(teams),
  });

// The explicit selection loop preserves the legacy tie-breaking behavior under parity tests.
// fallow-ignore-next-line code-duplication
// fallow-ignore-next-line complexity
const applyEncore = (room: Room): Room => {
  const teams = Chunk.toArray(room.teams);
  const tiererTalent = pipe(
    teams,
    Array.filter((team) => HashSet.has(team.tags, "tierer")),
    Array.match({
      onEmpty: () => 0,
      onNonEmpty: (tierers) => Array.max(tierers, PlayerTeam.byTalent).talent,
    }),
  );

  let encoreIndex = -1;
  let encoreTeam: PlayerTeam | undefined;
  let bestEffectValue = -Infinity;
  for (const [index, team] of teams.entries()) {
    if (
      HashSet.has(team.tags, "encable") &&
      PlayerTeam.getEffectValue(team) > bestEffectValue &&
      team.talent >= tiererTalent
    ) {
      bestEffectValue = PlayerTeam.getEffectValue(team);
      encoreIndex = index;
      encoreTeam = team;
    }
  }

  let tiererOverride = false;
  if (encoreIndex === -1) {
    let bestTalent = -Infinity;
    for (const [index, team] of teams.entries()) {
      if (HashSet.has(team.tags, "tierer") && team.talent > bestTalent) {
        bestTalent = team.talent;
        encoreIndex = index;
        encoreTeam = team;
        tiererOverride = true;
      }
    }
  }

  if (Predicate.isUndefined(encoreTeam)) return room;
  const selectedEncoreTeam = encoreTeam;
  const updatedTeams = teams.map((team, index) => {
    if (index === encoreIndex) {
      return addTags(team, [tiererOverride ? "tierer_enc_override" : "enc"]);
    }
    return team.talent >= selectedEncoreTeam.talent && !HashSet.has(team.tags, "tierer")
      ? addTags(team, ["not_enc"])
      : team;
  });
  return new Room({
    enced: true,
    tiererEnced: tiererOverride,
    healed: room.healed,
    talent: room.talent,
    effectValue: room.effectValue + encoreFactor * PlayerTeam.getEffectValue(selectedEncoreTeam),
    teams: Chunk.fromIterable(updatedTeams),
  });
};

const placeholder = (playerName?: string): PlayerTeam =>
  new PlayerTeam({
    type: "Placeholder",
    playerId: Option.none(),
    playerName: Option.some(playerName ?? "Placeholder"),
    teamName: Predicate.isUndefined(playerName) ? "Placeholder" : `${playerName} | placeholder`,
    lead: 0,
    backline: 0,
    talent: 0,
    tags: HashSet.make("placeholder"),
  });

const cartesianTeams = (
  slots: ReadonlyArray<ReadonlyArray<PlayerTeam>>,
): ReadonlyArray<ReadonlyArray<PlayerTeam>> | undefined => {
  if (slots.length === 0) return [];

  // Validate the raw candidate product before allocating any partial products. Duplicate-player
  // filtering can only reduce this size, so the bound remains conservative for the full search.
  let candidateProductSize = 1;
  for (const slot of slots) {
    const candidateCount = Math.max(1, slot.length);
    if (candidateProductSize > maximumCalculationRoomCandidates / candidateCount) {
      return undefined;
    }
    candidateProductSize *= candidateCount;
  }

  let products: ReadonlyArray<ReadonlyArray<PlayerTeam>> = [[]];
  for (const slot of slots) {
    const candidates = slot.length > 0 ? slot : [placeholder()];
    const slotPlaceholder = placeholder(Option.getOrUndefined(candidates[0]!.playerName));
    products = products.flatMap((product) => {
      const permitted = candidates.filter(
        (candidate) => !product.some((team) => samePlayerReference(team, candidate)),
      );
      const next = permitted.length > 0 ? permitted : [slotPlaceholder];
      return next.map((candidate) => [...product, candidate]);
    });
  }
  return products;
};

const bestRooms = (
  slots: ReadonlyArray<ReadonlyArray<PlayerTeam>>,
  input: CalculationsRecalculateSheetInput,
): ReadonlyArray<Room> | undefined => {
  const candidateTeams = cartesianTeams(slots);
  if (Predicate.isUndefined(candidateTeams)) return undefined;
  const rooms = candidateTeams
    .map((teams) => baseRoom(teams))
    .map(input.config.considerEnc ? applyEncore : Function.identity)
    .filter(({ healed }) => healed >= input.config.healNeeded);
  // Array.sort applies the legacy Room.Order comparator; the strictly increasing selection below
  // consumes that deterministic ordering, and the final reverse restores best-first output.
  const sorted = Array.sort(rooms, Room.Order);
  let bestEffectValue = Option.none<number>();
  const selected: Room[] = [];
  for (const room of sorted) {
    if (Option.isNone(bestEffectValue) || room.effectValue > bestEffectValue.value) {
      if (selected.length >= maximumCalculationRoomFrontier) return undefined;
      bestEffectValue = Option.some(room.effectValue);
      selected.push(room);
    }
  }
  return selected.reverse();
};

const roomRow = (room: Room): ReadonlyArray<string | number> => [
  Room.avgTalent(room),
  Room.avgEffectValue(room),
  ...Chunk.toArray(room.teams).flatMap((team) => [
    team.teamName,
    team.lead,
    team.backline,
    PlayerTeam.getEffectValue(team),
    team.talent,
    Array.sort(Array.fromIterable(team.tags), String.Order).join(", "),
  ]),
];

export const calculateProjection = (
  input: CalculationsRecalculateSheetInput,
  source: CalculationSource,
): Effect.Effect<CalculationProjection, CalculationDeclaredFailure> =>
  Effect.suspend(() => {
    if (Predicate.isNotNull(source.failure)) return Effect.fail(source.failure);
    if (
      source.players.length !== input.players.length ||
      source.players.some(({ name }, index) => name !== input.players[index]?.name)
    ) {
      return Effect.fail(invalidSource());
    }
    const fixedTeamNames = new Set<string>();
    for (const { name } of input.fixedTeams) {
      if (fixedTeamNames.has(name)) {
        return Effect.fail(
          calculationInvalidRequest(
            calculationInvalidRequestCodes.duplicateFixedTeam,
            "The calculation input contains duplicate fixed team names",
          ),
        );
      }
      fixedTeamNames.add(name);
    }
    const fixedTeams = new Map(input.fixedTeams.map(({ heal, name }) => [name, { heal }]));
    const slots = source.players.map(({ teams }, index) => {
      const player = input.players[index]!;
      return fixedTeamsFor(
        teams.flatMap((team) =>
          Option.match(sourceTeam(input.config.cc, team), {
            onNone: () => [],
            onSome: (converted) => {
              const fixed = fixedTeams.get(converted.teamName);
              return [
                addTags(converted, [
                  ...(player.encable ? ["encable"] : []),
                  ...(Predicate.isUndefined(fixed) ? [] : ["fixed"]),
                  ...(fixed?.heal === true ? ["heal"] : []),
                ]),
              ];
            },
          }),
        ),
      );
    });
    const rooms = bestRooms(slots, input);
    if (Predicate.isUndefined(rooms)) {
      return Effect.fail(
        calculationBusinessRuleRejected(
          calculationBusinessRuleCodes.searchSpaceTooLarge,
          "The calculation search space exceeds the supported limit",
        ),
      );
    }
    const rows = [[input.hour, ""], ...rooms.map(roomRow)];
    return Effect.succeed({
      rows,
      outputRange: calculationResultRange(rooms.length),
      roomCount: rooms.length,
      failure: null,
    });
  });

const failureStatus = (failure: CalculationDeclaredFailure): string =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      AuthorizationRevoked: () => "CALCULATION_AUTHORIZATION_REVOKED: Authorization was revoked",
      InvalidRequest: () => "CALCULATION_INVALID_REQUEST: Calculation input is invalid",
      ConfigurationMissing: () =>
        "CALCULATION_CONFIGURATION_MISSING: Sheet configuration is incomplete",
      BusinessRuleRejected: () => "CALCULATION_RULE_REJECTED: Calculation rules rejected the input",
      ExternalOperationRejected: () =>
        "CALCULATION_PROVIDER_REJECTED: The Sheets operation was rejected",
    }),
  );

export const calculationFailureProjection = (
  hour: number,
  failure: CalculationDeclaredFailure,
): CalculationProjection => ({
  rows: [[hour, failureStatus(failure)]],
  outputRange: calculationResultRange(0),
  roomCount: 0,
  failure,
});
