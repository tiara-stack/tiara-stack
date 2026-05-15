import { NodeServices } from "@effect/platform-node";
import { randomUUID } from "node:crypto";
import { Effect, FileSystem, Path, Result, Schema } from "effect";
import type { SchemaSnapshot, StoredSnapshot } from "../snapshot";
import { snapshotVersion } from "../snapshot";
import { slugify } from "../util";
import { DialectSchema } from "../cli/schema";

export type JournalEntry = {
  readonly idx: number;
  readonly version: number;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
};

export type Journal = {
  readonly version: number;
  readonly dialect: "postgresql" | "sqlite";
  readonly entries: readonly JournalEntry[];
};

const JournalEntrySchema = Schema.Struct({
  idx: Schema.Number,
  version: Schema.Number,
  when: Schema.Number,
  tag: Schema.String,
  breakpoints: Schema.Boolean,
});

const JournalSchema = Schema.Struct({
  version: Schema.Number,
  dialect: DialectSchema,
  entries: Schema.Array(JournalEntrySchema),
});

const StoredSnapshotSchema = Schema.Struct({
  version: Schema.Number,
  dialect: DialectSchema,
  id: Schema.String,
  prevId: Schema.String,
  schema: Schema.Unknown,
  drizzle: Schema.optionalKey(Schema.Unknown),
});

const parseJsonEffect = (content: string) =>
  Effect.try({
    try: () => JSON.parse(content) as unknown,
    catch: (cause) => cause,
  });

const isMissingPathError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  ("code" in error
    ? error.code === "ENOENT"
    : "_tag" in error
      ? error._tag === "SystemError" && "reason" in error && error.reason === "NotFound"
      : false);

const existsEffect = (fs: FileSystem.FileSystem, filePath: string) =>
  Effect.gen(function* () {
    const existsResult = yield* Effect.result(fs.exists(filePath));
    if (Result.isSuccess(existsResult)) {
      return existsResult.success;
    }
    if (isMissingPathError(existsResult.failure)) {
      return false;
    }
    return yield* Effect.fail(existsResult.failure);
  });

export const readJournalEffect = (out: string, dialect: "postgresql" | "sqlite") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const journalPath = path.join(out, "meta", "_journal.json");
    const exists = yield* existsEffect(fs, journalPath);
    if (!exists) {
      return {
        version: snapshotVersion,
        dialect,
        entries: [],
      } satisfies Journal;
    }

    const content = yield* fs.readFileString(journalPath, "utf8");
    const journal = yield* Schema.decodeUnknownEffect(JournalSchema)(
      yield* parseJsonEffect(content),
    );
    if (journal.dialect !== dialect) {
      return yield* Effect.fail(
        new Error(
          `effect-sql-kit: migration folder dialect is ${journal.dialect}, expected ${dialect}`,
        ),
      );
    }
    return journal satisfies Journal;
  });

export const readJournal = (out: string, dialect: "postgresql" | "sqlite"): Promise<Journal> =>
  Effect.runPromise(readJournalEffect(out, dialect).pipe(Effect.provide(NodeServices.layer)));

export const readStoredSnapshotEffect = (out: string, prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const content = yield* fs.readFileString(
      path.join(out, "meta", `${prefix}_snapshot.json`),
      "utf8",
    );
    const parsed = yield* parseJsonEffect(content);
    const decoded = yield* Schema.decodeUnknownEffect(StoredSnapshotSchema)(parsed);
    return decoded as StoredSnapshot;
  });

export const readStoredSnapshot = (out: string, prefix: string): Promise<StoredSnapshot> =>
  Effect.runPromise(readStoredSnapshotEffect(out, prefix).pipe(Effect.provide(NodeServices.layer)));

export const readLatestSnapshotEffect = (out: string, journal: Journal) =>
  Effect.gen(function* () {
    const latest = journal.entries.at(-1);
    if (!latest) {
      return undefined;
    }
    const separatorIndex = latest.tag.lastIndexOf("_");
    const prefix = separatorIndex === -1 ? latest.tag : latest.tag.slice(0, separatorIndex);
    return yield* readStoredSnapshotEffect(out, prefix);
  });

export const readLatestSnapshot = (
  out: string,
  journal: Journal,
): Promise<StoredSnapshot | undefined> =>
  Effect.runPromise(
    readLatestSnapshotEffect(out, journal).pipe(Effect.provide(NodeServices.layer)),
  );

export const nextMigrationName = (
  journal: Journal,
  name?: string,
  prefixMode: "index" | "timestamp" = "index",
): { readonly idx: number; readonly prefix: string; readonly tag: string } => {
  const idx = (journal.entries.at(-1)?.idx ?? 0) + 1;
  const prefix =
    prefixMode === "timestamp"
      ? `${new Date().toISOString().replace(/\D/g, "").slice(0, 17)}_${String(idx).padStart(4, "0")}`
      : String(idx).padStart(4, "0");
  const tag = `${prefix}_${slugify(name ?? "migration")}`;
  return { idx, prefix, tag };
};

export const writeMigrationRecordEffect = ({
  out,
  journal,
  snapshot,
  tag,
  prefix,
  idx,
  breakpoints,
  prevSnapshotId,
  drizzle,
}: {
  readonly out: string;
  readonly journal: Journal;
  readonly snapshot: SchemaSnapshot;
  readonly tag: string;
  readonly prefix: string;
  readonly idx: number;
  readonly breakpoints: boolean;
  readonly prevSnapshotId?: string;
  readonly drizzle?: unknown;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const meta = path.join(out, "meta");
    yield* fs.makeDirectory(meta, { recursive: true });
    const prevId = prevSnapshotId ?? "00000000-0000-0000-0000-000000000000";
    const stored: StoredSnapshot = {
      version: snapshotVersion,
      dialect: snapshot.dialect,
      id: randomUUID(),
      prevId,
      schema: snapshot,
      drizzle,
    };
    const nextJournal: Journal = {
      ...journal,
      entries: [
        ...journal.entries,
        {
          idx,
          version: snapshotVersion,
          when: Date.now(),
          tag,
          breakpoints,
        },
      ],
    };
    yield* fs.writeFileString(
      path.join(meta, `${prefix}_snapshot.json`),
      JSON.stringify(stored, null, 2),
    );
    yield* fs.writeFileString(
      path.join(meta, "_journal.json"),
      JSON.stringify(nextJournal, null, 2),
    );
  });

export const writeMigrationRecord = (options: {
  readonly out: string;
  readonly journal: Journal;
  readonly snapshot: SchemaSnapshot;
  readonly tag: string;
  readonly prefix: string;
  readonly idx: number;
  readonly breakpoints: boolean;
  readonly prevSnapshotId?: string;
  readonly drizzle?: unknown;
}): Promise<void> =>
  Effect.runPromise(writeMigrationRecordEffect(options).pipe(Effect.provide(NodeServices.layer)));

export const listMigrationModulesEffect = (out: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* existsEffect(fs, out);
    if (!exists) {
      return [];
    }
    return (yield* fs.readDirectory(out))
      .filter((file) => /^\d+_.+\.(ts|js|mjs)$/.test(file))
      .sort();
  });

export const listMigrationModules = (out: string): Promise<readonly string[]> =>
  Effect.runPromise(listMigrationModulesEffect(out).pipe(Effect.provide(NodeServices.layer)));
