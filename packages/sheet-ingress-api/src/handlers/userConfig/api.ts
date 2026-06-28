import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { SchemaError, ArgumentError } from "typhoon-core/error";
import { QueryResultError, MutatorResultError } from "typhoon-zero/error";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";
import { ClientPlatform } from "../../schemas/client";
import {
  CheckinDmRecipient,
  MonitorDmRecipient,
  SupportedNotificationClient,
  UserPlatformConfig,
} from "../../schemas/userConfig";

export class UserConfigApi extends HttpApiGroup.make("userConfig")
  .add(
    HttpApiEndpoint.get("getCurrentUserPlatformConfig", "/userConfig/current/platform/:platform", {
      params: Schema.Struct({
        platform: ClientPlatform,
      }),
      success: Schema.Option(UserPlatformConfig),
      error: [SchemaError, QueryResultError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.post("upsertCurrentUserPlatformConfig", "/userConfig/current/platform", {
      payload: Schema.Struct({
        platform: ClientPlatform,
        checkinDmEnabled: Schema.Boolean,
        monitorDmEnabled: Schema.Boolean,
        defaultClientId: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      success: UserPlatformConfig,
      error: [SchemaError, QueryResultError, MutatorResultError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listSupportedNotificationClients", "/userConfig/notificationClients", {
      success: Schema.Array(SupportedNotificationClient),
      error: [SchemaError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.post("getCheckinDmRecipients", "/userConfig/checkinDmRecipients", {
      payload: Schema.Struct({
        platform: ClientPlatform,
        userIds: Schema.Array(Schema.String),
      }),
      success: Schema.Array(CheckinDmRecipient),
      error: [SchemaError, QueryResultError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.post("getMonitorDmRecipients", "/userConfig/monitorDmRecipients", {
      payload: Schema.Struct({
        platform: ClientPlatform,
        userIds: Schema.Array(Schema.String),
      }),
      success: Schema.Array(MonitorDmRecipient),
      error: [SchemaError, QueryResultError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.post("getUserPlatformConfig", "/userConfig/platform/get", {
      payload: Schema.Struct({
        platform: ClientPlatform,
        userId: Schema.String,
      }),
      success: Schema.Option(UserPlatformConfig),
      error: [SchemaError, QueryResultError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.post("upsertUserPlatformConfig", "/userConfig/platform/upsert", {
      payload: Schema.Struct({
        platform: ClientPlatform,
        userId: Schema.String,
        checkinDmEnabled: Schema.Boolean,
        monitorDmEnabled: Schema.Boolean,
        defaultClientId: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      success: UserPlatformConfig,
      error: [SchemaError, QueryResultError, MutatorResultError, ArgumentError],
    }),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "User Config")
  .annotate(OpenApi.Description, "Current user notification preference endpoints") {}
