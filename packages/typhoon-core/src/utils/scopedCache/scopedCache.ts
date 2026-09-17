import {
  Deferred,
  Effect,
  Exit,
  Function,
  MutableHashMap,
  MutableRef,
  Match,
  Option,
  Scope,
  Types,
  pipe,
} from "effect";

const ScopedCacheTypeId = Symbol.for("typhoon/ScopedCache");

export type ScopedCacheTypeId = typeof ScopedCacheTypeId;

export interface Variance<in Key, out Value, out Error, out Environment> {
  readonly [ScopedCacheTypeId]: {
    readonly _Key: Types.Contravariant<Key>;
    readonly _Value: Types.Covariant<Value>;
    readonly _Error: Types.Covariant<Error>;
    readonly _Environment: Types.Covariant<Environment>;
  };
}

const scopedCacheVariance: <Key, Value, Error, Environment>() => Variance<
  Key,
  Value,
  Error,
  Environment
>[ScopedCacheTypeId] = () => ({
  _Key: Function.identity,
  _Value: Function.identity,
  _Error: Function.identity,
  _Environment: Function.identity,
});

export interface ScopedCache<in Key, out Value, out Error, out Environment> extends Variance<
  Key,
  Value,
  Error,
  Environment
> {
  get(key: Key): Effect.Effect<Value, Error, Environment | Scope.Scope>;
}

interface CachedEntry<Key, Value, Error> {
  readonly key: Key;
  readonly exit: Exit.Exit<Value, Error>;
  readonly finalizer: () => Effect.Effect<void, never, never>;
  readonly ownerCount: MutableRef.MutableRef<number>;
}

class ScopedCacheImpl<Key, Value, Error, Environment> implements ScopedCache<
  Key,
  Value,
  Error,
  Environment
> {
  readonly [ScopedCacheTypeId] = scopedCacheVariance<Key, Value, Error, Environment>();

  private readonly cache: MutableHashMap.MutableHashMap<
    Key,
    Deferred.Deferred<CachedEntry<Key, Value, Error>, never>
  > = MutableHashMap.empty();

  constructor(
    readonly lookup: (key: Key) => Effect.Effect<Value, Error, Environment | Scope.Scope>,
  ) {}

  get(key: Key): Effect.Effect<Value, Error, Environment | Scope.Scope> {
    return pipe(
      Effect.sync(() => MutableHashMap.get(this.cache, key)),
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () => this.startComputation(key),
        }),
      ),
      Effect.flatMap((deferred) => this.useEntry(deferred)),
    );
  }

  private useEntry(
    deferred: Deferred.Deferred<CachedEntry<Key, Value, Error>, never>,
  ): Effect.Effect<Value, Error, Scope.Scope> {
    return pipe(
      Deferred.await(deferred),
      Effect.flatMap((cachedEntry) =>
        Effect.acquireRelease(
          pipe(
            Effect.sync(() => MutableRef.incrementAndGet(cachedEntry.ownerCount)),
            Effect.flatMap(() => cachedEntry.exit),
          ),
          () =>
            pipe(
              Effect.sync(() => MutableRef.decrementAndGet(cachedEntry.ownerCount)),
              Effect.flatMap((count) =>
                pipe(
                  cachedEntry.finalizer(),
                  Effect.andThen(() =>
                    Effect.sync(() => MutableHashMap.remove(this.cache, cachedEntry.key)),
                  ),
                  Effect.when(Effect.succeed(count === 0)),
                ),
              ),
            ),
        ),
      ),
    );
  }

  private startComputation(
    key: Key,
  ): Effect.Effect<
    Deferred.Deferred<CachedEntry<Key, Value, Error>, never>,
    never,
    Environment | Scope.Scope
  > {
    return pipe(
      Deferred.make<CachedEntry<Key, Value, Error>, never>(),
      Effect.tap((deferred) =>
        pipe(
          Effect.sync(() => MutableHashMap.set(this.cache, key, deferred)),
          Effect.tap(() =>
            Effect.uninterruptibleMask((restore) =>
              Effect.flatMap(Effect.exit(restore(this.computeEntry(key))), (exit) => {
                const removeCachedDeferred = Effect.sync(() => {
                  const current = MutableHashMap.get(this.cache, key);
                  if (Option.isSome(current) && current.value === deferred) {
                    MutableHashMap.remove(this.cache, key);
                  }
                });
                const failedEntry = Match.value(exit).pipe(
                  Match.when({ _tag: "Success" }, ({ value }) =>
                    Match.value(value.exit).pipe(
                      Match.when({ _tag: "Failure" }, () => Option.some(value)),
                      Match.orElse(() => Option.none<CachedEntry<Key, Value, Error>>()),
                    ),
                  ),
                  Match.orElse(() => Option.none<CachedEntry<Key, Value, Error>>()),
                );
                return Option.match(failedEntry, {
                  onNone: () =>
                    Match.value(exit).pipe(
                      Match.when({ _tag: "Failure" }, () => removeCachedDeferred),
                      Match.orElse(() => Effect.void),
                    ),
                  onSome: (entry) =>
                    Effect.exit(entry.finalizer()).pipe(Effect.andThen(removeCachedDeferred)),
                }).pipe(Effect.andThen(Deferred.done(deferred, exit)));
              }),
            ),
          ),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              const current = MutableHashMap.get(this.cache, key);
              if (Option.isSome(current) && current.value === deferred) {
                MutableHashMap.remove(this.cache, key);
              }
            }),
          ),
        ),
      ),
    );
  }

  private computeEntry(
    key: Key,
  ): Effect.Effect<CachedEntry<Key, Value, Error>, never, Environment> {
    return pipe(
      Effect.Do,
      Effect.bind("innerScope", () => Scope.make()),
      Effect.bind("exit", ({ innerScope }) =>
        pipe(this.lookup(key), Scope.provide(innerScope), Effect.exit),
      ),
      Effect.map(({ exit, innerScope }) => ({
        key,
        exit,
        finalizer: () => Scope.close(innerScope, exit),
        ownerCount: MutableRef.make(0),
      })),
    );
  }
}

export type Lookup<Key, Value, Error, Environment> = (
  key: Key,
) => Effect.Effect<Value, Error, Environment | Scope.Scope>;

export const make = <Key, Value, Error, Environment>(options: {
  readonly lookup: Lookup<Key, Value, Error, Environment>;
}): Effect.Effect<ScopedCache<Key, Value, Error, Environment>, never, never> =>
  Effect.succeed(new ScopedCacheImpl(options.lookup));
