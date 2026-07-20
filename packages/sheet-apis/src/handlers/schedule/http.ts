// fallow-ignore-file complexity
import { Effect, Layer } from "effect";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { withCurrentWorkspaceAuthFromQuery } from "@/handlers/shared/workspaceAuthorization";
import { getSheetIdFromWorkspaceId } from "@/handlers/shared/workspaceConfig";
import { hasWorkspacePermission, hasPermission } from "@/services/authorization";
import { SheetAuthWorkspaceUser } from "sheet-ingress-api/internal";
import { Unauthorized } from "typhoon-core/error";
import {
  AuthorizationService,
  WorkspaceConfigService,
  ScheduleService,
  summarizeDayPlayerSchedule,
} from "@/services";
import { resolveScheduleViewFromPermissions } from "./shared";

export const scheduleLayer = sheetApisGroupLayer(
  "schedule",
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const scheduleService = yield* ScheduleService;
    const workspaceConfigService = yield* WorkspaceConfigService;
    const withQueryWorkspaceAuth = withCurrentWorkspaceAuthFromQuery(authorizationService);

    return {
      "schedule.getAllPopulatedSchedules": withQueryWorkspaceAuth(
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
          const schedules = yield* view === "monitor"
            ? scheduleService.getAllPopulatedSchedules(sheetId)
            : scheduleService.getAllPopulatedFillerSchedules(sheetId);

          return { schedules, view };
        }),
      ),
      "schedule.getDayPopulatedSchedules": withQueryWorkspaceAuth(
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
          const schedules = yield* view === "monitor"
            ? scheduleService.getDayPopulatedSchedules(sheetId, query.day)
            : scheduleService.getDayPopulatedFillerSchedules(sheetId, query.day);

          return { schedules, view };
        }),
      ),
      "schedule.getConversationPopulatedSchedules": withQueryWorkspaceAuth(
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
          const schedules = yield* view === "monitor"
            ? scheduleService.getChannelPopulatedSchedules(sheetId, query.conversationName)
            : scheduleService.getChannelPopulatedFillerSchedules(sheetId, query.conversationName);

          return { schedules, view };
        }),
      ),
      "schedule.getDayPlayerSchedule": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const resolvedUser = yield* SheetAuthWorkspaceUser;
          const view = resolveScheduleViewFromPermissions(
            resolvedUser.permissions,
            query.workspaceId,
            query.view,
          );

          if (
            resolvedUser.accountId !== query.accountId &&
            !hasPermission(resolvedUser.permissions, "service") &&
            !hasPermission(resolvedUser.permissions, "app_owner") &&
            !hasWorkspacePermission(
              resolvedUser.permissions,
              "monitor_workspace",
              query.workspaceId,
            )
          ) {
            return yield* Effect.fail(
              new Unauthorized({ message: "User does not have access to this user" }),
            );
          }

          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          const schedules = yield* view === "monitor"
            ? scheduleService.getDayPopulatedSchedules(sheetId, query.day)
            : scheduleService.getDayPopulatedFillerSchedules(sheetId, query.day);

          return {
            view,
            schedule: summarizeDayPlayerSchedule(schedules, query.accountId),
          };
        }),
      ),
    } satisfies HandlerMap<"schedule">;
  }),
).pipe(
  Layer.provide([AuthorizationService.layer, ScheduleService.layer, WorkspaceConfigService.layer]),
);
