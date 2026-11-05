import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import * as FileSystem from "effect/FileSystem";
import { SqlClient } from "effect/unstable/sql";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import {
  admitSheetDbMigrationHistory,
  compareMigrationHistory,
  MigrationAdmissionError,
} from "./index";
import {
  sheetDbMigrationArtifactDigestFromSources,
  sheetDbMigrationArtifactDigest,
  sheetDbMigrationArtifactSources,
  sheetDbMigrationArtifacts,
} from "../migrations";

describe("State Plane migration admission", () => {
  it.live("pins the exact migration source bytes represented by producer schema identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
      expect(sheetDbMigrationArtifactSources).toHaveLength(sheetDbMigrationArtifacts.length);

      for (const [index, [source, expectedDigest]] of sheetDbMigrationArtifactSources.entries()) {
        const registeredMigrationId = sheetDbMigrationArtifacts[index]?.[0];
        expect(Number(path.basename(source).slice(0, 4))).toBe(registeredMigrationId);
        const packageRelative = source.replace("packages/sheet-db-schema/", "");
        const bytes = yield* fileSystem.readFile(path.join(packageRoot, packageRelative));
        const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        expect(actualDigest, source).toBe(expectedDigest);
      }

      expect(sheetDbMigrationArtifactDigest).toBe(
        sheetDbMigrationArtifactDigestFromSources(sheetDbMigrationArtifactSources),
      );
      const changedManifest = sheetDbMigrationArtifactSources.map(([source, digest], index) => {
        if (index === 0) return [source, `sha256:${"0".repeat(64)}`] as const;
        return [source, digest] as const;
      });
      expect(sheetDbMigrationArtifactDigestFromSources(changedManifest)).not.toBe(
        sheetDbMigrationArtifactDigest,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("accepts only the complete expected migration id and artifact-name history", () =>
    Effect.gen(function* () {
      const history = sheetDbMigrationArtifacts.map(([id, name]) => [id, name] as const);
      yield* compareMigrationHistory(history);
    }),
  );

  it.effect("refuses missing, unknown, reordered, or renamed migration artifacts", () =>
    Effect.gen(function* () {
      const history = sheetDbMigrationArtifacts.map(([id, name]) => [id, name] as const);
      const unknown = [...history, [26, "unregistered"] as const];
      const mismatched = history.map(
        ([id, name]) => [id, id === 25 ? "changed_artifact" : name] as const,
      );
      for (const observed of [history.slice(0, -1), unknown, mismatched]) {
        const exit = yield* Effect.exit(compareMigrationHistory(observed));
        expect(Exit.isFailure(exit)).toBe(true);
      }
    }),
  );

  it.effect("uses a read-only journal query and starts no work after failed admission", () =>
    Effect.gen(function* () {
      const history = sheetDbMigrationArtifacts
        .slice(0, -1)
        .map(([migration_id, name]) => ({ migration_id, name }));
      const statements: string[] = [];

      const sql = Object.assign(() => Effect.succeed([]), {
        unsafe: (statement: string) => {
          statements.push(statement);
          return { withoutTransform: Effect.succeed(history) };
        },
      }) as unknown /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as SqlClient.SqlClient /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
      let applicationWorkStarted = false;
      const startup = Effect.gen(function* () {
        yield* admitSheetDbMigrationHistory;
        applicationWorkStarted = true;
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

      const exit = yield* Effect.exit(startup);
      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        : undefined;
      expect(error).toBeInstanceOf(MigrationAdmissionError);
      expect(applicationWorkStarted).toBe(false);
      expect(statements).toHaveLength(1);
      expect(statements[0]?.trim()).toMatch(/^SELECT migration_id, name/);
      expect(statements[0]).not.toMatch(/CREATE|ALTER|INSERT|UPDATE|DELETE|DROP/i);
    }),
  );
});
