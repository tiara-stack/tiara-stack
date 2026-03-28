import { HttpApiBuilder, HttpApiSwagger, HttpMiddleware, HttpServer } from "@effect/platform";
import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, pipe, Redacted } from "effect";
import { PrefixedUnstorageLive, RedisUnstorageLive } from "dfx-discord-utils/discord/cache";
import { createServer } from "http";
import { Api } from "./api";
import { config } from "./config";
import { CalcLive } from "./handlers/calc";
import { CheckinLive } from "./handlers/checkin";
import { HealthLive } from "./handlers/health";
import { GuildConfigLive } from "./handlers/guildConfig";
import { MessageCheckinLive } from "./handlers/messageCheckin";
import { MessageRoomOrderLive } from "./handlers/messageRoomOrder";
import { MessageSlotLive } from "./handlers/messageSlot";
import { PermissionsLive } from "./handlers/permissions";
import { SheetLive } from "./handlers/sheet";
import { MonitorLive } from "./handlers/monitor";
import { PlayerLive } from "./handlers/player";
import { RoomOrderLive } from "./handlers/roomOrder";
import { ScreenshotLive } from "./handlers/screenshot";
import { ScheduleLive } from "./handlers/schedule";
import { DiscordLive } from "./handlers/discord";
import { DiscordApiClientLive, CachesLive } from "./services/cache";

const ApiLive = Layer.provide(HttpApiBuilder.api(Api), [
  CalcLive,
  CheckinLive,
  HealthLive,
  GuildConfigLive,
  MessageCheckinLive,
  MessageRoomOrderLive,
  MessageSlotLive,
  PermissionsLive,
  SheetLive,
  MonitorLive,
  PlayerLive,
  RoomOrderLive,
  ScreenshotLive,
  ScheduleLive,
  DiscordLive,
]);

// Redis layer - provides the base Unstorage context
const RedisLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const redisUrl = yield* config.redisUrl;
    return RedisUnstorageLive({ url: Redacted.value(redisUrl) });
  }),
);

// Unstorage layer with prefix - same pattern as sheet-bot
// Provides prefixed storage that cache services consume
const UnstorageLayer = pipe(PrefixedUnstorageLive("discord:"), Layer.provide(RedisLive));

// Discord cache layer - requires Redis to share cache with sheet-bot
// These services consume the Unstorage context provided by UnstorageLayer
const CacheWithUnstorageLive = CachesLive.pipe(Layer.provide(UnstorageLayer));

// Helper to check if origin matches trusted origins (supports wildcards like http://localhost:*)
// * matches single hostname segment only (e.g., *.example.com matches a.example.com but not a.b.example.com)
function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.some((allowed) => {
    if (allowed === origin) return true;
    if (allowed.includes("*")) {
      // Replace * with placeholder, escape all regex chars, then restore as [^./]*
      // [^./]* ensures * matches only valid hostname chars (no dots or slashes)
      const withPlaceholder = allowed.replace(/\*/g, "\x00");
      const escaped = withPlaceholder.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      // eslint-disable-next-line no-control-regex
      const regex = new RegExp("^" + escaped.replace(/\x00/g, "[^./]*") + "$");
      return regex.test(origin);
    }
    return false;
  });
}

const MiddlewareCorsLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const trustedOrigins = [...(yield* config.trustedOrigins)];
    return HttpApiBuilder.middlewareCors({
      allowedOrigins: (origin) => isOriginAllowed(origin, trustedOrigins),
      allowedHeaders: ["Content-Type", "Authorization", "b3", "traceparent", "tracestate"],
      allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
      exposedHeaders: ["Content-Length"],
      maxAge: 600,
      credentials: true,
    });
  }),
);

export const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiSwagger.layer()),
  Layer.provide(HttpApiBuilder.middlewareOpenApi()),
  Layer.provide(MiddlewareCorsLive),
  Layer.provide(ApiLive),
  Layer.provide(CacheWithUnstorageLive),
  Layer.provide(DiscordApiClientLive),
  Layer.provide(NodeHttpClient.layer),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);
