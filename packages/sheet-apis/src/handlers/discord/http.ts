import { HttpApiBuilder, HttpServerRequest } from "@effect/platform";
import { catchParseErrorAsValidationError, makeArgumentError } from "typhoon-core/error";
import { Effect, Layer, pipe, Schema, Record } from "effect";
import { Api } from "@/api";
import { SheetAuthTokenAuthorizationLive } from "@/middlewares/sheetAuthTokenAuthorization/live";
import { Discord } from "@/schema";
import { config } from "@/config";
import { createSheetAuthClient, getDiscordAccessToken } from "sheet-auth/client";
import { GuildsCacheView } from "@/services/cache";
import type { GuildResponse } from "@/schemas/discord";

// Minimal guild from Discord API for checking membership
const DiscordMyGuild = Schema.Struct({
  id: Schema.String,
});

export const DiscordLive = HttpApiBuilder.group(Api, "discord", (handlers) =>
  pipe(
    Effect.all({
      authIssuer: config.sheetAuthIssuer,
      guildsCache: GuildsCacheView,
    }),
    Effect.map(({ authIssuer, guildsCache }) => {
      const authClient = createSheetAuthClient(authIssuer.replace(/\/$/, ""));

      return handlers.handle("getCurrentUserGuilds", () =>
        Effect.gen(function* () {
          const headers = yield* HttpServerRequest.schemaHeaders(
            Schema.Record({ key: Schema.String, value: Schema.UndefinedOr(Schema.String) }),
          ).pipe(catchParseErrorAsValidationError);

          const tokenResult = yield* pipe(
            getDiscordAccessToken(
              authClient,
              Record.filter(headers, (value) => value !== undefined),
            ),
            Effect.mapError((error) =>
              makeArgumentError(
                `Failed to get Discord access token: ${error.message}. ` +
                  "Ensure the user has authenticated with Discord.",
              ),
            ),
          );

          // Fetch user's guild IDs from Discord API
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

          // Decode minimal guild data to get IDs
          const userGuilds = yield* Schema.decodeUnknown(Schema.Array(DiscordMyGuild))(json).pipe(
            Effect.mapError((error) =>
              makeArgumentError(`Invalid response from Discord API: ${error}`),
            ),
          );

          // Look up full guild data from cache - cache returns GuildResponse directly or fails
          const maybeGuilds = yield* Effect.forEach(
            userGuilds,
            ({ id }) =>
              pipe(
                guildsCache.get(id),
                Effect.matchEffect({
                  onSuccess: (guild) => Effect.succeed(guild),
                  onFailure: () => Effect.succeed(null),
                }),
              ),
            { concurrency: "unbounded" },
          );

          // Filter out nulls (guilds not in cache)
          const cachedGuilds = maybeGuilds.filter((g): g is GuildResponse => g !== null);

          // Decode through schema to ensure type safety
          return yield* Schema.decode(Schema.Array(Discord.DiscordGuild))(cachedGuilds).pipe(
            Effect.mapError((error) => makeArgumentError(`Invalid cached guild data: ${error}`)),
          );
        }),
      );
    }),
  ),
).pipe(Layer.provide(SheetAuthTokenAuthorizationLive));
