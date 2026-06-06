import { Array, DateTime, Effect, Layer, Option, Context } from "effect";
import { makeArgumentError, makeDBQueryError } from "typhoon-core/error";
import { SheetZeroClient } from "./sheetZeroClient";

const updateAnnouncementDeliveryPendingChannelId = "__pending_update_announcement_delivery__";

const normalizeFeatureFlagName = (flagName: string) => {
  const normalized = flagName.trim();
  return normalized.length > 0
    ? Effect.succeed(normalized)
    : Effect.fail(makeArgumentError("Feature flag name cannot be empty"));
};

export class GuildConfigService extends Context.Service<GuildConfigService>()(
  "GuildConfigService",
  {
    make: Effect.gen(function* () {
      const zero = yield* SheetZeroClient;

      return {
        getAutoCheckinGuilds: Effect.fn("GuildConfigService.getAutoCheckinGuilds")(function* () {
          return yield* zero.guildConfig.getAutoCheckinGuilds({});
        }),
        getGuildConfig: Effect.fn("GuildConfigService.getGuildConfig")(function* (guildId: string) {
          return yield* zero.guildConfig.getGuildConfigByGuildId({ guildId });
        }),
        upsertGuildConfig: Effect.fn("GuildConfigService.upsertGuildConfig")(function* (
          guildId: string,
          config: {
            sheetId?: string | null | undefined;
            autoCheckin?: boolean | null | undefined;
          },
        ) {
          yield* zero.guildConfig.upsertGuildConfig({ guildId, ...config });
          const guildConfig = yield* zero.guildConfig.getGuildConfigByGuildId({ guildId });

          if (Option.isNone(guildConfig)) {
            return yield* Effect.die(makeDBQueryError("Failed to upsert guild config"));
          }

          return guildConfig.value;
        }),
        getGuildMonitorRoles: Effect.fn("GuildConfigService.getGuildMonitorRoles")(function* (
          guildId: string,
        ) {
          return yield* zero.guildConfig.getGuildMonitorRoles({ guildId });
        }),
        getGuildFeatureFlags: Effect.fn("GuildConfigService.getGuildFeatureFlags")(function* (
          guildId: string,
        ) {
          return yield* zero.guildConfig.getGuildFeatureFlags({ guildId });
        }),
        getGuildsForFeatureFlag: Effect.fn("GuildConfigService.getGuildsForFeatureFlag")(function* (
          flagName: string,
        ) {
          const normalizedFlagName = yield* normalizeFeatureFlagName(flagName);
          return yield* zero.guildConfig.getGuildsForFeatureFlag({
            flagName: normalizedFlagName,
          });
        }),
        getGuildFeatureFlag: Effect.fn("GuildConfigService.getGuildFeatureFlag")(function* (
          guildId: string,
          flagName: string,
        ) {
          const normalizedFlagName = yield* normalizeFeatureFlagName(flagName);
          return yield* zero.guildConfig.getGuildFeatureFlag({
            guildId,
            flagName: normalizedFlagName,
          });
        }),
        getGuildUpdateAnnouncementDelivery: Effect.fn(
          "GuildConfigService.getGuildUpdateAnnouncementDelivery",
        )(function* (guildId: string, announcementId: string) {
          return yield* zero.guildConfig.getGuildUpdateAnnouncementDelivery({
            guildId,
            announcementId,
          });
        }),
        getGuildChannels: Effect.fn("GuildConfigService.getGuildChannels")(function* (params: {
          guildId: string;
          running?: boolean | undefined;
        }) {
          return yield* zero.guildConfig.getGuildChannels({
            guildId: params.guildId,
            ...(typeof params.running === "undefined" ? {} : { running: params.running }),
          });
        }),
        addGuildMonitorRole: Effect.fn("GuildConfigService.addGuildMonitorRole")(function* (
          guildId: string,
          roleId: string,
        ) {
          yield* zero.guildConfig.addGuildMonitorRole({ guildId, roleId });
          const roles = yield* zero.guildConfig.getGuildMonitorRoles({ guildId });
          const role = Array.findFirst(roles, (item) => item.roleId === roleId);

          if (Option.isNone(role)) {
            return yield* Effect.die(makeDBQueryError("Failed to add guild monitor role"));
          }

          return role.value;
        }),
        removeGuildMonitorRole: Effect.fn("GuildConfigService.removeGuildMonitorRole")(function* (
          guildId: string,
          roleId: string,
        ) {
          yield* zero.guildConfig.removeGuildMonitorRole({ guildId, roleId });
          const roles = yield* zero.guildConfig.getGuildMonitorRoles({ guildId });
          const role = Array.findFirst(roles, (item) => item.roleId === roleId);

          if (Option.isNone(role)) {
            return yield* Effect.die(makeDBQueryError("Failed to remove guild monitor role"));
          }

          return role.value;
        }),
        addGuildFeatureFlag: Effect.fn("GuildConfigService.addGuildFeatureFlag")(function* (
          guildId: string,
          flagName: string,
        ) {
          const normalizedFlagName = yield* normalizeFeatureFlagName(flagName);
          yield* zero.guildConfig.addGuildFeatureFlag({ guildId, flagName: normalizedFlagName });
          const flag = yield* zero.guildConfig.getGuildFeatureFlag({
            guildId,
            flagName: normalizedFlagName,
          });

          if (Option.isNone(flag)) {
            return yield* Effect.die(makeDBQueryError("Failed to add guild feature flag"));
          }

          return flag.value;
        }),
        removeGuildFeatureFlag: Effect.fn("GuildConfigService.removeGuildFeatureFlag")(function* (
          guildId: string,
          flagName: string,
        ) {
          const normalizedFlagName = yield* normalizeFeatureFlagName(flagName);
          const flag = yield* zero.guildConfig.getGuildFeatureFlag({
            guildId,
            flagName: normalizedFlagName,
          });

          if (Option.isNone(flag)) {
            return yield* Effect.fail(
              makeArgumentError(
                `Feature flag "${flagName}" (normalized: "${normalizedFlagName}") is not enabled for guild ${guildId}`,
              ),
            );
          }

          yield* zero.guildConfig.removeGuildFeatureFlag({
            guildId,
            flagName: normalizedFlagName,
          });

          return flag.value;
        }),
        recordGuildUpdateAnnouncementDelivery: Effect.fn(
          "GuildConfigService.recordGuildUpdateAnnouncementDelivery",
        )(function* (delivery: {
          readonly guildId: string;
          readonly announcementId: string;
          readonly publishedAt: DateTime.Utc;
          readonly deliveredAt: DateTime.Utc;
          readonly channelId: string;
          readonly messageId: string;
        }) {
          yield* zero.guildConfig.recordGuildUpdateAnnouncementDelivery({
            ...delivery,
            publishedAt: DateTime.toEpochMillis(delivery.publishedAt),
            deliveredAt: DateTime.toEpochMillis(delivery.deliveredAt),
          });
          const recordedDelivery = yield* zero.guildConfig.getGuildUpdateAnnouncementDelivery({
            guildId: delivery.guildId,
            announcementId: delivery.announcementId,
          });

          if (Option.isNone(recordedDelivery)) {
            return yield* Effect.die(
              makeDBQueryError("Failed to record guild update announcement delivery"),
            );
          }

          return recordedDelivery.value;
        }),
        claimGuildUpdateAnnouncementDelivery: Effect.fn(
          "GuildConfigService.claimGuildUpdateAnnouncementDelivery",
        )(function* (claim: {
          readonly guildId: string;
          readonly announcementId: string;
          readonly publishedAt: DateTime.Utc;
          readonly claimToken: string;
        }) {
          yield* zero.guildConfig.claimGuildUpdateAnnouncementDelivery({
            ...claim,
            publishedAt: DateTime.toEpochMillis(claim.publishedAt),
          });

          const delivery = yield* zero.guildConfig.getGuildUpdateAnnouncementDelivery({
            guildId: claim.guildId,
            announcementId: claim.announcementId,
          });

          if (Option.isNone(delivery)) {
            return yield* Effect.die(
              makeDBQueryError("Failed to claim guild update announcement delivery"),
            );
          }

          if (delivery.value.channelId === updateAnnouncementDeliveryPendingChannelId) {
            return {
              status: delivery.value.messageId === claim.claimToken ? "claimed" : "already_claimed",
              delivery,
            } as const;
          }

          return {
            status: "already_delivered",
            delivery,
          } as const;
        }),
        releaseGuildUpdateAnnouncementDeliveryClaim: Effect.fn(
          "GuildConfigService.releaseGuildUpdateAnnouncementDeliveryClaim",
        )(function* (claim: {
          readonly guildId: string;
          readonly announcementId: string;
          readonly claimToken: string;
        }) {
          return yield* zero.guildConfig.releaseGuildUpdateAnnouncementDeliveryClaim(claim);
        }),
        upsertGuildChannelConfig: Effect.fn("GuildConfigService.upsertGuildChannelConfig")(
          function* (
            guildId: string,
            channelId: string,
            config: {
              name?: string | null | undefined;
              running?: boolean | null | undefined;
              roleId?: string | null | undefined;
              checkinChannelId?: string | null | undefined;
            },
          ) {
            yield* zero.guildConfig.upsertGuildChannelConfig({
              guildId,
              channelId,
              name: config.name,
              running: config.running,
              roleId: config.roleId,
              checkinChannelId: config.checkinChannelId,
            });
            const channel = yield* zero.guildConfig.getGuildChannelById({ guildId, channelId });

            if (Option.isNone(channel)) {
              return yield* Effect.die(makeDBQueryError("Failed to upsert guild channel config"));
            }

            return channel.value;
          },
        ),
        getGuildChannelById: Effect.fn("GuildConfigService.getGuildChannelById")(
          function* (params: {
            guildId: string;
            channelId: string;
            running?: boolean | undefined;
          }) {
            return yield* zero.guildConfig.getGuildChannelById({
              guildId: params.guildId,
              channelId: params.channelId,
              ...(typeof params.running === "undefined" ? {} : { running: params.running }),
            });
          },
        ),
        getGuildChannelByName: Effect.fn("GuildConfigService.getGuildChannelByName")(
          function* (params: {
            guildId: string;
            channelName: string;
            running?: boolean | undefined;
          }) {
            return yield* zero.guildConfig.getGuildChannelByName({
              guildId: params.guildId,
              channelName: params.channelName,
              ...(typeof params.running === "undefined" ? {} : { running: params.running }),
            });
          },
        ),
      };
    }),
  },
) {
  static layer = Layer.effect(GuildConfigService, this.make).pipe(
    Layer.provide(SheetZeroClient.layer),
  );
}
