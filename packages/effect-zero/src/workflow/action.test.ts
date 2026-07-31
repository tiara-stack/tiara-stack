import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { makeAction } from "./action";

const action = makeAction({
  name: "example.action",
  version: "v2",
  input: Schema.Struct({
    requestId: Schema.String,
    value: Schema.Number,
  }),
  success: Schema.Number,
  idempotencyKey: ({ requestId }) => requestId,
  execute: ({ value }) => Effect.succeed(value + 1),
});

describe("durable action definition", () => {
  it.effect("uses stable name, version, and input idempotency", () =>
    Effect.gen(function* () {
      expect(action.name).toBe("example.action");
      expect(action.version).toBe("v2");
      const first = yield* action.workflow.executionId({
        requestId: "request-1",
        value: 1,
      });
      const retried = yield* action.workflow.executionId({
        requestId: "request-1",
        value: 999,
      });
      expect(retried).toBe(first);
    }),
  );
});
