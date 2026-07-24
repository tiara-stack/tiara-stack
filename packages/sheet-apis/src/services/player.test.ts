import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { RawPlayer, Team } from "sheet-ingress-api/schemas/sheet";
import { PlayerService } from "./player";
import { SheetService } from "./sheet";

const makeRawPlayer = ({ index, id, name }: { index: number; id: string; name: string }) =>
  new RawPlayer({
    index,
    id: Option.some(id),
    name: Option.some(name),
  });

const makeTeam = (playerName: string) =>
  new Team({
    type: "Test",
    playerId: Option.none(),
    playerName: Option.some(playerName),
    teamName: Option.some(`${playerName} | Full Fill`),
    tags: [],
    lead: 10,
    backline: 10,
    talent: Option.some(10),
  });

describe("PlayerService", () => {
  it.effect("returns same-id aliases without attributing ambiguous names", () => {
    const sheetLayer = Layer.mock(SheetService)({
      getPlayers: () =>
        Effect.succeed([
          makeRawPlayer({ index: 0, id: "enc-player", name: "Encore Player" }),
          makeRawPlayer({ index: 1, id: "enc-player", name: "Encore Player (e)" }),
          makeRawPlayer({ index: 2, id: "player-a", name: "Shared Name" }),
          makeRawPlayer({ index: 3, id: "player-b", name: "Shared Name" }),
        ]),
      getTeams: () =>
        Effect.succeed([
          makeTeam("Encore Player"),
          makeTeam("Encore Player (e)"),
          makeTeam("Shared Name"),
        ]),
    });

    return Effect.gen(function* () {
      const service = yield* PlayerService.make;
      const teams = yield* service.getTeamsByIds("sheet", ["enc-player", "player-a"]);

      expect(teams.map((team) => Option.getOrNull(team.playerName))).toEqual([
        "Encore Player",
        "Encore Player (e)",
      ]);
      expect(teams.every((team) => Option.getOrNull(team.playerId) === "enc-player")).toBe(true);
    }).pipe(Effect.provide(sheetLayer));
  });
});
