import { Context, Effect, Layer, Predicate } from "effect";
import {
  createStorage,
  joinKeys,
  prefixStorage,
  type CreateStorageOptions,
  type Storage,
  type StorageValue,
} from "unstorage";
import { default as memoryDriver } from "unstorage/drivers/memory";
import { default as redisDriver, type RedisOptions } from "unstorage/drivers/redis";

export interface ConditionalSetOptions {
  readonly ttl?: number;
}

export interface AtomicStorage extends Storage {
  readonly setItemIfAbsent: (
    key: string,
    value: StorageValue,
    options?: ConditionalSetOptions,
  ) => Promise<boolean>;
}

const hasConditionalSet = (storage: Storage): storage is AtomicStorage =>
  Predicate.hasProperty(storage, "setItemIfAbsent") &&
  Predicate.isFunction(storage.setItemIfAbsent);

// This fallback serializes writes only inside one process. Multi-process and replicated
// deployments must use a natively atomic backend such as the Redis layer below.
const withInProcessConditionalSet = (storage: Storage): AtomicStorage => {
  if (hasConditionalSet(storage)) return storage;
  let conditionalSetQueue = Promise.resolve();
  return {
    ...storage,
    setItemIfAbsent: (key: string, value: StorageValue, options?: ConditionalSetOptions) => {
      const operation = conditionalSetQueue.then(async () => {
        if (await storage.hasItem(key)) return false;
        await storage.setItem(key, value, options);
        return true;
      });
      conditionalSetQueue = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
};

const serializeStorageValue = (value: StorageValue) =>
  Predicate.isString(value) ? value : JSON.stringify(value);

const makeRedisStorage = (options: RedisOptions): AtomicStorage => {
  const driver = redisDriver(options);
  const storage = createStorage({ driver });
  return {
    ...storage,
    setItemIfAbsent: async (
      key: string,
      value: StorageValue,
      conditionalOptions?: ConditionalSetOptions,
    ) => {
      const redis = driver.getInstance?.();
      if (redis === undefined) throw new Error("Redis driver instance is unavailable");
      const redisKey = joinKeys(options.base ?? "", key);
      const serialized = serializeStorageValue(value);
      const result = conditionalOptions?.ttl
        ? await redis.set(redisKey, serialized, "EX", conditionalOptions.ttl, "NX")
        : await redis.set(redisKey, serialized, "NX");
      return result === "OK";
    },
  };
};

export class Unstorage extends Context.Service<Unstorage, AtomicStorage>()("Unstorage") {
  static layer = (storage: AtomicStorage) => Layer.succeed(Unstorage, storage);

  static createInProcessLayer = (opts?: CreateStorageOptions) =>
    Unstorage.layer(withInProcessConditionalSet(createStorage(opts)));

  static redisLayer = (opts: RedisOptions) => Layer.succeed(Unstorage, makeRedisStorage(opts));

  static get memoryLayer() {
    return Unstorage.createInProcessLayer({ driver: memoryDriver() });
  }

  static prefixed = Effect.fn("Unstorage.prefixed")(function* (prefix: string) {
    const storage = yield* Unstorage;
    return {
      ...prefixStorage(storage, prefix),
      setItemIfAbsent: (key: string, value: StorageValue, options?: ConditionalSetOptions) =>
        storage.setItemIfAbsent(joinKeys(prefix, key), value, options),
    };
  });

  static prefixedLayer = (prefix: string) =>
    Layer.effectContext(
      Effect.gen(function* () {
        const storage = yield* Unstorage.prefixed(prefix);
        return Context.make(Unstorage, storage);
      }),
    );
}
