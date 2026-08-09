import type { CacheDriver, ParentCacheDriver } from "dfx/Cache/driver";
import { createParentDriver } from "dfx/Cache/driver";
import {
  createReverseLookupDriver,
  type ParentCachePage,
  type ParentCachePageSize,
  type ReverseLookupCacheDriver,
} from "./driver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Semaphore from "effect/Semaphore";
import { prefixStorage, type Storage } from "unstorage";

export interface UnstorageOpts {
  /** The unstorage storage instance */
  readonly storage: Storage;

  /**
   * The prefix for cache item keys in storage.
   * Defaults to no prefix.
   */
  readonly prefix?: string;
}

export interface UnstorageWithParentOpts extends UnstorageOpts {
  /**
   * The prefix for parent-to-child mapping keys in storage.
   * Defaults to "mapping:".
   */
  readonly mappingPrefix?: string;
}

export interface UnstorageWithReverseLookupOpts extends UnstorageOpts {
  /**
   * The prefix for parent-to-child mapping keys in storage.
   * Defaults to "mapping:".
   */
  readonly mappingPrefix?: string;

  /**
   * The prefix for reverse lookup (resource-to-parent) mapping keys.
   * Defaults to "reverse:".
   */
  readonly reversePrefix?: string;
}

const parentCachePageScanMultiplier = 10;
const maximumStaleIndexRepairsPerCall = 1_000;
const cachePopulationConcurrency = 32;

const readPageEntries = <T>(
  storage: Storage,
  parentId: string,
  orderedIds: ReadonlyArray<string>,
  start: number,
  limit: ParentCachePageSize,
) =>
  Effect.gen(function* () {
    const entries: Array<readonly [string, T]> = [];
    const staleIds: Array<string> = [];
    const scanLimit = limit * parentCachePageScanMultiplier;
    let scanned = 0;
    let index = start;
    while (index < orderedIds.length && entries.length <= limit && scanned < scanLimit) {
      const batchSize = Math.min(limit + 1 - entries.length, scanLimit - scanned);
      const batchIds = orderedIds.slice(index, index + batchSize);
      const batch = yield* Effect.forEach(
        batchIds,
        (resourceId) =>
          Effect.promise(async () => {
            const value = (await storage.getItem(`${parentId}:${resourceId}`)) as T | null;
            return [resourceId, value] as const;
          }),
        { concurrency: "unbounded" },
      );
      for (const [resourceId, value] of batch) {
        if (Predicate.isNotNull(value)) {
          entries.push([resourceId, value]);
        } else {
          staleIds.push(resourceId);
        }
      }
      index += batchIds.length;
      scanned += batchIds.length;
    }
    return { entries, hasMoreIds: index < orderedIds.length, index, staleIds };
  });

const makeStorage = (storage: Storage, prefix?: string) =>
  prefix ? prefixStorage(storage, prefix) : storage;

const getStoredIds = (storage: Storage, key: string): Effect.Effect<Set<string>, never> =>
  Effect.promise(async () => {
    const value = await storage.getItem<string[]>(key);
    const ids = value ?? [];
    const isSorted = ids.every((id, index) => index === 0 || ids[index - 1]! <= id);
    return new Set(isSorted ? ids : [...ids].sort());
  });

const setStoredIds = (
  storage: Storage,
  key: string,
  ids: Set<string>,
): Effect.Effect<void, never> =>
  Effect.promise(async () => {
    if (ids.size === 0) {
      await storage.removeItem(key);
    } else {
      await storage.setItem(key, Array.from(ids).sort());
    }
  });

const makeStoredIdIndex = (storage: Storage) => ({
  get: (key: string): Effect.Effect<Set<string>, never> => getStoredIds(storage, key),
  set: (key: string, ids: Set<string>): Effect.Effect<void, never> =>
    setStoredIds(storage, key, ids),
});

const indexAfterCursor = (orderedIds: ReadonlyArray<string>, cursor: string): number => {
  let lower = 0;
  let upper = orderedIds.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (orderedIds[middle]! <= cursor) lower = middle + 1;
    else upper = middle;
  }
  return lower;
};

const makeParentCachePage = <T>(
  entries: ReadonlyArray<readonly [string, T]>,
  orderedIds: ReadonlyArray<string>,
  index: number,
  hasMoreIds: boolean,
  cursor: string | undefined,
  limit: ParentCachePageSize,
): Option.Option<ParentCachePage<T>> => {
  if (entries.length === 0) {
    if (hasMoreIds) {
      return Option.some({ entries: new Map(), nextCursor: orderedIds[index - 1]! });
    }
    return Predicate.isUndefined(cursor) ? Option.none() : Option.some({ entries: new Map() });
  }

  const visible = entries.slice(0, limit);
  const page = new Map(visible);
  if (entries.length > limit) {
    return Option.some({ entries: page, nextCursor: visible[visible.length - 1]![0] });
  }
  return Option.some(
    hasMoreIds ? { entries: page, nextCursor: orderedIds[index - 1]! } : { entries: page },
  );
};

// Simple cache driver (no parent)
const make = <T>(opts: UnstorageOpts): CacheDriver<never, T> => {
  const { prefix = "", storage } = opts;
  const prefixedStorage = makeStorage(storage, prefix);

  const driver: CacheDriver<never, T> = {
    size: Effect.promise(() => prefixedStorage.getKeys("").then((keys) => keys.length)),

    get: (resourceId) =>
      Effect.promise(async () => {
        const value = (await prefixedStorage.getItem(resourceId)) as T | null;
        return Option.fromNullishOr(value);
      }),

    refreshTTL: () => Effect.void,

    set: (resourceId, resource) =>
      Effect.promise(() => prefixedStorage.setItem(resourceId, resource as never)),

    delete: (resourceId) => Effect.promise(() => prefixedStorage.removeItem(resourceId)),

    run: Effect.never,
  };

  return driver;
};

export const create = <T>(opts: UnstorageOpts): Effect.Effect<CacheDriver<never, T>> =>
  Effect.sync(() => make<T>(opts));

// Parent cache driver (without reverse lookup)
export const createWithParent = <T>({
  mappingPrefix = "mapping:",
  ...opts
}: UnstorageWithParentOpts): Effect.Effect<ParentCacheDriver<never, T>> =>
  Effect.sync(() => {
    const store = make<T>(opts);
    const { storage } = opts;

    const mappingStorage = makeStorage(storage, mappingPrefix);

    const { get: getParentIds, set: setParentIds } = makeStoredIdIndex(mappingStorage);

    return createParentDriver({
      size: store.size,
      sizeForParent: Effect.fnUntraced(function* (parentId) {
        const ids = yield* getParentIds(parentId);
        return ids.size;
      }),

      refreshTTL: () => Effect.void,

      get: (_, id) => store.get(id),

      getForParent: Effect.fnUntraced(function* (parentId) {
        const ids = yield* getParentIds(parentId);
        if (ids.size === 0) return Option.none();

        const entries = yield* Effect.forEach(
          Array.from(ids),
          (id) => store.get(id).pipe(Effect.map((item) => [id, item] as const)),
          { concurrency: "unbounded" },
        );

        const result = new Map<string, T>();
        const validIds = new Set<string>();
        for (const [id, item] of entries) {
          if (Option.isSome(item)) {
            result.set(id, item.value);
            validIds.add(id);
          }
        }

        if (validIds.size !== ids.size) {
          yield* setParentIds(parentId, validIds);
        }

        return result.size > 0 ? Option.some(result) : Option.none();
      }),

      set: Effect.fnUntraced(
        function* (parentId, resourceId, resource) {
          yield* store.set(resourceId, resource);

          const existingIds = yield* getParentIds(parentId);
          existingIds.add(resourceId);
          yield* setParentIds(parentId, existingIds);
        },
        Effect.catchDefect((e) => Effect.logWarning("Cache set failed", e)),
      ),

      delete: Effect.fnUntraced(
        function* (parentId, resourceId) {
          yield* store.delete(resourceId);

          const existingIds = yield* getParentIds(parentId);
          existingIds.delete(resourceId);
          yield* setParentIds(parentId, existingIds);
        },
        Effect.catchDefect((e) => Effect.logWarning("Cache delete failed", e)),
      ),

      parentDelete: Effect.fnUntraced(
        function* (parentId) {
          const ids = yield* getParentIds(parentId);
          yield* setParentIds(parentId, new Set());

          const effects: Effect.Effect<void, never>[] = [];
          for (const id of ids) {
            effects.push(store.delete(id));
          }
          yield* Effect.all(effects, { concurrency: "unbounded", discard: true });
        },
        Effect.catchDefect((e) => Effect.logWarning("Cache parentDelete failed", e)),
      ),

      run: Effect.never,
    });
  });

// Parent cache driver with reverse lookup
export const createWithReverseLookup = <T>({
  mappingPrefix = "mapping:",
  reversePrefix = "reverse:",
  ...opts
}: UnstorageWithReverseLookupOpts): Effect.Effect<ReverseLookupCacheDriver<never, T>> =>
  Effect.sync(() => {
    const { storage } = opts;
    const { prefix = "" } = opts;
    const prefixedStorage = makeStorage(storage, prefix);
    const mappingStorage = makeStorage(storage, mappingPrefix);
    const reverseStorage = makeStorage(storage, reversePrefix);
    interface KeyedLock {
      readonly semaphore: Semaphore.Semaphore;
      references: number;
    }
    const parentLocks = new Map<string, KeyedLock>();
    const resourceLocks = new Map<string, KeyedLock>();
    const withKeyPermit = <A, E, R>(
      locks: Map<string, KeyedLock>,
      key: string,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          let lock = locks.get(key);
          if (Predicate.isUndefined(lock)) {
            lock = { semaphore: Semaphore.makeUnsafe(1), references: 0 };
            locks.set(key, lock);
          }
          lock.references += 1;
          return lock;
        }),
        (acquired) => acquired.semaphore.withPermit(effect),
        (acquired) =>
          Effect.sync(() => {
            acquired.references -= 1;
            if (acquired.references === 0 && locks.get(key) === acquired) locks.delete(key);
          }),
      );
    const withParentPermit = <A, E, R>(
      parentId: string,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => withKeyPermit(parentLocks, parentId, effect);
    const withResourcePermit = <A, E, R>(
      resourceId: string,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => withKeyPermit(resourceLocks, resourceId, effect);
    const { get: getParentIds, set: setParentIds } = makeStoredIdIndex(mappingStorage);
    const { get: getResourceParentIds, set: setResourceParentIds } =
      makeStoredIdIndex(reverseStorage);

    const removeStaleIds = (
      withOwnerPermit: (
        ownerId: string,
        effect: Effect.Effect<void, never>,
      ) => Effect.Effect<void, never>,
      ownerId: string,
      getIds: (ownerId: string) => Effect.Effect<Set<string>, never>,
      setIds: (ownerId: string, ids: Set<string>) => Effect.Effect<void, never>,
      staleIds: ReadonlyArray<string>,
      storageKey: (staleId: string) => string,
    ) =>
      withOwnerPermit(
        ownerId,
        Effect.gen(function* () {
          const currentIds = yield* getIds(ownerId);
          const repairIds = staleIds.slice(0, maximumStaleIndexRepairsPerCall);
          const currentValues = yield* Effect.forEach(
            repairIds,
            (staleId) => Effect.promise(() => prefixedStorage.getItem(storageKey(staleId))),
            { concurrency: cachePopulationConcurrency },
          );
          let changed = false;
          for (const [index, value] of currentValues.entries()) {
            if (Predicate.isNull(value)) changed = currentIds.delete(repairIds[index]!) || changed;
          }
          if (changed) yield* setIds(ownerId, currentIds);
        }),
      );

    const removeStaleResourceIds = (parentId: string, staleIds: ReadonlyArray<string>) =>
      removeStaleIds(
        withParentPermit,
        parentId,
        getParentIds,
        setParentIds,
        staleIds,
        (resourceId) => `${parentId}:${resourceId}`,
      );

    const removeStaleParentIds = (resourceId: string, staleParentIds: ReadonlyArray<string>) =>
      removeStaleIds(
        withResourcePermit,
        resourceId,
        getResourceParentIds,
        setResourceParentIds,
        staleParentIds,
        (parentId) => `${parentId}:${resourceId}`,
      );

    const setForParent = (
      parentId: string,
      entries: ReadonlyArray<readonly [resourceId: string, resource: T]>,
    ): Effect.Effect<void, never> => {
      const uniqueEntries = Array.from(new Map(entries));
      if (uniqueEntries.length === 0) return Effect.void;
      const resourceIds = uniqueEntries.map(([resourceId]) => resourceId);
      return Effect.andThen(
        withParentPermit(
          parentId,
          Effect.gen(function* () {
            yield* Effect.forEach(
              uniqueEntries,
              ([resourceId, resource]) =>
                Effect.promise(() =>
                  prefixedStorage.setItem(`${parentId}:${resourceId}`, resource as never),
                ),
              { concurrency: cachePopulationConcurrency, discard: true },
            );
            const existingIds = yield* getParentIds(parentId);
            for (const resourceId of resourceIds) existingIds.add(resourceId);
            yield* setParentIds(parentId, existingIds);
          }),
        ),
        Effect.forEach(
          resourceIds,
          (resourceId) =>
            withResourcePermit(
              resourceId,
              Effect.gen(function* () {
                const value = yield* Effect.promise(() =>
                  prefixedStorage.getItem(`${parentId}:${resourceId}`),
                );
                if (Predicate.isNull(value)) return;
                const existingParentIds = yield* getResourceParentIds(resourceId);
                existingParentIds.add(parentId);
                yield* setResourceParentIds(resourceId, existingParentIds);
              }),
            ),
          { concurrency: cachePopulationConcurrency, discard: true },
        ),
      );
    };

    const driver: ReverseLookupCacheDriver<never, T> = {
      size: Effect.promise(() => prefixedStorage.getKeys("").then((keys) => keys.length)),

      sizeForParent: Effect.fnUntraced(function* (parentId) {
        const ids = yield* getParentIds(parentId);
        return ids.size;
      }),

      sizeForResource: Effect.fnUntraced(function* (resourceId) {
        const parentIds = yield* getResourceParentIds(resourceId);
        return parentIds.size;
      }),

      get: (parentId, resourceId) =>
        Effect.promise(async () => {
          const value = (await prefixedStorage.getItem(`${parentId}:${resourceId}`)) as T | null;
          return Option.fromNullishOr(value);
        }),

      getForParent: Effect.fnUntraced(function* (parentId) {
        const ids = yield* withParentPermit(parentId, getParentIds(parentId));
        if (ids.size === 0) return Option.none();

        const entries = yield* Effect.forEach(
          Array.from(ids),
          (resourceId) =>
            Effect.promise(async () => {
              const value = (await prefixedStorage.getItem(
                `${parentId}:${resourceId}`,
              )) as T | null;
              return [resourceId, value] as const;
            }),
          { concurrency: "unbounded" },
        );

        const result = new Map<string, T>();
        const validIds = new Set<string>();
        for (const [id, value] of entries) {
          if (Predicate.isNotNull(value)) {
            result.set(id, value);
            validIds.add(id);
          }
        }

        const staleIds = Array.from(ids).filter((id) => !validIds.has(id));
        if (staleIds.length > 0) {
          yield* removeStaleResourceIds(parentId, staleIds);
        }

        return result.size > 0 ? Option.some(result) : Option.none();
      }),

      getPageForParent: Effect.fnUntraced(function* (parentId, cursor, limit) {
        const ids = yield* withParentPermit(parentId, getParentIds(parentId));
        if (ids.size === 0) return Option.none();

        const orderedIds = Array.from(ids);
        const start = Predicate.isUndefined(cursor) ? 0 : indexAfterCursor(orderedIds, cursor);
        if (start >= orderedIds.length) {
          return Option.some<ParentCachePage<T>>({ entries: new Map() });
        }

        const { entries, hasMoreIds, index, staleIds } = yield* readPageEntries<T>(
          prefixedStorage,
          parentId,
          orderedIds,
          start,
          limit,
        );

        if (staleIds.length > 0) {
          yield* removeStaleResourceIds(parentId, staleIds);
        }
        return makeParentCachePage(entries, orderedIds, index, hasMoreIds, cursor, limit);
      }),

      getForResource: Effect.fnUntraced(function* (resourceId) {
        const parentIds = yield* withResourcePermit(resourceId, getResourceParentIds(resourceId));
        if (parentIds.size === 0) return Option.none();

        const entries = yield* Effect.forEach(
          Array.from(parentIds),
          (parentId) =>
            Effect.promise(async () => {
              const value = (await prefixedStorage.getItem(
                `${parentId}:${resourceId}`,
              )) as T | null;
              return [parentId, value] as const;
            }),
          { concurrency: "unbounded" },
        );

        const result = new Map<string, T>();
        const validParentIds = new Set<string>();
        for (const [parentId, value] of entries) {
          if (Predicate.isNotNull(value)) {
            result.set(parentId, value);
            validParentIds.add(parentId);
          }
        }

        const staleParentIds = Array.from(parentIds).filter((id) => !validParentIds.has(id));
        if (staleParentIds.length > 0) {
          yield* removeStaleParentIds(resourceId, staleParentIds);
        }

        return result.size > 0 ? Option.some(result) : Option.none();
      }),

      setForParent,

      set: (parentId, resourceId, resource) => setForParent(parentId, [[resourceId, resource]]),

      delete: Effect.fnUntraced(function* (parentId, resourceId) {
        yield* withResourcePermit(
          resourceId,
          Effect.gen(function* () {
            yield* withParentPermit(
              parentId,
              Effect.gen(function* () {
                yield* Effect.promise(() =>
                  prefixedStorage.removeItem(`${parentId}:${resourceId}`),
                );
                const existingIds = yield* getParentIds(parentId);
                existingIds.delete(resourceId);
                yield* setParentIds(parentId, existingIds);
              }),
            );
            const existingParentIds = yield* getResourceParentIds(resourceId);
            existingParentIds.delete(parentId);
            yield* setResourceParentIds(resourceId, existingParentIds);
          }),
        );
      }),

      parentDelete: Effect.fnUntraced(function* (parentId) {
        const ids = yield* withParentPermit(
          parentId,
          Effect.gen(function* () {
            const existingIds = yield* getParentIds(parentId);
            yield* Effect.forEach(
              existingIds,
              (resourceId) =>
                Effect.promise(() => prefixedStorage.removeItem(`${parentId}:${resourceId}`)),
              { concurrency: cachePopulationConcurrency, discard: true },
            );
            yield* setParentIds(parentId, new Set());
            return existingIds;
          }),
        );
        yield* Effect.forEach(
          ids,
          (resourceId) =>
            withResourcePermit(
              resourceId,
              Effect.gen(function* () {
                const value = yield* Effect.promise(() =>
                  prefixedStorage.getItem(`${parentId}:${resourceId}`),
                );
                if (Predicate.isNotNull(value)) return;
                const existingParentIds = yield* getResourceParentIds(resourceId);
                existingParentIds.delete(parentId);
                yield* setResourceParentIds(resourceId, existingParentIds);
              }),
            ),
          { concurrency: cachePopulationConcurrency, discard: true },
        );
      }),

      resourceDelete: Effect.fnUntraced(function* (resourceId) {
        yield* withResourcePermit(
          resourceId,
          Effect.gen(function* () {
            const parentIds = yield* getResourceParentIds(resourceId);
            yield* Effect.forEach(
              parentIds,
              (parentId) =>
                withParentPermit(
                  parentId,
                  Effect.gen(function* () {
                    yield* Effect.promise(() =>
                      prefixedStorage.removeItem(`${parentId}:${resourceId}`),
                    );
                    const existingIds = yield* getParentIds(parentId);
                    existingIds.delete(resourceId);
                    yield* setParentIds(parentId, existingIds);
                  }),
                ),
              { concurrency: cachePopulationConcurrency, discard: true },
            );
            yield* setResourceParentIds(resourceId, new Set());
          }),
        );
      }),

      refreshTTL: () => Effect.void,

      run: Effect.never,
    };

    return createReverseLookupDriver(driver);
  });
