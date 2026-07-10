import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  adaptTableHandlerArgument,
  invokeTableHandler,
  withKnownRequestServices,
} from "./httpApiAdapter";

describe("httpApiAdapter", () => {
  it("keeps the adapted layer unchanged at runtime", () => {
    const layer = Layer.empty;

    expect(withKnownRequestServices<{ readonly service: string }>()(layer)).toBe(layer);
  });

  it.effect("invokes the selected table handler with its typed arguments", () =>
    Effect.gen(function* () {
      const handlers = {
        increment: (value: number) => Effect.succeed(value + 1),
        label: (value: string) => Effect.succeed(`value:${value}`),
      } as const;

      expect(yield* invokeTableHandler(handlers, "increment", 2)).toBe(3);
      expect(yield* invokeTableHandler(handlers, "label", "ok")).toBe("value:ok");
      expect(adaptTableHandlerArgument(handlers, "increment", 4)).toBe(4);
    }),
  );
});
