import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import { runSheetWorkflowsDispatch } from "./sheetWorkflowsDispatch";

describe("runSheetWorkflowsDispatch", () => {
  it.effect("allows dispatches longer than ten seconds", () =>
    Effect.gen(function* () {
      const editReply = vi.fn(() => Effect.void);
      const dispatch = runSheetWorkflowsDispatch(
        { editReply },
        "the operation",
        Effect.sleep(Duration.seconds(15)),
      );

      const fiber = yield* Effect.forkChild(dispatch);
      yield* TestClock.adjust(Duration.seconds(15));
      yield* Fiber.join(fiber);

      expect(editReply).not.toHaveBeenCalled();
    }),
  );
});
