import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpRouter } from "effect/unstable/http";
import { config } from "./config";

export const allowedOriginMatchers = (allowedOrigins: ReadonlyArray<string>) =>
  allowedOrigins.map((allowed) => {
    if (!allowed.includes("*")) {
      return (origin: string) => allowed === origin;
    }
    const escapedSegments = allowed
      .split("*")
      .map((segment) => segment.replace(/[.?+^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp("^" + escapedSegments.join("[^./]*") + "$");
    return (origin: string) => pattern.test(origin);
  });

export const corsMiddlewareLayer = Layer.unwrap(
  Effect.gen(function* () {
    const originMatchers = allowedOriginMatchers(yield* config.trustedOrigins);
    return HttpRouter.middleware(
      HttpMiddleware.cors({
        allowedOrigins: (origin) => originMatchers.some((matches) => matches(origin)),
        allowedHeaders: ["Content-Type", "Authorization", "b3", "traceparent", "tracestate"],
        allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
        exposedHeaders: ["Content-Length"],
        maxAge: 600,
        credentials: true,
      }),
      { global: true },
    );
  }),
);
