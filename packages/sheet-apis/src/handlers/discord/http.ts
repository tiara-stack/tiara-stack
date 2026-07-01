import { GuildsApiCacheView } from "dfx-discord-utils/discord/cache/guilds";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { Effect, Layer, Redacted, Schema } from "effect";
import { makeArgumentError } from "typhoon-core/error";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { Discord } from "@/schema";
import { discordLayer as discordServiceLayer, DiscordAccessTokenService } from "@/services";

const DiscordMyGuild = Schema.Struct({
  id: Schema.String,
});

const discordApiUrl = (path: string): string =>
  new URL(path, "https://discord.com/api/v10/").toString();

const formatError = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error);

export const discordLayer = sheetApisGroupLayer(
  "discord",
  Effect.gen(function* () {
    const guildsCache = yield* GuildsApiCacheView;
    const httpClient = yield* HttpClient.HttpClient;
    const discordAccessTokenService = yield* DiscordAccessTokenService;

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
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError((error) => makeArgumentError(`${failureMessage}: ${formatError(error)}`)),
        );

      return yield* response.json.pipe(
        Effect.mapError((error) =>
          makeArgumentError(`Failed to parse Discord response: ${formatError(error)}`),
        ),
      );
    });

    return {
      "discord.getCurrentUser": Effect.fnUntraced(function* () {
        const accessToken = yield* discordAccessTokenService.getCurrentUserDiscordAccessToken();
        const json = yield* getDiscordJson(
          discordApiUrl("users/@me"),
          accessToken,
          "Failed to fetch Discord user",
        );

        return yield* Schema.decodeUnknownEffect(Discord.DiscordUser)(json).pipe(
          Effect.mapError((error) =>
            makeArgumentError(`Invalid response from Discord API: ${String(error)}`),
          ),
        );
      }),
      "discord.getCurrentUserGuilds": Effect.fnUntraced(function* () {
        const accessToken = yield* discordAccessTokenService.getCurrentUserDiscordAccessToken();
        const json = yield* getDiscordJson(
          discordApiUrl("users/@me/guilds"),
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
    } satisfies HandlerMap<"discord">;
  }),
).pipe(Layer.provide([discordServiceLayer, DiscordAccessTokenService.layer]));
