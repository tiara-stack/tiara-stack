import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Path, Result } from "effect";
import { nextMigrationName, readJournalEffect, readLatestSnapshotEffect } from "./journal";

const withJournal = <A, E, R>(content: string, f: (out: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "effect-sql-kit-journal-")));
      yield* fs.makeDirectory(path.join(dir, "meta"), { recursive: true });
      yield* Effect.promise(() => writeFile(path.join(dir, "meta", "_journal.json"), content));
      return dir;
    }),
    f,
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

describe("migration journal effects", () => {
  it("uses high-resolution timestamp migration prefixes", () => {
    const first = nextMigrationName(
      {
        version: 1,
        dialect: "sqlite",
        entries: [],
      },
      "initial",
      "timestamp",
    );
    const second = nextMigrationName(
      {
        version: 1,
        dialect: "sqlite",
        entries: [
          {
            idx: first.idx,
            version: 1,
            when: 1,
            tag: first.tag,
            breakpoints: true,
          },
        ],
      },
      "next",
      "timestamp",
    );

    expect(first.prefix).toMatch(/^\d{17}_0001$/);
    expect(second.prefix).toMatch(/^\d{17}_0002$/);
    expect(first.prefix).not.toBe(second.prefix);
  });

  it.effect("reads valid journals", () =>
    withJournal(
      JSON.stringify({
        version: 1,
        dialect: "sqlite",
        entries: [
          {
            idx: 1,
            version: 1,
            when: 1,
            tag: "0001_initial",
            breakpoints: true,
          },
        ],
      }),
      (out) =>
        Effect.gen(function* () {
          const journal = yield* readJournalEffect(out, "sqlite");
          expect(journal.entries).toHaveLength(1);
          expect(journal.entries[0]?.tag).toBe("0001_initial");
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads latest snapshots for timestamp-style tags", () =>
    withJournal(
      JSON.stringify({
        version: 1,
        dialect: "sqlite",
        entries: [
          {
            idx: 1,
            version: 1,
            when: 1,
            tag: "20260515070123456_0001_initial",
            breakpoints: true,
          },
        ],
      }),
      (out) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.writeFileString(
            path.join(out, "meta", "20260515070123456_0001_snapshot.json"),
            JSON.stringify({
              version: 1,
              dialect: "sqlite",
              id: "snapshot-id",
              prevId: "00000000-0000-0000-0000-000000000000",
              schema: {},
            }),
          );

          const journal = yield* readJournalEffect(out, "sqlite");
          const snapshot = yield* readLatestSnapshotEffect(out, journal);
          expect(snapshot?.id).toBe("snapshot-id");
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails invalid journals through the schema parser", () =>
    withJournal(
      JSON.stringify({
        version: 1,
        dialect: "sqlite",
        entries: [{ tag: "0001_initial" }],
      }),
      (out) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(readJournalEffect(out, "sqlite"));
          expect(Result.isFailure(result)).toBe(true);
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
