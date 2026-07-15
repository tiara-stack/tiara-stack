import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import {
  isInteractionFailureHandled,
  unwrapInteractionFailure,
} from "@/handlers/shared/interactionFailure";
import { runTeamSubmissionButtonAction } from "./teamSubmissionCommon";

const runAction = <A, E>(action: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    let interactionFinished = false;
    const exit = yield* Effect.exit(
      runTeamSubmissionButtonAction(action, "operation failed", () =>
        Effect.sync(() => {
          interactionFinished = true;
        }),
      ),
    );
    return { exit, interactionFinished };
  });

it.effect("preserves defects without handling the interaction failure", () =>
  Effect.gen(function* () {
    const { exit, interactionFinished } = yield* runAction(Effect.die("unexpected defect"));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
    }
    expect(interactionFinished).toBe(false);
  }),
);

it.effect("marks ordinary failures with a tagged domain error", () =>
  Effect.gen(function* () {
    const { exit, interactionFinished } = yield* runAction(Effect.fail("operation failed"));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const maybeError = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(maybeError)).toBe(true);
      if (Option.isSome(maybeError)) {
        expect(isInteractionFailureHandled(maybeError.value)).toBe(true);
        expect(unwrapInteractionFailure(maybeError.value)).toMatchObject({ _tag: "UnknownError" });
      }
    }
    expect(interactionFinished).toBe(true);
  }),
);
