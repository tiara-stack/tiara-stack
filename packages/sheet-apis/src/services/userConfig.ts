import { Context, Effect, Layer, Option } from "effect";
import { makeArgumentError, makeDBQueryError } from "typhoon-core/error";
import { IngressBotClient } from "./ingressBotClient";
import { SheetZeroClient } from "./sheetZeroClient";

const supportedPlatforms = new Set(["discord"]);

const requireSupportedPlatform = (platform: string) =>
  supportedPlatforms.has(platform)
    ? Effect.void
    : Effect.fail(makeArgumentError(`Unsupported notification platform: ${platform}`));

export class UserConfigService extends Context.Service<UserConfigService>()("UserConfigService", {
  make: Effect.gen(function* () {
    const zero = yield* SheetZeroClient;
    const ingressBotClient = yield* IngressBotClient;

    const listSupportedNotificationClients = Effect.fn(
      "UserConfigService.listSupportedNotificationClients",
    )(function* () {
      const clients = yield* ingressBotClient.listClients();
      return clients.filter((client) => supportedPlatforms.has(client.platform));
    });

    const requireSupportedClient = Effect.fn("UserConfigService.requireSupportedClient")(function* (
      platform: string,
      clientId: string,
    ) {
      yield* requireSupportedPlatform(platform);
      const clients = yield* listSupportedNotificationClients();
      const supported = clients.some(
        (client) => client.platform === platform && client.clientId === clientId,
      );
      if (!supported) {
        return yield* Effect.fail(
          makeArgumentError(`Unsupported notification client: ${platform}:${clientId}`),
        );
      }
    });

    const getUserPlatformConfig = Effect.fn("UserConfigService.getUserPlatformConfig")(function* (
      platform: string,
      userId: string,
    ) {
      yield* requireSupportedPlatform(platform);
      return yield* zero.userConfig.getUserPlatformConfig({
        platform,
        userId,
      });
    });

    const upsertUserPlatformConfig = Effect.fn("UserConfigService.upsertUserPlatformConfig")(
      function* (
        platform: string,
        userId: string,
        config: {
          readonly checkinDmEnabled: boolean;
          readonly defaultClientId?: string | null | undefined;
        },
      ) {
        yield* requireSupportedPlatform(platform);
        if (config.checkinDmEnabled && !config.defaultClientId) {
          return yield* Effect.fail(
            makeArgumentError("A default notification client is required to enable check-in DMs"),
          );
        }
        if (config.defaultClientId) {
          yield* requireSupportedClient(platform, config.defaultClientId);
        }

        yield* zero.userConfig.upsertUserPlatformConfig({
          platform,
          userId,
          checkinDmEnabled: config.checkinDmEnabled,
          defaultClientId: config.defaultClientId,
        });

        const updated = yield* zero.userConfig.getUserPlatformConfig({
          platform,
          userId,
        });

        if (Option.isNone(updated)) {
          return yield* Effect.die(makeDBQueryError("Failed to upsert user platform config"));
        }

        return updated.value;
      },
    );

    return {
      listSupportedNotificationClients,
      getUserPlatformConfig,
      upsertUserPlatformConfig,
      getCurrentUserPlatformConfig: Effect.fn("UserConfigService.getCurrentUserPlatformConfig")(
        function* (platform: string, accountId: string) {
          return yield* getUserPlatformConfig(platform, accountId);
        },
      ),
      upsertCurrentUserPlatformConfig: Effect.fn(
        "UserConfigService.upsertCurrentUserPlatformConfig",
      )(function* (
        platform: string,
        accountId: string,
        config: {
          readonly checkinDmEnabled: boolean;
          readonly defaultClientId?: string | null | undefined;
        },
      ) {
        return yield* upsertUserPlatformConfig(platform, accountId, config);
      }),
      getCheckinDmRecipients: Effect.fn("UserConfigService.getCheckinDmRecipients")(function* (
        platform: string,
        userIds: ReadonlyArray<string>,
      ) {
        yield* requireSupportedPlatform(platform);
        const requestedUserIds = [...new Set(userIds)];
        if (requestedUserIds.length === 0) {
          return [];
        }
        const configs = yield* zero.userConfig.getCheckinDmEnabledUserConfigs({
          platform,
          userIds: requestedUserIds,
        });
        return configs.flatMap((config) =>
          Option.isSome(config.defaultClientId)
            ? [
                {
                  platform: config.platform,
                  userId: config.userId,
                  defaultClientId: config.defaultClientId.value,
                },
              ]
            : [],
        );
      }),
    };
  }),
}) {
  static layer = Layer.effect(UserConfigService, this.make).pipe(
    Layer.provide([IngressBotClient.layer, SheetZeroClient.layer]),
  );
}
