import type { ThreadEvent } from "@openai/codex-sdk";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "@effect/vitest";
import { CodexStreamParseError } from "../CodexError";
import { collectStreamEvents } from "./clientRun";

const eventsThatThrow = (cause: unknown): AsyncIterable<ThreadEvent> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () => {
      throw cause;
    },
  }),
});

describe("collectStreamEvents", () => {
  it.effect("preserves AbortError failures", () =>
    Effect.gen(function* () {
      const abort = new DOMException("aborted", "AbortError");

      const exit67 = yield* Effect.exit(collectStreamEvents(eventsThatThrow(abort)));
      expect(Exit.isFailure(exit67)).toBe(true);
      if (Exit.isFailure(exit67)) {
        const failure = exit67.cause.reasons.find(Cause.isFailReason)?.error;
        expect(failure).toBe(abort);
        expect(failure).not.toBeInstanceOf(CodexStreamParseError);
      }
    }),
  );

  it.effect("wraps non-abort iterator failures", () =>
    Effect.gen(function* () {
      const exit5 = yield* Effect.exit(
        collectStreamEvents(eventsThatThrow(new Error("stream failed"))),
      );
      expect(Exit.isFailure(exit5)).toBe(true);
      if (Exit.isFailure(exit5)) {
        expect(Cause.pretty(exit5.cause)).toContain(CodexStreamParseError.name);
      }
    }),
  );
});
