import { Effect, Layer, Option } from "effect";
import { SheetApisServiceUserFallback } from "sheet-ingress-api/middlewares/sheetApisServiceUserFallback/tag";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { Unauthorized } from "typhoon-core/error";

export const SheetApisServiceUserFallbackLive = Layer.succeed(
  SheetApisServiceUserFallback,
  SheetApisServiceUserFallback.of(
    Effect.fn("SheetApisServiceUserFallback")(function* (httpEffect) {
      const existingUser = yield* Effect.serviceOption(SheetAuthUser);
      if (Option.isSome(existingUser)) {
        return yield* httpEffect.pipe(Effect.provideService(SheetAuthUser, existingUser.value));
      }

      return yield* Effect.fail(new Unauthorized({ message: "SheetAuthUser unavailable" }));
    }),
  ),
);
