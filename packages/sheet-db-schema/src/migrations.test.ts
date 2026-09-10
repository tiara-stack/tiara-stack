import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { fileURLToPath } from "node:url";
import { sheetDbMigrations } from "./migrations";

const generatedMigrationId = (fileName: string): number | undefined => {
  const match = /^(\d{4})_.+\.ts$/.exec(fileName);
  return match === null ? undefined : Number(match[1]);
};

describe("sheet database migration loader", () => {
  it.live("registers every generated migration file exactly once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const migrationsDirectory = fileURLToPath(
        new URL("../effect-sql-migrations/", import.meta.url),
      );
      const generatedIds = fileSystem.readDirectory(migrationsDirectory).pipe(
        Effect.map((fileNames) =>
          fileNames
            .flatMap((fileName) => {
              const id = generatedMigrationId(fileName);
              return id === undefined ? [] : [id];
            })
            .sort((left, right) => left - right),
        ),
      );
      const loaderIds = (yield* sheetDbMigrations).map(([id]) => id);

      expect(loaderIds).toEqual(yield* generatedIds);
      expect(new Set(loaderIds).size).toBe(loaderIds.length);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
