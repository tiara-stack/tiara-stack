import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ReceiptReference = Schema.Struct({
  capture_id: Schema.String,
  path: Schema.String,
  sha256: Schema.String,
});
const CaptureResult = Schema.Struct({
  receipt: Schema.Struct({
    schema: Schema.Literal("tiara-evidence-receipt/v1"),
    capture_id: Schema.String,
    run_id: Schema.String,
    sha256: Schema.String,
    byte_count: Schema.Number,
    media_type: Schema.String,
    artifact: Schema.Struct({ path: Schema.String, sha256: Schema.String }),
  }),
  receipt_reference: ReceiptReference,
});
const VerifyResult = Schema.Struct({ receipt_reference: ReceiptReference });

it.live(
  "seals actual fixture evidence through pnpm evidence:capture and verifies its receipt",
  () =>
    Effect.sync(() => {
      const root = mkdtempSync(path.join(tmpdir(), "tiara-evidence-command-"));
      const repoRoot = path.resolve(process.cwd(), "../..");
      const fixtureBytes = Uint8Array.of(
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0x01,
        0x02,
        0x03,
      );
      const inputPath = path.join(root, "fixture.png");
      const storeDirectory = path.join(root, "evidence-store");
      try {
        writeFileSync(inputPath, fixtureBytes);
        const capture = spawnSync(
          "pnpm",
          [
            "evidence:capture",
            "capture",
            "--input",
            inputPath,
            "--store",
            storeDirectory,
            "--media-type",
            "image/png",
            "--run-id",
            "run-fixture",
          ],
          { cwd: repoRoot, encoding: "utf8" },
        );
        expect(capture.status, `${capture.stdout}\n${capture.stderr}`).toBe(0);
        const result = Schema.decodeUnknownSync(CaptureResult)(JSON.parse(capture.stdout));
        expect(result.receipt).toMatchObject({
          schema: "tiara-evidence-receipt/v1",
          run_id: "run-fixture",
          sha256: digest(fixtureBytes),
          byte_count: fixtureBytes.byteLength,
          media_type: "image/png",
        });
        const verify = spawnSync(
          "pnpm",
          [
            "evidence:capture",
            "verify",
            "--store",
            storeDirectory,
            "--capture-id",
            result.receipt.capture_id,
            "--receipt-sha256",
            result.receipt_reference.sha256,
          ],
          { cwd: repoRoot, encoding: "utf8" },
        );
        expect(verify.status, `${verify.stdout}\n${verify.stderr}`).toBe(0);
        expect(
          Schema.decodeUnknownSync(VerifyResult)(JSON.parse(verify.stdout)).receipt_reference,
        ).toEqual(result.receipt_reference);
        expect([...readFileSync(path.join(storeDirectory, result.receipt.artifact.path))]).toEqual([
          ...fixtureBytes,
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  30_000,
);
