import { describe, expect, it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import {
  compensateDeliveryFailure,
  reconcileDeliveryPersistence,
  reconcileRoomOrderPersistence,
} from "./messageDelivery";

const failureCause = <A, E>(exit: Exit.Exit<A, E>): Cause.Cause<E> => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected effect to fail");
  }
  return exit.cause;
};

const failureValues = (cause: Cause.Cause<unknown>) =>
  cause.reasons.flatMap((reason) => (Cause.isFailReason(reason) ? [reason.error] : []));

describe("message delivery reconciliation", () => {
  it.effect("restores delivery failures after successful or failed compensation", () =>
    Effect.gen(function* () {
      const deliveryCause = Cause.fail("delivery failed");
      const successfulCleanup = failureCause(
        yield* Effect.exit(compensateDeliveryFailure(deliveryCause, Effect.void)),
      );
      const failedCleanup = failureCause(
        yield* Effect.exit(compensateDeliveryFailure(deliveryCause, Effect.fail("cleanup failed"))),
      );

      expect(failureValues(successfulCleanup)).toEqual(["delivery failed"]);
      expect(failureValues(failedCleanup)).toEqual(["delivery failed"]);
    }),
  );

  it.effect("combines an interrupting compensation with the delivery failure", () =>
    Effect.gen(function* () {
      const cause = failureCause(
        yield* Effect.exit(
          compensateDeliveryFailure(
            Cause.fail("delivery failed"),
            Effect.failCause(Cause.interrupt(2)),
          ),
        ),
      );

      expect(Cause.hasInterrupts(cause)).toBe(true);
      expect(failureValues(cause)).toContain("delivery failed");
    }),
  );

  it.effect("bounds an uninterruptible compensation operation", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.exit(compensateDeliveryFailure(Cause.fail("delivery failed"), Effect.never)),
      );
      yield* TestClock.adjust(Duration.seconds(10));
      const cause = failureCause(yield* Fiber.join(fiber));

      expect(failureValues(cause)).toEqual(["delivery failed"]);
    }),
  );

  it.effect("reconciles interrupted delivery persistence before cleanup", () =>
    Effect.gen(function* () {
      const interrupted = Cause.interrupt(1);
      let cleanupCount = 0;
      const cleanup = Effect.sync(() => {
        cleanupCount += 1;
      });
      const reconcile = (lookup: Effect.Effect<Option.Option<unknown>, unknown>) =>
        reconcileDeliveryPersistence({
          cause: interrupted,
          cleanup,
          lookup,
          lookupFailureAnnotations: {},
          lookupFailureMessage: "lookup failed",
        });

      const foundCause = failureCause(
        yield* Effect.exit(reconcile(Effect.succeed(Option.some("persisted")))),
      );
      expect(Cause.hasInterrupts(foundCause)).toBe(true);
      expect(cleanupCount).toBe(0);

      const missingCause = failureCause(
        yield* Effect.exit(reconcile(Effect.succeed(Option.none()))),
      );
      expect(Cause.hasInterrupts(missingCause)).toBe(true);
      expect(cleanupCount).toBe(1);

      const lookupCause = failureCause(yield* Effect.exit(reconcile(Effect.fail("lookup failed"))));
      expect(Cause.hasInterrupts(lookupCause)).toBe(true);
      expect(failureValues(lookupCause)).toContain("lookup failed");
      expect(cleanupCount).toBe(1);
    }),
  );

  it.effect("reconciles room-order persistence without swallowing interrupts", () =>
    Effect.gen(function* () {
      const message = { id: "message-1", conversation_id: "conversation-1" };
      let deleteCount = 0;
      const botClient = {
        deleteMessage: () =>
          Effect.sync(() => {
            deleteCount += 1;
          }),
      };
      const reconcile = (
        cause: Cause.Cause<unknown>,
        lookup: Effect.Effect<Option.Option<unknown>, unknown>,
      ) =>
        reconcileRoomOrderPersistence({
          botClient,
          cause,
          message,
          messageRoomOrderService: { getMessageRoomOrder: () => lookup },
        });

      yield* reconcile(Cause.fail("persist failed"), Effect.succeed(Option.some("persisted")));
      expect(deleteCount).toBe(0);

      const missingCause = failureCause(
        yield* Effect.exit(reconcile(Cause.fail("persist failed"), Effect.succeed(Option.none()))),
      );
      expect(failureValues(missingCause)).toEqual(["persist failed"]);
      expect(deleteCount).toBe(1);

      const interruptedCause = failureCause(
        yield* Effect.exit(reconcile(Cause.interrupt(3), Effect.succeed(Option.some("persisted")))),
      );
      expect(Cause.hasInterrupts(interruptedCause)).toBe(true);
      expect(deleteCount).toBe(1);
    }),
  );

  it.effect("combines room-order cleanup failures with an original interrupt", () =>
    Effect.gen(function* () {
      const cause = failureCause(
        yield* Effect.exit(
          reconcileRoomOrderPersistence({
            botClient: { deleteMessage: () => Effect.fail("cleanup failed") },
            cause: Cause.interrupt(4),
            message: { id: "message-1", conversation_id: "conversation-1" },
            messageRoomOrderService: {
              getMessageRoomOrder: () => Effect.succeed(Option.none()),
            },
          }),
        ),
      );

      expect(Cause.hasInterrupts(cause)).toBe(true);
      expect(failureValues(cause)).toContain("cleanup failed");
    }),
  );
});
