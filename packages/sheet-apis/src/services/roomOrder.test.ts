import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Match, Option } from "effect";
import {
  Player,
  PopulatedSchedule,
  PopulatedSchedulePlayer,
  RawPlayer,
  ScheduleHourWindow,
  Team,
} from "sheet-ingress-api/schemas/sheet";
import {
  WorkspaceConfig,
  WorkspaceConversationConfig,
} from "sheet-ingress-api/schemas/workspaceConfig";
import { CalcService } from "./calc";
import { RoomOrderService, buildRoomOrderContent } from "./roomOrder";
import { PlayerService } from "./player";
import { ScheduleService } from "./schedule";
import { SheetService } from "./sheet";
import { WorkspaceConfigService } from "./workspaceConfig";

const expectTimestampPart = (part: unknown, epochMs: number) =>
  Match.value(part).pipe(
    Match.when({ type: "timestamp", epochMs }, (timestamp) => {
      expect(timestamp).not.toHaveProperty("style");
    }),
    Match.orElse(() => {
      throw new Error(`Expected timestamp part for ${epochMs}`);
    }),
  );

describe("RoomOrderService buildRoomOrderContent", () => {
  it("leaves both hourly range endpoints in Discord date/time style", () => {
    const start = DateTime.makeUnsafe("2026-03-26T12:00:00.000Z");
    const end = DateTime.makeUnsafe("2026-03-26T13:00:00.000Z");
    const content = buildRoomOrderContent(1, start, end, null, [], [], []);

    expectTimestampPart(content[2], DateTime.toEpochMillis(start));
    expectTimestampPart(content[4], DateTime.toEpochMillis(end));
  });
});

const makePlayer = (index: number, id: string, name: string) =>
  new Player({
    index,
    id,
    name,
  });

const makeRawPlayer = (index: number, id: string, name: string) =>
  new RawPlayer({
    index,
    id: Option.some(id),
    name: Option.some(name),
  });

const makeTeam = ({
  playerName,
  teamName,
  lead,
  backline,
  talent,
  tags = [],
}: {
  playerName: string;
  teamName: string;
  lead: number;
  backline: number;
  talent: Option.Option<number>;
  tags?: ReadonlyArray<string>;
}) =>
  new Team({
    type: "Test",
    playerId: Option.none(),
    playerName: Option.some(playerName),
    teamName: Option.some(teamName),
    tags,
    lead,
    backline,
    talent,
  });

describe("RoomOrderService generate", () => {
  it.effect("uses all aliases for an encore player in the first hour", () => {
    const players = [
      makePlayer(0, "tierer", "Tierer"),
      makePlayer(1, "player-2", "Player 2"),
      makePlayer(2, "player-3", "Player 3"),
      makePlayer(3, "player-4", "Player 4"),
      makePlayer(4, "enc-player", "Encore Player (e)"),
    ];
    const currentSchedule = new PopulatedSchedule({
      channel: "room",
      day: 1,
      visible: true,
      hour: Option.some(1),
      hourWindow: Option.some(
        new ScheduleHourWindow({
          start: DateTime.makeUnsafe("2026-07-23T21:00:00Z"),
          end: DateTime.makeUnsafe("2026-07-23T22:00:00Z"),
        }),
      ),
      fills: players.map((player, index) =>
        Option.some(
          new PopulatedSchedulePlayer({
            player,
            enc: index === 4,
          }),
        ),
      ),
      overfills: [],
      standbys: [],
      runners: [],
      monitor: Option.none(),
    });
    const rawPlayers = [
      makeRawPlayer(0, "tierer", "Tierer"),
      makeRawPlayer(1, "player-2", "Player 2"),
      makeRawPlayer(2, "player-3", "Player 3"),
      makeRawPlayer(3, "player-4", "Player 4"),
      makeRawPlayer(4, "enc-player", "Encore Player"),
      makeRawPlayer(5, "enc-player", "Encore Player (e)"),
    ];
    const teams = [
      makeTeam({
        playerName: "Tierer",
        teamName: "Tierer | Runner",
        lead: 5,
        backline: 5,
        talent: Option.some(7),
        tags: ["tierer_hint"],
      }),
      makeTeam({
        playerName: "Player 2",
        teamName: "Player 2 | Full Fill",
        lead: 10,
        backline: 10,
        talent: Option.some(10),
      }),
      makeTeam({
        playerName: "Player 3",
        teamName: "Player 3 | Full Fill",
        lead: 10,
        backline: 10,
        talent: Option.some(10),
      }),
      makeTeam({
        playerName: "Player 4",
        teamName: "Player 4 | Full Fill",
        lead: 10,
        backline: 10,
        talent: Option.some(10),
      }),
      makeTeam({
        playerName: "Encore Player",
        teamName: "Encore Player | Full Fill",
        lead: 160,
        backline: 780,
        talent: Option.none(),
      }),
      makeTeam({
        playerName: "Encore Player",
        teamName: "Encore Player | Encore",
        lead: 160,
        backline: 700,
        talent: Option.some(390),
      }),
    ];
    const workspaceConfig = new WorkspaceConfig({
      workspaceId: "workspace",
      sheetId: Option.some("sheet"),
      autoCheckin: Option.none(),
      createdAt: Option.none(),
      updatedAt: Option.none(),
      deletedAt: Option.none(),
    });
    const conversation = new WorkspaceConversationConfig({
      workspaceId: "workspace",
      conversationId: "conversation",
      name: Option.some("room"),
      running: Option.some(true),
      roleId: Option.none(),
      checkinConversationId: Option.none(),
      createdAt: Option.none(),
      updatedAt: Option.none(),
      deletedAt: Option.none(),
    });
    const workspaceConfigLayer = Layer.mock(WorkspaceConfigService)({
      getWorkspaceConfig: () => Effect.succeed(Option.some(workspaceConfig)),
      getWorkspaceConversationById: () => Effect.succeed(Option.some(conversation)),
    });
    const scheduleLayer = Layer.mock(ScheduleService)({
      getChannelPopulatedSchedules: () => Effect.succeed([currentSchedule]),
    });
    const sheetLayer = Layer.mock(SheetService)({
      getPlayers: () => Effect.succeed(rawPlayers),
      getTeams: () => Effect.succeed(teams),
    });
    const playerLayer = Layer.effect(PlayerService, PlayerService.make).pipe(
      Layer.provide(sheetLayer),
    );

    return Effect.gen(function* () {
      const service = yield* RoomOrderService.make;
      const result = yield* service.generate({
        workspaceId: "workspace",
        conversationId: "conversation",
        hour: 1,
      });
      const selectedEncore = result.entries.find(
        (entry) => entry.rank === 0 && entry.tags.includes("enc"),
      );

      expect(result.previousFills).toEqual([]);
      expect(selectedEncore?.team).toBe("Encore Player | Encore");
      expect(result.entries.some((entry) => entry.tags.includes("placeholder"))).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          CalcService.layer,
          workspaceConfigLayer,
          scheduleLayer,
          sheetLayer,
          playerLayer,
        ),
      ),
    );
  });
});
