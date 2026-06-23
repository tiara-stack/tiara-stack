import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { healthRoutesLayer } from "./health";

const runHealthRoute = (path: "/live" | "/ready") =>
  Effect.scoped(
    Effect.gen(function* () {
      const handler = yield* HttpRouter.toHttpEffect(
        healthRoutesLayer.pipe(Layer.provide(HttpRouter.layer)),
      );

      return yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(`http://localhost${path}`)),
        ),
      );
    }),
  );

describe("health routes", () => {
  it.effect("serves live checks", () =>
    Effect.gen(function* () {
      const response = yield* runHealthRoute("/live");

      expect(response.status).toBe(200);
    }),
  );

  it.effect("serves ready checks", () =>
    Effect.gen(function* () {
      const response = yield* runHealthRoute("/ready");

      expect(response.status).toBe(200);
    }),
  );
});
