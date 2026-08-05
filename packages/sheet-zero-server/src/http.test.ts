import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { api } from "sheet-zero-api";
import { internal, serverMutators, serverQueries, serviceApi } from "sheet-zero-api/server";
import { getZeroHandler, makeZeroHandlerRegistry } from "typhoon-zero/server";

type FunctionReference = {
  readonly kind: "query" | "mutator";
  readonly group: string;
  readonly name: string;
};

const procedureNames = (
  catalog: Readonly<Record<string, Readonly<Record<string, FunctionReference>>>>,
  kind: FunctionReference["kind"],
) =>
  Object.values(catalog)
    .flatMap((group) => Object.values(group))
    .filter((reference) => reference.kind === kind)
    .map((reference) => `${reference.group}.${reference.name}`)
    .sort();

describe("Sheet Zero server handlers", () => {
  it.effect("binds exactly the public and service procedure catalogs", () =>
    Effect.gen(function* () {
      const queryHandlers = yield* makeZeroHandlerRegistry(serverQueries);
      const mutatorHandlers = yield* makeZeroHandlerRegistry(serverMutators);
      const publicCatalog = api as Readonly<
        Record<string, Readonly<Record<string, FunctionReference>>>
      >;
      const serviceCatalog = serviceApi as Readonly<
        Record<string, Readonly<Record<string, FunctionReference>>>
      >;

      expect(Object.keys(queryHandlers).sort()).toEqual(
        [
          ...procedureNames(publicCatalog, "query"),
          ...procedureNames(serviceCatalog, "query"),
        ].sort(),
      );
      expect(Object.keys(mutatorHandlers).sort()).toEqual(
        [
          ...procedureNames(publicCatalog, "mutator"),
          ...procedureNames(serviceCatalog, "mutator"),
        ].sort(),
      );
    }),
  );

  it.effect("does not register internal or unknown procedures", () =>
    Effect.gen(function* () {
      const queryHandlers = yield* makeZeroHandlerRegistry(serverQueries);
      const mutatorHandlers = yield* makeZeroHandlerRegistry(serverMutators);
      const internalCatalog = internal as Readonly<
        Record<string, Readonly<Record<string, FunctionReference>>>
      >;

      for (const procedure of procedureNames(internalCatalog, "query")) {
        expect(procedure in queryHandlers).toBe(false);
      }
      for (const procedure of procedureNames(internalCatalog, "mutator")) {
        expect(procedure in mutatorHandlers).toBe(false);
      }
      expect(
        Exit.isFailure(yield* Effect.exit(getZeroHandler(queryHandlers, "unknown.query"))),
      ).toBe(true);
      expect(
        Exit.isFailure(yield* Effect.exit(getZeroHandler(mutatorHandlers, "unknown.mutator"))),
      ).toBe(true);
    }),
  );
});
