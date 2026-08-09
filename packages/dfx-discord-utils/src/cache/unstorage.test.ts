import { expect, it, layer } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";
import type { Storage } from "unstorage";
import { Unstorage } from "../discord/cache/shared";
import { ParentCachePageSize } from "./driver";
import { createWithReverseLookup } from "./unstorage";

const pageSize = Schema.decodeUnknownSync(ParentCachePageSize)(100);

it("rejects invalid cache page limits", () => {
  for (const invalid of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => Schema.decodeUnknownSync(ParentCachePageSize)(invalid)).toThrow();
  }
});

layer(Unstorage.memoryLayer)("unstorage reverse-lookup pagination", (it) => {
  it.effect("reads stable bounded pages from a large synthetic parent cache", () =>
    Effect.gen(function* () {
      const storage = yield* Unstorage;
      const resourceIds = Array.from(
        { length: 10_000 },
        (_, index) => `resource-${String(index).padStart(5, "0")}`,
      );

      yield* Effect.promise(() => storage.setItem("mapping:workspace-1", resourceIds));
      yield* Effect.promise(() =>
        storage.setItems(
          resourceIds.map((id) => ({
            key: `workspace-1:${id}`,
            value: { id },
          })),
        ),
      );

      let resourceReads = 0;
      const countingStorage: Storage = {
        ...storage,
        getItem: (key: string, options?: Parameters<Storage["getItem"]>[1]) => {
          if (key.startsWith("workspace-1:resource-")) resourceReads += 1;
          return storage.getItem(key, options);
        },
      };
      const driver = yield* createWithReverseLookup<{ readonly id: string }>({
        storage: countingStorage,
      });

      const first = yield* driver.getPageForParent("workspace-1", undefined, pageSize);
      expect(Option.getOrThrow(first)).toEqual({
        entries: new Map(resourceIds.slice(0, 100).map((id) => [id, { id }])),
        nextCursor: "resource-00099",
      });
      expect(resourceReads).toBe(101);

      resourceReads = 0;
      const second = yield* driver.getPageForParent("workspace-1", "resource-00099", pageSize);
      expect(Option.getOrThrow(second)).toEqual({
        entries: new Map(resourceIds.slice(100, 200).map((id) => [id, { id }])),
        nextCursor: "resource-00199",
      });
      expect(resourceReads).toBe(101);

      resourceReads = 0;
      const last = yield* driver.getPageForParent("workspace-1", "resource-09994", pageSize);
      expect(Option.getOrThrow(last)).toEqual({
        entries: new Map(resourceIds.slice(9_995).map((id) => [id, { id }])),
      });
      expect(resourceReads).toBe(5);

      yield* Effect.promise(() =>
        storage.setItem("mapping:workspace-unsorted", ["resource-c", "resource-a", "resource-b"]),
      );
      yield* Effect.promise(() =>
        storage.setItems(
          ["resource-a", "resource-b", "resource-c"].map((id) => ({
            key: `workspace-unsorted:${id}`,
            value: { id },
          })),
        ),
      );
      expect(
        Option.getOrThrow(
          yield* driver.getPageForParent("workspace-unsorted", "resource-a", pageSize),
        ),
      ).toEqual({
        entries: new Map([
          ["resource-b", { id: "resource-b" }],
          ["resource-c", { id: "resource-c" }],
        ]),
      });

      yield* Effect.promise(() => storage.setItem("mapping:workspace-stale", ["missing"]));
      expect(
        Option.isNone(yield* driver.getPageForParent("workspace-stale", undefined, pageSize)),
      ).toBe(true);
      expect(yield* Effect.promise(() => storage.getItem("mapping:workspace-stale"))).toBeNull();

      yield* Effect.promise(() =>
        storage.setItem("mapping:workspace-stale-tail", ["present", "stale"]),
      );
      yield* Effect.promise(() =>
        storage.setItem("workspace-stale-tail:present", { id: "present" }),
      );
      expect(
        Option.getOrThrow(
          yield* driver.getPageForParent("workspace-stale-tail", "present", pageSize),
        ),
      ).toEqual({ entries: new Map() });
      expect(yield* Effect.promise(() => storage.getItem("mapping:workspace-stale-tail"))).toEqual([
        "present",
      ]);
    }),
  );

  it.effect("bounds stale page scans and exposes a repair cursor", () =>
    Effect.gen(function* () {
      const storage = yield* Unstorage;
      const staleIds = Array.from(
        { length: 2_500 },
        (_, index) => `stale-${String(index).padStart(5, "0")}`,
      );
      yield* Effect.promise(() => storage.setItem("mapping:workspace-stale-page", staleIds));

      let resourceReads = 0;
      const countingStorage: Storage = {
        ...storage,
        getItem: (key: string, options?: Parameters<Storage["getItem"]>[1]) => {
          if (key.startsWith("workspace-stale-page:stale-")) resourceReads += 1;
          return storage.getItem(key, options);
        },
      };
      const driver = yield* createWithReverseLookup<{ readonly id: string }>({
        storage: countingStorage,
      });

      expect(
        Option.getOrThrow(
          yield* driver.getPageForParent("workspace-stale-page", undefined, pageSize),
        ),
      ).toEqual({ entries: new Map(), nextCursor: "stale-00999" });
      // A page scans 100 × 10 IDs, then guarded repair rechecks those 1,000 misses once.
      expect(resourceReads).toBe(2_000);
      expect(
        yield* Effect.promise(() => storage.getItem<string[]>("mapping:workspace-stale-page")),
      ).toEqual(staleIds.slice(1_000));
    }),
  );

  it.effect("bulk-populates a parent with one sorted index update", () =>
    Effect.gen(function* () {
      const storage = yield* Unstorage;
      let parentIndexWrites = 0;
      const countingStorage: Storage = {
        ...storage,
        setItem: (
          key: string,
          value: Parameters<Storage["setItem"]>[1],
          options?: Parameters<Storage["setItem"]>[2],
        ) => {
          if (key === "mapping:workspace-bulk") parentIndexWrites += 1;
          return storage.setItem(key, value, options);
        },
      };
      const driver = yield* createWithReverseLookup<{ readonly id: string }>({
        storage: countingStorage,
      });

      yield* driver.setForParent("workspace-bulk", [
        ["resource-b", { id: "resource-b" }],
        ["resource-a", { id: "resource-a" }],
      ]);

      expect(parentIndexWrites).toBe(1);
      expect(yield* Effect.promise(() => storage.getItem("mapping:workspace-bulk"))).toEqual([
        "resource-a",
        "resource-b",
      ]);
      expect(yield* Effect.promise(() => storage.getItem("reverse:resource-a"))).toEqual([
        "workspace-bulk",
      ]);
      expect(yield* Effect.promise(() => storage.getItem("reverse:resource-b"))).toEqual([
        "workspace-bulk",
      ]);
    }),
  );

  it.effect("propagates storage defects from set and delete", () =>
    Effect.gen(function* () {
      const storage = yield* Unstorage;
      const driver = yield* createWithReverseLookup<{ readonly id: string }>({ storage });
      yield* driver.set("workspace-delete-failure", "resource", { id: "resource" });

      const failingStorage: Storage = {
        ...storage,
        setItem: (
          key: string,
          value: Parameters<Storage["setItem"]>[1],
          options?: Parameters<Storage["setItem"]>[2],
        ) => {
          if (key === "mapping:workspace-set-failure") {
            return Promise.reject(new Error("set index failed"));
          }
          return storage.setItem(key, value, options);
        },
        removeItem: (key: string, options?: Parameters<Storage["removeItem"]>[1]) => {
          if (key === "mapping:workspace-delete-failure") {
            return Promise.reject(new Error("delete index failed"));
          }
          return storage.removeItem(key, options);
        },
      };
      const failingDriver = yield* createWithReverseLookup<{ readonly id: string }>({
        storage: failingStorage,
      });

      const setExit = yield* Effect.exit(
        failingDriver.set("workspace-set-failure", "resource", { id: "resource" }),
      );
      const deleteExit = yield* Effect.exit(
        failingDriver.delete("workspace-delete-failure", "resource"),
      );
      expect(Exit.isFailure(setExit)).toBe(true);
      expect(Exit.isFailure(deleteExit)).toBe(true);
      if (Exit.isFailure(setExit)) {
        expect(Cause.hasDies(setExit.cause)).toBe(true);
        expect(Cause.squash(setExit.cause)).toMatchObject({ message: "set index failed" });
      }
      if (Exit.isFailure(deleteExit)) {
        expect(Cause.hasDies(deleteExit.cause)).toBe(true);
        expect(Cause.squash(deleteExit.cause)).toMatchObject({ message: "delete index failed" });
      }
    }),
  );

  it.effect("serializes stale-index repair with concurrent cache writes", () =>
    Effect.gen(function* () {
      const storage = yield* Unstorage;
      yield* Effect.promise(() => storage.setItem("mapping:workspace-race", ["stale"]));

      let announceStaleRead: () => void = () => undefined;
      const staleReadStarted = new Promise<void>((resolve) => {
        announceStaleRead = resolve;
      });
      let releaseStaleRead: () => void = () => undefined;
      const staleReadRelease = new Promise<void>((resolve) => {
        releaseStaleRead = resolve;
      });
      const coordinatedStorage: Storage = {
        ...storage,
        getItem: async (key: string, options?: Parameters<Storage["getItem"]>[1]) => {
          if (key === "workspace-race:stale") {
            announceStaleRead();
            await staleReadRelease;
            return null;
          }
          return storage.getItem(key, options);
        },
      };
      const driver = yield* createWithReverseLookup<{ readonly id: string }>({
        storage: coordinatedStorage,
      });

      const readFiber = yield* Effect.forkChild(
        driver.getPageForParent("workspace-race", undefined, pageSize),
      );
      yield* Effect.promise(() => staleReadStarted);
      const unrelatedWriteFiber = yield* Effect.forkChild(
        driver.set("workspace-other", "other", { id: "other" }),
      );
      yield* Fiber.join(unrelatedWriteFiber);
      const writeFiber = yield* Effect.forkChild(
        driver.set("workspace-race", "current", { id: "current" }),
      );
      yield* Fiber.join(writeFiber);
      releaseStaleRead();

      expect(Option.isNone(yield* Fiber.join(readFiber))).toBe(true);
      expect(yield* Effect.promise(() => storage.getItem("mapping:workspace-race"))).toEqual([
        "current",
      ]);
      expect(yield* Effect.promise(() => storage.getItem("workspace-race:current"))).toEqual({
        id: "current",
      });
      expect(yield* Effect.promise(() => storage.getItem("mapping:workspace-other"))).toEqual([
        "other",
      ]);
    }),
  );
});
