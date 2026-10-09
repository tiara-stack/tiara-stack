import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { createHash, randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Stream } from "effect";
import { TestClock as TestClockService } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HttpIncomingMessage, HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { describe, expect } from "vitest";
import {
  stagedSourceDigestInput,
  stagedSourceActivationTimeouts,
  type StagedRunnerSnapshotIdentity,
  type StagedSourceFile,
  type StagedSourceSnapshot,
} from "sheet-workflow-contracts";
import {
  RunnerSourceProcessController,
  RunnerSourceRuntime,
  RunnerSourceRuntimeLive,
  RunnerSourceSnapshotAuthorizer,
  RunnerSourceSupervisorError,
  RunnerSourceSupervisor,
  RunnerSourceSupervisorLive,
  runnerSourceSnapshotRoutesLayer,
  runnerSourceIdentityKey,
  runnerSourceRevisionKey,
  type RunnerSourceSnapshotAuthorizerApi,
  type RunnerSourceSupervisorApi,
  type RunnerSourceRuntimeApi,
} from "./stagedSourceSupervisor";

const utf8File = (path: string, content: string): StagedSourceFile => ({
  path,
  contentEncoding: "utf8",
  content,
  mode: 0o644,
});

const snapshot = (
  revision: string,
  additionalFiles: ReadonlyArray<StagedSourceFile> = [],
): StagedSourceSnapshot => {
  const files = [
    utf8File("package.json", '{"name":"workspace"}'),
    utf8File("pnpm-lock.yaml", "lockfileVersion: '9.0'"),
    ...additionalFiles,
  ];
  return {
    revision,
    files,
    completion: {
      expectedFileCount: files.length,
      filesDigest: createHash("sha256")
        .update(stagedSourceDigestInput(revision, files))
        .digest("hex"),
    },
  };
};

const sourceIdentity: StagedRunnerSnapshotIdentity = {
  sessionId: "session-1",
  generation: 1,
  role: "ordinary-runner",
};
const sourceIdentityReordered: StagedRunnerSnapshotIdentity = {
  role: "ordinary-runner",
  generation: 1,
  sessionId: "session-1",
};
const identityKey = runnerSourceIdentityKey(sourceIdentity);
const runtimeStorageDefaults = {
  estimatePreparedSnapshotBytes: () => Effect.succeed(1_000),
  isRevisionSafelyReclaimable: () => Effect.succeed(true),
};

const revisionDirectory = (
  candidate: StagedSourceSnapshot,
  identity: StagedRunnerSnapshotIdentity = sourceIdentity,
) => runnerSourceRevisionKey(identity, candidate.revision, candidate.completion.filesDigest);
const revisionRoot = (workspaceRoot: string, candidate: StagedSourceSnapshot) =>
  join(workspaceRoot, "staged", identityKey, revisionDirectory(candidate));

const supervisorEnvironment = (
  workspaceRoot: string,
  runtime: RunnerSourceRuntimeApi,
  maxStagedStorageBytes?: number,
) =>
  RunnerSourceSupervisorLive({
    stagedRoot: join(workspaceRoot, "staged"),
    activeRoot: join(workspaceRoot, "active"),
    workspaceRoot,
    ...(maxStagedStorageBytes === undefined ? {} : { maxStagedStorageBytes }),
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        Layer.sync(RunnerSourceRuntime, () => runtime),
      ),
    ),
  );

const activateInEnvironment = (
  environment: ReturnType<typeof supervisorEnvironment>,
  candidate: StagedSourceSnapshot,
  identity: StagedRunnerSnapshotIdentity = sourceIdentity,
) =>
  Effect.gen(function* () {
    const supervisor = yield* RunnerSourceSupervisor;
    return yield* supervisor.activate({ identity, snapshot: candidate });
  }).pipe(Effect.provide(environment));

const testFileSystemLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

describe("runner staged-source supervisor", () => {
  it.effect("skips the snapshot root prepare sentinel and runs pending dependency setup", () => {
    const sourceRoot = join("/tmp", `runner-source-install-${randomUUID()}`);
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const commands: Array<string> = [];
      const spawner: ChildProcessSpawner.ChildProcessSpawner["Service"] = {
        spawn: () => Effect.die("spawn is not used by the install contract test"),
        exitCode: (command) =>
          Effect.gen(function* () {
            if (command._tag !== "StandardCommand")
              return yield* Effect.die("expected a standard pnpm command");
            expect(command.command).toBe("pnpm");
            expect(command.options.stdout).toBe("ignore");
            expect(command.options.stderr).toBe("ignore");
            expect(command.options.env?.pnpm_config_side_effects_cache_readonly).toBe("true");
            const cwd = command.options.cwd ?? sourceRoot;
            const rootManifest = JSON.parse(
              yield* fileSystem.readFileString(join(cwd, "package.json")),
            );
            if (command.args[0] === "install") {
              commands.push("install");
              expect(command.args).toEqual([
                "install",
                "--offline",
                "--frozen-lockfile",
                "--frozen-store",
                "--filter",
                "sheet-workflows...",
                "--prod",
                "--ignore-scripts",
              ]);
              if (
                rootManifest.scripts?.prepare !== undefined &&
                !command.args.includes("--ignore-scripts")
              )
                yield* fileSystem.writeFileString(join(cwd, "root-prepare-ran"), "executed");
            } else {
              commands.push("rebuild");
              expect(command.args).toEqual([
                "rebuild",
                "--pending",
                "--filter",
                "sheet-workflows...",
              ]);
              const nativeDependency = JSON.parse(
                yield* fileSystem.readFileString(join(cwd, "packages/native-dep/package.json")),
              );
              expect(nativeDependency.scripts?.install).toBe("touch dep-install-ran");
              yield* fileSystem.writeFileString(
                join(cwd, "packages/native-dep/dep-install-ran"),
                "executed",
              );
            }
            return ChildProcessSpawner.ExitCode(0);
          }),
        streamString: () => Stream.empty,
        streamLines: () => Stream.empty,
        lines: () => Effect.succeed([]),
        string: () => Effect.succeed(""),
      };
      const runtimeLayer = RunnerSourceRuntimeLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            NodeFileSystem.layer,
            NodePath.layer,
            Layer.succeed(RunnerSourceProcessController, {
              estimatePreparedSnapshotBytes: () => Effect.succeed(1),
              restart: () => Effect.void,
              verifyReadiness: () => Effect.succeed(true),
            }),
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      );
      yield* fileSystem.makeDirectory(join(sourceRoot, "packages/sheet-workflows"), {
        recursive: true,
      });
      yield* fileSystem.makeDirectory(join(sourceRoot, "packages/native-dep"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        join(sourceRoot, "package.json"),
        JSON.stringify({
          name: "fixture-root",
          private: true,
          scripts: { prepare: "touch root-prepare-ran" },
        }),
      );
      yield* fileSystem.writeFileString(
        join(sourceRoot, "pnpm-workspace.yaml"),
        "packages:\n  - packages/*\n",
      );
      yield* fileSystem.writeFileString(
        join(sourceRoot, "packages/sheet-workflows/package.json"),
        JSON.stringify({
          name: "sheet-workflows",
          version: "1.0.0",
          private: true,
          dependencies: { "native-dep": "workspace:*" },
        }),
      );
      yield* fileSystem.writeFileString(
        join(sourceRoot, "packages/native-dep/package.json"),
        JSON.stringify({
          name: "native-dep",
          version: "1.0.0",
          scripts: { install: "touch dep-install-ran" },
        }),
      );
      const runtime = yield* RunnerSourceRuntime.pipe(Effect.provide(runtimeLayer));
      yield* runtime.prepareSnapshot(sourceRoot);

      expect(commands).toEqual(["install", "rebuild"]);
      expect(yield* fileSystem.exists(join(sourceRoot, "root-prepare-ran"))).toBe(false);
      expect(
        yield* fileSystem.exists(join(sourceRoot, "packages/native-dep/dep-install-ran")),
      ).toBe(true);
      const restoredManifest = yield* fileSystem.readFileString(join(sourceRoot, "package.json"));
      expect(JSON.parse(restoredManifest).scripts.prepare).toBe("touch root-prepare-ran");
    }).pipe(
      Effect.provide(testFileSystemLayer),
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(sourceRoot, { recursive: true, force: true });
        }).pipe(
          Effect.provide(testFileSystemLayer),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  });

  it.effect("rejects a truncated tree before filesystem or process effects", () => {
    const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
    const calls: Array<string> = [];
    const runtime: RunnerSourceRuntimeApi = {
      ...runtimeStorageDefaults,
      prepareSnapshot: () =>
        Effect.sync(() => {
          calls.push("prepare");
        }),
      restart: () =>
        Effect.sync(() => {
          calls.push("restart");
        }),
      verifyReadiness: () => Effect.succeed(true),
    };
    const environment = supervisorEnvironment(workspaceRoot, runtime);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const complete = snapshot("r1", [utf8File("src/ordinary.ts", "export const ready = true")]);
      const truncated = { ...complete, files: complete.files.slice(0, 2) };
      const supervisor = yield* RunnerSourceSupervisor;
      const result = yield* supervisor.activate({ identity: sourceIdentity, snapshot: truncated });

      expect(result.failure).toBe("snapshot-completion-mismatch");
      expect(result.activeRevision).toBeNull();
      expect(calls).toEqual([]);
      expect(yield* fileSystem.exists(join(workspaceRoot, "staged"))).toBe(false);
    }).pipe(
      Effect.provide(environment),
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
        }).pipe(
          Effect.provide(environment),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  });

  it.effect("writes binary bytes, installs from the frozen store, and atomically activates", () => {
    const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
    const calls: Array<string> = [];
    const runtime: RunnerSourceRuntimeApi = {
      ...runtimeStorageDefaults,
      prepareSnapshot: (sourceRoot) =>
        Effect.sync(() => {
          calls.push(`install:${sourceRoot}`);
        }),
      restart: ({ revision }) =>
        Effect.sync(() => {
          calls.push(`restart:${revision}`);
        }),
      verifyReadiness: ({ revision }) =>
        Effect.sync(() => {
          calls.push(`ready:${revision}`);
          return true;
        }),
    };
    const environment = supervisorEnvironment(workspaceRoot, runtime);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const bytes = Uint8Array.from([0x00, 0x80, 0xff, 0x28, 0x00]);
      const binaryFile: StagedSourceFile = {
        path: "assets/opaque.bin",
        contentEncoding: "base64",
        content: Buffer.from(bytes).toString("base64"),
        mode: 0o644,
      };
      const supervisor = yield* RunnerSourceSupervisor;
      const result = yield* supervisor.activate({
        identity: sourceIdentity,
        snapshot: snapshot("r1", [binaryFile]),
      });
      const activeLink = join(workspaceRoot, "active", identityKey, "current");
      const activatedBytes = yield* fileSystem.readFile(join(activeLink, binaryFile.path));

      expect(result).toEqual({
        requestedRevision: "r1",
        activeRevision: "r1",
        unavailableRoles: [],
        failure: null,
      });
      expect([...activatedBytes]).toEqual([...bytes]);
      expect(calls.some((call) => call.startsWith("install:"))).toBe(true);
      expect(calls).toContain("restart:r1");
      expect(calls).toContain("ready:r1");
    }).pipe(
      Effect.provide(environment),
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
        }).pipe(
          Effect.provide(environment),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  });

  it.effect("times out snapshot preparation and releases the activation permit", () => {
    const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
    let preparationHangs = true;
    let prepareCalls = 0;
    let announcePreparationStarted!: () => void;
    const preparationStarted = new Promise<void>((resolve) => {
      announcePreparationStarted = resolve;
    });
    const runtime: RunnerSourceRuntimeApi = {
      ...runtimeStorageDefaults,
      prepareSnapshot: () =>
        Effect.sync(() => {
          prepareCalls += 1;
          if (preparationHangs) announcePreparationStarted();
        }).pipe(Effect.andThen(preparationHangs ? Effect.never : Effect.void)),
      restart: () => Effect.void,
      verifyReadiness: () => Effect.succeed(true),
    };
    const environment = supervisorEnvironment(workspaceRoot, runtime);

    return Effect.gen(function* () {
      const supervisor = yield* RunnerSourceSupervisor;
      const candidate = snapshot("r-timeout");
      const stalledActivation = yield* supervisor
        .activate({ identity: sourceIdentity, snapshot: candidate })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => preparationStarted);
      yield* TestClockService.adjust(stagedSourceActivationTimeouts.preparation);
      const timeoutResult = yield* Fiber.join(stalledActivation);

      expect(timeoutResult.failure).toBe("snapshot-preparation-timeout");
      expect(prepareCalls).toBe(1);

      preparationHangs = false;
      const retry = yield* supervisor.activate({ identity: sourceIdentity, snapshot: candidate });
      expect(retry.failure).toBeNull();
      expect(retry.activeRevision).toBe("r-timeout");
      expect(prepareCalls).toBe(2);
    }).pipe(
      Effect.provide(environment),
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
        }).pipe(
          Effect.provide(environment),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  });

  it.effect("keeps the requested pointer unavailable when its revision is not ready", () => {
    const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
    const restarts: Array<string | null> = [];
    const runtime: RunnerSourceRuntimeApi = {
      ...runtimeStorageDefaults,
      prepareSnapshot: () => Effect.void,
      restart: ({ revision }) =>
        Effect.sync(() => {
          restarts.push(revision);
        }),
      verifyReadiness: ({ revision }) => Effect.succeed(revision === "r1"),
    };
    const environment = supervisorEnvironment(workspaceRoot, runtime);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const supervisor = yield* RunnerSourceSupervisor;
      const first = snapshot("r1", [utf8File("src/ordinary.ts", "old source")]);
      const second = snapshot("r2", [utf8File("src/ordinary.ts", "new source")]);
      const firstResult = yield* supervisor.activate({ identity: sourceIdentity, snapshot: first });
      const activeLink = join(workspaceRoot, "active", identityKey, "current");
      const previousTarget = yield* fileSystem.readLink(activeLink);
      const secondResult = yield* supervisor.activate({
        identity: sourceIdentity,
        snapshot: second,
      });

      expect(firstResult.failure).toBeNull();
      expect(secondResult).toEqual({
        requestedRevision: "r2",
        activeRevision: "r2",
        unavailableRoles: ["ordinary-runner"],
        failure: "readiness-check-failed",
      });
      expect(yield* fileSystem.readLink(activeLink)).not.toBe(previousTarget);
      expect(restarts).toEqual(["r1", "r2"]);
      expect(yield* supervisor.readiness(sourceIdentity)).toEqual({
        requestedRevision: "r2",
        activeRevision: "r2",
        unavailableRoles: ["ordinary-runner"],
        failure: "readiness-check-failed",
      });
    }).pipe(
      Effect.provide(environment),
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
        }).pipe(
          Effect.provide(environment),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  });

  it.effect("keeps the prior pointer but marks it unavailable when staging fails", () => {
    const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
    let failPreparation = false;
    const restarts: Array<string | null> = [];
    const runtime: RunnerSourceRuntimeApi = {
      ...runtimeStorageDefaults,
      prepareSnapshot: () =>
        failPreparation
          ? Effect.fail(new RunnerSourceSupervisorError({ reason: "offline-install-failed" }))
          : Effect.void,
      restart: ({ revision }) =>
        Effect.sync(() => {
          restarts.push(revision);
        }),
      verifyReadiness: () => Effect.succeed(true),
    };
    const environment = supervisorEnvironment(workspaceRoot, runtime);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const supervisor = yield* RunnerSourceSupervisor;
      const first = yield* supervisor.activate({
        identity: sourceIdentity,
        snapshot: snapshot("r1", [utf8File("src/ordinary.ts", "old source")]),
      });
      const activeLink = join(workspaceRoot, "active", identityKey, "current");
      const previousTarget = yield* fileSystem.readLink(activeLink);
      failPreparation = true;
      const failed = yield* supervisor.activate({
        identity: sourceIdentity,
        snapshot: snapshot("r2", [utf8File("src/ordinary.ts", "new source")]),
      });

      expect(first.failure).toBeNull();
      expect(failed).toEqual({
        requestedRevision: "r2",
        activeRevision: "r1",
        unavailableRoles: ["ordinary-runner"],
        failure: "offline-install-failed",
      });
      expect(yield* fileSystem.readLink(activeLink)).toBe(previousTarget);
      expect(restarts).toEqual(["r1"]);
      expect(yield* supervisor.readiness(sourceIdentity)).toEqual({
        requestedRevision: "r1",
        activeRevision: "r1",
        unavailableRoles: ["ordinary-runner"],
        failure: "offline-install-failed",
      });
    }).pipe(
      Effect.provide(environment),
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
        }).pipe(
          Effect.provide(environment),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  });

  it.effect("reuses a previously staged immutable revision on activation retry", () => {
    const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
    const prepareCalls: Array<string> = [];
    const restartCalls: Array<string | null> = [];
    let ready = false;
    const runtime = Layer.sync(RunnerSourceRuntime, () => ({
      ...runtimeStorageDefaults,
      prepareSnapshot: (sourceRoot: string) =>
        Effect.sync(() => {
          prepareCalls.push(sourceRoot);
        }),
      restart: ({ revision }: { readonly revision: string | null }) =>
        Effect.sync(() => {
          restartCalls.push(revision);
        }),
      verifyReadiness: () => Effect.sync(() => ready),
    }));
    const environment = RunnerSourceSupervisorLive({
      stagedRoot: join(workspaceRoot, "staged"),
      activeRoot: join(workspaceRoot, "active"),
      workspaceRoot,
    }).pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, runtime)));

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const supervisor = yield* RunnerSourceSupervisor;
      const candidate = snapshot("r1", [utf8File("src/ordinary.ts", "retry me")]);
      const first = yield* supervisor.activate({ identity: sourceIdentity, snapshot: candidate });
      ready = true;
      const retry = yield* supervisor.activate({ identity: sourceIdentity, snapshot: candidate });

      expect(first.failure).toBe("readiness-check-failed");
      expect(retry.failure).toBeNull();
      expect(prepareCalls).toHaveLength(1);
      expect(restartCalls).toEqual(["r1", "r1"]);
      expect(yield* fileSystem.exists(join(workspaceRoot, "active", identityKey, "current"))).toBe(
        true,
      );
    }).pipe(
      Effect.provide(environment),
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
        }).pipe(
          Effect.provide(environment),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  });

  it.effect("retains referenced or unknown immutable revisions when capacity is exhausted", () => {
    const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
    let referenceState: "referenced" | "unknown" = "referenced";
    let prepareCalls = 0;
    const runtime: RunnerSourceRuntimeApi = {
      ...runtimeStorageDefaults,
      isRevisionSafelyReclaimable: () =>
        referenceState === "referenced"
          ? Effect.succeed(false)
          : Effect.fail(new RunnerSourceSupervisorError({ reason: "reference-check-unavailable" })),
      prepareSnapshot: () => Effect.sync(() => void (prepareCalls += 1)),
      restart: () => Effect.void,
      verifyReadiness: () => Effect.succeed(true),
    };
    const environment = supervisorEnvironment(workspaceRoot, runtime, 10_192);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const supervisor = yield* RunnerSourceSupervisor;
      const first = snapshot("r1");
      const second = snapshot("r2");
      const third = snapshot("r3");
      yield* supervisor.activate({ identity: sourceIdentity, snapshot: first });
      yield* supervisor.activate({ identity: sourceIdentity, snapshot: second });

      const referencedCapacityFailure = yield* supervisor.activate({
        identity: sourceIdentity,
        snapshot: third,
      });
      referenceState = "unknown";
      const unknownCapacityFailure = yield* supervisor.activate({
        identity: sourceIdentity,
        snapshot: third,
      });

      expect(referencedCapacityFailure.failure).toBe("staged-storage-capacity-exceeded");
      expect(unknownCapacityFailure.failure).toBe("staged-storage-capacity-exceeded");
      expect(yield* fileSystem.exists(revisionRoot(workspaceRoot, first))).toBe(true);
      expect(yield* fileSystem.exists(revisionRoot(workspaceRoot, second))).toBe(true);
      expect(yield* fileSystem.exists(revisionRoot(workspaceRoot, third))).toBe(false);
      expect(prepareCalls).toBe(2);
      expect((yield* supervisor.readiness(sourceIdentity)).activeRevision).toBe("r2");
    }).pipe(
      Effect.provide(environment),
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
        }).pipe(
          Effect.provide(environment),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  });

  it.effect("prunes only an affirmatively unreferenced non-current revision", () => {
    const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
    const runtime: RunnerSourceRuntimeApi = {
      ...runtimeStorageDefaults,
      isRevisionSafelyReclaimable: () => Effect.succeed(true),
      prepareSnapshot: () => Effect.void,
      restart: () => Effect.void,
      verifyReadiness: () => Effect.succeed(true),
    };
    const firstEnvironment = supervisorEnvironment(workspaceRoot, runtime, 10_192);
    const restartedEnvironment = supervisorEnvironment(workspaceRoot, runtime, 10_192);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const first = snapshot("r1");
      const second = snapshot("r2");
      const third = snapshot("r3");
      yield* activateInEnvironment(firstEnvironment, first);
      yield* activateInEnvironment(firstEnvironment, second);
      const activated = yield* activateInEnvironment(restartedEnvironment, third);

      expect(activated.failure).toBeNull();
      expect(yield* fileSystem.exists(revisionRoot(workspaceRoot, first))).toBe(false);
      expect(yield* fileSystem.exists(revisionRoot(workspaceRoot, second))).toBe(true);
      expect(yield* fileSystem.exists(revisionRoot(workspaceRoot, third))).toBe(true);
      expect(
        yield* fileSystem.readLink(join(workspaceRoot, "active", identityKey, "current")),
      ).toBe(
        relative(join(workspaceRoot, "active", identityKey), revisionRoot(workspaceRoot, third)),
      );
    }).pipe(
      Effect.provide(testFileSystemLayer),
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
        }).pipe(
          Effect.provide(testFileSystemLayer),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  });

  it.effect("uses canonical identity keys across property order and supervisor restart", () => {
    const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
    const preparedRoots: Array<string> = [];
    const restartCalls: Array<string | null> = [];
    const runtime: RunnerSourceRuntimeApi = {
      ...runtimeStorageDefaults,
      estimatePreparedSnapshotBytes: () => Effect.succeed(1_000),
      isRevisionSafelyReclaimable: () => Effect.succeed(false),
      prepareSnapshot: (sourceRoot) => Effect.sync(() => void preparedRoots.push(sourceRoot)),
      restart: ({ revision }) => Effect.sync(() => void restartCalls.push(revision)),
      verifyReadiness: () => Effect.succeed(true),
    };
    const firstEnvironment = supervisorEnvironment(workspaceRoot, runtime);
    const restartedEnvironment = supervisorEnvironment(workspaceRoot, runtime);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const candidate = snapshot("r1");
      expect(runnerSourceIdentityKey(sourceIdentityReordered)).toBe(identityKey);
      expect(revisionDirectory(candidate, sourceIdentityReordered)).toBe(
        revisionDirectory(candidate),
      );

      const first = yield* activateInEnvironment(firstEnvironment, candidate, sourceIdentity);
      const [afterRestart, sameRevisionWithOriginalOrder] = yield* Effect.gen(function* () {
        const supervisor = yield* RunnerSourceSupervisor;
        const afterRestart = yield* supervisor.activate({
          identity: sourceIdentityReordered,
          snapshot: candidate,
        });
        const sameRevisionWithOriginalOrder = yield* supervisor.activate({
          identity: sourceIdentity,
          snapshot: candidate,
        });
        return [afterRestart, sameRevisionWithOriginalOrder] as const;
      }).pipe(Effect.provide(restartedEnvironment));
      const activeDirectory = join(workspaceRoot, "active", identityKey);

      expect(first.failure).toBeNull();
      expect(afterRestart.failure).toBeNull();
      expect(sameRevisionWithOriginalOrder.failure).toBeNull();
      expect(preparedRoots).toHaveLength(1);
      expect(restartCalls).toEqual(["r1", "r1"]);
      expect(yield* fileSystem.exists(revisionRoot(workspaceRoot, candidate))).toBe(true);
      expect(yield* fileSystem.readLink(join(activeDirectory, "current"))).toBe(
        relative(activeDirectory, revisionRoot(workspaceRoot, candidate)),
      );
    }).pipe(
      Effect.provide(testFileSystemLayer),
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
        }).pipe(
          Effect.provide(testFileSystemLayer),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  });

  it.effect(
    "retains an old revision if the accepted-work reference check is missing after restart",
    () => {
      const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
      const referencedRuntime: RunnerSourceRuntimeApi = {
        ...runtimeStorageDefaults,
        isRevisionSafelyReclaimable: () => Effect.succeed(true),
        prepareSnapshot: () => Effect.void,
        restart: () => Effect.void,
        verifyReadiness: () => Effect.succeed(true),
      };
      const runtimeWithoutReferenceCheck: RunnerSourceRuntimeApi = {
        ...runtimeStorageDefaults,
        isRevisionSafelyReclaimable: undefined,
        prepareSnapshot: () => Effect.void,
        restart: () => Effect.void,
        verifyReadiness: () => Effect.succeed(true),
      };
      const firstEnvironment = supervisorEnvironment(workspaceRoot, referencedRuntime, 10_192);
      const restartedEnvironment = supervisorEnvironment(
        workspaceRoot,
        runtimeWithoutReferenceCheck,
        10_192,
      );

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const first = snapshot("r1");
        const second = snapshot("r2");
        const third = snapshot("r3");
        yield* activateInEnvironment(firstEnvironment, first);
        yield* activateInEnvironment(firstEnvironment, second);
        const failed = yield* activateInEnvironment(restartedEnvironment, third);

        expect(failed.failure).toBe("staged-storage-capacity-exceeded");
        expect(yield* fileSystem.exists(revisionRoot(workspaceRoot, first))).toBe(true);
        expect(yield* fileSystem.exists(revisionRoot(workspaceRoot, second))).toBe(true);
        expect(yield* fileSystem.exists(revisionRoot(workspaceRoot, third))).toBe(false);
      }).pipe(
        Effect.provide(testFileSystemLayer),
        Effect.ensuring(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
          }).pipe(
            Effect.provide(testFileSystemLayer),
            Effect.catch(() => Effect.void),
          ),
        ),
      );
    },
  );

  it.effect(
    "cleans abandoned temporary trees and fails capacity before touching the active revision",
    () => {
      const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
      let prepareCalls = 0;
      const runtime: RunnerSourceRuntimeApi = {
        ...runtimeStorageDefaults,
        isRevisionSafelyReclaimable: () => Effect.succeed(true),
        prepareSnapshot: () => Effect.sync(() => void (prepareCalls += 1)),
        restart: () => Effect.void,
        verifyReadiness: () => Effect.succeed(true),
      };
      const environment = supervisorEnvironment(workspaceRoot, runtime, 5_096);

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const supervisor = yield* RunnerSourceSupervisor;
        const first = snapshot("r1");
        const second = snapshot("r2");
        const stageParent = join(workspaceRoot, "staged", identityKey);
        const abandonedTemporaryRoot = join(stageParent, ".staging-abandoned");
        yield* fileSystem.makeDirectory(abandonedTemporaryRoot, { recursive: true });
        yield* fileSystem.writeFileString(join(abandonedTemporaryRoot, "partial.ts"), "partial");
        const firstResult = yield* supervisor.activate({
          identity: sourceIdentity,
          snapshot: first,
        });
        const activeLink = join(workspaceRoot, "active", identityKey, "current");
        const previousTarget = yield* fileSystem.readLink(activeLink);
        const secondResult = yield* supervisor.activate({
          identity: sourceIdentity,
          snapshot: second,
        });

        expect(firstResult.failure).toBeNull();
        expect(secondResult).toEqual({
          requestedRevision: "r2",
          activeRevision: "r1",
          unavailableRoles: ["ordinary-runner"],
          failure: "staged-storage-capacity-exceeded",
        });
        expect(yield* fileSystem.exists(abandonedTemporaryRoot)).toBe(false);
        expect(yield* fileSystem.readLink(activeLink)).toBe(previousTarget);
        expect(yield* fileSystem.exists(revisionRoot(workspaceRoot, first))).toBe(true);
        expect(yield* fileSystem.exists(revisionRoot(workspaceRoot, second))).toBe(false);
        expect(prepareCalls).toBe(1);
        expect(yield* supervisor.readiness(sourceIdentity)).toEqual({
          requestedRevision: "r1",
          activeRevision: "r1",
          unavailableRoles: ["ordinary-runner"],
          failure: "staged-storage-capacity-exceeded",
        });
      }).pipe(
        Effect.provide(environment),
        Effect.ensuring(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
          }).pipe(
            Effect.provide(environment),
            Effect.catch(() => Effect.void),
          ),
        ),
      );
    },
  );

  it.effect("finishes pointer promotion after the activation caller is interrupted", () => {
    const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
    return Effect.gen(function* () {
      const restartEntered = yield* Deferred.make<void>();
      const releaseRestart = yield* Deferred.make<void>();
      const restarts: Array<string | null> = [];
      const runtime: RunnerSourceRuntimeApi = {
        ...runtimeStorageDefaults,
        prepareSnapshot: () => Effect.void,
        restart: ({ revision }) =>
          Effect.gen(function* () {
            restarts.push(revision);
            if (revision === "r2") {
              yield* Deferred.succeed(restartEntered, undefined);
              yield* Deferred.await(releaseRestart);
            }
          }),
        verifyReadiness: () => Effect.succeed(true),
      };
      const environment = supervisorEnvironment(workspaceRoot, runtime);
      const run = Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const supervisor = yield* RunnerSourceSupervisor;
        const previous = snapshot("r1", [utf8File("src/ordinary.ts", "previous")]);
        const requested = snapshot("r2", [utf8File("src/ordinary.ts", "requested")]);
        const previousStatus = yield* supervisor.activate({
          identity: sourceIdentity,
          snapshot: previous,
        });
        const activeDirectory = join(workspaceRoot, "active", identityKey);
        const activeLink = join(activeDirectory, "current");
        const requestedTarget = relative(activeDirectory, revisionRoot(workspaceRoot, requested));
        const caller = yield* supervisor
          .activate({ identity: sourceIdentity, snapshot: requested })
          .pipe(Effect.forkScoped);

        yield* Deferred.await(restartEntered);
        expect(yield* fileSystem.readLink(activeLink)).toBe(requestedTarget);

        yield* Fiber.interrupt(caller);
        const callerExit = yield* Fiber.await(caller);
        expect(Exit.isFailure(callerExit) && Cause.hasInterrupts(callerExit.cause)).toBe(true);

        yield* Deferred.succeed(releaseRestart, undefined);

        // This waits behind the in-flight activation permit. When it proceeds,
        // the requested pointer and the supervisor's active revision must agree.
        const repeated = yield* supervisor.activate({
          identity: sourceIdentity,
          snapshot: requested,
        });
        const readiness = yield* supervisor.readiness(sourceIdentity);

        expect(previousStatus.failure).toBeNull();
        expect(repeated.failure).toBeNull();
        expect(readiness).toEqual({
          requestedRevision: "r2",
          activeRevision: "r2",
          unavailableRoles: [],
          failure: null,
        });
        expect(yield* fileSystem.readLink(activeLink)).toBe(requestedTarget);
        expect(restarts).toEqual(["r1", "r2"]);
      }).pipe(Effect.provide(environment));

      yield* run;
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
        }).pipe(
          Effect.provide(testFileSystemLayer),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  });

  it.effect("does not restart an already healthy same revision", () => {
    const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
    const restarts: Array<string | null> = [];
    const runtime: RunnerSourceRuntimeApi = {
      ...runtimeStorageDefaults,
      prepareSnapshot: () => Effect.void,
      restart: ({ revision }) =>
        Effect.sync(() => {
          restarts.push(revision);
        }),
      verifyReadiness: () => Effect.succeed(true),
    };
    const environment = supervisorEnvironment(workspaceRoot, runtime);

    return Effect.gen(function* () {
      const supervisor = yield* RunnerSourceSupervisor;
      const candidate = snapshot("r1", [utf8File("src/ordinary.ts", "same source")]);
      const first = yield* supervisor.activate({ identity: sourceIdentity, snapshot: candidate });
      const repeated = yield* supervisor.activate({
        identity: sourceIdentity,
        snapshot: candidate,
      });

      expect(first.failure).toBeNull();
      expect(repeated.failure).toBeNull();
      expect(restarts).toEqual(["r1"]);
    }).pipe(
      Effect.provide(environment),
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
        }).pipe(
          Effect.provide(environment),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  });

  it.effect("does not restart the prior revision when requested restart fails", () => {
    const workspaceRoot = join("/tmp", `runner-source-${randomUUID()}`);
    const restarts: Array<string | null> = [];
    let failRequestedRestart = true;
    const runtime = Layer.sync(RunnerSourceRuntime, () => ({
      ...runtimeStorageDefaults,
      prepareSnapshot: () => Effect.void,
      restart: ({ revision }: { readonly revision: string | null }) =>
        Effect.gen(function* () {
          restarts.push(revision);
          if (revision === "r2" && failRequestedRestart)
            return yield* Effect.fail(
              new RunnerSourceSupervisorError({ reason: "requested-process-restart-failed" }),
            );
        }),
      verifyReadiness: () => Effect.succeed(true),
    }));
    const environment = RunnerSourceSupervisorLive({
      stagedRoot: join(workspaceRoot, "staged"),
      activeRoot: join(workspaceRoot, "active"),
      workspaceRoot,
    }).pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, runtime)));

    return Effect.gen(function* () {
      const supervisor = yield* RunnerSourceSupervisor;
      const previous = yield* supervisor.activate({
        identity: sourceIdentity,
        snapshot: snapshot("r1", [utf8File("src/ordinary.ts", "old")]),
      });
      const failed = yield* supervisor.activate({
        identity: sourceIdentity,
        snapshot: snapshot("r2", [utf8File("src/ordinary.ts", "new")]),
      });

      expect(previous.failure).toBeNull();
      expect(failed).toEqual({
        requestedRevision: "r2",
        activeRevision: "r2",
        unavailableRoles: ["ordinary-runner"],
        failure: "requested-process-restart-failed",
      });
      expect(restarts).toEqual(["r1", "r2"]);
      const unavailableReadiness = yield* supervisor.readiness(sourceIdentity);
      expect(unavailableReadiness.activeRevision).toBe("r2");
      expect(unavailableReadiness.failure).toBe("requested-process-restart-failed");

      failRequestedRestart = false;
      const retried = yield* supervisor.activate({
        identity: sourceIdentity,
        snapshot: snapshot("r2", [utf8File("src/ordinary.ts", "new")]),
      });
      const readiness = yield* supervisor.readiness(sourceIdentity);

      expect(retried.failure).toBeNull();
      expect(restarts).toEqual(["r1", "r2", "r2"]);
      expect(readiness.activeRevision).toBe("r2");
      expect(readiness.failure).toBeNull();
    }).pipe(
      Effect.provide(environment),
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(workspaceRoot, { recursive: true, force: true });
        }).pipe(
          Effect.provide(environment),
          Effect.catch(() => Effect.void),
        ),
      ),
    );
  });

  it.effect("authenticates the exact session role before invoking source activation", () => {
    const authorizationChecks: Array<string> = [];
    const activations: Array<string> = [];
    const supervisor: RunnerSourceSupervisorApi = {
      activate: ({ identity, snapshot: requested }) =>
        Effect.sync(() => {
          activations.push(`${identity.sessionId}:${identity.generation}:${identity.role}`);
          return {
            requestedRevision: requested.revision,
            activeRevision: requested.revision,
            unavailableRoles: [],
            failure: null,
          };
        }),
      readiness: () =>
        Effect.succeed({
          requestedRevision: "r1",
          activeRevision: "r1",
          unavailableRoles: [],
          failure: null,
        }),
    };
    const authorizer: RunnerSourceSnapshotAuthorizerApi = {
      authorize: ({ headers }) =>
        Effect.sync(() => {
          authorizationChecks.push(headers.authorization ?? "");
          return sourceIdentity;
        }),
    };
    const routes = runnerSourceSnapshotRoutesLayer.pipe(
      Layer.provide(Layer.sync(RunnerSourceSupervisor, () => supervisor)),
      Layer.provide(Layer.sync(RunnerSourceSnapshotAuthorizer, () => authorizer)),
    );

    return Effect.gen(function* () {
      const handler = yield* HttpRouter.toHttpEffect(routes);
      const request = new Request("http://localhost/_internal/runner-source/v1/activate", {
        method: "POST",
        headers: {
          authorization: "Bearer session-bound-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          identity: sourceIdentity,
          snapshot: snapshot("r1"),
        }),
      });
      const response = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      );

      expect(response.status).toBe(200);
      expect(authorizationChecks).toEqual(["Bearer session-bound-token"]);
      expect(activations).toEqual(["session-1:1:ordinary-runner"]);
    }).pipe(Effect.provide(HttpRouter.layer));
  });

  it.effect("rejects an unauthorized session before source activation", () => {
    const activations: Array<string> = [];
    let authorizationCalls = 0;
    let bodyReads = 0;
    const supervisor: RunnerSourceSupervisorApi = {
      activate: ({ snapshot: requested }) =>
        Effect.sync(() => {
          activations.push(requested.revision);
          return {
            requestedRevision: requested.revision,
            activeRevision: requested.revision,
            unavailableRoles: [],
            failure: null,
          };
        }),
      readiness: () =>
        Effect.succeed({
          requestedRevision: "",
          activeRevision: null,
          unavailableRoles: ["ordinary-runner"],
          failure: "no-active-revision",
        }),
    };
    const authorizer: RunnerSourceSnapshotAuthorizerApi = {
      authorize: () =>
        Effect.sync(() => {
          authorizationCalls += 1;
        }).pipe(
          Effect.andThen(
            Effect.fail(new RunnerSourceSupervisorError({ reason: "session-role-unauthorized" })),
          ),
        ),
    };
    const routes = runnerSourceSnapshotRoutesLayer.pipe(
      Layer.provide(Layer.sync(RunnerSourceSupervisor, () => supervisor)),
      Layer.provide(Layer.sync(RunnerSourceSnapshotAuthorizer, () => authorizer)),
    );

    return Effect.gen(function* () {
      const handler = yield* HttpRouter.toHttpEffect(routes);
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            bodyReads += 1;
            controller.enqueue(new TextEncoder().encode("not read"));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const requestOptions: RequestInit & { readonly duplex: "half" } = {
        method: "POST",
        headers: {
          authorization: "Bearer rejected-token",
          "content-type": "application/json",
        },
        body,
        duplex: "half",
      };
      const response = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://localhost/_internal/runner-source/v1/activate", requestOptions),
          ),
        ),
      );

      expect(response.status).toBe(401);
      expect(authorizationCalls).toBe(1);
      expect(bodyReads).toBe(0);
      expect(activations).toEqual([]);
    }).pipe(Effect.provide(HttpRouter.layer));
  });

  it.effect("rejects a body identity that differs from the authenticated runner", () => {
    let activationCalls = 0;
    const supervisor: RunnerSourceSupervisorApi = {
      activate: () =>
        Effect.sync(() => {
          activationCalls += 1;
          return {
            requestedRevision: "r1",
            activeRevision: "r1",
            unavailableRoles: [],
            failure: null,
          };
        }),
      readiness: () =>
        Effect.succeed({
          requestedRevision: "",
          activeRevision: null,
          unavailableRoles: ["ordinary-runner"],
          failure: "no-active-revision",
        }),
    };
    const authorizer: RunnerSourceSnapshotAuthorizerApi = {
      authorize: () => Effect.succeed(sourceIdentity),
    };
    const routes = runnerSourceSnapshotRoutesLayer.pipe(
      Layer.provide(Layer.sync(RunnerSourceSupervisor, () => supervisor)),
      Layer.provide(Layer.sync(RunnerSourceSnapshotAuthorizer, () => authorizer)),
    );

    return Effect.gen(function* () {
      const handler = yield* HttpRouter.toHttpEffect(routes);
      const response = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://localhost/_internal/runner-source/v1/activate", {
              method: "POST",
              headers: {
                authorization: "Bearer session-bound-token",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                identity: { ...sourceIdentity, sessionId: "another-session" },
                snapshot: snapshot("r1"),
              }),
            }),
          ),
        ),
      );

      expect(response.status).toBe(401);
      expect(activationCalls).toBe(0);
    }).pipe(Effect.provide(HttpRouter.layer));
  });

  it.effect("rejects oversized declared and streamed request bodies before activation", () => {
    let authorizationCalls = 0;
    let activationCalls = 0;
    const supervisor: RunnerSourceSupervisorApi = {
      activate: () =>
        Effect.sync(() => {
          activationCalls += 1;
          return {
            requestedRevision: "r1",
            activeRevision: "r1",
            unavailableRoles: [],
            failure: null,
          };
        }),
      readiness: () =>
        Effect.succeed({
          requestedRevision: "",
          activeRevision: null,
          unavailableRoles: ["ordinary-runner"],
          failure: "no-active-revision",
        }),
    };
    const authorizer: RunnerSourceSnapshotAuthorizerApi = {
      authorize: () =>
        Effect.sync(() => {
          authorizationCalls += 1;
          return sourceIdentity;
        }),
    };
    const routes = runnerSourceSnapshotRoutesLayer.pipe(
      Layer.provide(Layer.sync(RunnerSourceSupervisor, () => supervisor)),
      Layer.provide(Layer.sync(RunnerSourceSnapshotAuthorizer, () => authorizer)),
    );

    return Effect.gen(function* () {
      const handler = yield* HttpRouter.toHttpEffect(routes);
      const invoke = (request: Request) =>
        handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request),
          ),
          Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(32)),
        );
      const headers = {
        authorization: "Bearer session-bound-token",
        "content-type": "application/json",
      };
      const declaredLengthResponse = yield* invoke(
        new Request("http://localhost/_internal/runner-source/v1/activate", {
          method: "POST",
          headers: { ...headers, "content-length": "33" },
        }),
      );
      const streamedRequest = new Request("http://localhost/_internal/runner-source/v1/activate", {
        method: "POST",
        headers,
        body: new Uint8Array(33),
      });
      expect(streamedRequest.headers.get("content-length")).toBeNull();
      const streamedResponse = yield* invoke(streamedRequest);

      expect(declaredLengthResponse.status).toBe(413);
      expect(streamedResponse.status).toBe(413);
      expect(authorizationCalls).toBe(2);
      expect(activationCalls).toBe(0);
    }).pipe(Effect.provide(HttpRouter.layer));
  });

  it.effect("times out a stalled request body and releases the body permit", () => {
    let authorizationCalls = 0;
    let activationCalls = 0;
    let activeReaders = 0;
    let maxActiveReaders = 0;
    let announceFirstRead!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => {
      announceFirstRead = resolve;
    });
    const supervisor: RunnerSourceSupervisorApi = {
      activate: ({ snapshot: requested }) =>
        Effect.sync(() => {
          activationCalls += 1;
          return {
            requestedRevision: requested.revision,
            activeRevision: requested.revision,
            unavailableRoles: [],
            failure: null,
          };
        }),
      readiness: () =>
        Effect.succeed({
          requestedRevision: "",
          activeRevision: null,
          unavailableRoles: ["ordinary-runner"],
          failure: "no-active-revision",
        }),
    };
    const authorizer: RunnerSourceSnapshotAuthorizerApi = {
      authorize: () =>
        Effect.sync(() => {
          authorizationCalls += 1;
          return sourceIdentity;
        }),
    };
    const routes = runnerSourceSnapshotRoutesLayer.pipe(
      Layer.provide(Layer.sync(RunnerSourceSupervisor, () => supervisor)),
      Layer.provide(Layer.sync(RunnerSourceSnapshotAuthorizer, () => authorizer)),
    );

    return Effect.gen(function* () {
      const handler = yield* HttpRouter.toHttpEffect(routes);
      const headers = {
        authorization: "Bearer session-bound-token",
        "content-type": "application/json",
      };
      const makeRequest = (content: string, blockFirstRead = false) => {
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              activeReaders += 1;
              maxActiveReaders = Math.max(maxActiveReaders, activeReaders);
              try {
                if (blockFirstRead) {
                  announceFirstRead();
                  await new Promise<void>(() => undefined);
                }
                controller.enqueue(new TextEncoder().encode(content));
                controller.close();
              } finally {
                activeReaders -= 1;
              }
            },
          },
          { highWaterMark: 0 },
        );
        const requestOptions: RequestInit & { readonly duplex: "half" } = {
          method: "POST",
          headers,
          body,
          duplex: "half",
        };
        return new Request("http://localhost/_internal/runner-source/v1/activate", requestOptions);
      };
      const invoke = (request: Request) =>
        handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request),
          ),
        );
      const malformedRequest = makeRequest("{ malformed", true);
      const validRequest = makeRequest(
        JSON.stringify({ identity: sourceIdentity, snapshot: snapshot("r-serialized") }),
      );
      const malformedResponse = yield* invoke(malformedRequest).pipe(Effect.forkScoped);
      yield* Effect.promise(() => firstReadStarted);
      const validResponse = yield* invoke(validRequest).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(maxActiveReaders).toBe(1);
      yield* TestClockService.adjust(stagedSourceActivationTimeouts.requestBody);
      const responses = yield* Effect.all([
        Fiber.join(malformedResponse),
        Fiber.join(validResponse),
      ]);

      expect(responses.map((response) => response.status)).toEqual([408, 200]);
      expect(JSON.stringify(responses[0]?.body.toJSON())).toContain("request-body-timeout");
      expect(authorizationCalls).toBe(2);
      expect(activationCalls).toBe(1);
    }).pipe(Effect.provide(HttpRouter.layer));
  });
});
