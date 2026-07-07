import type { CacheDriver } from "dfx/Cache/driver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { CacheReadonlyError } from "../discord/schema";
import type { ReverseLookupCacheDriver } from "./driver";
import type { ReverseLookupCacheOp } from "./prelude";

const retryPolicy = Schedule.exponential("500 millis").pipe(
  Schedule.andThen(Schedule.spaced("10 seconds")),
);

// Conditional type for put operation based on readonly flag
type PutEffect<ReadonlyValue extends boolean, EDriver, EMiss, EId> = ReadonlyValue extends true
  ? Effect.Effect<never, CacheReadonlyError, never>
  : Effect.Effect<void, EDriver | EMiss | EId>;

// Conditional type for update operation based on readonly flag
type UpdateEffect<
  ReadonlyValue extends boolean,
  A,
  EDriver,
  EMiss,
  E,
  R,
> = ReadonlyValue extends true
  ? Effect.Effect<never, CacheReadonlyError, never>
  : Effect.Effect<A, EDriver | EMiss | E, R>;

// Conditional type for write operations (set, delete, refreshTTL) based on readonly flag
type WriteEffect<ReadonlyValue extends boolean, EDriver> = ReadonlyValue extends true
  ? Effect.Effect<never, CacheReadonlyError, never>
  : Effect.Effect<void, EDriver>;

export interface ReverseLookupCache<
  EDriver,
  EMiss,
  EPMiss,
  ERMiss,
  A,
  ReadonlyValue extends boolean = false,
> {
  readonly get: (parentId: string, resourceId: string) => Effect.Effect<A, EMiss | EDriver>;
  readonly put: (_: A) => PutEffect<ReadonlyValue, EDriver, EMiss, never>;
  readonly update: <R, E>(
    parentId: string,
    resourceId: string,
    f: (_: A) => Effect.Effect<A, E, R>,
  ) => UpdateEffect<ReadonlyValue, A, EDriver, EMiss, E, R>;
  readonly getForParent: (
    parentId: string,
  ) => Effect.Effect<ReadonlyMap<string, A>, EDriver | EPMiss>;
  readonly getForResource: (
    resourceId: string,
  ) => Effect.Effect<ReadonlyMap<string, A>, EMiss | EDriver | ERMiss>;
  readonly size: Effect.Effect<number, EDriver>;
  readonly sizeForParent: (parentId: string) => Effect.Effect<number, EDriver>;
  readonly sizeForResource: (resourceId: string) => Effect.Effect<number, EDriver>;
  readonly set: (
    parentId: string,
    resourceId: string,
    resource: A,
  ) => WriteEffect<ReadonlyValue, EDriver>;
  readonly delete: (parentId: string, resourceId: string) => WriteEffect<ReadonlyValue, EDriver>;
  readonly parentDelete: (parentId: string) => WriteEffect<ReadonlyValue, EDriver>;
  readonly resourceDelete: (resourceId: string) => WriteEffect<ReadonlyValue, EDriver>;
  readonly refreshTTL: (
    parentId: string,
    resourceId: string,
  ) => WriteEffect<ReadonlyValue, EDriver>;
}

export const makeWithReverseLookup = Effect.fn("cache.makeWithReverseLookup")(
  function* <
    EOps,
    EDriver,
    EMiss,
    EPMiss,
    ERMiss,
    A,
    EId = never,
    const ReadonlyValue extends boolean = false,
  >(args: {
    driver: ReverseLookupCacheDriver<EDriver, A>;
    ops?: Stream.Stream<ReverseLookupCacheOp<A>, EOps>;
    id: (_: A) => Effect.Effect<readonly [parentId: string, resourceId: string], EId>;
    onMiss: (parentId: string, resourceId: string) => Effect.Effect<A, EMiss>;
    onParentMiss: (parentId: string) => Effect.Effect<readonly (readonly [string, A])[], EPMiss>;
    onResourceMiss: (
      resourceId: string,
    ) => Effect.Effect<readonly (readonly [string, A])[], ERMiss>;
    readonly?: ReadonlyValue;
  }) {
    const {
      driver,
      id,
      onMiss,
      onParentMiss,
      onResourceMiss,
      ops = Stream.empty,
      readonly = false as ReadonlyValue,
    } = args;

    // In readonly mode, we still consume the ops stream but don't apply writes
    yield* Stream.runDrain(
      Stream.tap(ops, (op): Effect.Effect<void, EDriver> => {
        if (readonly) {
          // Skip all write operations in readonly mode
          return Effect.void;
        }
        switch (op.op) {
          case "create":
          case "update":
            return driver.set(op.parentId, op.resourceId, op.resource);

          case "delete":
            return driver.delete(op.parentId, op.resourceId);

          case "parentDelete":
            return driver.parentDelete(op.parentId);

          case "resourceDelete":
            return driver.resourceDelete(op.resourceId);
        }
      }),
    ).pipe(
      Effect.tapCause((_) => Effect.logError("ops error, restarting", _)),
      Effect.retry(retryPolicy),
      Effect.forkScoped,
      Effect.interruptible,
    );

    yield* driver.run.pipe(
      Effect.tapCause((_) => Effect.logError("cache driver error, restarting", _)),
      Effect.retry(retryPolicy),
      Effect.forkScoped,
      Effect.interruptible,
    );

    const get = (parentId: string, resourceId: string) =>
      Effect.flatMap(
        driver.get(parentId, resourceId),
        Option.match({
          onNone: () =>
            readonly
              ? onMiss(parentId, resourceId) // In readonly mode, don't cache the result
              : Effect.tap(onMiss(parentId, resourceId), (a) =>
                  driver.set(parentId, resourceId, a),
                ),
          onSome: Effect.succeed,
        }),
      );

    const put = ((_: A) =>
      readonly
        ? (Effect.fail(
            new CacheReadonlyError({ message: "Cannot put in readonly cache" }),
          ) as PutEffect<typeof readonly, EDriver, EMiss, EId>)
        : Effect.flatMap(id(_), ([parentId, resourceId]) =>
            driver.set(parentId, resourceId, _),
          )) as (_: A) => PutEffect<ReadonlyValue, EDriver, EMiss, EId>;

    const update = (<R, E>(
      parentId: string,
      resourceId: string,
      f: (_: A) => Effect.Effect<A, E, R>,
    ) =>
      readonly
        ? (Effect.fail(
            new CacheReadonlyError({ message: "Cannot update in readonly cache" }),
          ) as UpdateEffect<typeof readonly, A, EDriver, EMiss, E, R>)
        : get(parentId, resourceId).pipe(
            Effect.flatMap(f),
            Effect.tap((a) => driver.set(parentId, resourceId, a)),
          )) as <R, E>(
      parentId: string,
      resourceId: string,
      f: (_: A) => Effect.Effect<A, E, R>,
    ) => UpdateEffect<ReadonlyValue, A, EDriver, EMiss, E, R>;

    return {
      get,
      put,
      update,
      size: driver.size,
      sizeForParent: driver.sizeForParent,
      sizeForResource: driver.sizeForResource,

      getForParent: (parentId: string) =>
        Effect.flatMap(
          driver.getForParent(parentId),
          Option.match({
            onNone: () =>
              readonly
                ? onParentMiss(parentId).pipe(
                    // In readonly mode, don't cache the result
                    Effect.map((entries) => new Map(entries) as ReadonlyMap<string, A>),
                  )
                : onParentMiss(parentId).pipe(
                    Effect.tap((entries) =>
                      Effect.all(entries.map(([id, a]) => driver.set(parentId, id, a))),
                    ),
                    Effect.map((entries) => new Map(entries) as ReadonlyMap<string, A>),
                  ),
            onSome: Effect.succeed,
          }),
        ),

      getForResource: (resourceId: string) =>
        Effect.flatMap(
          driver.getForResource(resourceId),
          Option.match({
            onNone: () =>
              readonly
                ? onResourceMiss(resourceId).pipe(
                    // In readonly mode, don't cache the result
                    Effect.map((entries) => new Map(entries) as ReadonlyMap<string, A>),
                  )
                : onResourceMiss(resourceId).pipe(
                    Effect.tap((entries) =>
                      Effect.all(
                        entries.map(([parentId, a]) => driver.set(parentId, resourceId, a)),
                      ),
                    ),
                    Effect.map((entries) => new Map(entries) as ReadonlyMap<string, A>),
                  ),
            onSome: Effect.succeed,
          }),
        ),
      refreshTTL: ((parentId: string, resourceId: string) =>
        readonly
          ? (Effect.fail(
              new CacheReadonlyError({ message: "Cannot refreshTTL in readonly cache" }),
            ) as WriteEffect<typeof readonly, EDriver>)
          : driver.refreshTTL(parentId, resourceId)) as (
        parentId: string,
        resourceId: string,
      ) => WriteEffect<ReadonlyValue, EDriver>,
      set: ((parentId: string, resourceId: string, resource: A) =>
        readonly
          ? (Effect.fail(
              new CacheReadonlyError({ message: "Cannot set in readonly cache" }),
            ) as WriteEffect<typeof readonly, EDriver>)
          : driver.set(parentId, resourceId, resource)) as (
        parentId: string,
        resourceId: string,
        resource: A,
      ) => WriteEffect<ReadonlyValue, EDriver>,
      delete: ((parentId: string, resourceId: string) =>
        readonly
          ? (Effect.fail(
              new CacheReadonlyError({ message: "Cannot delete in readonly cache" }),
            ) as WriteEffect<typeof readonly, EDriver>)
          : driver.delete(parentId, resourceId)) as (
        parentId: string,
        resourceId: string,
      ) => WriteEffect<ReadonlyValue, EDriver>,
      parentDelete: ((parentId: string) =>
        readonly
          ? (Effect.fail(
              new CacheReadonlyError({ message: "Cannot parentDelete in readonly cache" }),
            ) as WriteEffect<typeof readonly, EDriver>)
          : driver.parentDelete(parentId)) as (
        parentId: string,
      ) => WriteEffect<ReadonlyValue, EDriver>,
      resourceDelete: ((resourceId: string) =>
        readonly
          ? (Effect.fail(
              new CacheReadonlyError({ message: "Cannot resourceDelete in readonly cache" }),
            ) as WriteEffect<typeof readonly, EDriver>)
          : driver.resourceDelete(resourceId)) as (
        resourceId: string,
      ) => WriteEffect<ReadonlyValue, EDriver>,
    } as ReverseLookupCache<EDriver, EMiss | EId, EPMiss, ERMiss, A, ReadonlyValue>;
  },
  Effect.annotateLogs({
    package: "dfx-discord-utils",
    service: "ReverseLookupCache",
  }),
);

// ============================================================================
// Simple Cache (non-parented, like dfx/Cache but with readonly support)
// ============================================================================

// Simple cache operations
type SimpleCacheOp<T> =
  | { op: "create"; resourceId: string; resource: T }
  | { op: "update"; resourceId: string; resource: T }
  | { op: "delete"; resourceId: string };

// Conditional type for put operation based on readonly flag
type SimplePutEffect<ReadonlyValue extends boolean, EDriver> = ReadonlyValue extends true
  ? Effect.Effect<never, CacheReadonlyError, never>
  : Effect.Effect<void, EDriver>;

// Conditional type for update operation based on readonly flag
type SimpleUpdateEffect<
  ReadonlyValue extends boolean,
  A,
  EDriver,
  EMiss,
  E,
  R,
> = ReadonlyValue extends true
  ? Effect.Effect<never, CacheReadonlyError, never>
  : Effect.Effect<A, EDriver | EMiss | E, R>;

// Conditional type for set/delete operations based on readonly flag
type SimpleWriteEffect<ReadonlyValue extends boolean, EDriver> = ReadonlyValue extends true
  ? Effect.Effect<never, CacheReadonlyError, never>
  : Effect.Effect<void, EDriver>;

export interface SimpleCache<EDriver, EMiss, A, ReadonlyValue extends boolean = false> {
  readonly get: (id: string) => Effect.Effect<A, EDriver | EMiss>;
  readonly put: (_: A) => SimplePutEffect<ReadonlyValue, EDriver>;
  readonly update: <R, E>(
    id: string,
    f: (_: A) => Effect.Effect<A, E, R>,
  ) => SimpleUpdateEffect<ReadonlyValue, A, EDriver, EMiss, E, R>;
  readonly size: Effect.Effect<number, EDriver>;
  readonly set: (resourceId: string, resource: A) => SimpleWriteEffect<ReadonlyValue, EDriver>;
  readonly delete: (resourceId: string) => SimpleWriteEffect<ReadonlyValue, EDriver>;
  readonly refreshTTL: (resourceId: string) => SimpleWriteEffect<ReadonlyValue, EDriver>;
}

export const make = Effect.fn("cache.make")(
  function* <EOps, EDriver, EMiss, A, const ReadonlyValue extends boolean = false>(args: {
    driver: CacheDriver<EDriver, A>;
    ops?: Stream.Stream<SimpleCacheOp<A>, EOps>;
    id: (_: A) => string;
    onMiss: (id: string) => Effect.Effect<A, EMiss>;
    readonly?: ReadonlyValue;
  }) {
    const { driver, id, onMiss, ops = Stream.empty, readonly = false as ReadonlyValue } = args;

    // In readonly mode, we still consume the ops stream but don't apply writes
    yield* Stream.runDrain(
      Stream.tap(ops, (op): Effect.Effect<void, EDriver> => {
        if (readonly) {
          // Skip all write operations in readonly mode
          return Effect.void;
        }
        switch (op.op) {
          case "create":
          case "update":
            return driver.set(op.resourceId, op.resource);

          case "delete":
            return driver.delete(op.resourceId);
        }
      }),
    ).pipe(
      Effect.tapCause((_) => Effect.logError("ops error, restarting", _)),
      Effect.retry(retryPolicy),
      Effect.forkScoped,
      Effect.interruptible,
    );

    yield* driver.run.pipe(
      Effect.tapCause((_) => Effect.logError("cache driver error, restarting", _)),
      Effect.retry(retryPolicy),
      Effect.forkScoped,
      Effect.interruptible,
    );

    const get = (id: string) =>
      Effect.flatMap(
        driver.get(id),
        Option.match({
          onNone: () =>
            readonly
              ? onMiss(id) // In readonly mode, don't cache the result
              : Effect.tap(onMiss(id), (a) => driver.set(id, a)),
          onSome: Effect.succeed,
        }),
      );

    const put = ((_: A) =>
      readonly
        ? (Effect.fail(
            new CacheReadonlyError({ message: "Cannot put in readonly cache" }),
          ) as SimplePutEffect<typeof readonly, EDriver>)
        : driver.set(id(_), _)) as (_: A) => SimplePutEffect<ReadonlyValue, EDriver>;

    const update = (<R, E>(resourceId: string, f: (_: A) => Effect.Effect<A, E, R>) =>
      readonly
        ? (Effect.fail(
            new CacheReadonlyError({ message: "Cannot update in readonly cache" }),
          ) as SimpleUpdateEffect<typeof readonly, A, EDriver, EMiss, E, R>)
        : get(resourceId).pipe(
            Effect.flatMap(f),
            Effect.tap((a) => driver.set(resourceId, a)),
          )) as <R, E>(
      resourceId: string,
      f: (_: A) => Effect.Effect<A, E, R>,
    ) => SimpleUpdateEffect<ReadonlyValue, A, EDriver, EMiss, E, R>;

    const set = ((resourceId: string, resource: A) =>
      readonly
        ? (Effect.fail(
            new CacheReadonlyError({ message: "Cannot set in readonly cache" }),
          ) as SimpleWriteEffect<typeof readonly, EDriver>)
        : driver.set(resourceId, resource)) as (
      resourceId: string,
      resource: A,
    ) => SimpleWriteEffect<ReadonlyValue, EDriver>;

    const delete_ = ((resourceId: string) =>
      readonly
        ? (Effect.fail(
            new CacheReadonlyError({ message: "Cannot delete in readonly cache" }),
          ) as SimpleWriteEffect<typeof readonly, EDriver>)
        : driver.delete(resourceId)) as (
      resourceId: string,
    ) => SimpleWriteEffect<ReadonlyValue, EDriver>;

    const refreshTTL = ((resourceId: string) =>
      readonly
        ? (Effect.fail(
            new CacheReadonlyError({ message: "Cannot refreshTTL in readonly cache" }),
          ) as SimpleWriteEffect<typeof readonly, EDriver>)
        : driver.refreshTTL(resourceId)) as (
      resourceId: string,
    ) => SimpleWriteEffect<ReadonlyValue, EDriver>;

    return {
      get,
      put,
      update,
      set,
      delete: delete_,
      refreshTTL,
      size: driver.size,
    } as SimpleCache<EDriver, EMiss, A, ReadonlyValue>;
  },
  Effect.annotateLogs({
    package: "dfx-discord-utils",
    service: "SimpleCache",
  }),
);
