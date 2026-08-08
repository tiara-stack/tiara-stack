import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { Unstorage } from "dfx-discord-utils/discord/cache";
import { runRecoveryCommand } from "./reconcileDelivery";

describe("reconcile delivery command", () => {
  it.effect("validates action-specific flags before reading store configuration", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runRecoveryCommand([
          "safe-retry",
          "--delivery-key",
          "delivery-invalid-command",
          "--actor",
          "on-call@example.com",
        ]),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "RecoveryCommandError",
        message: expect.stringContaining("Missing --evidence"),
      });
    }).pipe(Effect.provide(Unstorage.memoryLayer)),
  );
});
