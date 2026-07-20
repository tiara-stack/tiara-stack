import { Effect, Layer } from "effect";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { withCurrentWorkspaceAuthFromQuery } from "@/handlers/shared/workspaceAuthorization";
import { getSheetIdFromWorkspaceId } from "@/handlers/shared/workspaceConfig";
import { SheetAuthWorkspaceUser } from "sheet-ingress-api/internal";
import { BreakSchedule, Schedule } from "sheet-ingress-api/schemas/sheet";
import {
  AuthorizationService,
  withScheduleHourWindow,
  WorkspaceConfigService,
  SheetConfigService,
  SheetService,
} from "@/services";
import { resolveScheduleViewFromPermissions } from "../schedule/shared";

const withScheduleHourWindows = (
  schedules: ReadonlyArray<BreakSchedule | Schedule>,
  startTime: Parameters<typeof withScheduleHourWindow>[0],
) => schedules.map((schedule) => withScheduleHourWindow(startTime, schedule));

export const sheetLayer = sheetApisGroupLayer(
  "sheet",
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const sheetService = yield* SheetService;
    const sheetConfigService = yield* SheetConfigService;
    const workspaceConfigService = yield* WorkspaceConfigService;
    const withQueryWorkspaceAuth = withCurrentWorkspaceAuthFromQuery(authorizationService);
    const withMonitorQueryWorkspaceAuth = <
      Args extends { query: { workspaceId: string } },
      A,
      E,
      R,
    >(
      body: (args: Args) => Effect.Effect<A, E, R>,
    ) =>
      withQueryWorkspaceAuth(
        Effect.fnUntraced(function* (args: Args) {
          yield* authorizationService.requireMonitorWorkspace(args.query.workspaceId);
          return yield* body(args);
        }),
      );

    return {
      "sheet.getPlayers": withMonitorQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          return yield* sheetService.getPlayers(sheetId);
        }),
      ),
      "sheet.getMonitors": withMonitorQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          return yield* sheetService.getMonitors(sheetId);
        }),
      ),
      "sheet.getTeams": withMonitorQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          return yield* sheetService.getTeams(sheetId);
        }),
      ),
      "sheet.getAllSchedules": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          const resolvedUser = yield* SheetAuthWorkspaceUser;
          const view = resolveScheduleViewFromPermissions(
            resolvedUser.permissions,
            query.workspaceId,
            query.view,
          );
          const { schedules, eventConfig } = yield* Effect.all({
            schedules:
              view === "monitor"
                ? sheetService.getAllSchedules(sheetId)
                : sheetService.getAllFillerSchedules(sheetId),
            eventConfig: sheetConfigService.getEventConfig(sheetId),
          });

          return {
            schedules: withScheduleHourWindows(schedules, eventConfig.startTime),
            view,
          };
        }),
      ),
      "sheet.getDaySchedules": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          const resolvedUser = yield* SheetAuthWorkspaceUser;
          const view = resolveScheduleViewFromPermissions(
            resolvedUser.permissions,
            query.workspaceId,
            query.view,
          );
          const { schedules, eventConfig } = yield* Effect.all({
            schedules:
              view === "monitor"
                ? sheetService.getDaySchedules(sheetId, query.day)
                : sheetService.getDayFillerSchedules(sheetId, query.day),
            eventConfig: sheetConfigService.getEventConfig(sheetId),
          });

          return {
            schedules: withScheduleHourWindows(schedules, eventConfig.startTime),
            view,
          };
        }),
      ),
      "sheet.getConversationSchedules": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          const resolvedUser = yield* SheetAuthWorkspaceUser;
          const view = resolveScheduleViewFromPermissions(
            resolvedUser.permissions,
            query.workspaceId,
            query.view,
          );
          const { schedules, eventConfig } = yield* Effect.all({
            schedules:
              view === "monitor"
                ? sheetService.getChannelSchedules(sheetId, query.conversationName)
                : sheetService.getChannelFillerSchedules(sheetId, query.conversationName),
            eventConfig: sheetConfigService.getEventConfig(sheetId),
          });

          return {
            schedules: withScheduleHourWindows(schedules, eventConfig.startTime),
            view,
          };
        }),
      ),
      "sheet.getRangesConfig": withMonitorQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          return yield* sheetConfigService.getRangesConfig(sheetId);
        }),
      ),
      "sheet.getTeamConfig": withMonitorQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          return yield* sheetConfigService.getTeamConfig(sheetId);
        }),
      ),
      "sheet.getEventConfig": withMonitorQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          return yield* sheetConfigService.getEventConfig(sheetId);
        }),
      ),
      "sheet.getScheduleConfig": withMonitorQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          return yield* sheetConfigService.getScheduleConfig(sheetId);
        }),
      ),
      "sheet.getRunnerConfig": withMonitorQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          return yield* sheetConfigService.getRunnerConfig(sheetId);
        }),
      ),
    } satisfies HandlerMap<"sheet">;
  }),
).pipe(Layer.provide([AuthorizationService.layer, WorkspaceConfigService.layer]));
