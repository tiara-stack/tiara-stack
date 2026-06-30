// fallow-ignore-file code-duplication
import { Effect, Layer, Option } from "effect";
import { SheetAuthTokenAuthorization } from "sheet-ingress-api/middlewares/sheetAuthTokenAuthorization/tag";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { Unauthorized } from "typhoon-core/error";

export const SheetAuthTokenAuthorizationLive = Layer.succeed(
  SheetAuthTokenAuthorization,
  SheetAuthTokenAuthorization.of({
    sheetAuthToken: Effect.fn("SheetAuthTokenAuthorization.sheetAuthToken")(
      function* (httpEffect, _options) {
        const existingUser = yield* Effect.serviceOption(SheetAuthUser);
        if (Option.isSome(existingUser)) {
          return yield* httpEffect.pipe(Effect.provideService(SheetAuthUser, existingUser.value));
        }

        return yield* Effect.fail(new Unauthorized({ message: "SheetAuthUser unavailable" }));
      },
    ),
  }),
);
