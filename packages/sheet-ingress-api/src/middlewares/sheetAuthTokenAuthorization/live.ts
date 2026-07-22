import { Effect, Layer, Option } from "effect";
import { Unauthorized } from "typhoon-core/error";
import { SheetAuthUser } from "../../schemas/middlewares/sheetAuthUser";
import { SheetAuthTokenAuthorization } from "./tag";

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
