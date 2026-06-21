// fallow-ignore-file code-duplication
import { Chunk, DateTime, Duration, Effect, Layer, Option, Predicate, Context, pipe } from "effect";
import { makeArgumentError } from "typhoon-core/error";
import { WorkspaceConfigService } from "./workspaceConfig";
import { ScheduleService } from "./schedule";
import { CalcConfig, CalcService } from "./calc";
import { SheetService } from "./sheet";
import { getSheetIdFromWorkspaceId, requireRunningConversation } from "./workspaceSheet";
import {
  type FillParticipant,
  diffFillParticipants,
  getScheduleFills,
  toFillParticipant,
} from "./fillMovement";
import type { GeneratedSheetText } from "sheet-ingress-api/schemas/client";
import { inlineCode, joinText, parts, strong, text, timestamp } from "./generatedText";
import {
  GeneratedRoomOrderEntry,
  RoomOrderGenerateResult,
} from "sheet-ingress-api/schemas/roomOrder";
import { MessageRoomOrderRange } from "sheet-ingress-api/schemas/messageRoomOrder";
import {
  Player,
  PlayerTeam,
  Team,
  type PopulatedScheduleResult,
} from "sheet-ingress-api/schemas/sheet";

type SheetServiceApi = Context.Service.Shape<typeof SheetService>;

const isPlayer = Predicate.isTagged("Player");
const isPopulatedSchedule = Predicate.isTagged("PopulatedSchedule");

const formatEffectValue = (effectValue: number): string => {
  const rounded = Math.round(effectValue * 10) / 10;
  const formatted = rounded % 1 === 0 ? rounded.toString() : rounded.toFixed(1);
  return `+${formatted}%`;
};

const deriveHour = Effect.fn("RoomOrderService.deriveHour")(function* (
  payload: { hour?: number | undefined },
  sheetService: SheetServiceApi,
  sheetId: string,
) {
  if (Predicate.isNumber(payload.hour)) {
    return payload.hour;
  }

  const dateTime = yield* DateTime.now.pipe(Effect.map(DateTime.addDuration(Duration.minutes(20))));
  const eventConfig = yield* sheetService.getEventConfig(sheetId);
  const distance = DateTime.distance(
    eventConfig.startTime,
    pipe(dateTime, DateTime.startOf("hour")),
  );
  return Math.floor(Duration.toHours(distance)) + 1;
});

const deriveHourWindow = (sheetService: SheetServiceApi, sheetId: string, hour: number) =>
  sheetService.getEventConfig(sheetId).pipe(
    Effect.map((eventConfig) => ({
      start: pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(hour - 1))),
      end: pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(hour))),
    })),
  );

const toTeamWithPlayer = (player: Player, team: Team) =>
  new Team({
    type: team.type,
    playerId: Option.some(player.id),
    playerName: team.playerName,
    teamName: team.teamName,
    tags: team.tags,
    lead: team.lead,
    backline: team.backline,
    talent: team.talent,
  });

export type RoomOrderContentEntry = {
  readonly position: number;
  readonly team: string;
  readonly tags: ReadonlyArray<string>;
  readonly effectValue: number;
};

export const buildRoomOrderContent = (
  hour: number,
  start: DateTime.DateTime,
  end: DateTime.DateTime,
  monitor: string | null,
  previousParticipants: ReadonlyArray<FillParticipant>,
  participants: ReadonlyArray<FillParticipant>,
  entries: ReadonlyArray<RoomOrderContentEntry>,
): GeneratedSheetText => {
  const fillMovement = diffFillParticipants(previousParticipants, participants);

  return joinText(
    [
      parts(
        strong([text(`Hour ${hour}`)]),
        text(" "),
        timestamp(DateTime.toEpochMillis(start), "longDate"),
        text(" - "),
        timestamp(DateTime.toEpochMillis(end), "longDate"),
      ),
      ...(Predicate.isNull(monitor) ? [] : [parts(inlineCode("Monitor:"), text(` ${monitor}`))]),
      [text("")],
      ...entries.map(({ position, team, tags, effectValue }) => {
        const hasTiererTag = tags.includes("tierer");
        const effectParts = hasTiererTag
          ? []
          : [
              formatEffectValue(effectValue),
              ...(tags.includes("enc") ? ["enc"] : []),
              ...(tags.includes("not_enc") ? ["not enc"] : []),
            ];

        const effectStr = effectParts.length > 0 ? ` (${effectParts.join(", ")})` : "";
        return parts(inlineCode(`P${position + 1}:`), text(`  ${team}${effectStr}`));
      }),
      [text("")],
      parts(
        inlineCode("In:"),
        text(
          ` ${fillMovement.in.length > 0 ? fillMovement.in.map(({ name }) => name).join(", ") : "(none)"}`,
        ),
      ),
      parts(
        inlineCode("Out:"),
        text(
          ` ${fillMovement.out.length > 0 ? fillMovement.out.map(({ name }) => name).join(", ") : "(none)"}`,
        ),
      ),
    ],
    "\n",
  );
};

export class RoomOrderService extends Context.Service<RoomOrderService>()("RoomOrderService", {
  make: Effect.gen(function* () {
    const calcService = yield* CalcService;
    const workspaceConfigService = yield* WorkspaceConfigService;
    const scheduleService = yield* ScheduleService;
    const sheetService = yield* SheetService;

    return {
      // fallow-ignore-next-line complexity
      generate: Effect.fn("RoomOrderService.generate")(function* (payload: {
        workspaceId: string;
        conversationId?: string | undefined;
        conversationName?: string | undefined;
        hour?: number | undefined;
        healNeeded?: number | undefined;
      }) {
        const runningConversation = yield* requireRunningConversation(
          payload.workspaceId,
          payload,
          workspaceConfigService,
          "generate room order",
        );
        const sheetId = yield* getSheetIdFromWorkspaceId(
          payload.workspaceId,
          workspaceConfigService,
          "generate room order",
        );
        const hour = yield* deriveHour(payload, sheetService, sheetId);
        const healNeeded = payload.healNeeded ?? 0;
        const conversationName = yield* Option.match(runningConversation.name, {
          onNone: () =>
            Effect.fail(
              makeArgumentError(
                "Cannot generate room order, the running conversation is missing a conversation name",
              ),
            ),
          onSome: (name) =>
            name.trim().length === 0
              ? Effect.fail(
                  makeArgumentError(
                    "Cannot generate room order, the running conversation has an empty conversation name",
                  ),
                )
              : Effect.succeed(name.trim()),
        });

        const schedules = yield* scheduleService.getChannelPopulatedSchedules(
          sheetId,
          conversationName,
        );
        const schedulesByHour = new Map<number, PopulatedScheduleResult>();
        for (const schedule of schedules) {
          if (Option.isSome(schedule.hour)) {
            schedulesByHour.set(schedule.hour.value, schedule);
          }
        }

        const previousSchedule = schedulesByHour.get(hour - 1);
        const currentSchedule = schedulesByHour.get(hour);

        const previousFills = getScheduleFills(previousSchedule);
        const fills = getScheduleFills(currentSchedule);

        const previousFillNames = previousFills.map((fill) => fill.player.name);
        const fillNames = fills.map((fill) => fill.player.name);
        const runnerNames = fillNames;
        const monitor =
          currentSchedule &&
          isPopulatedSchedule(currentSchedule) &&
          Option.isSome(currentSchedule.monitor)
            ? currentSchedule.monitor.value.monitor.name
            : null;

        const allTeams = yield* sheetService.getTeams(sheetId);
        const playerTeams = fills.map((fill) => {
          if (!isPlayer(fill.player)) {
            return [] as PlayerTeam[];
          }
          const player = fill.player;

          return allTeams
            .filter((team) => Option.exists(team.playerName, (name) => name === player.name))
            .map((team) => toTeamWithPlayer(player, team))
            .map(
              (team) =>
                new Team({
                  type: team.type,
                  playerId: team.playerId,
                  playerName: team.playerName,
                  teamName: team.teamName,
                  tags: pipe(
                    team.tags,
                    (tags) =>
                      tags.includes("tierer_hint") && runnerNames.includes(player.name)
                        ? [...tags, "tierer"]
                        : [...tags],
                    (tags) => (fill.enc ? [...tags, "encable"] : tags),
                  ),
                  lead: team.lead,
                  backline: team.backline,
                  talent: team.talent,
                }),
            )
            .flatMap((team) => Option.toArray(PlayerTeam.fromTeam(false, team)));
        });

        const rooms = yield* calcService.calc(
          new CalcConfig({ healNeeded, considerEnc: true }),
          playerTeams,
        );
        const roomOrders = Chunk.toArray(rooms);

        if (roomOrders.length === 0) {
          return yield* Effect.fail(
            makeArgumentError("cannot calculate room orders with given teams"),
          );
        }

        const entries = roomOrders.flatMap((room: any, rank) =>
          Chunk.toArray(room.teams).map(
            (entry: any, position) =>
              new GeneratedRoomOrderEntry({
                rank,
                position,
                hour,
                team: entry.teamName,
                tags: Array.from(entry.tags),
                effectValue: PlayerTeam.getEffectValue(entry),
              }),
          ),
        );

        const firstRankEntries = entries.filter((entry) => entry.rank === 0);
        const { start, end } =
          currentSchedule && Option.isSome(currentSchedule.hourWindow)
            ? currentSchedule.hourWindow.value
            : yield* deriveHourWindow(sheetService, sheetId, hour);

        return new RoomOrderGenerateResult({
          content: buildRoomOrderContent(
            hour,
            start,
            end,
            monitor,
            previousFills.map(toFillParticipant),
            fills.map(toFillParticipant),
            firstRankEntries,
          ),
          runningConversationId: runningConversation.conversationId,
          range: new MessageRoomOrderRange({
            minRank: 0,
            maxRank: roomOrders.length - 1,
          }),
          rank: 0,
          hour,
          monitor,
          previousFills: previousFillNames,
          fills: fillNames,
          entries,
        });
      }),
    };
  }),
}) {
  static layer = Layer.effect(RoomOrderService, this.make).pipe(
    Layer.provide(CalcService.layer),
    Layer.provide(WorkspaceConfigService.layer),
    Layer.provide(ScheduleService.layer),
    Layer.provide(SheetService.layer),
  );
}
