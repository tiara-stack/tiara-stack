import { Effect, Layer, Redacted } from "effect";
import { Unstorage, cachesLayer as discordCachesLayer } from "dfx-discord-utils/discord/cache";
import { config } from "@/config";
import { discordConfigLayer } from "./config";

const redisRequestTimeoutMs = 5_000;

const redisLayer = Layer.unwrap(
  Effect.gen(function* () {
    const redisUrl = yield* config.redisUrl;
    return Unstorage.redisLayer({
      url: Redacted.value(redisUrl),
      connectTimeout: redisRequestTimeoutMs,
      commandTimeout: redisRequestTimeoutMs,
      maxRetriesPerRequest: 1,
    });
  }),
);

export const makePrefixedUnstorageLayer = <E>(storageLayer: Layer.Layer<Unstorage, E, never>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const clientId = yield* config.sheetBotClientId;
      return Unstorage.prefixedLayer(`discord:${clientId}:`).pipe(Layer.provide(storageLayer));
    }),
  );

export const prefixedUnstorageLayer = makePrefixedUnstorageLayer(redisLayer);

export const cachesLayer = discordCachesLayer.pipe(
  Layer.provide([prefixedUnstorageLayer, discordConfigLayer]),
);
