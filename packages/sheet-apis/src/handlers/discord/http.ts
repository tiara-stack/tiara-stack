import { GuildsApiCacheView } from "dfx-discord-utils/discord/cache/guilds";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { Effect, Layer, Match, Metric, Predicate, Redacted, Schema } from "effect";
import { makeArgumentError } from "typhoon-core/error";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { Discord } from "@/schema";
import { discordLayer as discordServiceLayer, DiscordAccessTokenService } from "@/services";
import { discordGuildCacheFailures } from "@/metrics/discord";

const DiscordMyGuild = Schema.Struct({
  id: Schema.String,
});

const discordApiUrl = (path: string): string =>
  new URL(path, "https://discord.com/api/v10/").toString();

const formatError = Match.type<unknown>().pipe(
  Match.when(Predicate.isError, (error) => error.message),
  Match.when(Predicate.isString, (error) => error),
  Match.orElse((error) => JSON.stringify(error)),
);

const hasStringTag = (error: unknown): error is { readonly _tag: string } =>
  Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag);

const cacheFailureReason = Match.type<unknown>().pipe(
  Match.when(hasStringTag, (error) => error._tag),
  Match.orElse(() => "UnknownCacheError"),
);

type GuildCacheLookup<Guild, CacheError> =
  | { readonly _tag: "Success"; readonly guild: Guild }
  | {
      readonly _tag: "Failure";
      readonly error: CacheError;
      readonly guildId: string;
      readonly reason: string;
    };

const isGuildCacheFailure = <Guild, CacheError>(
  lookup: GuildCacheLookup<Guild, CacheError>,
): lookup is Extract<GuildCacheLookup<Guild, CacheError>, { readonly _tag: "Failure" }> =>
  Predicate.isTagged(lookup, "Failure");

const isGuildCacheSuccess = <Guild, CacheError>(
  lookup: GuildCacheLookup<Guild, CacheError>,
): lookup is Extract<GuildCacheLookup<Guild, CacheError>, { readonly _tag: "Success" }> =>
  Predicate.isTagged(lookup, "Success");

// Bound remote cache pressure while keeping the current user's guild lookup latency low.
const guildCacheLookupConcurrency = 16;

export const resolveCachedDiscordGuilds = <Guild, CacheError>(
  guildIds: ReadonlyArray<string>,
  getGuild: (guildId: string) => Effect.Effect<Guild, CacheError>,
) =>
  Effect.gen(function* () {
    const guildLookups = yield* Effect.forEach(
      guildIds,
      (guildId) =>
        getGuild(guildId).pipe(
          Effect.match({
            onSuccess: (guild) => ({ _tag: "Success" as const, guild }),
            onFailure: (error) => ({
              _tag: "Failure" as const,
              error,
              guildId,
              reason: cacheFailureReason(error),
            }),
          }),
        ),
      { concurrency: guildCacheLookupConcurrency },
    );

    const failures = guildLookups.filter(isGuildCacheFailure);

    yield* Effect.forEach(
      failures,
      ({ error, guildId, reason }) =>
        Effect.all(
          [
            Effect.logWarning("Discord guild cache lookup failed").pipe(
              Effect.annotateLogs({ error: formatError(error), guildId, reason }),
            ),
            Metric.update(
              Metric.withAttributes(discordGuildCacheFailures, {
                reason,
              }),
              1,
            ),
          ],
          { discard: true },
        ),
      { concurrency: "unbounded", discard: true },
    );

    // Guilds drive authorization and UI state, so never expose a partially resolved set.
    if (failures.length > 0) {
      return yield* Effect.fail(
        makeArgumentError(
          `Failed to resolve ${failures.length} of ${guildLookups.length} Discord guilds from cache`,
        ),
      );
    }

    return guildLookups.filter(isGuildCacheSuccess).map(({ guild }) => guild);
  });

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

        const cachedGuilds = yield* resolveCachedDiscordGuilds(
          userGuilds.map(({ id }) => id),
          (guildId) => guildsCache.get(guildId),
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
