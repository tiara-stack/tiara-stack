import { it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { describe, expect } from "vitest";
import {
  activateCoalescedRunnerSnapshots,
  activateRunnerSnapshot,
  affectedRunnerRoles,
  classifySnapshotChange,
  sealStagedSourceSnapshot,
  StagedRunnerRuntime,
  SnapshotRuntimeError,
  validateStagedSnapshot,
  type StagedRunnerRuntimeApi,
  type StagedSourceSnapshot,
} from "./staged-source";

const utf8File = (path: string, content: string, mode = 0o644) => ({
  path,
  contentEncoding: "utf8" as const,
  content,
  mode,
});

const snapshot = (
  revision: string,
  files: ReadonlyArray<readonly [string, string]> = [],
): StagedSourceSnapshot =>
  sealStagedSourceSnapshot(revision, [
    utf8File("package.json", '{"name":"workspace"}'),
    utf8File("pnpm-lock.yaml", "lockfileVersion: '9.0'"),
    ...files.map(([path, content]) => utf8File(path, content)),
  ]);

const withFileMode = (
  tree: StagedSourceSnapshot,
  path: string,
  mode: number,
): StagedSourceSnapshot =>
  sealStagedSourceSnapshot(
    tree.revision,
    tree.files.map((file) => (file.path === path ? { ...file, mode } : file)),
  );

const runtimeLayer = (overrides: Partial<StagedRunnerRuntimeApi> = {}) =>
  Layer.sync(StagedRunnerRuntime, () => ({
    stageComplete: () => Effect.void,
    fenceOldOwner: () => Effect.void,
    activateComplete: () => Effect.void,
    retainImmutableRevision: () => Effect.void,
    rebuildArtifacts: () => Effect.void,
    restartRole: () => Effect.void,
    verifyActualReadiness: () => Effect.succeed(true),
    ...overrides,
  }));

const activateWithRuntime = ({
  runtime: layer,
  ...input
}: Parameters<typeof activateRunnerSnapshot>[0] & {
  readonly runtime: ReturnType<typeof runtimeLayer>;
}) => activateRunnerSnapshot(input).pipe(Effect.provide(layer));

const activateCoalescedWithRuntime = ({
  runtime: layer,
  ...input
}: Parameters<typeof activateCoalescedRunnerSnapshots>[0] & {
  readonly runtime: ReturnType<typeof runtimeLayer>;
}) => activateCoalescedRunnerSnapshots(input).pipe(Effect.provide(layer));

describe("staged source snapshots", () => {
  it.effect(
    "accepts complete snapshots and represents additions/deletions by full replacement",
    () =>
      Effect.gen(function* () {
        const first = snapshot("r1", [["src/old.ts", "old"]]);
        const next = snapshot("r2", [["src/new.ts", "new"]]);
        yield* validateStagedSnapshot(next);
        expect(classifySnapshotChange(first, next)).toBe("source");
        expect(next.files.some(({ path }) => path === "src/old.ts")).toBe(false);
        let stagedPaths: ReadonlyArray<string> = [];
        const result = yield* activateWithRuntime({
          snapshot: next,
          previous: first,
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            stageComplete: (staged) =>
              Effect.sync(() => {
                stagedPaths = staged.files.map(({ path }) => path);
              }),
          }),
        });
        expect(result.failure).toBeNull();
        expect(result.activeRevision).toBe("r2");
        expect(stagedPaths).not.toContain("src/old.ts");
      }),
  );

  it.effect("preserves base64 file bytes and includes encoding in the digest", () =>
    Effect.gen(function* () {
      const bytes = Uint8Array.from([0x00, 0x80, 0xff, 0x28, 0x00]);
      const binaryFile = {
        path: "assets/opaque.bin",
        contentEncoding: "base64" as const,
        content: Buffer.from(bytes).toString("base64"),
        mode: 0o644,
      };
      const base64Snapshot = sealStagedSourceSnapshot("r1", [...snapshot("r1").files, binaryFile]);
      const utf8Snapshot = sealStagedSourceSnapshot("r1", [
        ...snapshot("r1").files,
        { ...binaryFile, contentEncoding: "utf8" },
      ]);
      const storedFile = base64Snapshot.files.find(({ path }) => path === binaryFile.path);

      yield* validateStagedSnapshot(base64Snapshot);
      expect(storedFile?.contentEncoding).toBe("base64");
      expect([...Buffer.from(storedFile?.content ?? "", "base64")]).toEqual([...bytes]);
      expect(base64Snapshot.completion.filesDigest).not.toBe(utf8Snapshot.completion.filesDigest);
      expect(classifySnapshotChange(base64Snapshot, utf8Snapshot)).toBe("source");
    }),
  );

  it.effect("rejects a truncated snapshot before any runtime effects", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1", [["src/retained.ts", "active"]]);
      const complete = snapshot("r2", [["src/retained.ts", "next"]]);
      const truncated: StagedSourceSnapshot = {
        ...complete,
        files: complete.files.filter(({ path }) => path !== "src/retained.ts"),
      };
      expect(truncated.files.some(({ path }) => path === "package.json")).toBe(true);
      expect(truncated.files.some(({ path }) => path === "pnpm-lock.yaml")).toBe(true);

      let runtimeCalls = 0;
      const sideEffect = () => Effect.sync(() => void (runtimeCalls += 1));
      const result = yield* activateWithRuntime({
        snapshot: truncated,
        previous,
        owner: "old",
        nextOwner: "new",
        runtime: runtimeLayer({
          stageComplete: sideEffect,
          fenceOldOwner: sideEffect,
          retainImmutableRevision: sideEffect,
          rebuildArtifacts: sideEffect,
          activateComplete: sideEffect,
          restartRole: sideEffect,
          verifyActualReadiness: () =>
            Effect.sync(() => {
              runtimeCalls += 1;
              return true;
            }),
        }),
      });
      expect(result).toEqual({
        requestedRevision: "r2",
        activeRevision: "r1",
        unavailableRoles: ["ordinary-runner"],
        failure: "snapshot-completion-mismatch",
      });
      expect(runtimeCalls).toBe(0);
    }),
  );

  it.effect("does not restart workflow roles for a mode-only unrelated source edit", () =>
    Effect.gen(function* () {
      const manifestsAndSources = [
        ["packages/sheet-workflows/package.json", '{"name":"sheet-workflows"}'],
        ["packages/sheet-workflows/src/index.ts", "export const workflow = true"],
        ["packages/unrelated/package.json", '{"name":"unrelated"}'],
        ["packages/unrelated/src/index.ts", "export const unrelated = true"],
      ] as const;
      const previous = snapshot("r1", manifestsAndSources);
      const next = withFileMode(
        snapshot("r2", manifestsAndSources),
        "packages/unrelated/src/index.ts",
        0o755,
      );
      expect(classifySnapshotChange(previous, next)).toBe("source");
      expect(affectedRunnerRoles(previous, next, ["workflow-api", "ordinary-runner"])).toEqual([]);

      let restartCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: "owner",
        nextOwner: "next-owner",
        roles: ["workflow-api", "ordinary-runner"],
        runtime: runtimeLayer({
          restartRole: () => {
            restartCalls += 1;
            return Effect.void;
          },
        }),
      });
      expect(result.failure).toBeNull();
      expect(restartCalls).toBe(0);
    }),
  );

  it.effect("does not select workflow roles for an unrelated package source edit", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1", [
        ["packages/sheet-workflows/package.json", '{"name":"sheet-workflows"}'],
        ["packages/unrelated/package.json", '{"name":"unrelated"}'],
        ["packages/unrelated/src/index.ts", "export const value = 1"],
      ]);
      const next = snapshot("r2", [
        ["packages/sheet-workflows/package.json", '{"name":"sheet-workflows"}'],
        ["packages/unrelated/package.json", '{"name":"unrelated"}'],
        ["packages/unrelated/src/index.ts", "export const value = 2"],
      ]);

      expect(affectedRunnerRoles(previous, next, ["workflow-api", "ordinary-runner"])).toEqual([]);
      let restartCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: "old",
        nextOwner: "new",
        roles: ["workflow-api", "ordinary-runner"],
        runtime: runtimeLayer({
          restartRole: () => {
            restartCalls += 1;
            return Effect.void;
          },
        }),
      });
      expect(result.failure).toBeNull();
      expect(restartCalls).toBe(0);
    }),
  );

  it.effect("identifies workflow packages by manifest name rather than directory", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1", [
        ["packages/runner-app/package.json", '{"name":"sheet-workflows"}'],
        ["packages/unrelated/package.json", '{"name":"unrelated"}'],
        ["packages/unrelated/src/index.ts", "before"],
      ]);
      const next = snapshot("r2", [
        ["packages/runner-app/package.json", '{"name":"sheet-workflows"}'],
        ["packages/unrelated/package.json", '{"name":"unrelated"}'],
        ["packages/unrelated/src/index.ts", "after"],
      ]);

      expect(affectedRunnerRoles(previous, next, ["workflow-api", "ordinary-runner"])).toEqual([]);
    }),
  );

  it.effect("rebuilds artifacts for a mode-only lockfile change", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1");
      const next = withFileMode(snapshot("r2"), "pnpm-lock.yaml", 0o600);
      expect(classifySnapshotChange(previous, next)).toBe("artifact");

      let rebuildCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: "owner",
        nextOwner: "next-owner",
        runtime: runtimeLayer({
          rebuildArtifacts: () => {
            rebuildCalls += 1;
            return Effect.void;
          },
        }),
      });
      expect(result.failure).toBeNull();
      expect(rebuildCalls).toBe(1);
    }),
  );

  it.effect("rebuilds artifacts when pnpm workspace selection changes", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1", [["pnpm-workspace.yaml", "packages:\n  - packages/*"]]);
      const next = snapshot("r2", [["pnpm-workspace.yaml", "packages:\n  - packages/app"]]);
      expect(classifySnapshotChange(previous, next)).toBe("artifact");

      let rebuildCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: "owner",
        nextOwner: "next-owner",
        runtime: runtimeLayer({
          rebuildArtifacts: () => {
            rebuildCalls += 1;
            return Effect.void;
          },
        }),
      });

      expect(result.failure).toBeNull();
      expect(rebuildCalls).toBe(1);
    }),
  );

  it.effect("rejects host dependencies, credentials, traversal, and incomplete manifests", () =>
    Effect.gen(function* () {
      const bad = [
        snapshot("r", [["node_modules/x/index.js", "x"]]),
        snapshot("r", [[".env", "secret"]]),
        snapshot("r", [[".env.local", "secret"]]),
        snapshot("r", [[".env.production", "secret"]]),
        snapshot("r", [["secrets/google-service-account.json", "secret"]]),
        snapshot("r", [["certs/client.pem", "secret"]]),
        snapshot("r", [[".cache/ms-playwright/chromium", "binary"]]),
        snapshot("r", [["../escape", "x"]]),
        snapshot("r", [
          ["src/duplicate.ts", "one"],
          ["src/duplicate.ts", "two"],
        ]),
        {
          ...sealStagedSourceSnapshot("r", [
            ...snapshot("r").files,
            utf8File("src/invalid.ts", "x", 0o1000),
          ]),
        },
        sealStagedSourceSnapshot("", snapshot("r").files),
        sealStagedSourceSnapshot("r", [utf8File("package.json", "{}")]),
      ];
      for (const candidate of bad) {
        const result = yield* Effect.exit(
          validateStagedSnapshot(candidate as StagedSourceSnapshot),
        );
        expect(Exit.isFailure(result)).toBe(true);
      }
    }),
  );

  it.effect("rejects suffixed environment files before runtime effects", () =>
    Effect.gen(function* () {
      for (const path of [".env.local", ".env.production"]) {
        let runtimeCalls = 0;
        const result = yield* activateWithRuntime({
          snapshot: snapshot("r2", [[path, "credential"]]),
          previous: snapshot("r1"),
          owner: "owner",
          nextOwner: "next-owner",
          runtime: runtimeLayer({
            stageComplete: () => {
              runtimeCalls += 1;
              return Effect.void;
            },
            fenceOldOwner: () => {
              runtimeCalls += 1;
              return Effect.void;
            },
            activateComplete: () => {
              runtimeCalls += 1;
              return Effect.void;
            },
          }),
        });
        expect(result.failure).toBe("excluded-or-unsafe-path");
        expect(runtimeCalls).toBe(0);
      }
    }),
  );

  it.effect("rejects malformed root and workspace manifests before runtime effects", () =>
    Effect.gen(function* () {
      const valid = snapshot("r2");
      const invalidRoot = sealStagedSourceSnapshot(
        valid.revision,
        valid.files.map((file) =>
          file.path === "package.json" ? { ...file, content: "{" } : file,
        ),
      );
      const invalidPackage = snapshot("r2", [["packages/broken/package.json", "{"]]);
      for (const candidate of [invalidRoot, invalidPackage]) {
        let stageCalls = 0;
        let fenceCalls = 0;
        let activationCalls = 0;
        const result = yield* activateWithRuntime({
          snapshot: candidate,
          previous: snapshot("r1"),
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            stageComplete: () => {
              stageCalls += 1;
              return Effect.void;
            },
            fenceOldOwner: () => {
              fenceCalls += 1;
              return Effect.void;
            },
            activateComplete: () => {
              activationCalls += 1;
              return Effect.void;
            },
          }),
        });
        expect(result.failure).toBe("invalid-package-manifest");
        expect(stageCalls).toBe(0);
        expect(fenceCalls).toBe(0);
        expect(activationCalls).toBe(0);
      }
    }),
  );

  it.effect("rejects base64-encoded package manifests before runtime effects", () =>
    Effect.gen(function* () {
      const valid = snapshot("r2", [
        ["packages/sheet-workflows/package.json", '{"name":"sheet-workflows"}'],
      ]);
      for (const manifestPath of ["package.json", "packages/sheet-workflows/package.json"]) {
        const candidate = sealStagedSourceSnapshot(
          valid.revision,
          valid.files.map((file) =>
            file.path === manifestPath
              ? {
                  ...file,
                  contentEncoding: "base64" as const,
                  content: Buffer.from(file.content, "utf8").toString("base64"),
                }
              : file,
          ),
        );
        let stageCalls = 0;
        const result = yield* activateWithRuntime({
          snapshot: candidate,
          previous: snapshot("r1"),
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            stageComplete: () => {
              stageCalls += 1;
              return Effect.void;
            },
          }),
        });

        expect(result.failure).toBe("invalid-package-manifest-encoding");
        expect(stageCalls).toBe(0);
      }
    }),
  );

  it.effect("reports malformed prior manifests before any runtime effects", () =>
    Effect.gen(function* () {
      const prior = snapshot("r1");
      const invalidPrevious = sealStagedSourceSnapshot(
        prior.revision,
        prior.files.map((file) =>
          file.path === "package.json" ? { ...file, content: "{" } : file,
        ),
      );
      let runtimeCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: snapshot("r2"),
        previous: invalidPrevious,
        owner: "old",
        nextOwner: "new",
        runtime: runtimeLayer({
          stageComplete: () => {
            runtimeCalls += 1;
            return Effect.void;
          },
          fenceOldOwner: () => {
            runtimeCalls += 1;
            return Effect.void;
          },
          activateComplete: () => {
            runtimeCalls += 1;
            return Effect.void;
          },
          verifyActualReadiness: () => {
            runtimeCalls += 1;
            return Effect.succeed(true);
          },
        }),
      });
      expect(result).toEqual({
        requestedRevision: "r2",
        activeRevision: "r1",
        unavailableRoles: ["ordinary-runner"],
        failure: "invalid-package-manifest",
      });
      expect(runtimeCalls).toBe(0);
    }),
  );

  it.effect(
    "stages completely, fences the old owner, retains its revision and restarts only the ordinary runner",
    () =>
      Effect.gen(function* () {
        const operations: string[] = [];
        const result = yield* activateWithRuntime({
          snapshot: snapshot("r2", [["src/run.ts", "changed"]]),
          previous: snapshot("r1", [["src/run.ts", "before"]]),
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            stageComplete: (tree) =>
              Effect.sync(() => operations.push(`stage:${tree.revision}`)).pipe(Effect.asVoid),
            fenceOldOwner: (owner, nextOwner) =>
              Effect.sync(() => operations.push(`fence:${owner}:${nextOwner}`)).pipe(Effect.asVoid),
            retainImmutableRevision: (revision) =>
              Effect.sync(() => operations.push(`retain:${revision}`)).pipe(Effect.asVoid),
            activateComplete: (revision) =>
              Effect.sync(() => operations.push(`activate:${revision}`)).pipe(Effect.asVoid),
            restartRole: (role, revision, kind) =>
              Effect.sync(() => operations.push(`restart:${role}:${revision}:${kind}`)).pipe(
                Effect.asVoid,
              ),
            verifyActualReadiness: (revision, roles) =>
              Effect.sync(() => {
                operations.push(`ready:${revision}:${roles.join(",")}`);
                return true;
              }),
          }),
        });
        expect(result).toMatchObject({
          requestedRevision: "r2",
          activeRevision: "r2",
          failure: null,
        });
        expect(operations).toEqual([
          "stage:r2",
          "fence:old:new",
          "retain:r1",
          "activate:r2",
          "restart:ordinary-runner:r2:source",
          "ready:r2:ordinary-runner",
        ]);
      }),
  );

  it.effect("does not activate after interrupted transfer and reports both revisions", () =>
    Effect.gen(function* () {
      let activateCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: snapshot("r2"),
        previous: snapshot("r1"),
        owner: "old",
        nextOwner: "new",
        runtime: runtimeLayer({
          stageComplete: () =>
            Effect.fail(new SnapshotRuntimeError({ reason: "transfer-interrupted" })),
          activateComplete: () => {
            activateCalls += 1;
            return Effect.void;
          },
        }),
      });
      expect(result).toMatchObject({
        requestedRevision: "r2",
        activeRevision: "r1",
        unavailableRoles: ["ordinary-runner"],
      });
      expect(activateCalls).toBe(0);
    }),
  );

  it.effect("rejects a stale owner before activation or restart", () =>
    Effect.gen(function* () {
      let activateCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: snapshot("r2"),
        previous: snapshot("r1"),
        owner: "stale-owner",
        nextOwner: "current-owner",
        runtime: runtimeLayer({
          fenceOldOwner: () => Effect.fail(new SnapshotRuntimeError({ reason: "stale-owner" })),
          activateComplete: () => {
            activateCalls += 1;
            return Effect.void;
          },
        }),
      });
      expect(result.failure).toBe("stale-owner");
      expect(result.activeRevision).toBe("r1");
      expect(activateCalls).toBe(0);
    }),
  );

  it.effect(
    "rebuilds package changes and leaves the requested revision unavailable when readiness fails",
    () =>
      Effect.gen(function* () {
        let rebuilt = false;
        const previous = snapshot("r1");
        const next = snapshot("r2", [["packages/lib/package.json", '{"name":"lib"}']]);
        expect(classifySnapshotChange(previous, next)).toBe("artifact");
        const result = yield* activateWithRuntime({
          snapshot: next,
          previous,
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            rebuildArtifacts: () => {
              rebuilt = true;
              return Effect.void;
            },
            verifyActualReadiness: () => Effect.succeed(false),
          }),
        });
        expect(result.failure).toBe("readiness-check-failed");
        expect(rebuilt).toBe(true);
        expect(result.unavailableRoles).toEqual(["ordinary-runner"]);
        expect(result.activeRevision).toBe("r2");
      }),
  );

  it.effect("starts affected dependencies before the ordinary runner", () =>
    Effect.gen(function* () {
      const restarted: string[] = [];
      const result = yield* activateWithRuntime({
        snapshot: snapshot("r2"),
        previous: snapshot("r1"),
        owner: "old",
        nextOwner: "new",
        roles: ["ordinary-runner", "workflow-api"],
        runtime: runtimeLayer({
          restartRole: (role, revision, kind) =>
            Effect.sync(() => restarted.push(`${role}:${revision}:${kind}`)).pipe(Effect.asVoid),
        }),
      });
      expect(result.failure).toBeNull();
      expect(restarted).toEqual(["workflow-api:r2:source", "ordinary-runner:r2:source"]);
    }),
  );

  it.effect("coalesces a rapid save burst to one activation of the newest complete revision", () =>
    Effect.gen(function* () {
      const activated: string[] = [];
      const restarted: string[] = [];
      const result = yield* activateCoalescedWithRuntime({
        snapshots: [
          snapshot("r2", [["src/run.ts", "two"]]),
          snapshot("r3", [["src/run.ts", "three"]]),
          snapshot("r4", [["src/run.ts", "four"]]),
        ],
        previous: snapshot("r1", [["src/run.ts", "one"]]),
        owner: "old",
        nextOwner: "new",
        runtime: runtimeLayer({
          activateComplete: (revision) =>
            Effect.sync(() => activated.push(revision)).pipe(Effect.asVoid),
          restartRole: (role, revision) =>
            Effect.sync(() => restarted.push(`${role}:${revision}`)).pipe(Effect.asVoid),
        }),
      });
      expect(result.activeRevision).toBe("r4");
      expect(activated).toEqual(["r4"]);
      expect(restarted).toEqual(["ordinary-runner:r4"]);
    }),
  );

  it.effect("activates the newest complete save when a later save is truncated", () =>
    Effect.gen(function* () {
      const activated: string[] = [];
      const restarted: string[] = [];
      const complete = snapshot("r3", [["src/run.ts", "complete"]]);
      const latest = snapshot("r4", [["src/run.ts", "truncated"]]);
      const truncated: StagedSourceSnapshot = {
        ...latest,
        files: latest.files.slice(0, -1),
      };
      const result = yield* activateCoalescedWithRuntime({
        snapshots: [complete, truncated],
        previous: snapshot("r2"),
        owner: "old",
        nextOwner: "new",
        runtime: runtimeLayer({
          activateComplete: (revision) =>
            Effect.sync(() => activated.push(revision)).pipe(Effect.asVoid),
          restartRole: (role, revision) =>
            Effect.sync(() => restarted.push(`${role}:${revision}`)).pipe(Effect.asVoid),
        }),
      });

      expect(result).toEqual({
        requestedRevision: "r3",
        activeRevision: "r3",
        unavailableRoles: [],
        failure: null,
      });
      expect(activated).toEqual(["r3"]);
      expect(restarted).toEqual(["ordinary-runner:r3"]);
    }),
  );

  it.effect("fails a malformed-only save burst before any runtime effects", () =>
    Effect.gen(function* () {
      const runtimeCalls: string[] = [];
      const latest = snapshot("r4", [["src/run.ts", "truncated"]]);
      const truncated: StagedSourceSnapshot = {
        ...latest,
        files: latest.files.slice(0, -1),
      };
      const record = (name: string) => Effect.sync(() => void runtimeCalls.push(name));
      const result = yield* activateCoalescedWithRuntime({
        snapshots: [truncated],
        previous: snapshot("r2"),
        owner: "old",
        nextOwner: "new",
        runtime: runtimeLayer({
          stageComplete: () => record("stage"),
          fenceOldOwner: () => record("fence"),
          retainImmutableRevision: () => record("retain"),
          rebuildArtifacts: () => record("rebuild"),
          activateComplete: () => record("activate"),
          restartRole: () => record("restart"),
          verifyActualReadiness: () => record("readiness").pipe(Effect.as(true)),
        }),
      });

      expect(result).toEqual({
        requestedRevision: "r4",
        activeRevision: "r2",
        unavailableRoles: ["ordinary-runner"],
        failure: "snapshot-completion-mismatch",
      });
      expect(runtimeCalls).toEqual([]);
    }),
  );

  it.effect("propagates a changed shared workspace library to selected workflow consumers", () =>
    Effect.gen(function* () {
      const before = snapshot("r1", [
        ["packages/sheet-domain/package.json", '{"name":"sheet-domain"}'],
        ["packages/sheet-domain/src/value.ts", "export const value = 1"],
        [
          "packages/sheet-workflows/package.json",
          '{"name":"sheet-workflows","dependencies":{"sheet-domain":"workspace:*"}}',
        ],
        ["packages/sheet-workflows/src/index.ts", "import { value } from 'sheet-domain'"],
      ]);
      const after = snapshot("r2", [
        ["packages/sheet-domain/package.json", '{"name":"sheet-domain"}'],
        ["packages/sheet-domain/src/value.ts", "export const value = 2"],
        [
          "packages/sheet-workflows/package.json",
          '{"name":"sheet-workflows","dependencies":{"sheet-domain":"workspace:*"}}',
        ],
        ["packages/sheet-workflows/src/index.ts", "import { value } from 'sheet-domain'"],
      ]);
      expect(affectedRunnerRoles(before, after, ["workflow-api", "ordinary-runner"])).toEqual([
        "workflow-api",
        "ordinary-runner",
      ]);
      let restartCalls = 0;
      yield* activateWithRuntime({
        snapshot: after,
        previous: before,
        owner: "old",
        nextOwner: "new",
        roles: ["workflow-api", "ordinary-runner"],
        runtime: runtimeLayer({
          restartRole: () => {
            restartCalls += 1;
            return Effect.void;
          },
        }),
      });
      expect(restartCalls).toBe(2);
    }),
  );

  it.effect(
    "does not repeat restart side effects when the requested revision is already active",
    () =>
      Effect.gen(function* () {
        let readinessCalls = 0;
        let restartCalls = 0;
        const active = snapshot("r2", [["src/run.ts", "current"]]);
        const result = yield* activateWithRuntime({
          snapshot: active,
          previous: active,
          owner: "owner",
          nextOwner: "owner",
          runtime: runtimeLayer({
            verifyActualReadiness: () => {
              readinessCalls += 1;
              return Effect.succeed(true);
            },
            restartRole: () => {
              restartCalls += 1;
              return Effect.void;
            },
          }),
        });
        expect(result.failure).toBeNull();
        expect(readinessCalls).toBe(1);
        expect(restartCalls).toBe(0);
      }),
  );

  it.effect(
    "rejects different snapshot content under an active revision before runtime effects",
    () =>
      Effect.gen(function* () {
        const active = snapshot("r2", [["src/run.ts", "current"]]);
        const conflicting = snapshot("r2", [["src/run.ts", "different"]]);
        expect(conflicting.completion.filesDigest).not.toBe(active.completion.filesDigest);

        let runtimeCalls = 0;
        const recordRuntimeCall = () =>
          Effect.sync(() => {
            runtimeCalls += 1;
          });
        const result = yield* activateWithRuntime({
          snapshot: conflicting,
          previous: active,
          owner: "owner",
          nextOwner: "next-owner",
          runtime: runtimeLayer({
            stageComplete: recordRuntimeCall,
            fenceOldOwner: recordRuntimeCall,
            retainImmutableRevision: recordRuntimeCall,
            rebuildArtifacts: recordRuntimeCall,
            activateComplete: recordRuntimeCall,
            restartRole: recordRuntimeCall,
            verifyActualReadiness: () =>
              Effect.sync(() => {
                runtimeCalls += 1;
                return true;
              }),
          }),
        });

        expect(result).toEqual({
          requestedRevision: "r2",
          activeRevision: "r2",
          unavailableRoles: ["ordinary-runner"],
          failure: "revision-content-conflict",
        });
        expect(runtimeCalls).toBe(0);
      }),
  );

  it.effect(
    "recovers after an interrupted transfer without activating the incomplete revision",
    () =>
      Effect.gen(function* () {
        const previous = snapshot("r1", [["src/run.ts", "one"]]);
        const requested = snapshot("r2", [["src/run.ts", "two"]]);
        const interrupted = yield* activateWithRuntime({
          snapshot: requested,
          previous,
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            stageComplete: () =>
              Effect.fail(new SnapshotRuntimeError({ reason: "interrupted-sync" })),
          }),
        });
        expect(interrupted.activeRevision).toBe("r1");

        let activateCalls = 0;
        const recovered = yield* activateWithRuntime({
          snapshot: requested,
          previous,
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            activateComplete: () => {
              activateCalls += 1;
              return Effect.void;
            },
          }),
        });
        expect(recovered.activeRevision).toBe("r2");
        expect(recovered.failure).toBeNull();
        expect(activateCalls).toBe(1);
      }),
  );
});
