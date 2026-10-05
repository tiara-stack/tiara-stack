import path from "node:path";
import { Context, Effect, FileSystem, Predicate, Redacted, Schema } from "effect";
import {
  applicationPlaneDigest,
  OwnedApplicationError,
  type OwnedApplicationPlane,
} from "./owned-application-plane";

const fail = (reason: string) => Effect.fail(new OwnedApplicationError({ reason }));
export interface OwnedApplicationDirectoryRemovalApi {
  readonly removeEmptyDirectory: (directory: string) => Effect.Effect<void, OwnedApplicationError>;
}
export class OwnedApplicationDirectoryRemoval extends Context.Service<
  OwnedApplicationDirectoryRemoval,
  OwnedApplicationDirectoryRemovalApi
>()("developer-launcher/OwnedApplicationDirectoryRemoval") {}
type Volume = "replica" | "credentials";
const files: Record<Volume, readonly string[]> = {
  replica: ["replica.db", "replica.db-wal", "replica.db-shm"],
  credentials: ["runtime", "replication", "migration"],
};

const DirectoryNotEmptyError = Schema.Struct({ code: Schema.Literals(["ENOTEMPTY", "EEXIST"]) });
const isDirectoryNotEmptyCode = Schema.is(DirectoryNotEmptyError);
const hasCause = Predicate.hasProperty("cause");
const hasReason = Predicate.hasProperty("reason");
const isDirectoryNotEmptyError = (error: unknown, seen = new Set<object>()): boolean => {
  if (isDirectoryNotEmptyCode(error)) return true;
  if (!Predicate.isObject(error) || seen.has(error)) return false;
  seen.add(error);
  return (
    (hasCause(error) && isDirectoryNotEmptyError(error.cause, seen)) ||
    (hasReason(error) && isDirectoryNotEmptyError(error.reason, seen))
  );
};
export const ownedApplicationDirectoryRemovalError = (error: unknown) =>
  new OwnedApplicationError({
    reason: isDirectoryNotEmptyError(error)
      ? "unrecorded-storage-file"
      : "storage-directory-removal-failed",
  });

/** Filesystem-backed disposable storage for operator-managed volumes, never a shared cache path. */
export const makeOwnedApplicationStorage = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const canonicalRoot = yield* fs.realPath(root);
    const location = (plane: OwnedApplicationPlane, volume: Volume) =>
      Effect.gen(function* () {
        if (!/^p[a-f0-9]{32}$/.test(plane.app)) return yield* fail("invalid-storage-identity");
        return path.join(canonicalRoot, `${plane.app}-${volume}`);
      });
    const marker = (plane: OwnedApplicationPlane) =>
      applicationPlaneDigest({
        sessionId: plane.sessionId,
        ownerToken: plane.ownerToken,
        app: plane.app,
        server: plane.server,
      });
    const verify = (plane: OwnedApplicationPlane, volume: Volume) =>
      Effect.gen(function* () {
        const directory = yield* location(plane, volume);
        // Directory enumeration also sees dangling symlinks; they are not absence proof.
        if (!(yield* fs.readDirectory(canonicalRoot)).includes(path.basename(directory)))
          return undefined;
        if ((yield* fs.realPath(directory)) !== directory)
          return yield* fail("storage-symlink-refused");
        const owner = path.join(directory, ".owner");
        if (
          (yield* fs.realPath(owner)) !== owner ||
          (yield* fs.readFileString(owner)) !== marker(plane)
        )
          return yield* fail("storage-owner-unproved");
        const entries = yield* fs.readDirectory(directory);
        if (entries.some((name) => name !== ".owner" && !files[volume].includes(name)))
          return yield* fail("unrecorded-storage-file");
        for (const name of entries) {
          const file = path.join(directory, name);
          if ((yield* fs.realPath(file)) !== file) return yield* fail("storage-symlink-refused");
          if ((yield* fs.stat(file)).type !== "File")
            return yield* fail("storage-file-type-mismatch");
        }
        return directory;
      });
    return {
      provision: (
        plane: OwnedApplicationPlane,
        credentials: {
          readonly runtime: Redacted.Redacted<string>;
          readonly replication: Redacted.Redacted<string>;
          readonly migration: Redacted.Redacted<string>;
        },
      ) =>
        Effect.gen(function* () {
          for (const volume of ["replica", "credentials"] as const) {
            const directory = yield* location(plane, volume);
            yield* fs.makeDirectory(directory, { mode: 0o700 });
            yield* fs.writeFileString(path.join(directory, ".owner"), marker(plane), {
              flag: "wx",
              mode: 0o600,
            });
          }
          const directory = yield* location(plane, "credentials");
          for (const name of ["runtime", "replication", "migration"] as const)
            yield* fs.writeFileString(
              path.join(directory, name),
              Redacted.value(credentials[name]),
              { flag: "wx", mode: 0o600 },
            );
          return {
            replicaPath: path.join(yield* location(plane, "replica"), "replica.db"),
            credentialsDirectory: directory,
          };
        }),
      inspect: (plane: OwnedApplicationPlane) =>
        Effect.gen(function* () {
          const present: Volume[] = [];
          for (const volume of ["replica", "credentials"] as const)
            if ((yield* verify(plane, volume)) !== undefined) present.push(volume);
          return present;
        }),
      /** Call only after cache/process termination proof; unknown files and links quarantine. */
      remove: (plane: OwnedApplicationPlane, volume: Volume) =>
        Effect.gen(function* () {
          const directory = yield* verify(plane, volume);
          if (directory === undefined) return;
          for (const name of files[volume]) {
            const file = path.join(directory, name);
            if (yield* fs.exists(file)) yield* fs.remove(file);
          }
          const owner = path.join(directory, ".owner");
          yield* fs.remove(owner);
          const removal = yield* Effect.exit(
            Effect.gen(function* () {
              if ((yield* fs.readDirectory(directory)).length !== 0)
                return yield* fail("unrecorded-storage-file");
              const directoryRemoval = yield* OwnedApplicationDirectoryRemoval;
              yield* directoryRemoval.removeEmptyDirectory(directory);
            }),
          );
          if (removal._tag === "Failure") {
            const restoration = yield* Effect.result(
              fs.writeFileString(owner, marker(plane), { flag: "wx", mode: 0o600 }),
            );
            if (restoration._tag === "Failure")
              return yield* fail("storage-owner-restoration-failed");
            return yield* Effect.failCause(removal.cause);
          }
        }),
    };
  });
