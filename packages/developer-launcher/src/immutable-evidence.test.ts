import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  publishEvidence,
  readVerifiedEvidence,
  verifyEvidenceReceiptReference,
} from "./immutable-evidence";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const temporaryStore = () => mkdtempSync(path.join(tmpdir(), "tiara-evidence-"));
const hasDescriptorDirectorySupport = (directory: string) => {
  if (process.platform !== "linux") return false;
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);
  let evidenceDescriptor: number | undefined;
  let descriptorProbe: number | undefined;
  try {
    evidenceDescriptor = openSync(directory, flags);
    descriptorProbe = openSync(`/proc/self/fd/${evidenceDescriptor}`, flags);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptorProbe !== undefined) closeSync(descriptorProbe);
    if (evidenceDescriptor !== undefined) closeSync(evidenceDescriptor);
  }
};

it.live("seals the byte snapshot provided when the publisher Effect is created", () =>
  Effect.gen(function* () {
    const storeDirectory = temporaryStore();
    const originalBytes = new TextEncoder().encode("captured bytes\n");
    const mutableBytes = Uint8Array.from(originalBytes);
    try {
      const publication = publishEvidence({
        storeDirectory,
        bytes: mutableBytes,
        mediaType: "application/json",
      });
      mutableBytes.fill(0);
      const result = yield* publication;
      const verified = yield* readVerifiedEvidence({
        storeDirectory,
        captureId: result.receipt.capture_id,
      });
      expect([...verified.bytes]).toEqual([...originalBytes]);
    } finally {
      rmSync(storeDirectory, { recursive: true, force: true });
    }
  }),
);

it.live("seals derived source identity when the publisher Effect is created", () =>
  Effect.gen(function* () {
    const storeDirectory = temporaryStore();
    const sourceBytes = new TextEncoder().encode("original source evidence\n");
    const derivedBytes = new TextEncoder().encode("transformed evidence\n");
    try {
      const source = yield* publishEvidence({
        storeDirectory,
        bytes: sourceBytes,
        mediaType: "image/png",
      });
      const derivedFrom = {
        captureId: source.receipt.capture_id,
        sha256: source.receipt.sha256,
      };
      const publication = publishEvidence({
        storeDirectory,
        bytes: derivedBytes,
        mediaType: "image/png",
        derivedFrom,
      });
      derivedFrom.captureId = "mutated-source";
      derivedFrom.sha256 = "f".repeat(64);
      const derived = yield* publication;
      expect(derived.receipt.derived_from).toEqual({
        capture_id: source.receipt.capture_id,
        sha256: source.receipt.sha256,
      });
      const verified = yield* readVerifiedEvidence({
        storeDirectory,
        captureId: derived.receipt.capture_id,
      });
      expect([...verified.bytes]).toEqual([...derivedBytes]);
    } finally {
      rmSync(storeDirectory, { recursive: true, force: true });
    }
  }),
);

it.live("publishes concurrent identical captures without exposing partial bytes", () =>
  Effect.gen(function* () {
    const storeDirectory = temporaryStore();
    const bytes = new TextEncoder().encode("screenshot fixture bytes\n");
    try {
      const captures = yield* Effect.all(
        Array.from({ length: 12 }, (_, index) =>
          publishEvidence({
            storeDirectory,
            bytes,
            mediaType: "image/png",
            captureId: `parallel-${index}`,
          }),
        ),
        { concurrency: "unbounded" },
      );
      expect(
        captures.map(({ receipt }) => receipt.sha256).every((value) => value === sha256(bytes)),
      ).toBe(true);
      expect(readdirSync(path.join(storeDirectory, "objects"))).toEqual([`${sha256(bytes)}.bin`]);
      expect(readdirSync(path.join(storeDirectory, "receipts"))).toHaveLength(12);
      for (const capture of captures) {
        const verified = yield* readVerifiedEvidence({
          storeDirectory,
          captureId: capture.receipt.capture_id,
        });
        expect([...verified.bytes]).toEqual([...bytes]);
        const verifiedReference = yield* verifyEvidenceReceiptReference({
          storeDirectory,
          reference: capture.receiptReference,
        });
        expect(verifiedReference.receiptReference).toEqual(capture.receiptReference);
      }
    } finally {
      rmSync(storeDirectory, { recursive: true, force: true });
    }
  }),
);

it.live("refuses to overwrite a corrupt object at its content address", () =>
  Effect.gen(function* () {
    const storeDirectory = temporaryStore();
    const bytes = new TextEncoder().encode("expected artifact\n");
    const objectPath = path.join(storeDirectory, "objects", `${sha256(bytes)}.bin`);
    try {
      mkdirSync(path.dirname(objectPath), { recursive: true });
      writeFileSync(objectPath, "corrupt prior content\n");
      const exit = yield* Effect.exit(
        publishEvidence({
          storeDirectory,
          bytes,
          mediaType: "application/json",
          captureId: "no-overwrite",
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(readFileSync(objectPath, "utf8")).toBe("corrupt prior content\n");
      expect(readdirSync(path.join(storeDirectory, ".staging"))).toEqual([]);
      expect(readdirSync(path.join(storeDirectory, "receipts"))).toEqual([]);
    } finally {
      rmSync(storeDirectory, { recursive: true, force: true });
    }
  }),
);

it.live("keeps legacy convenience copies separate from the sealed object", () =>
  Effect.gen(function* () {
    const storeDirectory = temporaryStore();
    const bytes = new TextEncoder().encode("sealed source snapshot\n");
    const conveniencePath = "artifacts/source.json";
    try {
      const hasDescriptorSupport = hasDescriptorDirectorySupport(storeDirectory);
      const published = yield* publishEvidence({
        storeDirectory,
        bytes,
        mediaType: "application/json",
        convenienceArtifactPath: conveniencePath,
      });
      if (hasDescriptorSupport) {
        expect(published.compatibilityArtifactPath).toBe(conveniencePath);
        expect([...readFileSync(path.join(storeDirectory, conveniencePath))]).toEqual([...bytes]);
        writeFileSync(path.join(storeDirectory, conveniencePath), "legacy path changed\n");
      } else {
        expect(published.compatibilityArtifactPath).toBeUndefined();
        expect(existsSync(path.join(storeDirectory, "artifacts"))).toBe(false);
      }
      const verified = yield* readVerifiedEvidence({
        storeDirectory,
        captureId: published.receipt.capture_id,
      });
      expect([...verified.bytes]).toEqual([...bytes]);
      const verifiedReference = yield* verifyEvidenceReceiptReference({
        storeDirectory,
        reference: published.receiptReference,
      });
      expect([...verifiedReference.bytes]).toEqual([...bytes]);
    } finally {
      rmSync(storeDirectory, { recursive: true, force: true });
    }
  }),
);

it.live("rejects symlinked convenience directories before copying outside the store", () =>
  Effect.gen(function* () {
    const storeDirectory = temporaryStore();
    const outsideDirectory = temporaryStore();
    const bytes = new TextEncoder().encode("sealed evidence\n");
    const hasDescriptorSupport = hasDescriptorDirectorySupport(storeDirectory);
    try {
      symlinkSync(outsideDirectory, path.join(storeDirectory, "artifacts"), "dir");
      if (hasDescriptorSupport) {
        const exit = yield* Effect.exit(
          publishEvidence({
            storeDirectory,
            bytes,
            mediaType: "image/png",
            convenienceArtifactPath: "artifacts/capture.png",
          }),
        );
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
          : undefined;
        expect(failure).toMatchObject({
          message: expect.stringContaining("Convenience artifact path is not a regular directory"),
        });
        expect(readdirSync(path.join(storeDirectory, "receipts"))).toEqual([]);
      } else {
        const published = yield* publishEvidence({
          storeDirectory,
          bytes,
          mediaType: "image/png",
          convenienceArtifactPath: "artifacts/capture.png",
        });
        expect(published.compatibilityArtifactPath).toBeUndefined();
        expect(published.artifactPath).toBe(`objects/${sha256(bytes)}.bin`);
        expect([...readFileSync(path.join(storeDirectory, published.artifactPath))]).toEqual([
          ...bytes,
        ]);
        expect(readdirSync(path.join(storeDirectory, "receipts"))).toHaveLength(1);
      }
      expect(readdirSync(outsideDirectory)).toEqual([]);
    } finally {
      rmSync(storeDirectory, { recursive: true, force: true });
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
  }),
);

it.live("leaves no receipt when receipt publication is interrupted", () =>
  Effect.gen(function* () {
    const storeDirectory = temporaryStore();
    const captureId = "interrupted-capture";
    const bytes = new TextEncoder().encode("complete artifact before receipt\n");
    const receiptDirectory = path.join(storeDirectory, "receipts");
    try {
      mkdirSync(receiptDirectory, { recursive: true });
      mkdirSync(path.join(receiptDirectory, `${captureId}.json`));
      const exit = yield* Effect.exit(
        publishEvidence({ storeDirectory, bytes, mediaType: "image/png", captureId }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect([
        ...readFileSync(path.join(storeDirectory, "objects", `${sha256(bytes)}.bin`)),
      ]).toEqual([...bytes]);
      expect(readdirSync(path.join(storeDirectory, ".staging"))).toEqual([]);
      const verified = yield* Effect.exit(readVerifiedEvidence({ storeDirectory, captureId }));
      expect(Exit.isFailure(verified)).toBe(true);
    } finally {
      rmSync(storeDirectory, { recursive: true, force: true });
    }
  }),
);

it.live("publishes a verified object reference when descriptor publication is unsupported", () =>
  Effect.gen(function* () {
    const storeDirectory = temporaryStore();
    const bytes = new TextEncoder().encode("fallback evidence bytes\n");
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    if (platform === undefined || !platform.configurable) {
      throw new Error("The process platform cannot be overridden for this test");
    }
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "freebsd" });
      const published = yield* publishEvidence({
        storeDirectory,
        bytes,
        mediaType: "application/json",
        convenienceArtifactPath: "artifacts/fallback.json",
      });
      expect(published.compatibilityArtifactPath).toBeUndefined();
      expect(published.artifactPath).toBe(`objects/${sha256(bytes)}.bin`);
      expect([...readFileSync(path.join(storeDirectory, published.artifactPath))]).toEqual([
        ...bytes,
      ]);
      expect(existsSync(path.join(storeDirectory, "artifacts"))).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", platform);
      rmSync(storeDirectory, { recursive: true, force: true });
    }
  }),
);

it.live("detects corruption when a reader verifies the receipt", () =>
  Effect.gen(function* () {
    const storeDirectory = temporaryStore();
    const bytes = new TextEncoder().encode("json source snapshot\n");
    try {
      const published = yield* publishEvidence({
        storeDirectory,
        bytes,
        mediaType: "application/json",
      });
      writeFileSync(path.join(storeDirectory, published.artifactPath), "modified after capture\n");
      const exit = yield* Effect.exit(
        readVerifiedEvidence({ storeDirectory, captureId: published.receipt.capture_id }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    } finally {
      rmSync(storeDirectory, { recursive: true, force: true });
    }
  }),
);

it.live("records derived captures without changing their verified original", () =>
  Effect.gen(function* () {
    const storeDirectory = temporaryStore();
    const originalBytes = new TextEncoder().encode("original screenshot bytes\n");
    const derivedBytes = new TextEncoder().encode("redacted screenshot bytes\n");
    try {
      const original = yield* publishEvidence({
        storeDirectory,
        bytes: originalBytes,
        mediaType: "image/png",
        runId: "run-fixture",
        sourceIdentitySha256: "a".repeat(64),
      });
      const derived = yield* publishEvidence({
        storeDirectory,
        bytes: derivedBytes,
        mediaType: "image/png",
        derivedFrom: { captureId: original.receipt.capture_id, sha256: original.receipt.sha256 },
      });
      const verifiedOriginal = yield* readVerifiedEvidence({
        storeDirectory,
        captureId: original.receipt.capture_id,
      });
      expect([...verifiedOriginal.bytes]).toEqual([...originalBytes]);
      expect(derived.receipt.sha256).toBe(sha256(derivedBytes));
      expect(derived.receipt.derived_from).toEqual({
        capture_id: original.receipt.capture_id,
        sha256: original.receipt.sha256,
      });
      expect(original.receipt.run_id).toBe("run-fixture");
      expect(original.receipt.source_identity_sha256).toBe("a".repeat(64));
    } finally {
      rmSync(storeDirectory, { recursive: true, force: true });
    }
  }),
);

it.live("verifies and records every source of a multi-input derived capture", () =>
  Effect.gen(function* () {
    const storeDirectory = temporaryStore();
    const firstBytes = new TextEncoder().encode("finding record source\n");
    const secondBytes = new TextEncoder().encode("finding detail source\n");
    const derivedBytes = new TextEncoder().encode("combined finding evidence\n");
    try {
      const first = yield* publishEvidence({
        storeDirectory,
        bytes: firstBytes,
        mediaType: "application/json",
      });
      const second = yield* publishEvidence({
        storeDirectory,
        bytes: secondBytes,
        mediaType: "text/markdown",
      });
      const lineage = [
        { captureId: first.receipt.capture_id, sha256: first.receipt.sha256 },
        { captureId: second.receipt.capture_id, sha256: second.receipt.sha256 },
      ];
      const derived = yield* publishEvidence({
        storeDirectory,
        bytes: derivedBytes,
        mediaType: "text/markdown",
        derivedFromInputs: lineage,
      });
      expect(derived.receipt.derived_from).toBeUndefined();
      expect(derived.receipt.derived_from_inputs).toEqual([
        { capture_id: first.receipt.capture_id, sha256: first.receipt.sha256 },
        { capture_id: second.receipt.capture_id, sha256: second.receipt.sha256 },
      ]);
      const verified = yield* readVerifiedEvidence({
        storeDirectory,
        captureId: derived.receipt.capture_id,
      });
      expect([...verified.bytes]).toEqual([...derivedBytes]);

      const failed = yield* Effect.exit(
        publishEvidence({
          storeDirectory,
          bytes: new TextEncoder().encode("unverified parent\n"),
          mediaType: "text/markdown",
          captureId: "missing-lineage-source",
          derivedFromInputs: [
            { captureId: first.receipt.capture_id, sha256: first.receipt.sha256 },
            { captureId: "missing-parent", sha256: "b".repeat(64) },
          ],
        }),
      );
      expect(Exit.isFailure(failed)).toBe(true);
      expect(existsSync(path.join(storeDirectory, "receipts", "missing-lineage-source.json"))).toBe(
        false,
      );
    } finally {
      rmSync(storeDirectory, { recursive: true, force: true });
    }
  }),
);
