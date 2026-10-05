import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Redacted } from "effect";
import { rmdir } from "node:fs/promises";
import path from "node:path";
import { applicationPlaneDigest, applicationPlaneIdentity } from "./owned-application-plane";
import {
  makeOwnedApplicationStorage,
  OwnedApplicationDirectoryRemoval,
  ownedApplicationDirectoryRemovalError,
} from "./owned-application-storage";

const untypedDirectoryRemoval = {
  removeEmptyDirectory: (_directory: string) => Effect.fail(new Error("raw removal failure")),
};
// @ts-expect-error Raw platform errors must be mapped before crossing the injected service seam.
const invalidDirectoryRemoval: typeof OwnedApplicationDirectoryRemoval.Service =
  untypedDirectoryRemoval;
void invalidDirectoryRemoval;

const plane = (sessionId: string) =>
  applicationPlaneIdentity({
    sessionId,
    ownerToken: sessionId,
    server: "test",
    generation: 1,
    callbackOrigin: "https://db.test",
    cacheOrigin: "https://cache.test",
    artifacts: {
      generatedSchema: "1".repeat(64),
      callbacks: "1".repeat(64),
      authorization: "1".repeat(64),
      client: "1".repeat(64),
      deployment: "1".repeat(64),
      zeroVersion: "1.5.0",
      migrations: [{ id: 1, name: "migration", digest: "1".repeat(64) }],
    },
  });
const credentials = {
  runtime: Redacted.make("runtime-only"),
  replication: Redacted.make("replication-only"),
  migration: Redacted.make("migration-only"),
};
const directoryRemoval = {
  removeEmptyDirectory: (directory: string) =>
    Effect.tryPromise({
      try: () => rmdir(directory),
      catch: ownedApplicationDirectoryRemovalError,
    }),
};
it.live(
  "removes exact replica sidecars and scoped credential files, preserving another group",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const storage = yield* makeOwnedApplicationStorage(root);
      const first = yield* storage.provision(plane("one"), credentials);
      const second = yield* storage.provision(plane("two"), credentials);
      yield* fs.writeFileString(first.replicaPath, "disposable");
      yield* fs.writeFileString(`${first.replicaPath}-wal`, "wal");
      yield* fs.writeFileString(`${first.replicaPath}-shm`, "shm");
      yield* storage.remove(plane("one"), "replica");
      yield* storage.remove(plane("one"), "credentials");
      yield* storage.remove(plane("one"), "credentials");
      expect(yield* storage.inspect(plane("one"))).toEqual([]);
      expect(yield* storage.inspect(plane("two"))).toEqual(["replica", "credentials"]);
      expect(yield* fs.readFileString(path.join(second.credentialsDirectory, "runtime"))).toBe(
        "runtime-only",
      );
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(OwnedApplicationDirectoryRemoval, directoryRemoval),
    ),
);
it.live("refuses changed owners, unexpected files and symlinks before deleting anything", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const storage = yield* makeOwnedApplicationStorage(root);
    const p = plane("one");
    const allocation = yield* storage.provision(p, credentials);
    expect(
      (yield* Effect.exit(storage.remove({ ...p, ownerToken: "foreign" }, "credentials")))._tag,
    ).toBe("Failure");
    const extra = path.join(allocation.credentialsDirectory, "unexpected");
    yield* fs.writeFileString(extra, "preserve");
    expect((yield* Effect.exit(storage.remove(p, "credentials")))._tag).toBe("Failure");
    yield* fs.remove(extra);
    const target = path.join(root, "shared");
    yield* fs.writeFileString(target, "shared");
    yield* fs.symlink(target, allocation.replicaPath);
    expect((yield* Effect.exit(storage.remove(p, "replica")))._tag).toBe("Failure");
    expect(yield* fs.readFileString(target)).toBe("shared");
    expect(yield* fs.exists(path.join(allocation.credentialsDirectory, "runtime"))).toBe(true);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(OwnedApplicationDirectoryRemoval, directoryRemoval),
  ),
);

it.live("preserves a file added after the owned directory emptiness check", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const p = plane("racing-cleanup");
    const directory = path.join(root, `${p.app}-credentials`);
    const owner = path.join(directory, ".owner");
    const lateFile = path.join(directory, "late-file");
    let injected = false;
    const raceFileSystem = FileSystem.make({
      ...fs,
      readDirectory: (target) =>
        Effect.gen(function* () {
          const entries = yield* fs.readDirectory(target);
          if (target === directory && entries.length === 0 && !injected) {
            injected = true;
            yield* fs.writeFileString(lateFile, "preserve");
          }
          return entries;
        }),
    });
    const storage = yield* Effect.provideService(
      makeOwnedApplicationStorage(root),
      FileSystem.FileSystem,
      raceFileSystem,
    );
    yield* storage.provision(p, credentials);

    const result = yield* Effect.exit(storage.remove(p, "credentials"));

    expect(result._tag).toBe("Failure");
    expect(yield* fs.readFileString(lateFile)).toBe("preserve");
    expect(yield* fs.readFileString(owner)).toBe(
      applicationPlaneDigest({
        sessionId: p.sessionId,
        ownerToken: p.ownerToken,
        app: p.app,
        server: p.server,
      }),
    );
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(OwnedApplicationDirectoryRemoval, directoryRemoval),
  ),
);

for (const { code, expectedReason } of [
  { code: "ENOTEMPTY", expectedReason: "unrecorded-storage-file" },
  { code: "EEXIST", expectedReason: "unrecorded-storage-file" },
  { code: "EACCES", expectedReason: "storage-directory-removal-failed" },
] as const)
  it.live(`maps injected atomic directory-removal error ${code} and keeps the directory`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const p = plane(`removal-${code}`);
      const directory = path.join(root, `${p.app}-credentials`);
      const storage = yield* makeOwnedApplicationStorage(root);
      yield* storage.provision(p, credentials);

      const error = yield* Effect.flip(
        storage.remove(p, "credentials").pipe(
          Effect.provideService(OwnedApplicationDirectoryRemoval, {
            removeEmptyDirectory: (target) =>
              target === directory
                ? Effect.fail(
                    ownedApplicationDirectoryRemovalError(
                      Object.assign(new Error("directory removal failed"), { code }),
                    ),
                  )
                : directoryRemoval.removeEmptyDirectory(target),
          }),
        ),
      );
      expect(error.reason).toBe(expectedReason);
      expect(yield* fs.exists(directory)).toBe(true);
      expect(yield* fs.exists(path.join(directory, ".owner"))).toBe(true);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(OwnedApplicationDirectoryRemoval, directoryRemoval),
    ),
  );
