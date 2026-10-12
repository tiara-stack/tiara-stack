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
  it("represents browser runner identities while rejecting non-runner roles", () => {
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
