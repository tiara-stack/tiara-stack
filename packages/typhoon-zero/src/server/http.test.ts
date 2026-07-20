import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Logger } from "effect";
import {
  getZeroHandler,
  hasZeroHandlerFn,
  makeZeroHandlerRegistry,
  removeUndefinedFields,
} from "./http";

const extractFailure = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe("Zero server HTTP helpers", () => {
  it("removes undefined object fields and normalizes undefined array entries to null", () => {
    expect(
      removeUndefinedFields({
        keep: "value",
        drop: undefined,
        nested: {
          keep: 1,
          drop: undefined,
        },
        array: ["value", undefined, { keep: true, drop: undefined }],
      } as any),
    ).toEqual({
      keep: "value",
      nested: {
        keep: 1,
      },
      array: ["value", null, { keep: true }],
    });
  });

  it("accepts Zero handler definitions stored as functions with fn metadata", () => {
    const query = Object.assign(() => undefined, {
      fn: () => undefined,
    });

    expect(typeof query).toBe("function");
    expect(hasZeroHandlerFn(query)).toBe(true);
  });

  it.effect("dispatches a valid procedure from the compiled registry", () =>
    Effect.gen(function* () {
      const handler = Object.assign(() => undefined, { fn: () => "valid" });
      const registry = yield* makeZeroHandlerRegistry({
        sheetApis: { getRangesConfig: handler },
      });

      expect(Object.isFrozen(registry)).toBe(true);
      expect(yield* getZeroHandler(registry, "sheetApis.getRangesConfig")).toBe(handler);
    }),
  );

  it.effect("returns a typed not-found error for an unknown procedure", () =>
    Effect.gen(function* () {
      const registry = yield* makeZeroHandlerRegistry({ sheetApis: {} });
      const exit = yield* Effect.exit(getZeroHandler(registry, "sheetApis.unknown"));

      expect(extractFailure(exit)).toMatchObject({
        _tag: "ZeroDispatchNotFoundError",
        procedure: "sheetApis.unknown",
      });
    }),
  );

  it.effect("rejects prototype-related procedure segments as bad requests", () =>
    Effect.gen(function* () {
      const registry = yield* makeZeroHandlerRegistry({ sheetApis: {} });

      for (const procedure of [
        "__proto__.handler",
        "sheetApis.constructor.handler",
        "sheetApis.prototype",
      ]) {
        const exit = yield* Effect.exit(getZeroHandler(registry, procedure));
        expect(extractFailure(exit)).toMatchObject({
          _tag: "ZeroDispatchBadRequestError",
          procedure,
        });
      }
    }),
  );

  it.effect("returns not found when a declared handler is missing", () =>
    Effect.gen(function* () {
      const registry = yield* makeZeroHandlerRegistry({
        sheetApis: { getRangesConfig: {} },
      });
      const exit = yield* Effect.exit(getZeroHandler(registry, "sheetApis.getRangesConfig"));

      expect(extractFailure(exit)).toMatchObject({ _tag: "ZeroDispatchNotFoundError" });
    }),
  );

  it.effect("returns not found for the old name after a handler is renamed", () =>
    Effect.gen(function* () {
      const renamed = Object.assign(() => undefined, { fn: () => undefined });
      const registry = yield* makeZeroHandlerRegistry({
        sheetApis: { getConfig: renamed },
      });

      expect(yield* getZeroHandler(registry, "sheetApis.getConfig")).toBe(renamed);
      const exit = yield* Effect.exit(getZeroHandler(registry, "sheetApis.getRangesConfig"));
      expect(extractFailure(exit)).toMatchObject({ _tag: "ZeroDispatchNotFoundError" });
    }),
  );

  it.effect("warns when skipping a handler candidate without a valid fn", () => {
    const logMessages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      logMessages.push(message);
    });
    const invalidHandler = Object.assign(() => undefined, {
      queryName: "sheetApis.invalid",
    });

    return Effect.gen(function* () {
      const registry = yield* makeZeroHandlerRegistry({
        sheetApis: { invalid: invalidHandler },
      });

      expect(Object.keys(registry)).toEqual([]);
      expect(logMessages).toContainEqual([
        "Skipping invalid Zero handler definition",
        { procedure: "sheetApis.invalid" },
      ]);
    }).pipe(Effect.provide(Logger.layer([logger])));
  });
});
