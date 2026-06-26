import { Context, Effect, Layer, Option } from "effect";
import { UserConfigRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { AuthorizationService, UserConfigService } from "@/services";

type SheetAuthUserType = Context.Service.Shape<typeof SheetAuthUser>;

export const userConfigLayer = UserConfigRpcs.toLayer(
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const userConfigService = yield* UserConfigService;
    const getAuthUser: Effect.Effect<SheetAuthUserType, never, never> = Effect.gen(function* () {
      const user = yield* Effect.serviceOption(SheetAuthUser);
      return yield* Option.match(user, {
        onNone: () => Effect.die("SheetAuthUser missing from user config request context"),
        onSome: (user) => Effect.succeed(user),
      });
    });

    return {
      "userConfig.getCurrentUserPlatformConfig": Effect.fnUntraced(function* ({ query }) {
        const user = yield* getAuthUser;
        return yield* userConfigService.getCurrentUserPlatformConfig(
          query.platform,
          user.accountId,
        );
      }),
      "userConfig.upsertCurrentUserPlatformConfig": Effect.fnUntraced(function* ({ payload }) {
        const user = yield* getAuthUser;
        return yield* userConfigService.upsertCurrentUserPlatformConfig(
          payload.platform,
          user.accountId,
          {
            checkinDmEnabled: payload.checkinDmEnabled,
            defaultClientId: payload.defaultClientId,
          },
        );
      }),
      "userConfig.listSupportedNotificationClients": Effect.fnUntraced(function* () {
        return yield* userConfigService.listSupportedNotificationClients();
      }),
      "userConfig.getCheckinDmRecipients": Effect.fnUntraced(function* ({ payload }) {
        yield* authorizationService.requireService();
        return yield* userConfigService.getCheckinDmRecipients(payload.platform, payload.userIds);
      }),
      "userConfig.getUserPlatformConfig": Effect.fnUntraced(function* ({ payload }) {
        yield* authorizationService.requireService();
        return yield* userConfigService.getUserPlatformConfig(payload.platform, payload.userId);
      }),
      "userConfig.upsertUserPlatformConfig": Effect.fnUntraced(function* ({ payload }) {
        yield* authorizationService.requireService();
        return yield* userConfigService.upsertUserPlatformConfig(payload.platform, payload.userId, {
          checkinDmEnabled: payload.checkinDmEnabled,
          defaultClientId: payload.defaultClientId,
        });
      }),
    } as any;
  }),
).pipe(Layer.provide([AuthorizationService.layer, UserConfigService.layer]));
