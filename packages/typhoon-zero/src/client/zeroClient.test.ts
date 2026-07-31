import type { ErroredQuery, RunOptions } from "@rocicorp/zero";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Stream } from "effect";
import * as ZeroClient from "./zeroClient";

const makeClient = (zero: unknown) => ZeroClient.ZeroClient<any, any, any>().make(zero as never);

describe("ZeroClient", () => {
  it.effect(
    "resolves unknown query data from the materialized snapshot",
    Effect.fnUntraced(function* () {
      let destroyed = false;
      const zero = {
        materialize: (_query: unknown, options: { ttl?: RunOptions["ttl"] }) => {
          expect(options).toEqual({ ttl: "1m" });
          return {
            data: [{ id: "item-1" }],
            addListener: () => {
              throw new Error("should not listen for unknown query results");
            },
            destroy: () => {
              destroyed = true;
            },
            updateTTL: () => undefined,
          };
        },
        run: () => Promise.reject(new Error("should not call zero.run")),
        mutate: () => {
          throw new Error("should not call zero.mutate");
        },
      };
      const client = yield* makeClient(zero);

      const result = yield* client.run({} as never, { type: "unknown", ttl: "1m" });

      expect(result).toEqual([{ id: "item-1" }]);
      expect(destroyed).toBe(true);
    }),
  );

  it.effect(
    "treats missing run options as an unknown materialized snapshot",
    Effect.fnUntraced(function* () {
      let destroyed = false;
      const zero = {
        materialize: (_query: unknown, options: { ttl?: RunOptions["ttl"] }) => {
          expect(options).toEqual({ ttl: undefined });
          return {
            data: [{ id: "item-2" }],
            addListener: () => {
              throw new Error("should not listen without complete run options");
            },
            destroy: () => {
              destroyed = true;
            },
            updateTTL: () => undefined,
          };
        },
        run: () => Promise.reject(new Error("should not call zero.run")),
        mutate: () => {
          throw new Error("should not call zero.mutate");
        },
      };
      const client = yield* makeClient(zero);

      const result = yield* client.run({} as never);

      expect(result).toEqual([{ id: "item-2" }]);
      expect(destroyed).toBe(true);
    }),
  );

  it.effect(
    "preserves Zero error details for complete query failures",
    Effect.fnUntraced(function* () {
      let destroyed = false;
      let removed = false;
      const error: ErroredQuery = {
        error: "app",
        id: "getGuildConfigByGuildId",
        name: "guildConfig.getGuildConfigByGuildId",
        message: "boom",
      };
      const zero = {
        materialize: (_query: unknown, options: { ttl?: RunOptions["ttl"] }) => {
          expect(options).toEqual({ ttl: "forever" });
          return {
            data: undefined,
            addListener: (
              listener: (data: unknown, result: "error", error: ErroredQuery) => void,
            ) => {
              listener(undefined, "error", error);
              return () => {
                removed = true;
              };
            },
            destroy: () => {
              destroyed = true;
            },
            updateTTL: () => undefined,
          };
        },
        run: () => Promise.reject(new Error("should not call zero.run")),
        mutate: () => {
          throw new Error("should not call zero.mutate");
        },
      };
      const client = yield* makeClient(zero);

      const exit = yield* Effect.exit(
        client.run({} as never, { type: "complete", ttl: "forever" }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const prettyCause = Cause.pretty(exit.cause);
        expect(prettyCause).toContain("getGuildConfigByGuildId");
        expect(prettyCause).toContain("guildConfig.getGuildConfigByGuildId");
        expect(prettyCause).toContain("boom");
        expect(prettyCause).not.toContain("got undefined");
      }
      expect(destroyed).toBe(true);
      expect(removed).toBe(true);
    }),
  );

  it.effect("resolves complete query data from a materialized complete result", () =>
    Effect.gen(function* () {
      let destroyed = false;
      let removed = false;
      const zero = {
        materialize: () => ({
          data: undefined,
          addListener: (listener: (data: unknown, result: "complete") => void) => {
            listener([{ id: "item-1" }], "complete");
            return () => {
              removed = true;
            };
          },
          destroy: () => {
            destroyed = true;
          },
          updateTTL: () => undefined,
        }),
        run: () => Promise.reject(new Error("should not call zero.run")),
        mutate: () => {
          throw new Error("should not call zero.mutate");
        },
      };
      const client = yield* makeClient(zero);

      const result = yield* client.run({} as never, { type: "complete" });

      expect(result).toEqual([{ id: "item-1" }]);
      expect(destroyed).toBe(true);
      expect(removed).toBe(true);
    }),
  );

  it.effect("suppresses unknown snapshots for complete reactive queries", () =>
    Effect.gen(function* () {
      let destroyed = false;
      let removed = false;
      const zero = {
        materialize: () => ({
          data: undefined,
          addListener: (listener: (data: unknown, result: "unknown" | "complete") => void) => {
            listener([{ id: "partial" }], "unknown");
            listener([{ id: "complete" }], "complete");
            return () => {
              removed = true;
            };
          },
          destroy: () => {
            destroyed = true;
          },
          updateTTL: () => undefined,
        }),
        mutate: () => {
          throw new Error("should not call zero.mutate");
        },
      };
      const client = yield* makeClient(zero);

      const result = yield* client
        .stream({} as never, { type: "complete" })
        .pipe(Stream.take(1), Stream.runCollect);

      expect(result).toEqual([[{ id: "complete" }]]);
      expect(destroyed).toBe(true);
      expect(removed).toBe(true);
    }),
  );

  it.effect("emits the initial snapshot when the listener only stores callbacks", () =>
    Effect.gen(function* () {
      let destroyed = false;
      let removed = false;
      const zero = {
        materialize: () => ({
          data: [{ id: "initial" }],
          addListener: () => () => {
            removed = true;
          },
          destroy: () => {
            destroyed = true;
          },
          updateTTL: () => undefined,
        }),
        mutate: () => {
          throw new Error("should not call zero.mutate");
        },
      };
      const client = yield* makeClient(zero);

      const result = yield* client.stream({} as never).pipe(Stream.take(1), Stream.runCollect);

      expect(result).toEqual([[{ id: "initial" }]]);
      expect(destroyed).toBe(true);
      expect(removed).toBe(true);
    }),
  );

  it.live(
    "does not duplicate a snapshot emitted synchronously during listener registration",
    Effect.fnUntraced(function* () {
      let destroyed = false;
      let removed = false;
      const error: ErroredQuery = {
        error: "app",
        id: "items.get",
        name: "items.get",
        message: "stream ended",
      };
      const zero = {
        materialize: () => ({
          data: [{ id: "item-1" }],
          addListener: (
            listener: (data: unknown, result: "unknown" | "error", error?: ErroredQuery) => void,
          ) => {
            listener([{ id: "item-1" }], "unknown");
            setTimeout(() => listener(undefined, "error", error), 0);
            return () => {
              removed = true;
            };
          },
          destroy: () => {
            destroyed = true;
          },
          updateTTL: () => undefined,
        }),
        mutate: () => {
          throw new Error("should not call zero.mutate");
        },
      };
      const client = yield* makeClient(zero);
      const updates: Array<unknown> = [];

      const exit = yield* client.stream({} as never).pipe(
        Stream.tap((value) =>
          Effect.sync(() => {
            updates.push(value);
          }),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(updates).toEqual([[{ id: "item-1" }]]);
      expect(destroyed).toBe(true);
      expect(removed).toBe(true);
    }),
  );

  it.effect("does not emit a snapshot after a synchronous reactive query failure", () =>
    Effect.gen(function* () {
      let destroyed = false;
      let removed = false;
      const error: ErroredQuery = {
        error: "app",
        id: "items.get",
        name: "items.get",
        message: "boom",
      };
      const zero = {
        materialize: () => ({
          data: [{ id: "stale" }],
          addListener: (
            listener: (data: unknown, result: "error", error: ErroredQuery) => void,
          ) => {
            listener(undefined, "error", error);
            return () => {
              removed = true;
            };
          },
          destroy: () => {
            destroyed = true;
          },
          updateTTL: () => undefined,
        }),
        mutate: () => {
          throw new Error("should not call zero.mutate");
        },
      };
      const client = yield* makeClient(zero);

      const exit = yield* client
        .stream({} as never, { type: "complete" })
        .pipe(Stream.runCollect, Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const prettyCause = Cause.pretty(exit.cause);
        expect(prettyCause).toContain("items.get");
        expect(prettyCause).toContain("boom");
        expect(prettyCause).not.toContain("stale");
      }
      expect(destroyed).toBe(true);
      expect(removed).toBe(true);
    }),
  );
});
