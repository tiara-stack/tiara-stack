import { Effect, Layer, Option } from "effect";
import { GuildConfigRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import {
  withCurrentGuildAuthFromPayload,
  withCurrentGuildAuthFromQuery,
} from "@/handlers/shared/guildAuthorization";
import { makeArgumentError } from "typhoon-core/error";
import { GuildConfigService } from "@/services";
import { AuthorizationService } from "@/services";

export const guildConfigLayer = GuildConfigRpcs.toLayer(
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const guildConfigService = yield* GuildConfigService;
    const withQueryGuildAuth = withCurrentGuildAuthFromQuery(authorizationService);
    const withPayloadGuildAuth = withCurrentGuildAuthFromPayload(authorizationService);

    return {
      "guildConfig.getAutoCheckinGuilds": Effect.fnUntraced(function* () {
        yield* authorizationService.requireService();
        return yield* guildConfigService.getAutoCheckinGuilds();
      }),
      "guildConfig.getGuildConfig": withQueryGuildAuth(
        Effect.fnUntraced(function* ({ query }) {
          yield* authorizationService.requireManageGuild(query.guildId);
          const config = yield* guildConfigService.getGuildConfig(query.guildId);

          if (Option.isNone(config)) {
            return yield* Effect.fail(
              makeArgumentError("Cannot get guild config, the guild might not be registered"),
            );
          }

          return config.value;
        }),
      ),
      "guildConfig.upsertGuildConfig": withPayloadGuildAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireManageGuild(payload.guildId);
          return yield* guildConfigService.upsertGuildConfig(payload.guildId, payload.config);
        }),
      ),
      "guildConfig.getGuildMonitorRoles": ({ query }) =>
        guildConfigService.getGuildMonitorRoles(query.guildId),
      "guildConfig.getGuildFeatureFlags": Effect.fnUntraced(function* ({ query }) {
        yield* authorizationService.requireService();
        return yield* guildConfigService.getGuildFeatureFlags(query.guildId);
      }),
      "guildConfig.getGuildsForFeatureFlag": Effect.fnUntraced(function* ({ query }) {
        yield* authorizationService.requireService();
        return yield* guildConfigService.getGuildsForFeatureFlag(query.flagName);
      }),
      "guildConfig.getGuildChannels": ({ query }) =>
        guildConfigService.getGuildChannels({
          guildId: query.guildId,
          ...(typeof query.running === "undefined" ? {} : { running: query.running }),
        }),
      "guildConfig.addGuildMonitorRole": withPayloadGuildAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireManageGuild(payload.guildId);
          return yield* guildConfigService.addGuildMonitorRole(payload.guildId, payload.roleId);
        }),
      ),
      "guildConfig.removeGuildMonitorRole": withPayloadGuildAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireManageGuild(payload.guildId);
          return yield* guildConfigService.removeGuildMonitorRole(payload.guildId, payload.roleId);
        }),
      ),
      "guildConfig.addGuildFeatureFlag": Effect.fnUntraced(function* ({ payload }) {
        yield* authorizationService.requireService();
        return yield* guildConfigService.addGuildFeatureFlag(payload.guildId, payload.flagName);
      }),
      "guildConfig.removeGuildFeatureFlag": Effect.fnUntraced(function* ({ payload }) {
        yield* authorizationService.requireService();
        return yield* guildConfigService.removeGuildFeatureFlag(payload.guildId, payload.flagName);
      }),
      "guildConfig.upsertGuildChannelConfig": withPayloadGuildAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireManageGuild(payload.guildId);
          return yield* guildConfigService.upsertGuildChannelConfig(
            payload.guildId,
            payload.channelId,
            payload.config,
          );
        }),
      ),
      "guildConfig.getGuildChannelById": Effect.fnUntraced(function* ({ query }) {
        const config = yield* guildConfigService.getGuildChannelById({
          guildId: query.guildId,
          channelId: query.channelId,
          running: query.running,
        });

        if (Option.isNone(config)) {
          return yield* Effect.fail(
            makeArgumentError(
              typeof query.running === "undefined"
                ? "Cannot get channel by id, the guild or the channel id might not be registered"
                : "Cannot get channel by id, the guild or the channel id might not be registered or does not match the specified running status",
            ),
          );
        }

        return config.value;
      }),
      "guildConfig.getGuildChannelByName": Effect.fnUntraced(function* ({ query }) {
        const config = yield* guildConfigService.getGuildChannelByName({
          guildId: query.guildId,
          channelName: query.channelName,
          running: query.running,
        });

        if (Option.isNone(config)) {
          return yield* Effect.fail(
            makeArgumentError(
              typeof query.running === "undefined"
                ? "Cannot get channel by name, the guild or the channel name might not be registered"
                : "Cannot get channel by name, the guild or the channel name might not be registered or does not match the specified running status",
            ),
          );
        }

        return config.value;
      }),
    };
  }),
).pipe(Layer.provide([AuthorizationService.layer, GuildConfigService.layer]));
