import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import * as ScopedCache from "./scopedCache";

describe("ScopedCache", () => {
  it.effect(
    "reuses the cached value while any acquired scope is still active",
    Effect.fnUntraced(function* () {
      let lookupCount = 0;
      let finalizedCount = 0;

      const cache = yield* ScopedCache.make({
        lookup: (key: string) =>
          Effect.acquireRelease(
            Effect.sync(() => `${key}-${++lookupCount}`),
            () => Effect.sync(() => void finalizedCount++),
          ),
      });

      const scopeA = yield* Scope.make();
      const scopeB = yield* Scope.make();
      const first = yield* Scope.provide(cache.get("alpha"), scopeA);
      const second = yield* Scope.provide(cache.get("alpha"), scopeB);

      expect(lookupCount).toBe(1);

      yield* Scope.close(scopeA, Exit.void);

      expect(finalizedCount).toBe(0);

      const third = yield* Scope.provide(cache.get("alpha"), scopeB);

      expect(lookupCount).toBe(1);
      expect(finalizedCount).toBe(0);

      yield* Scope.close(scopeB, Exit.void);

      expect(finalizedCount).toBe(1);
      expect({ first, second, third }).toEqual({
        first: "alpha-1",
        second: "alpha-1",
        third: "alpha-1",
      });
    }),
  );

  it.effect(
    "performs a new lookup after the last active scope expires",
    Effect.fnUntraced(function* () {
      let lookupCount = 0;
      let finalizedCount = 0;

      const cache = yield* ScopedCache.make({
        lookup: (key: string) =>
          Effect.acquireRelease(
            Effect.sync(() => `${key}-${++lookupCount}`),
            () => Effect.sync(() => void finalizedCount++),
          ),
      });

      const scopeA = yield* Scope.make();
      const first = yield* Scope.provide(cache.get("alpha"), scopeA);

      yield* Scope.close(scopeA, Exit.void);

      expect(lookupCount).toBe(1);
      expect(finalizedCount).toBe(1);

      const scopeB = yield* Scope.make();
      const second = yield* Scope.provide(cache.get("alpha"), scopeB);

      expect(lookupCount).toBe(2);

      yield* Scope.close(scopeB, Exit.void);

      expect(finalizedCount).toBe(2);
      expect({ first, second }).toEqual({
        first: "alpha-1",
        second: "alpha-2",
      });
    }),
  );

  it.effect("does not retain a failed lookup as a cached value", () =>
    Effect.gen(function* () {
      let lookupCount = 0;
      let finalizedCount = 0;
      const cache = yield* ScopedCache.make({
        lookup: () => {
          lookupCount += 1;
          return lookupCount === 1
            ? Effect.acquireRelease(Effect.void, () =>
                Effect.sync(() => void finalizedCount++),
              ).pipe(Effect.andThen(Effect.fail("temporary failure")))
            : Effect.succeed("recovered");
        },
      });
      const scope = yield* Scope.make();

      const first = yield* Effect.exit(Scope.provide(cache.get("alpha"), scope));
      expect(Exit.isFailure(first)).toBe(true);
      expect(finalizedCount).toBe(1);
      expect(yield* Scope.provide(cache.get("alpha"), scope)).toBe("recovered");
      expect(lookupCount).toBe(2);
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
