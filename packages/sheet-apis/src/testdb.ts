/** Test-only PGlite-backed SheetZeroClient layer. */
import { Effect, Layer, Scope } from "effect";
import {
  makeTestSheetZeroDatabase,
  type SheetSeeds,
  type SheetTableName,
  type SheetRows,
  type TestDatabaseError,
  type TestDatabaseTimings,
} from "sheet-db-schema/testdb";
import { mutators } from "sheet-db-schema/zero";
import { ZeroApiClient } from "typhoon-zero/zeroApi";
import { SheetZeroApi, SheetZeroClient, type SheetZeroClientApi } from "./services/sheetZeroClient";

export type {
  SheetRows,
  SheetSeeds,
  SheetTableName,
  TestDatabaseError,
} from "sheet-db-schema/testdb";

export interface TestSheetZero {
  readonly client: SheetZeroClientApi;
  readonly layer: Layer.Layer<SheetZeroClient>;
  readonly timings: TestDatabaseTimings;
  readonly seed: (seeds: SheetSeeds) => Effect.Effect<void, TestDatabaseError>;
  readonly rows: <K extends SheetTableName>(
    table: K,
  ) => Effect.Effect<ReadonlyArray<SheetRows[K]>, TestDatabaseError>;
  readonly reset: Effect.Effect<void, TestDatabaseError>;
  readonly close: Effect.Effect<void>;
}

export interface TestSheetZeroOptions<Context> {
  readonly seeds?: SheetSeeds | undefined;
  /** Context supplied to generated query and authoritative mutator functions. */
  readonly context?: Context | undefined;
}

export const makeTestSheetZeroClient = <Context = undefined>(
  options: TestSheetZeroOptions<Context> = {},
): Effect.Effect<TestSheetZero, TestDatabaseError, Scope.Scope> =>
  Effect.gen(function* () {
    const database = yield* makeTestSheetZeroDatabase(options);
    const generatedClient = yield* ZeroApiClient.makeWithService(SheetZeroApi, database.executor, {
      mutators,
    });
    const client = generatedClient as unknown as SheetZeroClientApi;
    return {
      client,
      layer: Layer.succeed(SheetZeroClient, client),
      timings: database.timings,
      seed: database.seed,
      rows: database.rows,
      reset: database.reset,
      close: database.close,
    };
  });
