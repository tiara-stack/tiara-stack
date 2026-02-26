import { HttpApiBuilder, HttpApiSwagger, HttpMiddleware, HttpServer } from "@effect/platform";
import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { createServer } from "http";
import { Api } from "./api";
import { config } from "./config";
import { CalcLive } from "./handlers/calc";
import { HealthLive } from "./handlers/health";
import { GuildConfigLive } from "./handlers/guildConfig";
import { MessageCheckinLive } from "./handlers/messageCheckin";
import { MessageRoomOrderLive } from "./handlers/messageRoomOrder";
import { MessageSlotLive } from "./handlers/messageSlot";
import { SheetLive } from "./handlers/sheet";
import { MonitorLive } from "./handlers/monitor";
import { PlayerLive } from "./handlers/player";
import { ScreenshotLive } from "./handlers/screenshot";
import { ScheduleLive } from "./handlers/schedule";
import { DiscordLive } from "./handlers/discord";

const ApiLive = Layer.provide(HttpApiBuilder.api(Api), [
  CalcLive,
  HealthLive,
  GuildConfigLive,
  MessageCheckinLive,
  MessageRoomOrderLive,
  MessageSlotLive,
  SheetLive,
  MonitorLive,
  PlayerLive,
  ScreenshotLive,
  ScheduleLive,
  DiscordLive,
]);

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
      allowedHeaders: ["Content-Type", "Authorization"],
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
  Layer.provide(NodeHttpClient.layer),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);
