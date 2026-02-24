import { HttpApiBuilder } from "@effect/platform";
import { makeArgumentError } from "typhoon-core/error";
import { Effect, Layer, pipe, Schema } from "effect";
import { Api } from "@/api";
import { SheetAuthUser } from "@/middlewares/sheetAuthTokenAuthorization/tag";
import { SheetAuthTokenAuthorizationLive } from "@/middlewares/sheetAuthTokenAuthorization/live";
import { Discord } from "@/schema";
import { config } from "@/config";
import { createSheetAuthClient, getDiscordAccessToken } from "sheet-auth/client";

/**
 * Discord API Handler
 *
 * Fetches the current user's Discord guilds using their OAuth access token.
 * Uses Better Auth's client with bearer plugin for stateless authentication.
 */
export const DiscordLive = HttpApiBuilder.group(Api, "discord", (handlers) =>
  pipe(
    Effect.all({
      authIssuer: config.sheetAuthIssuer,
    }),
    Effect.map(({ authIssuer }) => {
      // Create Better Auth client with bearer plugin for stateless auth
      const authClient = createSheetAuthClient(authIssuer.replace(/\/$/, ""));

      return handlers.handle("getCurrentUserGuilds", () =>
        Effect.gen(function* () {
          const sheetAuthUser = yield* SheetAuthUser;

          // Get Discord access token using Better Auth client with bearer token
          // The bearer plugin passes the JWT via Authorization header
          const tokenResult = yield* pipe(
            getDiscordAccessToken(authClient, sheetAuthUser.token),
            Effect.mapError((error) =>
              makeArgumentError(
                `Failed to get Discord access token: ${error.message}. ` +
                  "Ensure the user has authenticated with Discord.",
              ),
            ),
          );

          // Call Discord API to get guilds
          const discordResponse = yield* pipe(
            Effect.promise(() =>
              fetch("https://discord.com/api/v10/users/@me/guilds", {
                headers: {
                  Authorization: `Bearer ${tokenResult.accessToken}`,
                },
              }),
            ),
            Effect.flatMap((response) =>
              response.ok
                ? Effect.succeed(response)
                : Effect.fail(
                    makeArgumentError(`Failed to fetch Discord guilds: ${response.statusText}`),
                  ),
            ),
          );

          const json = yield* Effect.tryPromise({
            try: () => discordResponse.json(),
            catch: (error) => makeArgumentError(`Failed to parse Discord response: ${error}`),
          });

          // Decode and return guilds
          const guilds = yield* Schema.decodeUnknown(Schema.Array(Discord.DiscordGuild))(json).pipe(
            Effect.mapError((error) =>
              makeArgumentError(`Invalid response from Discord API: ${error}`),
            ),
          );

          return guilds;
        }),
      );
    }),
  ),
).pipe(Layer.provide(SheetAuthTokenAuthorizationLive));
