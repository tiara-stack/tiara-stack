import { guildPayload, guildQuery, serviceOnly } from "../authorization";
import type { IngressHandlerTable } from "../types";

export const workspaceHandlers = {
  workspaceConfig: (handlers) =>
    handlers
      .handle(
        "getAutoCheckinWorkspaces",
        serviceOnly("workspaceConfig", "getAutoCheckinWorkspaces"),
      )
      .handle(
        "getWorkspaceConfig",
        guildQuery("workspaceConfig", "getWorkspaceConfig", "manage", (query) => query.workspaceId),
      )
      .handle(
        "upsertWorkspaceConfig",
        guildPayload(
          "workspaceConfig",
          "upsertWorkspaceConfig",
          "manage",
          (payload) => payload.workspaceId,
        ),
      )
      .handle(
        "getWorkspaceMonitorRoles",
        guildQuery(
          "workspaceConfig",
          "getWorkspaceMonitorRoles",
          "member",
          (query) => query.workspaceId,
        ),
      )
      .handle(
        "getWorkspaceFeatureFlags",
        serviceOnly("workspaceConfig", "getWorkspaceFeatureFlags"),
      )
      .handle(
        "getWorkspacesForFeatureFlag",
        serviceOnly("workspaceConfig", "getWorkspacesForFeatureFlag"),
      )
      .handle(
        "getWorkspaceUpdateAnnouncementDelivery",
        serviceOnly("workspaceConfig", "getWorkspaceUpdateAnnouncementDelivery"),
      )
      .handle(
        "getWorkspaceConversations",
        guildQuery(
          "workspaceConfig",
          "getWorkspaceConversations",
          "member",
          (query) => query.workspaceId,
        ),
      )
      .handle(
        "getTeamSubmissionChannelByConversationId",
        serviceOnly("workspaceConfig", "getTeamSubmissionChannelByConversationId"),
      )
      .handle(
        "getTeamSubmissionChannelsForWorkspace",
        guildQuery(
          "workspaceConfig",
          "getTeamSubmissionChannelsForWorkspace",
          "manage",
          (query) => query.workspaceId,
        ),
      )
      .handle(
        "addWorkspaceMonitorRole",
        guildPayload(
          "workspaceConfig",
          "addWorkspaceMonitorRole",
          "manage",
          (payload) => payload.workspaceId,
        ),
      )
      .handle(
        "removeWorkspaceMonitorRole",
        guildPayload(
          "workspaceConfig",
          "removeWorkspaceMonitorRole",
          "manage",
          (payload) => payload.workspaceId,
        ),
      )
      .handle("addWorkspaceFeatureFlag", serviceOnly("workspaceConfig", "addWorkspaceFeatureFlag"))
      .handle(
        "removeWorkspaceFeatureFlag",
        serviceOnly("workspaceConfig", "removeWorkspaceFeatureFlag"),
      )
      .handle(
        "recordWorkspaceUpdateAnnouncementDelivery",
        serviceOnly("workspaceConfig", "recordWorkspaceUpdateAnnouncementDelivery"),
      )
      .handle(
        "claimWorkspaceUpdateAnnouncementDelivery",
        serviceOnly("workspaceConfig", "claimWorkspaceUpdateAnnouncementDelivery"),
      )
      .handle(
        "releaseWorkspaceUpdateAnnouncementDeliveryClaim",
        serviceOnly("workspaceConfig", "releaseWorkspaceUpdateAnnouncementDeliveryClaim"),
      )
      .handle(
        "upsertWorkspaceConversationConfig",
        guildPayload(
          "workspaceConfig",
          "upsertWorkspaceConversationConfig",
          "manage",
          (payload) => payload.workspaceId,
        ),
      )
      .handle(
        "upsertTeamSubmissionChannel",
        guildPayload(
          "workspaceConfig",
          "upsertTeamSubmissionChannel",
          "manage",
          (payload) => payload.workspaceId,
        ),
      )
      .handle(
        "removeTeamSubmissionChannel",
        guildPayload(
          "workspaceConfig",
          "removeTeamSubmissionChannel",
          "manage",
          (payload) => payload.workspaceId,
        ),
      )
      .handle(
        "getWorkspaceConversationById",
        guildQuery(
          "workspaceConfig",
          "getWorkspaceConversationById",
          "member",
          (query) => query.workspaceId,
        ),
      )
      .handle(
        "getWorkspaceConversationByName",
        guildQuery(
          "workspaceConfig",
          "getWorkspaceConversationByName",
          "member",
          (query) => query.workspaceId,
        ),
      ),
} satisfies Pick<IngressHandlerTable, "workspaceConfig">;
