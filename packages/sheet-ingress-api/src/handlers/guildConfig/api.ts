import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema, SchemaGetter } from "effect";
import { SchemaError, ArgumentError } from "typhoon-core/error";
import { QueryResultError, MutatorResultError } from "typhoon-zero/error";
import {
  FeatureFlagName,
  GuildChannelConfig,
  GuildConfig,
  GuildFeatureFlag,
  GuildConfigMonitorRole,
  GuildUpdateAnnouncementDelivery,
  GuildUpdateAnnouncementDeliveryClaimResult,
} from "../../schemas/guildConfig";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";

const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
  }),
);

export class GuildConfigApi extends HttpApiGroup.make("guildConfig")
  .add(
    HttpApiEndpoint.get("getAutoCheckinGuilds", "/guildConfig/getAutoCheckinGuilds", {
      success: Schema.Array(GuildConfig),
      error: [SchemaError, QueryResultError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getGuildConfig", "/guildConfig/getGuildConfig", {
      query: Schema.Struct({
        guildId: Schema.String,
      }),
      success: GuildConfig,
      error: [SchemaError, QueryResultError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.post("upsertGuildConfig", "/guildConfig/upsertGuildConfig", {
      payload: Schema.Struct({
        guildId: Schema.String,
        config: Schema.Struct({
          sheetId: Schema.optional(Schema.NullOr(Schema.String)),
          autoCheckin: Schema.optional(Schema.NullOr(Schema.Boolean)),
        }),
      }),
      success: GuildConfig,
      error: [SchemaError, QueryResultError, MutatorResultError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getGuildMonitorRoles", "/guildConfig/getGuildMonitorRoles", {
      query: Schema.Struct({
        guildId: Schema.String,
      }),
      success: Schema.Array(GuildConfigMonitorRole),
      error: [SchemaError, QueryResultError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getGuildFeatureFlags", "/guildConfig/getGuildFeatureFlags", {
      query: Schema.Struct({
        guildId: Schema.String,
      }),
      success: Schema.Array(GuildFeatureFlag),
      error: [SchemaError, QueryResultError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getGuildsForFeatureFlag", "/guildConfig/getGuildsForFeatureFlag", {
      query: Schema.Struct({
        flagName: FeatureFlagName,
      }),
      success: Schema.Array(GuildFeatureFlag),
      error: [SchemaError, QueryResultError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getGuildChannels", "/guildConfig/getGuildChannels", {
      query: Schema.Struct({
        guildId: Schema.String,
        running: Schema.optional(BooleanFromString),
      }),
      success: Schema.Array(GuildChannelConfig),
      error: [SchemaError, QueryResultError],
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "getGuildUpdateAnnouncementDelivery",
      "/guildConfig/getGuildUpdateAnnouncementDelivery",
      {
        query: Schema.Struct({
          guildId: Schema.String,
          announcementId: Schema.String,
        }),
        success: Schema.Option(GuildUpdateAnnouncementDelivery),
        error: [SchemaError, QueryResultError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("addGuildMonitorRole", "/guildConfig/addGuildMonitorRole", {
      payload: Schema.Struct({
        guildId: Schema.String,
        roleId: Schema.String,
      }),
      success: GuildConfigMonitorRole,
      error: [SchemaError, QueryResultError, MutatorResultError],
    }),
  )
  .add(
    HttpApiEndpoint.post("removeGuildMonitorRole", "/guildConfig/removeGuildMonitorRole", {
      payload: Schema.Struct({
        guildId: Schema.String,
        roleId: Schema.String,
      }),
      success: GuildConfigMonitorRole,
      error: [SchemaError, QueryResultError, MutatorResultError],
    }),
  )
  .add(
    HttpApiEndpoint.post("addGuildFeatureFlag", "/guildConfig/addGuildFeatureFlag", {
      payload: Schema.Struct({
        guildId: Schema.String,
        flagName: FeatureFlagName,
      }),
      success: GuildFeatureFlag,
      error: [SchemaError, QueryResultError, MutatorResultError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.post("removeGuildFeatureFlag", "/guildConfig/removeGuildFeatureFlag", {
      payload: Schema.Struct({
        guildId: Schema.String,
        flagName: FeatureFlagName,
      }),
      success: GuildFeatureFlag,
      error: [SchemaError, QueryResultError, MutatorResultError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "claimGuildUpdateAnnouncementDelivery",
      "/guildConfig/claimGuildUpdateAnnouncementDelivery",
      {
        payload: Schema.Struct({
          guildId: Schema.String,
          announcementId: Schema.String,
          publishedAt: Schema.DateTimeUtcFromMillis,
          claimToken: Schema.String,
        }),
        success: GuildUpdateAnnouncementDeliveryClaimResult,
        error: [SchemaError, QueryResultError, MutatorResultError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "releaseGuildUpdateAnnouncementDeliveryClaim",
      "/guildConfig/releaseGuildUpdateAnnouncementDeliveryClaim",
      {
        payload: Schema.Struct({
          guildId: Schema.String,
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
      "recordGuildUpdateAnnouncementDelivery",
      "/guildConfig/recordGuildUpdateAnnouncementDelivery",
      {
        payload: Schema.Struct({
          guildId: Schema.String,
          announcementId: Schema.String,
          publishedAt: Schema.DateTimeUtcFromMillis,
          deliveredAt: Schema.DateTimeUtcFromMillis,
          channelId: Schema.String,
          messageId: Schema.String,
        }),
        success: GuildUpdateAnnouncementDelivery,
        error: [SchemaError, QueryResultError, MutatorResultError],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("upsertGuildChannelConfig", "/guildConfig/upsertGuildChannelConfig", {
      payload: Schema.Struct({
        guildId: Schema.String,
        channelId: Schema.String,
        config: Schema.Struct({
          name: Schema.optional(Schema.NullOr(Schema.String)),
          running: Schema.optional(Schema.NullOr(Schema.Boolean)),
          roleId: Schema.optional(Schema.NullOr(Schema.String)),
          checkinChannelId: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      }),
      success: GuildChannelConfig,
      error: [SchemaError, QueryResultError, MutatorResultError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getGuildChannelById", "/guildConfig/getGuildChannelById", {
      query: Schema.Struct({
        guildId: Schema.String,
        channelId: Schema.String,
        running: Schema.optional(BooleanFromString),
      }),
      success: GuildChannelConfig,
      error: [SchemaError, QueryResultError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getGuildChannelByName", "/guildConfig/getGuildChannelByName", {
      query: Schema.Struct({
        guildId: Schema.String,
        channelName: Schema.String,
        running: Schema.optional(BooleanFromString),
      }),
      success: GuildChannelConfig,
      error: [SchemaError, QueryResultError, ArgumentError],
    }),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Guild Config")
  .annotate(OpenApi.Description, "Guild config endpoints") {}
