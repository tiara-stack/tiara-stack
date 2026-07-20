import { Effect, Predicate } from "effect";
import { SheetAuthUser } from "sheet-ingress-api/internal";
import { AuthorizationService } from "../../services/authorization";
import {
  guildPayload,
  guildQuery,
  requireDayPlayerSchedule,
  serviceOnly,
  singlePlayerOrMonitor,
} from "../authorization";
import { authorizedSheetApis } from "../sheetApisProxy";
import type { IngressHandlerTable } from "../types";

export const sheetHandlers = {
  monitor: (handlers) =>
    handlers
      .handle(
        "getMonitorMaps",
        guildQuery("monitor", "getMonitorMaps", "monitor", (query) => query.workspaceId),
      )
      .handle(
        "getByIds",
        guildQuery("monitor", "getByIds", "monitor", (query) => query.workspaceId),
      )
      .handle(
        "getByNames",
        guildQuery("monitor", "getByNames", "monitor", (query) => query.workspaceId),
      ),
  permissions: (handlers) =>
    handlers.handle(
      "getCurrentUserPermissions",
      Effect.fnUntraced(function* ({ query }) {
        const authorization = yield* AuthorizationService;
        const resolvedUser = Predicate.isString(query.workspaceId)
          ? yield* authorization.resolveCurrentWorkspaceUser(query.workspaceId)
          : yield* SheetAuthUser;

        return {
          permissions: resolvedUser.permissions,
        };
      }),
    ),
  player: (handlers) =>
    handlers
      .handle(
        "getPlayerMaps",
        guildQuery("player", "getPlayerMaps", "monitor", (query) => query.workspaceId),
      )
      .handle(
        "getByIds",
        singlePlayerOrMonitor("player", "getByIds", (query) => ({
          guildId: query.workspaceId,
          ids: query.ids,
        })),
      )
      .handle(
        "getByNames",
        guildQuery("player", "getByNames", "monitor", (query) => query.workspaceId),
      )
      .handle(
        "getTeamsByIds",
        singlePlayerOrMonitor("player", "getTeamsByIds", (query) => ({
          guildId: query.workspaceId,
          ids: query.ids,
        })),
      )
      .handle(
        "getTeamsByNames",
        guildQuery("player", "getTeamsByNames", "monitor", (query) => query.workspaceId),
      ),
  roomOrder: (handlers) =>
    handlers.handle(
      "generate",
      guildPayload("roomOrder", "generate", "monitor", (payload) => payload.workspaceId),
    ),
  schedule: (handlers) =>
    handlers
      .handle(
        "getAllPopulatedSchedules",
        guildQuery("schedule", "getAllPopulatedSchedules", "member", (query) => query.workspaceId),
      )
      .handle(
        "getDayPopulatedSchedules",
        guildQuery("schedule", "getDayPopulatedSchedules", "member", (query) => query.workspaceId),
      )
      .handle(
        "getConversationPopulatedSchedules",
        guildQuery(
          "schedule",
          "getConversationPopulatedSchedules",
          "member",
          (query) => query.workspaceId,
        ),
      )
      .handle(
        "getDayPlayerSchedule",
        authorizedSheetApis("schedule", "getDayPlayerSchedule", ({ query }) =>
          requireDayPlayerSchedule(query.workspaceId, query.accountId),
        ),
      ),
  screenshot: (handlers) =>
    handlers.handle(
      "getScreenshot",
      guildQuery("screenshot", "getScreenshot", "monitor", (query) => query.workspaceId),
    ),
  sheet: (handlers) =>
    handlers
      .handle("getPlayers", serviceOnly("sheet", "getPlayers"))
      .handle("getMonitors", serviceOnly("sheet", "getMonitors"))
      .handle("getTeams", serviceOnly("sheet", "getTeams"))
      .handle("getAllSchedules", serviceOnly("sheet", "getAllSchedules"))
      .handle("getDaySchedules", serviceOnly("sheet", "getDaySchedules"))
      .handle("getConversationSchedules", serviceOnly("sheet", "getConversationSchedules"))
      .handle("getRangesConfig", serviceOnly("sheet", "getRangesConfig"))
      .handle("getTeamConfig", serviceOnly("sheet", "getTeamConfig"))
      .handle(
        "getEventConfig",
        guildQuery("sheet", "getEventConfig", "member", (query) => query.workspaceId),
      )
      .handle("getScheduleConfig", serviceOnly("sheet", "getScheduleConfig"))
      .handle("getRunnerConfig", serviceOnly("sheet", "getRunnerConfig")),
} satisfies Pick<
  IngressHandlerTable,
  "monitor" | "permissions" | "player" | "roomOrder" | "schedule" | "screenshot" | "sheet"
>;
