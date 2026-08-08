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

export interface KeyScan {
  readonly cursor: string;
  readonly keys: ReadonlyArray<string>;
}

export interface AtomicStorage extends Storage {
  readonly setItemIfAbsent: (
    key: string,
    value: StorageValue,
    options?: ConditionalSetOptions,
  ) => Promise<boolean>;
  readonly compareAndSetItem: (
    key: string,
    expected: StorageValue,
    value: StorageValue,
    options?: ConditionalSetOptions,
  ) => Promise<boolean>;
  readonly compareAndRemoveItem: (key: string, expected: StorageValue) => Promise<boolean>;
  readonly scanKeys: (prefix: string, cursor: string, limit: number) => Promise<KeyScan>;
}

const escapeRedisGlobPattern = (value: string) => value.replace(/[*?[\]\\]/g, "\\$&");

const isAtomicStorage = (storage: Storage): storage is AtomicStorage =>
  Predicate.hasProperty(storage, "setItemIfAbsent") &&
  Predicate.isFunction(storage.setItemIfAbsent) &&
  Predicate.hasProperty(storage, "compareAndSetItem") &&
  Predicate.isFunction(storage.compareAndSetItem) &&
  Predicate.hasProperty(storage, "compareAndRemoveItem") &&
  Predicate.isFunction(storage.compareAndRemoveItem) &&
  Predicate.hasProperty(storage, "scanKeys") &&
  Predicate.isFunction(storage.scanKeys);

// This fallback serializes writes only inside one process. Multi-process and replicated
// deployments must use a natively atomic backend such as the Redis layer below.
const withInProcessAtomicStorage = (storage: Storage): AtomicStorage => {
  if (isAtomicStorage(storage)) return storage;
  // Reads intentionally remain outside this queue; only conditional operations require
  // read-compare-write serialization, while ordinary reads may observe between batch writes.
  let mutationQueue = Promise.resolve();
  const enqueue = <A>(operation: () => Promise<A>) => {
    const queued = mutationQueue.then(operation);
    mutationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };
  return {
    ...storage,
    setItem: (...args: Parameters<Storage["setItem"]>) => enqueue(() => storage.setItem(...args)),
    set: (...args: Parameters<Storage["set"]>) => enqueue(() => storage.set(...args)),
    setItems: (...args: Parameters<Storage["setItems"]>) =>
      enqueue(() => storage.setItems(...args)),
    setItemRaw: (...args: Parameters<Storage["setItemRaw"]>) =>
      enqueue(() => storage.setItemRaw(...args)),
    removeItem: (...args: Parameters<Storage["removeItem"]>) =>
      enqueue(() => storage.removeItem(...args)),
    remove: (...args: Parameters<Storage["remove"]>) => enqueue(() => storage.remove(...args)),
    del: (...args: Parameters<Storage["del"]>) => enqueue(() => storage.del(...args)),
    setMeta: (...args: Parameters<Storage["setMeta"]>) => enqueue(() => storage.setMeta(...args)),
    removeMeta: (...args: Parameters<Storage["removeMeta"]>) =>
      enqueue(() => storage.removeMeta(...args)),
    clear: (...args: Parameters<Storage["clear"]>) => enqueue(() => storage.clear(...args)),
    setItemIfAbsent: (key: string, value: StorageValue, options?: ConditionalSetOptions) =>
      enqueue(async () => {
        if (await storage.hasItem(key)) return false;
        await storage.setItem(key, value, options);
        return true;
      }),
    compareAndSetItem: (key, expected, value, options) =>
      enqueue(async () => {
        const current = await storage.getItem(key);
        if (Predicate.isNull(current)) return false;
        if (serializeStorageValue(current) !== serializeStorageValue(expected)) return false;
        await storage.setItem(key, value, options);
        return true;
      }),
    compareAndRemoveItem: (key, expected) =>
      enqueue(async () => {
        const current = await storage.getItem(key);
        if (Predicate.isNull(current)) return false;
        if (serializeStorageValue(current) !== serializeStorageValue(expected)) return false;
        await storage.removeItem(key);
        return true;
      }),
    // Offset paging is a single-process/test fallback. Concurrent key changes before the
    // cursor can skip or duplicate a key; production backends should provide native scans.
    scanKeys: async (prefix, cursor, limit) => {
      const keys = await storage.getKeys(prefix);
      const parsedCursor = Number.parseInt(cursor, 10);
      const offset = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
      const nextOffset = offset + limit;
      return {
        cursor: nextOffset < keys.length ? String(nextOffset) : "0",
        keys: keys.slice(offset, nextOffset),
      };
    },
  };
};

const canonicalizeStorageValue = (
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
): unknown => {
  if (!Array.isArray(value) && !Predicate.isObject(value)) return value;
  if (ancestors.has(value)) throw new Error("Cannot serialize a cyclic storage value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalizeStorageValue(item, ancestors));
    }
    if (Predicate.hasProperty(value, "toJSON") && Predicate.isFunction(value.toJSON)) {
      return canonicalizeStorageValue(value.toJSON(), ancestors);
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalizeStorageValue(nested, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
};

const serializeStorageValue = (value: unknown) =>
  Predicate.isString(value) ? value : JSON.stringify(canonicalizeStorageValue(value));

const serializeLegacyStorageValue = (value: unknown) =>
  Predicate.isString(value) ? value : JSON.stringify(value);

const compareAndSetScript = `
local current = redis.call("GET", KEYS[1])
if current ~= ARGV[1] and current ~= ARGV[2] then
  return 0
end
if ARGV[4] == "" then
  redis.call("SET", KEYS[1], ARGV[3], "KEEPTTL")
elseif tonumber(ARGV[4]) > 0 then
  redis.call("SET", KEYS[1], ARGV[3], "EX", ARGV[4])
else
  redis.call("SET", KEYS[1], ARGV[3])
end
return 1
`;

const compareAndRemoveScript = `
local current = redis.call("GET", KEYS[1])
if current ~= ARGV[1] and current ~= ARGV[2] then
  return 0
end
redis.call("UNLINK", KEYS[1])
return 1
`;

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
    compareAndSetItem: async (key, expected, value, conditionalOptions) => {
      const redis = driver.getInstance?.();
      if (redis === undefined) throw new Error("Redis driver instance is unavailable");
      const result = await redis.eval(
        compareAndSetScript,
        1,
        joinKeys(options.base ?? "", key),
        serializeStorageValue(expected),
        serializeLegacyStorageValue(expected),
        serializeStorageValue(value),
        conditionalOptions?.ttl?.toString() ?? "",
      );
      return String(result) === "1";
    },
    compareAndRemoveItem: async (key, expected) => {
      const redis = driver.getInstance?.();
      if (redis === undefined) throw new Error("Redis driver instance is unavailable");
      const result = await redis.eval(
        compareAndRemoveScript,
        1,
        joinKeys(options.base ?? "", key),
        serializeStorageValue(expected),
        serializeLegacyStorageValue(expected),
      );
      return String(result) === "1";
    },
    scanKeys: async (prefix, cursor, limit) => {
      const redis = driver.getInstance?.();
      if (redis === undefined) throw new Error("Redis driver instance is unavailable");
      const redisBase = (options.base ?? "").replace(/:$/, "");
      const storagePrefix = joinKeys(redisBase, prefix);
      const pattern =
        storagePrefix.length === 0 ? "*" : `${escapeRedisGlobPattern(storagePrefix)}:*`;
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", limit);
      const basePrefix = redisBase.length === 0 ? "" : `${redisBase}:`;
      return {
        cursor: nextCursor,
        keys: keys.map((key) => (basePrefix.length === 0 ? key : key.slice(basePrefix.length))),
      };
    },
  };
};

export class Unstorage extends Context.Service<Unstorage, AtomicStorage>()("Unstorage") {
  static layer = (storage: AtomicStorage) => Layer.succeed(Unstorage, storage);

  static createInProcessLayer = (opts?: CreateStorageOptions) =>
    Unstorage.layer(withInProcessAtomicStorage(createStorage(opts)));

  static redisLayer = (opts: RedisOptions) =>
    Layer.effect(Unstorage)(
      Effect.acquireRelease(
        Effect.sync(() => makeRedisStorage(opts)),
        (storage) => Effect.promise(() => storage.dispose()),
      ),
    );

  static get memoryLayer() {
    return Unstorage.createInProcessLayer({ driver: memoryDriver() });
  }

  static prefixed = Effect.fn("Unstorage.prefixed")(function* (prefix: string) {
    const storage = yield* Unstorage;
    const normalizedPrefix = joinKeys(prefix);
    const basePrefix = normalizedPrefix.length === 0 ? "" : `${normalizedPrefix}:`;
    return {
      ...prefixStorage(storage, prefix),
      setItemIfAbsent: (key: string, value: StorageValue, options?: ConditionalSetOptions) =>
        storage.setItemIfAbsent(joinKeys(prefix, key), value, options),
      compareAndSetItem: (
        key: string,
        expected: StorageValue,
        value: StorageValue,
        options?: ConditionalSetOptions,
      ) => storage.compareAndSetItem(joinKeys(prefix, key), expected, value, options),
      compareAndRemoveItem: (key: string, expected: StorageValue) =>
        storage.compareAndRemoveItem(joinKeys(prefix, key), expected),
      scanKeys: async (key: string, cursor: string, limit: number) => {
        const page = await storage.scanKeys(joinKeys(prefix, key), cursor, limit);
        return {
          cursor: page.cursor,
          keys: page.keys.map((scannedKey) =>
            basePrefix.length === 0 || !scannedKey.startsWith(basePrefix)
              ? scannedKey
              : scannedKey.slice(basePrefix.length),
          ),
        };
      },
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
