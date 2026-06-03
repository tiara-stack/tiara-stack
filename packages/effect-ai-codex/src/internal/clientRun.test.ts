import type { ThreadEvent } from "@openai/codex-sdk";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
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
  it("preserves AbortError failures", async () => {
    const abort = new DOMException("aborted", "AbortError");

    await expect(Effect.runPromise(collectStreamEvents(eventsThatThrow(abort)))).rejects.toBe(
      abort,
    );
  });

  it("wraps non-abort iterator failures", async () => {
    await expect(
      Effect.runPromise(collectStreamEvents(eventsThatThrow(new Error("stream failed")))),
    ).rejects.toBeInstanceOf(CodexStreamParseError);
  });
});
