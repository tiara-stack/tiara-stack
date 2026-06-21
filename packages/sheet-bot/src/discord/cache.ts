// fallow-ignore-file code-duplication
import { Effect, Layer, Redacted } from "effect";
import { Unstorage, cachesLayer as discordCachesLayer } from "dfx-discord-utils/discord/cache";
import { config } from "@/config";
import { discordConfigLayer } from "./config";

const redisLayer = Layer.unwrap(
  Effect.gen(function* () {
    const redisUrl = yield* config.redisUrl;
    return Unstorage.redisLayer({ url: Redacted.value(redisUrl) });
  }),
);

const prefixedUnstorageLayer = Unstorage.prefixedLayer("discord:").pipe(Layer.provide(redisLayer));

export const cachesLayer = discordCachesLayer.pipe(
  Layer.provide([prefixedUnstorageLayer, discordConfigLayer]),
);
