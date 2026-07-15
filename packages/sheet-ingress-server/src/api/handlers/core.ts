import { Effect } from "effect";
import { guildPayload, requireNonService, requireService, serviceOnly } from "../authorization";
import { authorizedSheetApis, statusGetServices } from "../sheetApisProxy";
import type { IngressHandlerTable } from "../types";

export const coreHandlers = {
  calc: (handlers) =>
    handlers
      .handle("calcBot", serviceOnly("calc", "calcBot"))
      .handle("calcSheet", serviceOnly("calc", "calcSheet")),
  checkin: (handlers) =>
    handlers.handle(
      "generate",
      guildPayload("checkin", "generate", "monitor", (payload) => payload.workspaceId),
    ),
  discord: (handlers) =>
    handlers
      .handle("getCurrentUser", authorizedSheetApis("discord", "getCurrentUser", requireNonService))
      .handle(
        "getCurrentUserGuilds",
        authorizedSheetApis("discord", "getCurrentUserGuilds", requireNonService),
      ),
  userConfig: (handlers) =>
    handlers
      .handle(
        "getCurrentUserPlatformConfig",
        authorizedSheetApis("userConfig", "getCurrentUserPlatformConfig", requireNonService),
      )
      .handle(
        "upsertCurrentUserPlatformConfig",
        authorizedSheetApis("userConfig", "upsertCurrentUserPlatformConfig", requireNonService),
      )
      .handle(
        "listSupportedNotificationClients",
        authorizedSheetApis("userConfig", "listSupportedNotificationClients", requireNonService),
      )
      .handle(
        "getCheckinDmRecipients",
        authorizedSheetApis("userConfig", "getCheckinDmRecipients", requireService),
      )
      .handle(
        "getMonitorDmRecipients",
        authorizedSheetApis("userConfig", "getMonitorDmRecipients", requireService),
      )
      .handle(
        "getUserPlatformConfig",
        authorizedSheetApis("userConfig", "getUserPlatformConfig", requireService),
      )
      .handle(
        "upsertUserPlatformConfig",
        authorizedSheetApis("userConfig", "upsertUserPlatformConfig", requireService),
      ),
  status: (handlers) =>
    handlers.handle("getServices", (args) =>
      requireService().pipe(Effect.andThen(statusGetServices(args))),
    ),
  teamSubmission: (handlers) =>
    handlers
      .handle("upsertFromDiscord", serviceOnly("teamSubmission", "upsertFromDiscord"))
      .handle("setConfirmationMessage", serviceOnly("teamSubmission", "setConfirmationMessage"))
      .handle("revertFromDiscord", serviceOnly("teamSubmission", "revertFromDiscord"))
      .handle("confirmFromDiscord", serviceOnly("teamSubmission", "confirmFromDiscord")),
} satisfies Pick<
  IngressHandlerTable,
  "calc" | "checkin" | "discord" | "userConfig" | "status" | "teamSubmission"
>;
