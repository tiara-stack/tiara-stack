import { Effect, Layer, Option } from "effect";
import { SheetApisAnonymousUserFallback } from "sheet-ingress-api/internal";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";

export const SheetApisAnonymousUserFallbackLive = Layer.succeed(
  SheetApisAnonymousUserFallback,
  SheetApisAnonymousUserFallback.of(
    Effect.fn("SheetApisAnonymousUserFallback")(function* (httpEffect) {
      const existingUser = yield* Effect.serviceOption(SheetAuthUser);
      return yield* Option.match(existingUser, {
        onSome: (user) => httpEffect.pipe(Effect.provideService(SheetAuthUser, user)),
        onNone: () => httpEffect,
      });
    }),
  ),
);
