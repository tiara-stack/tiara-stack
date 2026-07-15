import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema, SchemaGetter } from "effect";
import { SchemaError, ArgumentError } from "typhoon-core/error";
import { QueryResultError, MutatorResultError } from "typhoon-zero/error";
import {
  FeatureFlagName,
  WorkspaceConversationConfig,
  WorkspaceConfig,
  WorkspaceFeatureFlag,
  WorkspaceMonitorRole,
  WorkspaceTeamSubmissionChannel,
  WorkspaceUpdateAnnouncementDelivery,
  WorkspaceUpdateAnnouncementDeliveryClaimResult,
  TeamSubmissionRemovedRowStrategy,
  TeamSubmissionWriteMode,
} from "../../schemas/workspaceConfig";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";

const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
  }),
);

export class WorkspaceConfigApi extends HttpApiGroup.make("workspaceConfig")
  .add(
    HttpApiEndpoint.get("getAutoCheckinWorkspaces", "/workspaceConfig/getAutoCheckinWorkspaces", {
      success: Schema.Array(WorkspaceConfig),
      error: [SchemaError, QueryResultError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getWorkspaceConfig", "/workspaceConfig/getWorkspaceConfig", {
      query: Schema.Struct({
        workspaceId: Schema.String,
      }),
      success: WorkspaceConfig,
      error: [SchemaError, QueryResultError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.post("upsertWorkspaceConfig", "/workspaceConfig/upsertWorkspaceConfig", {
      payload: Schema.Struct({
        workspaceId: Schema.String,
        config: Schema.Struct({
          sheetId: Schema.optional(Schema.NullOr(Schema.String)),
          autoCheckin: Schema.optional(Schema.NullOr(Schema.Boolean)),
        }),
      }),
      success: WorkspaceConfig,
      error: [SchemaError, QueryResultError, MutatorResultError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getWorkspaceMonitorRoles", "/workspaceConfig/getWorkspaceMonitorRoles", {
      query: Schema.Struct({
        workspaceId: Schema.String,
      }),
      success: Schema.Array(WorkspaceMonitorRole),
      error: [SchemaError, QueryResultError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getWorkspaceFeatureFlags", "/workspaceConfig/getWorkspaceFeatureFlags", {
      query: Schema.Struct({
        workspaceId: Schema.String,
      }),
      success: Schema.Array(WorkspaceFeatureFlag),
      error: [SchemaError, QueryResultError],
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "getWorkspacesForFeatureFlag",
      "/workspaceConfig/getWorkspacesForFeatureFlag",
      {
        query: Schema.Struct({
          flagName: FeatureFlagName,
        }),
        success: Schema.Array(WorkspaceFeatureFlag),
        error: [SchemaError, QueryResultError, ArgumentError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.get("getWorkspaceConversations", "/workspaceConfig/getWorkspaceConversations", {
      query: Schema.Struct({
        workspaceId: Schema.String,
        running: Schema.optional(BooleanFromString),
      }),
      success: Schema.Array(WorkspaceConversationConfig),
      error: [SchemaError, QueryResultError],
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "getTeamSubmissionChannelByConversationId",
      "/workspaceConfig/getTeamSubmissionChannelByConversationId",
      {
        query: Schema.Struct({
          workspaceId: Schema.String,
          conversationId: Schema.String,
        }),
        success: WorkspaceTeamSubmissionChannel,
        error: [SchemaError, QueryResultError, ArgumentError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.get(
      "getTeamSubmissionChannelsForWorkspace",
      "/workspaceConfig/getTeamSubmissionChannelsForWorkspace",
      {
        query: Schema.Struct({
          workspaceId: Schema.String,
        }),
        success: Schema.Array(WorkspaceTeamSubmissionChannel),
        error: [SchemaError, QueryResultError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.get(
      "getWorkspaceUpdateAnnouncementDelivery",
      "/workspaceConfig/getWorkspaceUpdateAnnouncementDelivery",
      {
        query: Schema.Struct({
          workspaceId: Schema.String,
          announcementId: Schema.String,
        }),
        success: Schema.Option(WorkspaceUpdateAnnouncementDelivery),
        error: [SchemaError, QueryResultError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("addWorkspaceMonitorRole", "/workspaceConfig/addWorkspaceMonitorRole", {
      payload: Schema.Struct({
        workspaceId: Schema.String,
        roleId: Schema.String,
      }),
      success: WorkspaceMonitorRole,
      error: [SchemaError, QueryResultError, MutatorResultError],
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "removeWorkspaceMonitorRole",
      "/workspaceConfig/removeWorkspaceMonitorRole",
      {
        payload: Schema.Struct({
          workspaceId: Schema.String,
          roleId: Schema.String,
        }),
        success: WorkspaceMonitorRole,
        error: [SchemaError, QueryResultError, MutatorResultError, ArgumentError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("addWorkspaceFeatureFlag", "/workspaceConfig/addWorkspaceFeatureFlag", {
      payload: Schema.Struct({
        workspaceId: Schema.String,
        flagName: FeatureFlagName,
      }),
      success: WorkspaceFeatureFlag,
      error: [SchemaError, QueryResultError, MutatorResultError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "removeWorkspaceFeatureFlag",
      "/workspaceConfig/removeWorkspaceFeatureFlag",
      {
        payload: Schema.Struct({
          workspaceId: Schema.String,
          flagName: FeatureFlagName,
        }),
        success: WorkspaceFeatureFlag,
        error: [SchemaError, QueryResultError, MutatorResultError, ArgumentError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "claimWorkspaceUpdateAnnouncementDelivery",
      "/workspaceConfig/claimWorkspaceUpdateAnnouncementDelivery",
      {
        payload: Schema.Struct({
          workspaceId: Schema.String,
          announcementId: Schema.String,
          publishedAt: Schema.DateTimeUtcFromMillis,
          claimToken: Schema.String,
        }),
        success: WorkspaceUpdateAnnouncementDeliveryClaimResult,
        error: [SchemaError, QueryResultError, MutatorResultError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "releaseWorkspaceUpdateAnnouncementDeliveryClaim",
      "/workspaceConfig/releaseWorkspaceUpdateAnnouncementDeliveryClaim",
      {
        payload: Schema.Struct({
          workspaceId: Schema.String,
          announcementId: Schema.String,
          claimToken: Schema.String,
        }),
        success: Schema.Void,
        error: [SchemaError, MutatorResultError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "recordWorkspaceUpdateAnnouncementDelivery",
      "/workspaceConfig/recordWorkspaceUpdateAnnouncementDelivery",
      {
        payload: Schema.Struct({
          workspaceId: Schema.String,
          announcementId: Schema.String,
          publishedAt: Schema.DateTimeUtcFromMillis,
          deliveredAt: Schema.DateTimeUtcFromMillis,
          conversationId: Schema.String,
          messageId: Schema.String,
          claimToken: Schema.String,
        }),
        success: WorkspaceUpdateAnnouncementDelivery,
        error: [SchemaError, QueryResultError, MutatorResultError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "upsertWorkspaceConversationConfig",
      "/workspaceConfig/upsertWorkspaceConversationConfig",
      {
        payload: Schema.Struct({
          workspaceId: Schema.String,
          conversationId: Schema.String,
          config: Schema.Struct({
            name: Schema.optional(Schema.NullOr(Schema.String)),
            running: Schema.optional(Schema.NullOr(Schema.Boolean)),
            roleId: Schema.optional(Schema.NullOr(Schema.String)),
            checkinConversationId: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        }),
        success: WorkspaceConversationConfig,
        error: [SchemaError, QueryResultError, MutatorResultError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "upsertTeamSubmissionChannel",
      "/workspaceConfig/upsertTeamSubmissionChannel",
      {
        payload: Schema.Struct({
          workspaceId: Schema.String,
          conversationId: Schema.String,
          config: Schema.Struct({
            destinationTeamConfigName: Schema.optional(Schema.NullOr(Schema.String)),
            writeMode: Schema.optional(TeamSubmissionWriteMode),
            removedRowStrategy: Schema.optional(TeamSubmissionRemovedRowStrategy),
            requireValidOshi: Schema.optional(Schema.Boolean),
          }),
        }),
        success: WorkspaceTeamSubmissionChannel,
        error: [SchemaError, QueryResultError, MutatorResultError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "removeTeamSubmissionChannel",
      "/workspaceConfig/removeTeamSubmissionChannel",
      {
        payload: Schema.Struct({
          workspaceId: Schema.String,
          conversationId: Schema.String,
        }),
        success: WorkspaceTeamSubmissionChannel,
        error: [SchemaError, QueryResultError, MutatorResultError, ArgumentError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.get(
      "getWorkspaceConversationById",
      "/workspaceConfig/getWorkspaceConversationById",
      {
        query: Schema.Struct({
          workspaceId: Schema.String,
          conversationId: Schema.String,
          running: Schema.optional(BooleanFromString),
        }),
        success: WorkspaceConversationConfig,
        error: [SchemaError, QueryResultError, ArgumentError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.get(
      "getWorkspaceConversationByName",
      "/workspaceConfig/getWorkspaceConversationByName",
      {
        query: Schema.Struct({
          workspaceId: Schema.String,
          conversationName: Schema.String,
          running: Schema.optional(BooleanFromString),
        }),
        success: WorkspaceConversationConfig,
        error: [SchemaError, QueryResultError, ArgumentError],
      },
    ),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Workspace Config")
  .annotate(OpenApi.Description, "Workspace config endpoints") {}
