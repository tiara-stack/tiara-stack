import { Effect, Layer } from "effect";
import { SheetRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { withCurrentWorkspaceAuthFromQuery } from "@/handlers/shared/workspaceAuthorization";
import { getSheetIdFromWorkspaceId } from "@/handlers/shared/workspaceConfig";
import { SheetAuthWorkspaceUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthWorkspaceUser";
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

export const sheetLayer = SheetRpcs.toLayer(
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const sheetService = yield* SheetService;
    const sheetConfigService = yield* SheetConfigService;
    const workspaceConfigService = yield* WorkspaceConfigService;
    const withQueryWorkspaceAuth = withCurrentWorkspaceAuthFromQuery(authorizationService);

    return {
      "sheet.getPlayers": Effect.fnUntraced(function* ({ query }) {
        const sheetId = yield* getSheetIdFromWorkspaceId(query.workspaceId, workspaceConfigService);
        return yield* sheetService.getPlayers(sheetId);
      }),
      "sheet.getMonitors": Effect.fnUntraced(function* ({ query }) {
        const sheetId = yield* getSheetIdFromWorkspaceId(query.workspaceId, workspaceConfigService);
        return yield* sheetService.getMonitors(sheetId);
      }),
      "sheet.getTeams": Effect.fnUntraced(function* ({ query }) {
        const sheetId = yield* getSheetIdFromWorkspaceId(query.workspaceId, workspaceConfigService);
        return yield* sheetService.getTeams(sheetId);
      }),
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
      "sheet.getRangesConfig": Effect.fnUntraced(function* ({ query }) {
        const sheetId = yield* getSheetIdFromWorkspaceId(query.workspaceId, workspaceConfigService);
        return yield* sheetConfigService.getRangesConfig(sheetId);
      }),
      "sheet.getTeamConfig": Effect.fnUntraced(function* ({ query }) {
        const sheetId = yield* getSheetIdFromWorkspaceId(query.workspaceId, workspaceConfigService);
        return yield* sheetConfigService.getTeamConfig(sheetId);
      }),
      "sheet.getEventConfig": Effect.fnUntraced(function* ({ query }) {
        const sheetId = yield* getSheetIdFromWorkspaceId(query.workspaceId, workspaceConfigService);
        return yield* sheetConfigService.getEventConfig(sheetId);
      }),
      "sheet.getScheduleConfig": Effect.fnUntraced(function* ({ query }) {
        const sheetId = yield* getSheetIdFromWorkspaceId(query.workspaceId, workspaceConfigService);
        return yield* sheetConfigService.getScheduleConfig(sheetId);
      }),
      "sheet.getRunnerConfig": Effect.fnUntraced(function* ({ query }) {
        const sheetId = yield* getSheetIdFromWorkspaceId(query.workspaceId, workspaceConfigService);
        return yield* sheetConfigService.getRunnerConfig(sheetId);
      }),
    };
  }),
).pipe(
  Layer.provide([
    AuthorizationService.layer,
    SheetService.layer,
    SheetConfigService.layer,
    WorkspaceConfigService.layer,
  ]),
);
