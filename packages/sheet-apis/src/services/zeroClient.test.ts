import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import {
  runProactiveZeroAuthRefresh,
  shouldRefreshZeroAuth,
  zeroAuthRefreshDelay,
} from "./zeroClient";

describe("sheet Zero OAuth refresh", () => {
  it("refreshes one minute before token expiry", () => {
    expect(Duration.toMillis(zeroAuthRefreshDelay(3_700, 100))).toBe(
      Duration.toMillis(Duration.minutes(59)),
    );
  });

  it("uses a non-zero delay for already-expired tokens", () => {
    expect(Duration.toMillis(zeroAuthRefreshDelay(100, 100))).toBe(
      Duration.toMillis(Duration.seconds(1)),
    );
  });

  it("refreshes only for explicit authentication failures", () => {
    expect(
      shouldRefreshZeroAuth({
        name: "needs-auth",
        reason: { type: "query", status: 401 },
      }),
    ).toBe(true);
    expect(
      shouldRefreshZeroAuth({
        name: "error",
        reason: "Fetch from API server returned non-OK status 500",
      }),
    ).toBe(false);
    expect(shouldRefreshZeroAuth({ name: "error", reason: "Zero cache crashed" })).toBe(false);
    expect(shouldRefreshZeroAuth({ name: "connected" })).toBe(false);
  });

  it.effect("keeps scheduling proactive refreshes from each replacement token", () =>
    Effect.gen(function* () {
      const refresh = vi
        .fn(() => Effect.succeed({ auth: "second", refreshAfter: Duration.seconds(20) }))
        .mockReturnValueOnce(Effect.succeed({ auth: "first", refreshAfter: Duration.seconds(10) }));
      const fiber = yield* runProactiveZeroAuthRefresh(Duration.seconds(5), refresh).pipe(
        Effect.forkChild,
      );

      yield* TestClock.adjust(Duration.seconds(4));
      expect(refresh).not.toHaveBeenCalled();
      yield* TestClock.adjust(Duration.seconds(1));
      expect(refresh).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust(Duration.seconds(9));
      expect(refresh).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust(Duration.seconds(1));
      expect(refresh).toHaveBeenCalledTimes(2);

      yield* Fiber.interrupt(fiber);
    }),
  );
});
