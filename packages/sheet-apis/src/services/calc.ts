import { PlayerTeam } from "sheet-ingress-api/schemas/sheet";
import { Room } from "sheet-ingress-api/schemas/sheet";
import {
  Array,
  Chunk,
  Data,
  Effect,
  Function,
  HashSet,
  Option,
  Predicate,
  Layer,
  Context,
  String,
  pipe,
} from "effect";

export class CalcConfig extends Data.TaggedClass("CalcConfig")<{
  healNeeded: number;
  considerEnc: boolean;
}> {}

const samePlayerReference = (left: PlayerTeam, right: PlayerTeam) =>
  Option.makeEquivalence(String.Equivalence)(left.playerId, right.playerId) &&
  Option.makeEquivalence(String.Equivalence)(left.playerName, right.playerName);

const filterFixedTeams = (playerTeams: PlayerTeam[]) =>
  pipe(
    Effect.Do,
    Effect.let("fixedTeams", () =>
      playerTeams
        .filter(({ tags }) => HashSet.has(tags, "fixed"))
        .map((playerTeam) =>
          HashSet.has(playerTeam.tags, "tierer_hint")
            ? PlayerTeam.addTags(HashSet.make("tierer"))(playerTeam)
            : playerTeam,
        ),
    ),
    Effect.map(({ fixedTeams }) => (fixedTeams.length > 0 ? fixedTeams : playerTeams)),
  );

const baseRoom = (teams: ReadonlyArray<PlayerTeam>) => {
  return new Room({
    enced: false,
    tiererEnced: false,
    healed: pipe(
      teams,
      Array.reduce(0, (acc, t) => acc + (HashSet.has(t.tags, "heal") ? 1 : 0)),
    ),
    talent: pipe(
      teams,
      Array.reduce(0, (acc, t) => acc + t.talent),
    ),
    effectValue: pipe(
      teams,
      Array.reduce(0, (acc, t) => acc + PlayerTeam.getEffectValue(t)),
    ),
    teams: Chunk.fromIterable(teams),
  });
};

const applyRoomEncAndDoormat = (roomTeam: Room) => {
  const teams = Chunk.toArray(roomTeam.teams);

  const tiererTalent = pipe(
    teams,
    Array.filter((t) => HashSet.has(t.tags, "tierer")),
    Array.match({
      onEmpty: () => 0,
      onNonEmpty: (self) => Array.max(self, PlayerTeam.byTalent).talent,
    }),
  );

  let encIndex = -1;
  let bestEffectValue = -Infinity;
  for (const [i, t] of teams.entries()) {
    if (
      HashSet.has(t.tags, "encable") &&
      PlayerTeam.getEffectValue(t) > bestEffectValue &&
      t.talent >= tiererTalent
    ) {
      bestEffectValue = PlayerTeam.getEffectValue(t);
      encIndex = i;
    }
  }

  let tiererOverride = false;
  if (encIndex === -1) {
    let bestTalent = -Infinity;
    for (const [i, t] of teams.entries()) {
      if (HashSet.has(t.tags, "tierer") && t.talent > bestTalent) {
        bestTalent = t.talent;
        encIndex = i;
        tiererOverride = true;
      }
    }
  }

  if (encIndex === -1) {
    return roomTeam;
  }

  const encTeam = teams[encIndex];
  if (Predicate.isUndefined(encTeam)) {
    return roomTeam;
  }
  const updatedTeams = teams.map((t, i) => {
    if (i === encIndex) {
      return PlayerTeam.addTags(HashSet.make(tiererOverride ? "tierer_enc_override" : "enc"))(t);
    }
    return t.talent >= encTeam.talent && !HashSet.has(t.tags, "tierer")
      ? PlayerTeam.addTags(HashSet.make("not_enc"))(t)
      : t;
  });

  return new Room({
    enced: true,
    tiererEnced: tiererOverride,
    healed: roomTeam.healed,
    talent: roomTeam.talent,
    effectValue: roomTeam.effectValue + PlayerTeam.getEffectValue(encTeam),
    teams: Chunk.fromIterable(updatedTeams),
  });
};

const cartesianHeadTeams = (teams: ReadonlyArray<PlayerTeam>) =>
  pipe(
    teams,
    Array.match({
      onEmpty: () =>
        Array.make(
          new PlayerTeam({
            type: "Placeholder",
            playerId: Option.none(),
            playerName: Option.some("Placeholder"),
            teamName: "Placeholder",
            lead: 0,
            backline: 0,
            talent: 0,
            tags: HashSet.make("placeholder"),
          }),
        ),
      onNonEmpty: Function.identity,
    }),
  );

export const cartesianTeams = (
  playerTeams: Array.NonEmptyReadonlyArray<ReadonlyArray<PlayerTeam>>,
): readonly PlayerTeam[][] =>
  pipe(
    playerTeams,
    Array.tailNonEmpty,
    Array.match({
      onEmpty: () =>
        pipe(
          Array.headNonEmpty(playerTeams),
          cartesianHeadTeams,
          Array.map((headTeam) => Array.make(headTeam)),
        ),
      onNonEmpty: (self) =>
        pipe(
          cartesianTeams(self),
          Array.flatMap((product) =>
            pipe(Array.headNonEmpty(playerTeams), cartesianHeadTeams, (headTeams) =>
              pipe(
                headTeams,
                Array.filter(
                  (headTeam) =>
                    !pipe(
                      product,
                      Array.some((team) => samePlayerReference(team, headTeam)),
                    ),
                ),
                Array.match({
                  onEmpty: () =>
                    Array.make(
                      new PlayerTeam({
                        type: "Placeholder",
                        playerId: Array.headNonEmpty(headTeams).playerId,
                        playerName: Array.headNonEmpty(headTeams).playerName,
                        teamName: pipe(
                          Array.headNonEmpty(headTeams).playerName,
                          Option.map((name) => `${name} | placeholder`),
                          Option.getOrElse(() => "Placeholder"),
                        ),
                        lead: 0,
                        backline: 0,
                        talent: 0,
                        tags: HashSet.make("placeholder"),
                      }),
                    ),
                  onNonEmpty: Function.identity,
                }),
                Array.map((headTeam) => Array.make(headTeam)),
                Array.map(Array.appendAll(product)),
              ),
            ),
          ),
        ),
    }),
  );

const deriveRoomsFromCartesian =
  (config: CalcConfig) => (playerTeams: Array.NonEmptyReadonlyArray<ReadonlyArray<PlayerTeam>>) =>
    pipe(
      Effect.succeed(cartesianTeams(playerTeams)),
      Effect.map(
        Array.map((teams) =>
          pipe(baseRoom(teams), config.considerEnc ? applyRoomEncAndDoormat : Function.identity),
        ),
      ),
      Effect.map(Chunk.fromIterable),
      Effect.tap((derived) =>
        Effect.log(`Derived ${Chunk.size(derived)} rooms from cartesian product`),
      ),
      Effect.withSpan("deriveRoomsFromCartesian"),
    );

const filterConfigRooms = (config: CalcConfig) => (rooms: Chunk.Chunk<Room>) =>
  pipe(
    rooms,
    Chunk.filter(({ healed }) => healed >= config.healNeeded),
    Effect.succeed,
    Effect.withSpan("filterConfigRooms"),
  );

const filterBestRooms = (rooms: Chunk.Chunk<Room>) =>
  Effect.sync(() => {
    let bestEffectValue = Option.none<number>();
    const bestRooms: Room[] = [];

    for (const room of Chunk.toArray(rooms)) {
      if (Option.isNone(bestEffectValue) || room.effectValue > bestEffectValue.value) {
        bestEffectValue = Option.some(room.effectValue);
        bestRooms.push(room);
      }
    }

    return Chunk.fromIterable(bestRooms);
  }).pipe(Effect.withSpan("filterBestRooms"));

export class CalcService extends Context.Service<CalcService>()("CalcService", {
  make: Effect.succeed({
    calc: Effect.fn("CalcService.calc")(function* (
      config: CalcConfig,
      playerTeams: PlayerTeam[][],
    ) {
      const fixedTeams = yield* Effect.forEach(playerTeams, filterFixedTeams);
      const rooms = yield* pipe(
        fixedTeams,
        Array.match({
          onEmpty: () => Effect.succeed(Chunk.empty()),
          onNonEmpty: deriveRoomsFromCartesian(config),
        }),
      );
      const configRooms = yield* filterConfigRooms(config)(rooms);
      const bestRooms = yield* pipe(configRooms, Chunk.sort(Room.Order), filterBestRooms);
      return yield* pipe(
        bestRooms,
        Chunk.reverse,
        Effect.succeed,
        Effect.withSpan("CalcService.calc"),
      );
    }),
  }),
}) {
  static layer = Layer.effect(CalcService, this.make);
}
