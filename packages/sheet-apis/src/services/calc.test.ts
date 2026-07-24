import { describe, expect, it } from "@effect/vitest";
import { Chunk, Effect, HashSet, Option } from "effect";
import { CalcConfig, CalcService, cartesianTeams } from "./calc";
import { PlayerTeam } from "sheet-ingress-api/schemas/sheet";

const makePlayerTeam = ({
  playerId,
  playerName,
  teamName,
  lead = 10,
  backline = 10,
  talent = 10,
  tags = [],
}: {
  playerId: Option.Option<string>;
  playerName: Option.Option<string>;
  teamName: string;
  lead?: number;
  backline?: number;
  talent?: number;
  tags?: ReadonlyArray<string>;
}) =>
  new PlayerTeam({
    type: "Test",
    playerId,
    playerName,
    teamName,
    lead,
    backline,
    talent,
    tags: HashSet.fromIterable(tags),
  });

describe("CalcService", () => {
  it("dedupes only when player id and player name both match", () => {
    const slotA = [
      makePlayerTeam({
        playerId: Option.some("player-1"),
        playerName: Option.some("Alice"),
        teamName: "A1",
      }),
      makePlayerTeam({
        playerId: Option.some("player-2"),
        playerName: Option.some("Shared"),
        teamName: "A2",
      }),
      makePlayerTeam({
        playerId: Option.some("player-3"),
        playerName: Option.some("Alias A"),
        teamName: "A3",
      }),
      makePlayerTeam({
        playerId: Option.some("player-4"),
        playerName: Option.some("Same"),
        teamName: "A4",
      }),
    ];
    const slotB = [
      makePlayerTeam({
        playerId: Option.some("player-5"),
        playerName: Option.some("Bob"),
        teamName: "B1",
      }),
      makePlayerTeam({
        playerId: Option.some("player-6"),
        playerName: Option.some("Shared"),
        teamName: "B2",
      }),
      makePlayerTeam({
        playerId: Option.some("player-3"),
        playerName: Option.some("Alias B"),
        teamName: "B3",
      }),
      makePlayerTeam({
        playerId: Option.some("player-4"),
        playerName: Option.some("Same"),
        teamName: "B4",
      }),
    ];

    const rooms = cartesianTeams([slotA, slotB]);

    const roomTeams = rooms.map((room) => room.map((team) => team.teamName));

    expect(rooms).toHaveLength(15);
    expect(roomTeams).toContainEqual(["A1", "B1"]);
    expect(roomTeams).toContainEqual(["A2", "B2"]);
    expect(roomTeams).toContainEqual(["A3", "B3"]);
    expect(roomTeams).not.toContainEqual(["A4", "B4"]);
  });

  it.effect(
    "keeps the lowest talent room for a given effect value and orders results by effect descending",
    Effect.fnUntraced(function* () {
      const calcService = yield* CalcService;
      const rooms = yield* calcService.calc(new CalcConfig({ healNeeded: 0, considerEnc: false }), [
        [
          makePlayerTeam({
            playerId: Option.some("player-1"),
            playerName: Option.some("Alice"),
            teamName: "Low Talent Same Effect",
            lead: 10,
            backline: 10,
            talent: 1,
          }),
          makePlayerTeam({
            playerId: Option.some("player-2"),
            playerName: Option.some("Beatrice"),
            teamName: "High Talent Same Effect",
            lead: 10,
            backline: 10,
            talent: 5,
          }),
          makePlayerTeam({
            playerId: Option.some("player-3"),
            playerName: Option.some("Celine"),
            teamName: "Highest Effect",
            lead: 20,
            backline: 20,
            talent: 8,
          }),
        ],
        [
          makePlayerTeam({
            playerId: Option.some("player-4"),
            playerName: Option.some("Dana"),
            teamName: "Anchor",
            lead: 0,
            backline: 0,
            talent: 0,
          }),
        ],
      ]);
      const roomArray = Chunk.toArray(rooms);

      expect(roomArray).toHaveLength(2);
      expect(roomArray[0]?.effectValue).toBe(20);
      expect(roomArray[0]?.talent).toBe(8);
      expect(roomArray[1]?.effectValue).toBe(10);
      expect(roomArray[1]?.talent).toBe(1);
      expect(
        Chunk.toArray(roomArray[1]?.teams ?? Chunk.empty()).map((team) => team.teamName),
      ).toContain("Low Talent Same Effect");
      expect(
        Chunk.toArray(roomArray[1]?.teams ?? Chunk.empty()).map((team) => team.teamName),
      ).not.toContain("High Talent Same Effect");
    }, Effect.provide(CalcService.layer)),
  );

  it.effect(
    "tags non-enc teams with not_enc when enc is considered",
    Effect.fnUntraced(function* () {
      const calcService = yield* CalcService;
      const rooms = yield* calcService.calc(new CalcConfig({ healNeeded: 0, considerEnc: true }), [
        [
          makePlayerTeam({
            playerId: Option.some("player-1"),
            playerName: Option.some("Alice"),
            teamName: "Enc Team",
            lead: 20,
            backline: 20,
            talent: 5,
            tags: ["encable"],
          }),
        ],
        [
          makePlayerTeam({
            playerId: Option.some("player-2"),
            playerName: Option.some("Bob"),
            teamName: "Same Talent",
            lead: 10,
            backline: 10,
            talent: 5,
          }),
        ],
        [
          makePlayerTeam({
            playerId: Option.some("player-3"),
            playerName: Option.some("Carol"),
            teamName: "Higher Talent",
            lead: 8,
            backline: 8,
            talent: 6,
          }),
        ],
      ]);

      const [room] = Chunk.toArray(rooms);
      const roomTeams = Chunk.toArray(room?.teams ?? Chunk.empty());
      const encTeam = roomTeams.find((team) => team.teamName === "Enc Team");
      const sameTalentTeam = roomTeams.find((team) => team.teamName === "Same Talent");
      const higherTalentTeam = roomTeams.find((team) => team.teamName === "Higher Talent");

      expect(encTeam).toBeDefined();
      expect(sameTalentTeam).toBeDefined();
      expect(higherTalentTeam).toBeDefined();
      expect(HashSet.has(encTeam!.tags, "enc")).toBe(true);
      expect(HashSet.has(encTeam!.tags, "not_enc")).toBe(false);
      expect(HashSet.has(sameTalentTeam!.tags, "not_enc")).toBe(true);
      expect(HashSet.has(higherTalentTeam!.tags, "not_enc")).toBe(true);
      expect(HashSet.size(encTeam!.tags)).toBe(2);
      expect(HashSet.size(sameTalentTeam!.tags)).toBe(1);
      expect(HashSet.size(higherTalentTeam!.tags)).toBe(1);
    }, Effect.provide(CalcService.layer)),
  );

  it.effect("selects the highest-effect encore candidate permitted by the tierer talent", () =>
    Effect.gen(function* () {
      const calcService = yield* CalcService;
      const rooms = yield* calcService.calc(new CalcConfig({ healNeeded: 0, considerEnc: true }), [
        [
          makePlayerTeam({
            playerId: Option.some("tierer"),
            playerName: Option.some("Tierer"),
            teamName: "Tierer",
            lead: 5,
            backline: 5,
            talent: 5,
            tags: ["tierer"],
          }),
        ],
        [
          makePlayerTeam({
            playerId: Option.some("enc-player"),
            playerName: Option.some("Encore Player"),
            teamName: "Disallowed Full Fill",
            lead: 40,
            backline: 40,
            talent: 4,
            tags: ["encable"],
          }),
          makePlayerTeam({
            playerId: Option.some("enc-player"),
            playerName: Option.some("Encore Player (e)"),
            teamName: "Allowed Full Fill",
            lead: 30,
            backline: 30,
            talent: 6,
            tags: ["encable"],
          }),
          makePlayerTeam({
            playerId: Option.some("enc-player"),
            playerName: Option.some("Encore Player (enc)"),
            teamName: "Allowed Encore",
            lead: 20,
            backline: 20,
            talent: 7,
            tags: ["encable"],
          }),
        ],
      ]);

      const [bestRoom] = Chunk.toArray(rooms);
      const roomTeams = Chunk.toArray(bestRoom?.teams ?? Chunk.empty());
      const selectedEncore = roomTeams.find((team) => HashSet.has(team.tags, "enc"));

      expect(selectedEncore?.teamName).toBe("Allowed Full Fill");
      expect(roomTeams.some((team) => HashSet.has(team.tags, "placeholder"))).toBe(false);
    }).pipe(Effect.provide(CalcService.layer)),
  );
});
