import { NodeHttpClient } from "@effect/platform-node";
import { GuildsApiCacheView } from "dfx-discord-utils/discord/cache/guilds";
import { HttpClient, HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect, Layer, Redacted, Schema } from "effect";
import { makeArgumentError } from "typhoon-core/error";
import { Api } from "@/api";
import { SheetAuthTokenAuthorizationLive } from "@/middlewares/sheetAuthTokenAuthorization/live";
import { Discord } from "@/schema";
import { discordLayer as discordServiceLayer } from "@/services";

const forwardedDiscordHeaders = Schema.Struct({
  "x-sheet-discord-access-token": Schema.optional(Schema.String),
});

const DiscordMyGuild = Schema.Struct({
  id: Schema.String,
});

const formatError = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error);

const getForwardedDiscordAccessToken = Effect.fn("getForwardedDiscordAccessToken")(function* () {
  const headers = yield* HttpServerRequest.schemaHeaders(forwardedDiscordHeaders);
  if (!headers["x-sheet-discord-access-token"]) {
    return yield* Effect.fail(makeArgumentError("Missing forwarded Discord access token"));
  }
  return Redacted.make(headers["x-sheet-discord-access-token"]);
});

export const discordLayer = HttpApiBuilder.group(
  Api,
  "discord",
  Effect.fn(function* (handlers) {
    const guildsCache = yield* GuildsApiCacheView;
    const httpClient = yield* HttpClient.HttpClient;

    const getDiscordJson = Effect.fn("getDiscordJson")(function* (
      url: string,
      accessToken: Redacted.Redacted<string>,
      failureMessage: string,
    ) {
      const response = yield* httpClient
        .get(url, {
          headers: {
            Authorization: `Bearer ${Redacted.value(accessToken)}`,
          },
        })
        .pipe(
          Effect.mapError((error) => makeArgumentError(`${failureMessage}: ${formatError(error)}`)),
        );
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(makeArgumentError(`${failureMessage}: ${response.status}`));
      }

      return yield* response.json.pipe(
        Effect.mapError((error) =>
          makeArgumentError(`Failed to parse Discord response: ${formatError(error)}`),
        ),
      );
    });

    return handlers
      .handle(
        "getCurrentUser",
        Effect.fnUntraced(function* () {
          const accessToken = yield* getForwardedDiscordAccessToken();
          const json = yield* getDiscordJson(
            "https://discord.com/api/v10/users/@me",
            accessToken,
            "Failed to fetch Discord user",
          );

          return yield* Schema.decodeUnknownEffect(Discord.DiscordUser)(json).pipe(
            Effect.mapError((error) =>
              makeArgumentError(`Invalid response from Discord API: ${String(error)}`),
            ),
          );
        }),
      )
      .handle(
        "getCurrentUserGuilds",
        Effect.fnUntraced(function* () {
          const accessToken = yield* getForwardedDiscordAccessToken();
          const json = yield* getDiscordJson(
            "https://discord.com/api/v10/users/@me/guilds",
            accessToken,
            "Failed to fetch Discord guilds",
          );

          const userGuilds = yield* Schema.decodeUnknownEffect(Schema.Array(DiscordMyGuild))(
            json,
          ).pipe(
            Effect.mapError((error) =>
              makeArgumentError(`Invalid response from Discord API: ${String(error)}`),
            ),
          );

          const maybeGuilds = yield* Effect.forEach(
            userGuilds,
            ({ id }) =>
              guildsCache.get(id).pipe(
                Effect.matchEffect({
                  onSuccess: (guild) => Effect.succeed(guild),
                  onFailure: () => Effect.succeed(null),
                }),
              ),
            { concurrency: "unbounded" },
          );

          const cachedGuilds = maybeGuilds.filter(
            (guild): guild is NonNullable<typeof guild> => guild !== null,
          );

          return yield* Schema.decodeUnknownEffect(Schema.Array(Discord.DiscordGuild))(
            cachedGuilds,
          ).pipe(
            Effect.mapError((error) =>
              makeArgumentError(`Invalid cached guild data: ${String(error)}`),
            ),
          );
        }),
      );
  }),
).pipe(
  Layer.provide([discordServiceLayer, SheetAuthTokenAuthorizationLive, NodeHttpClient.layerFetch]),
);
