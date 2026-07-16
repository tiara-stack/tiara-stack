import { Cache, Context, Duration, Effect, Exit, Layer, Option, Redacted } from "effect";
import {
  SheetApisAnonymousUserFallback,
  SheetApisServiceUserFallback,
  SheetBotServiceAuthorization,
} from "sheet-ingress-api/internal";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { Unauthorized } from "typhoon-core/error";
import { hasPermission } from "../services/authorization";
import { SheetAuthUserResolver } from "../services/authResolver";
import { SheetApisRpcTokens } from "../services/sheetApisRpcTokens";

const getCurrentSheetAuthUser = Effect.context<never>().pipe(
  Effect.map((context) =>
    Context.getOption(context as Context.Context<SheetAuthUser>, SheetAuthUser),
  ),
);

export const SheetBotServiceAuthorizationLive = Layer.effect(
  SheetBotServiceAuthorization,
  Effect.gen(function* () {
    const sheetAuthUserResolver = yield* SheetAuthUserResolver;
    const serviceUserCache = yield* Cache.makeWith(
      (token: string) =>
        sheetAuthUserResolver.resolveToken(Redacted.make(token)).pipe(
          Effect.filterOrFail(
            ({ permissions }) => hasPermission(permissions, "service"),
            () => new Unauthorized({ message: "Unauthorized" }),
          ),
          Effect.tapError((error) =>
            Effect.logWarning("Failed to authorize service token for bot proxy route", error),
          ),
        ),
      {
        capacity: 10_000,
        timeToLive: Exit.match({
          onFailure: () => Duration.seconds(1),
          onSuccess: () => Duration.seconds(30),
        }),
      },
    );

    return SheetBotServiceAuthorization.of({
      sheetBotServiceToken: Effect.fn("SheetBotServiceAuthorization.sheetBotServiceToken")(
        function* (httpEffect, { credential }) {
          const serviceUser = yield* Cache.get(serviceUserCache, Redacted.value(credential)).pipe(
            Effect.mapError(() => new Unauthorized({ message: "Unauthorized" })),
          );
          return yield* httpEffect.pipe(Effect.provideService(SheetAuthUser, serviceUser));
        },
      ),
    });
  }),
);

export const SheetApisServiceUserFallbackLive = Layer.effect(
  SheetApisServiceUserFallback,
  Effect.gen(function* () {
    const tokens = yield* SheetApisRpcTokens;

    return SheetApisServiceUserFallback.of(
      Effect.fn("SheetApisServiceUserFallback")(function* (httpEffect) {
        const maybeUser = yield* getCurrentSheetAuthUser;
        if (Option.isSome(maybeUser)) {
          return yield* httpEffect.pipe(Effect.provideService(SheetAuthUser, maybeUser.value));
        }

        const serviceUser = yield* tokens
          .getServiceUser()
          .pipe(
            Effect.mapError(
              (cause) =>
                new Unauthorized({ message: "Failed to create service-user auth session", cause }),
            ),
          );
        return yield* httpEffect.pipe(Effect.provideService(SheetAuthUser, serviceUser));
      }),
    );
  }),
);

export const SheetApisAnonymousUserFallbackLive = Layer.succeed(
  SheetApisAnonymousUserFallback,
  SheetApisAnonymousUserFallback.of(
    Effect.fn("SheetApisAnonymousUserFallback")(function* (httpEffect) {
      const maybeUser = yield* getCurrentSheetAuthUser;
      if (Option.isSome(maybeUser)) {
        return yield* httpEffect.pipe(Effect.provideService(SheetAuthUser, maybeUser.value));
      }

      return yield* httpEffect;
    }),
  ),
);
