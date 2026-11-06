import { createHash } from "node:crypto";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  RunnerRoleSchema,
  StagedRunnerSnapshotIdentitySchema,
  stagedSourceDigestInput,
  StagedSourceFileSchema,
  validateStagedSourceSnapshot,
  WorkflowRecreationRecoverySchema,
  WorkflowTransitionPhaseFactsSchema,
  WorkflowTransitionReasonSchema,
  type StagedSourceFile,
  type StagedSourceSnapshot,
} from "./stagedSource";

const utf8File = (path: string, content: string): StagedSourceFile => ({
  path,
  contentEncoding: "utf8",
  content,
  mode: 0o644,
});

const sealSnapshot = (
  revision: string,
  files: ReadonlyArray<StagedSourceFile>,
): StagedSourceSnapshot => ({
  revision,
  files,
  completion: {
    expectedFileCount: files.length,
    filesDigest: createHash("sha256")
      .update(stagedSourceDigestInput(revision, files))
      .digest("hex"),
  },
});

describe("staged source snapshot structural contract", () => {
  it("validates browser runner identities while rejecting non-runner roles", () => {
    expect(Schema.is(RunnerRoleSchema)("browser-runner")).toBe(true);
    expect(
      Schema.is(StagedRunnerSnapshotIdentitySchema)({
        sessionId: "session-browser",
        generation: 1,
        role: "browser-runner",
      }),
    ).toBe(true);
    expect(
      Schema.is(StagedRunnerSnapshotIdentitySchema)({
        sessionId: "session-api",
        generation: 1,
        role: "workflow-api",
      }),
    ).toBe(false);
    expect(Schema.is(RunnerRoleSchema)("unsupported-runner")).toBe(false);
    expect(
      Schema.is(StagedRunnerSnapshotIdentitySchema)({
        sessionId: "session-a",
        generation: 1,
        role: "ordinary-runner",
      }),
    ).toBe(true);
  });

  it("validates the shared UTF-8 and base64 file structure", () => {
    const bytes = Uint8Array.from([0x00, 0x80, 0xff]);
    const complete = sealSnapshot("r1", [
      utf8File("package.json", '{"name":"workspace"}'),
      utf8File("pnpm-lock.yaml", "lockfileVersion: '9.0'"),
      {
        path: "assets/opaque.bin",
        contentEncoding: "base64",
        content: Buffer.from(bytes).toString("base64"),
        mode: 0o644,
      },
    ]);

    expect(validateStagedSourceSnapshot(complete, complete.completion.filesDigest)).toBeUndefined();
    expect(
      validateStagedSourceSnapshot(
        { ...complete, files: complete.files.slice(0, 2) },
        complete.completion.filesDigest,
      ),
    ).toBe("snapshot-completion-mismatch");
    expect(validateStagedSourceSnapshot(complete, "0".repeat(64))).toBe(
      "snapshot-completion-mismatch",
    );
  });

  it("rejects unsafe paths and non-UTF8 manifests with shared reasons", () => {
    const unsafe = sealSnapshot("r1", [
      utf8File("package.json", '{"name":"workspace"}'),
      utf8File("pnpm-lock.yaml", "lockfileVersion: '9.0'"),
      utf8File("../escape", "bad"),
    ]);
    const manifest = '{"name":"workspace"}';
    const nonUtf8Manifest = sealSnapshot("r1", [
      {
        path: "package.json",
        contentEncoding: "base64",
        content: Buffer.from(manifest, "utf8").toString("base64"),
        mode: 0o644,
      },
      utf8File("pnpm-lock.yaml", "lockfileVersion: '9.0'"),
    ]);

    expect(validateStagedSourceSnapshot(unsafe, unsafe.completion.filesDigest)).toBe(
      "excluded-or-unsafe-path",
    );
    expect(
      validateStagedSourceSnapshot(nonUtf8Manifest, nonUtf8Manifest.completion.filesDigest),
    ).toBe("invalid-package-manifest-encoding");
    expect(
      Schema.is(StagedSourceFileSchema)({
        path: "assets/opaque.bin",
        contentEncoding: "base64",
        content: "AA==",
        mode: 0o644,
      }),
    ).toBe(true);
  });

  it("rejects browser profiles and saved browser authentication state while allowing source code", () => {
    const forbiddenPaths = [
      ".config/google-chrome/Default/Cookies",
      ".config/BraveSoftware/Brave-Browser/Default/Preferences",
      "Library/Application Support/Microsoft Edge/Default/Cookies",
      "playwright/.auth/user.json",
      "tests/fixtures/authState.json",
      "tests/fixtures/storageState.json",
      "tests/fixtures/cookies.sqlite",
      "packages/sheet-workflows/src/authState/private.json",
      "packages/sheet-workflows/src/storage-state/snapshot.sqlite",
      "packages/sheet-workflows/src/STORAGE_STATE/snapshot.bin",
    ];

    for (const path of forbiddenPaths) {
      const candidate = sealSnapshot("r1", [
        utf8File("package.json", '{"name":"workspace"}'),
        utf8File("pnpm-lock.yaml", "lockfileVersion: '9.0'"),
        utf8File(path, "private browser state"),
      ]);

      expect(validateStagedSourceSnapshot(candidate, candidate.completion.filesDigest)).toBe(
        "excluded-or-unsafe-path",
      );
    }

    const source = sealSnapshot("r1", [
      utf8File("package.json", '{"name":"workspace"}'),
      utf8File("pnpm-lock.yaml", "lockfileVersion: '9.0'"),
      utf8File("packages/sheet-workflows/src/browser-profile.ts", "export const profile = 1"),
      utf8File("packages/sheet-workflows/src/storage-state-schema.ts", "export const schema = 1"),
      utf8File("packages/sheet-workflows/src/authState.ts", "export const authState = 1"),
      utf8File("packages/sheet-workflows/src/cookies/index.ts", "export const cookies = []"),
      utf8File(
        "packages/sheet-workflows/src/authState/index.ts",
        "export const authStateModule = true;",
      ),
      utf8File(
        "packages/sheet-workflows/src/AUTH-STATE/Provider.tsx",
        "export const AuthStateProvider = () => null;",
      ),
      utf8File(
        "packages/sheet-workflows/src/auth_state/hooks.mts",
        "export const useAuthState = () => undefined;",
      ),
      utf8File(
        "packages/sheet-workflows/src/storageState/Store.cts",
        "export const storageStateStore = {};",
      ),
      utf8File(
        "packages/sheet-workflows/src/STORAGE-STATE/index.jsx",
        "export const StorageStateView = () => null;",
      ),
      utf8File(
        "packages/sheet-workflows/src/storage_state/types.d.ts",
        "export type StorageState = never;",
      ),
    ]);

    expect(validateStagedSourceSnapshot(source, source.completion.filesDigest)).toBeUndefined();
  });

  it("rejects absolute and separator-alias browser state before accepting a snapshot", () => {
    const forbiddenFiles: ReadonlyArray<StagedSourceFile> = [
      utf8File("/workspace/.config/google-chrome/Default/Cookies", "synthetic cookie bytes"),
      utf8File(
        "C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies",
        "synthetic cookie bytes",
      ),
      utf8File("\\\\server\\share\\playwright\\.auth\\user.json", "synthetic auth bytes"),
      utf8File("..\\..\\private\\Cookies", "synthetic cookie bytes"),
      utf8File("packages/sheet-workflows\\..\\..\\private/Cookies", "synthetic cookie bytes"),
      utf8File("packages\\sheet-workflows\\playwright\\.auth\\user.json", "synthetic state"),
      {
        path: "C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\Cookies",
        contentEncoding: "base64",
        content: Buffer.from("synthetic binary cookie bytes", "utf8").toString("base64"),
        mode: 0o644,
      },
    ];

    for (const file of forbiddenFiles) {
      const candidate = sealSnapshot("r1", [
        utf8File("package.json", '{"name":"workspace"}'),
        utf8File("pnpm-lock.yaml", "lockfileVersion: '9.0'"),
        file,
      ]);

      expect({
        path: file.path,
        reason: validateStagedSourceSnapshot(candidate, candidate.completion.filesDigest),
      }).toEqual({ path: file.path, reason: "excluded-or-unsafe-path" });
    }

    const ordinarySource = sealSnapshot("r1", [
      utf8File("package.json", '{"name":"workspace"}'),
      utf8File("pnpm-lock.yaml", "lockfileVersion: '9.0'"),
      utf8File("packages/sheet-workflows/src/cookies.ts", "export const cookies = []"),
      utf8File("packages/sheet-workflows/src/cookies/index.ts", "export const cookies = []"),
      utf8File("packages/sheet-workflows/src/authState.ts", "export const authState = 1"),
    ]);
    expect(
      validateStagedSourceSnapshot(ordinarySource, ordinarySource.completion.filesDigest),
    ).toBeUndefined();
  });
});

describe("workflow recreation recovery contract", () => {
  it("accepts required workflow-group removal as an explicit transition reason", () => {
    expect(Schema.is(WorkflowTransitionReasonSchema)("workflow-group-added")).toBe(true);
    expect(Schema.is(WorkflowTransitionReasonSchema)("workflow-group-removed")).toBe(true);
  });

  it("records nonnegative nested settlement and total elapsed durations", () => {
    const phases = {
      proposal: "presented",
      admission: "paused",
      producerFencing: "fenced",
      drain: "completed",
      cancellation: "completed",
      reconciliation: "completed",
      settlement: "settled",
      cessation: "proven",
      oldSessionEnd: "ended",
      cleanup: "completed",
      freshGroup: "not-started",
      activation: "not-started",
      quarantine: "not-started",
      ordinaryReassignment: "not-started",
      drainElapsedMs: 300_000,
      cancellationReconciliationElapsedMs: 120_000,
      cessationProofElapsedMs: 30_000,
      settlementElapsedMs: 150_000,
      acceptedWorkElapsedMs: 480_000,
    } as const;

    expect(Schema.is(WorkflowTransitionPhaseFactsSchema)(phases)).toBe(true);
    expect(Schema.is(WorkflowTransitionPhaseFactsSchema)({ ...phases, drainElapsedMs: -1 })).toBe(
      false,
    );
  });

  it("preserves expired as a distinct observed fresh-session disposition", () => {
    const recovery = (freshSessionDisposition: string) => ({
      failureReason: "fresh-session-provisioning-failed",
      freshSessionDisposition,
      freshGroupQuarantineDisposition: "unconfirmed",
      quarantineDisposition: "unconfirmed",
      ordinaryReassignmentBlocked: null,
      recoveryRecordId: "session-1.workflow-recreation-recovery.json",
      recoveryRecordWritten: true,
      recoveryRecordUpdated: true,
    });

    expect(Schema.is(WorkflowRecreationRecoverySchema)(recovery("ended"))).toBe(true);
    expect(Schema.is(WorkflowRecreationRecoverySchema)(recovery("expired"))).toBe(true);
    expect(Schema.is(WorkflowRecreationRecoverySchema)(recovery("state-unverified"))).toBe(true);
  });
});
