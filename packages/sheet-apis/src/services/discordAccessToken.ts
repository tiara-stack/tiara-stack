import { Cache, Context, Duration, Effect, Exit, Layer, Redacted } from "effect";
import { getDiscordAccessToken, getDiscordAccessTokenWithOAuth } from "sheet-auth/client";
import { SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE } from "sheet-ingress-api/internal";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { makeArgumentError } from "typhoon-core/error";
import { SheetAuthClient } from "./sheetAuthClient";

export { SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE };

const isUnavailableSessionToken = (token: Redacted.Redacted<string>) =>
  Redacted.value(token) === SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE;

export class DiscordAccessTokenService extends Context.Service<DiscordAccessTokenService>()(
  "DiscordAccessTokenService",
  {
    make: Effect.gen(function* () {
      const sheetAuthClient = yield* SheetAuthClient;
      const accessTokenCache = yield* Cache.makeWith(
        (token: Redacted.Redacted<string>) =>
          getDiscordAccessTokenWithOAuth(sheetAuthClient, {
            Authorization: `Bearer ${Redacted.value(token)}`,
          }).pipe(
            Effect.catch(() =>
              getDiscordAccessToken(sheetAuthClient, {
                Authorization: `Bearer ${Redacted.value(token)}`,
              }),
            ),
            Effect.map(({ accessToken }) => accessToken),
            Effect.mapError((error) =>
              makeArgumentError("Failed to get Discord access token", error),
            ),
          ),
        {
          capacity: 10_000,
          timeToLive: Exit.match({
            onFailure: () => Duration.seconds(30),
            onSuccess: () => Duration.minutes(5),
          }),
        },
      );

      return {
        getCurrentUserDiscordAccessToken: Effect.fn(
          "DiscordAccessTokenService.getCurrentUserDiscordAccessToken",
        )(function* () {
          const user = yield* SheetAuthUser;

          if (isUnavailableSessionToken(user.token)) {
            return yield* Effect.fail(makeArgumentError("Missing sheet-auth session token"));
          }

          return yield* Cache.get(accessTokenCache, user.token);
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(DiscordAccessTokenService, this.make).pipe(
    Layer.provide(SheetAuthClient.layer),
  );
}
