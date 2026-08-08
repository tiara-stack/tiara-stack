import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { Unstorage } from "dfx-discord-utils/discord/cache";
import { makePrefixedUnstorageLayer } from "./cache";

const makeConfigLayer = (env: Record<string, string>) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {
        DISCORD_TOKEN: "test-token",
        POD_NAMESPACE: "test",
        REDIS_URL: "redis://localhost:6379",
        SHEET_INGRESS_BASE_URL: "http://ingress",
        SHEET_AUTH_ISSUER: "http://auth",
        SHEET_AUTH_OAUTH_CLIENT_ID: "client-id",
        SHEET_AUTH_OAUTH_CLIENT_SECRET: "secret",
        SHEET_AUTH_SUBJECT_TOKEN_KUBERNETES_TOKEN_PATH: "/var/run/secrets/token",
        ...env,
      },
    }),
  );

describe("discord cache prefix", () => {
  it.effect("prefixes atomic conditional writes", () =>
    Effect.gen(function* () {
      const memoryLayer = Unstorage.memoryLayer;
      const rawStorage = yield* Effect.provide(Unstorage, memoryLayer);
      const prefixedStorage = yield* Effect.provide(
        Unstorage,
        Layer.provide(
          makePrefixedUnstorageLayer(memoryLayer),
          makeConfigLayer({ SHEET_BOT_CLIENT_ID: "discord-atomic" }),
        ),
      );

      expect(yield* Effect.promise(() => prefixedStorage.setItemIfAbsent("delivery:key", 1))).toBe(
        true,
      );
      expect(yield* Effect.promise(() => prefixedStorage.setItemIfAbsent("delivery:key", 2))).toBe(
        false,
      );
      expect(
        yield* Effect.promise(() => rawStorage.getItem("discord:discord-atomic:delivery:key")),
      ).toBe(1);
      expect(
        yield* Effect.promise(() => prefixedStorage.compareAndSetItem("delivery:missing", 1, 2)),
      ).toBe(false);
      expect(
        yield* Effect.promise(() => prefixedStorage.compareAndRemoveItem("delivery:missing", 1)),
      ).toBe(false);

      expect(
        yield* Effect.promise(() =>
          prefixedStorage.compareAndSetItem("delivery:key", 2, { state: "completed" }),
        ),
      ).toBe(false);
      expect(yield* Effect.promise(() => prefixedStorage.getItem("delivery:key"))).toBe(1);
      expect(
        yield* Effect.promise(() =>
          prefixedStorage.compareAndSetItem("delivery:key", 1, { state: "completed" }),
        ),
      ).toBe(true);
      expect(
        yield* Effect.promise(() =>
          prefixedStorage.compareAndRemoveItem("delivery:key", { state: "pending" }),
        ),
      ).toBe(false);
      expect(
        yield* Effect.promise(() =>
          prefixedStorage.compareAndRemoveItem("delivery:key", { state: "completed" }),
        ),
      ).toBe(true);
      expect(
        yield* Effect.promise(() => rawStorage.getItem("discord:discord-atomic:delivery:key")),
      ).toBeNull();

      yield* Effect.promise(() =>
        prefixedStorage.setItemIfAbsent("delivery:ordered", { z: 1, a: 2 }),
      );
      expect(
        yield* Effect.promise(() =>
          prefixedStorage.compareAndSetItem(
            "delivery:ordered",
            { a: 2, z: 1 },
            { state: "completed" },
          ),
        ),
      ).toBe(true);

      const storedDate = new Date("2026-08-08T00:00:00.000Z");
      yield* Effect.promise(() =>
        prefixedStorage.setItemIfAbsent("delivery:date", { recordedAt: storedDate }),
      );
      expect(
        yield* Effect.promise(() =>
          prefixedStorage.compareAndRemoveItem("delivery:date", {
            recordedAt: new Date("2026-08-08T00:00:00.000Z"),
          }),
        ),
      ).toBe(true);

      yield* Effect.promise(() => prefixedStorage.setItem("scan:first", 1));
      yield* Effect.promise(() => prefixedStorage.setItem("scan:second", 2));
      const firstPage = yield* Effect.promise(() => prefixedStorage.scanKeys("scan:", "0", 1));
      const secondPage = yield* Effect.promise(() =>
        prefixedStorage.scanKeys("scan:", firstPage.cursor, 1),
      );
      expect(firstPage.keys).toHaveLength(1);
      expect(firstPage.cursor).not.toBe("0");
      expect(secondPage.cursor).toBe("0");
      expect([...firstPage.keys, ...secondPage.keys].sort()).toEqual(["scan:first", "scan:second"]);

      const alreadyTrimmedStorage = yield* Effect.provide(
        Unstorage.prefixed("discord:discord-atomic"),
        Unstorage.layer({
          ...rawStorage,
          scanKeys: () => Promise.resolve({ cursor: "0", keys: ["scan:already-trimmed"] }),
        }),
      );
      expect(yield* Effect.promise(() => alreadyTrimmedStorage.scanKeys("scan:", "0", 1))).toEqual({
        cursor: "0",
        keys: ["scan:already-trimmed"],
      });

      yield* Effect.promise(() => prefixedStorage.setItem("delivery:cyclic", 1));
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const cyclicExit = yield* Effect.exit(
        Effect.tryPromise({
          try: () => prefixedStorage.compareAndSetItem("delivery:cyclic", cyclic, 2),
          catch: (error) => error,
        }),
      );
      expect(Exit.isFailure(cyclicExit)).toBe(true);
      if (Exit.isSuccess(cyclicExit)) return;
      expect(Cause.squash(cyclicExit.cause)).toMatchObject({
        message: "Cannot serialize a cyclic storage value",
      });
    }),
  );

  it.effect("uses explicit clientId in the Redis key prefix", () =>
    Effect.gen(function* () {
      const configLayer = makeConfigLayer({ SHEET_BOT_CLIENT_ID: "discord-alt" });
      const memoryLayer = Unstorage.memoryLayer;

      const testLayer = Layer.provide(makePrefixedUnstorageLayer(memoryLayer), configLayer);
      const prefixedStorage = yield* Effect.provide(Unstorage, testLayer);

      yield* Effect.promise(() => prefixedStorage.setItem("guilds:test-guild", "test-value"));
      const value = yield* Effect.promise(() => prefixedStorage.getItem("guilds:test-guild"));
      expect(value).toBe("test-value");

      // Verify isolation: a different prefix cannot find this key
      const differentPrefixLayer = Layer.provide(
        Unstorage.prefixedLayer("discord:discord-main:"),
        memoryLayer,
      );
      const differentStorage = yield* Effect.provide(Unstorage, differentPrefixLayer);
      const differentValue = yield* Effect.promise(() =>
        differentStorage.getItem("guilds:test-guild"),
      );
      expect(differentValue).toBeNull();
    }),
  );

  it.effect("uses default clientId (discord-main) when SHEET_BOT_CLIENT_ID is not set", () =>
    Effect.gen(function* () {
      // When SHEET_BOT_CLIENT_ID is absent, config falls back to withDefault("discord-main")
      // Verify the prefix is actually discord:discord-main: by reading from the raw storage
      // and checking the key format. We use a unique key per test to avoid cross-test pollution.
      const memoryLayer = Unstorage.memoryLayer;
      const configLayer = makeConfigLayer({});

      // Provide memoryLayer to get the raw storage directly
      const rawStorage = yield* Effect.provide(Unstorage, memoryLayer);

      // Create the prefixed storage with config (no explicit SHEET_BOT_CLIENT_ID, uses default)
      const testLayer = Layer.provide(makePrefixedUnstorageLayer(memoryLayer), configLayer);
      const prefixedStorage = yield* Effect.provide(Unstorage, testLayer);

      // Write using the prefixed storage with a test-specific key
      const testKey = `guilds:${"test-default-" + Date.now()}`;
      yield* Effect.promise(() => prefixedStorage.setItem(testKey, "test-value"));
      const value = yield* Effect.promise(() => prefixedStorage.getItem(testKey));
      expect(value).toBe("test-value");

      // Now read raw storage keys to verify the key is stored under discord:discord-main: prefix
      const allKeys = yield* Effect.promise(() => rawStorage.getKeys());
      const matchingKeys = allKeys.filter((k) => k.includes(testKey));
      expect(matchingKeys).toHaveLength(1);
      expect(matchingKeys[0]).toBe(`discord:discord-main:${testKey}`);
    }),
  );
});
