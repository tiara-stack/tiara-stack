import { HttpApiBuilder, HttpServerRequest } from "@effect/platform";
import { catchParseErrorAsValidationError, makeArgumentError } from "typhoon-core/error";
import { Effect, Layer, pipe, Schema, Record, Struct, Redacted } from "effect";
import { Api } from "@/api";
import { SheetAuthTokenAuthorizationLive } from "@/middlewares/sheetAuthTokenAuthorization/live";
import { Discord } from "@/schema";
import { SheetAuthClient } from "@/services";
import { getDiscordAccessToken } from "sheet-auth/client";
import { GuildsApiCacheView } from "dfx-discord-utils/discord/cache";

// Minimal guild from Discord API for checking membership
const DiscordMyGuild = Schema.Struct({
  id: Schema.String,
});

export const DiscordLive = HttpApiBuilder.group(Api, "discord", (handlers) =>
  pipe(
    Effect.all({
      authClient: SheetAuthClient,
      guildsCache: GuildsApiCacheView,
    }),
    Effect.map(({ authClient, guildsCache }) => {
      return handlers
        .handle("getCurrentUser", () =>
          Effect.gen(function* () {
            const headers = yield* HttpServerRequest.schemaHeaders(
              Schema.Record({ key: Schema.String, value: Schema.UndefinedOr(Schema.String) }),
            ).pipe(catchParseErrorAsValidationError);

            const authHeaders = pipe(
              headers,
              Record.filter((value) => value !== undefined),
              Struct.pick("origin", "cookie"),
            );

            const tokenResult = yield* pipe(
              getDiscordAccessToken(authClient, authHeaders),
              Effect.mapError((error) =>
                makeArgumentError(
                  `Failed to get Discord access token: ${error.message}. ` +
                    "Ensure the user has authenticated with Discord.",
                ),
              ),
            );

            // Fetch user from Discord API
            const discordResponse = yield* pipe(
              Effect.promise(() =>
                fetch("https://discord.com/api/v10/users/@me", {
                  headers: {
                    Authorization: `Bearer ${Redacted.value(tokenResult.accessToken)}`,
                  },
                }),
              ),
              Effect.flatMap((response) =>
                response.ok
                  ? Effect.succeed(response)
                  : Effect.fail(
                      makeArgumentError(`Failed to fetch Discord user: ${response.statusText}`),
                    ),
              ),
            );

            const json = yield* Effect.tryPromise({
              try: () => discordResponse.json(),
              catch: (error) =>
                makeArgumentError(`Failed to parse Discord response: ${String(error)}`),
            });

            // Decode user data
            const user = yield* Schema.decodeUnknown(Discord.DiscordUser)(json).pipe(
              Effect.mapError((error) =>
                makeArgumentError(`Invalid response from Discord API: ${String(error)}`),
              ),
            );

            return user;
          }),
        )
        .handle("getCurrentUserGuilds", () =>
          Effect.gen(function* () {
            const headers = yield* HttpServerRequest.schemaHeaders(
              Schema.Record({ key: Schema.String, value: Schema.UndefinedOr(Schema.String) }),
            ).pipe(catchParseErrorAsValidationError);

            const authHeaders = pipe(
              headers,
              Record.filter((value) => value !== undefined),
              Struct.pick("origin", "cookie"),
            );

            const tokenResult = yield* pipe(
              getDiscordAccessToken(authClient, authHeaders),
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
                    Authorization: `Bearer ${Redacted.value(tokenResult.accessToken)}`,
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
              catch: (error) =>
                makeArgumentError(`Failed to parse Discord response: ${String(error)}`),
            });

            // Decode minimal guild data to get IDs
            const userGuilds = yield* Schema.decodeUnknown(Schema.Array(DiscordMyGuild))(json).pipe(
              Effect.mapError((error) =>
                makeArgumentError(`Invalid response from Discord API: ${String(error)}`),
              ),
            );

            // Look up full guild data from cache - returns Guild Object from Gateway
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
            const cachedGuilds = maybeGuilds.filter((g): g is NonNullable<typeof g> => g !== null);

            // Decode through schema to ensure type safety
            return yield* Schema.decode(Schema.Array(Discord.DiscordGuild))(cachedGuilds).pipe(
              Effect.mapError((error) =>
                makeArgumentError(`Invalid cached guild data: ${String(error)}`),
              ),
            );
          }),
        );
    }),
  ),
).pipe(Layer.provide(Layer.mergeAll(SheetAuthClient.Default, SheetAuthTokenAuthorizationLive)));
