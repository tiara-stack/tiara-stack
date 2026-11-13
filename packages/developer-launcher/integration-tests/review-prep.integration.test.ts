import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const writeArtifact = (root: string, relativePath: string, content: string) => {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  return { label: relativePath, path: relativePath, sha256: digest(content) };
};

describe("TiaraStack review preparation adapter", () => {
  it.live(
    "runs the installed core, binds the live head, and rejects a stale head",
    () =>
      Effect.sync(() => {
        const root = mkdtempSync(path.join(tmpdir(), "tiara-review-prep-"));
        const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        const delta = writeArtifact(
          root,
          "capture/correctness.diff",
          "diff --git a/src/owned.ts b/src/owned.ts\n",
        );
        const capture = {
          schema: "review-source-capture/v1",
          run_id: "adapter-test",
          base: head,
          head,
          capture_id: "capture-test",
          deltas: {
            correctness_reliability: { sha256: delta.sha256, changed_paths: ["src/owned.ts"] },
          },
        };
        const captureText = `${JSON.stringify(capture, null, 2)}\n`;
        mkdirSync(path.join(root, "capture"), { recursive: true });
        writeFileSync(path.join(root, "capture/source.json"), captureText);
        const priorFindings: Array<unknown> = [];
        const plan = {
          schema: "review-plan/v1",
          run_id: "adapter-test",
          source: {
            base: head,
            head,
            capture_id: "capture-test",
            capture_receipt: {
              label: "source capture",
              path: "capture/source.json",
              sha256: digest(captureText),
            },
          },
          reviewers: {
            correctness_reliability: {
              reviewer: { id: "worker", model: "gpt-6-luna", reasoning_effort: "medium" },
              delta,
              review_contract: writeArtifact(
                root,
                "review-contract.md",
                "Review owned correctness.\n",
              ),
              configuration: writeArtifact(root, "profile.json", '{"reviewer":"worker"}\n'),
              scope: {
                paths: ["src/owned.ts"],
                deleted_paths: [],
                changed_paths: ["src/owned.ts"],
                required_coverage: ["owned correctness"],
                included_coverage: ["owned correctness"],
              },
              source_files: [writeArtifact(root, "src/owned.ts", "export const owned = true;\n")],
              rules: [],
              requirements: [],
              specification_identity: [],
              generated_inputs: [],
              dependencies: [],
              prior_findings: priorFindings,
              prior_coverage: [],
            },
          },
        };
        const input = path.join(root, "review-plan.json");
        writeFileSync(input, `${JSON.stringify(plan, null, 2)}\n`);
        const repoRoot = path.resolve(process.cwd(), "../..");
        const cli = path.join(repoRoot, "scripts/review-prep.ts");
        execFileSync(
          "node",
          [
            "--experimental-strip-types",
            cli,
            "bundle",
            "--input",
            input,
            "--axis",
            "correctness_reliability",
            "--output",
            path.join(root, "bundle"),
          ],
          { cwd: repoRoot },
        );
        const manifest = Schema.decodeUnknownSync(
          Schema.Struct({ axis: Schema.String, source: Schema.Struct({ head: Schema.String }) }),
        )(JSON.parse(readFileSync(path.join(root, "bundle/review-manifest.json"), "utf8")));
        expect(manifest).toMatchObject({ axis: "correctness_reliability", source: { head } });
        const stalePlan = { ...plan, source: { ...plan.source, head: "0".repeat(40) } };
        writeFileSync(input, `${JSON.stringify(stalePlan, null, 2)}\n`);
        expect(() =>
          execFileSync(
            "node",
            [
              "--experimental-strip-types",
              cli,
              "bundle",
              "--input",
              input,
              "--axis",
              "correctness_reliability",
              "--output",
              path.join(root, "stale"),
            ],
            { cwd: repoRoot },
          ),
        ).toThrow();

        const nativeReceipt = writeArtifact(
          root,
          "receipts/native.json",
          '{"result":"accepted"}\n',
        );
        const startReceiptValue = {
          schema: "review-native-start/v1",
          run_id: "adapter-test",
          phase: "review-phase",
          base: head,
          head,
          axis: "correctness_reliability",
          reviewer_id: "worker",
          model: "gpt-6-luna",
          pool_id: "local-review",
          status: "started",
          native_id_available: true,
          native_start_id: "native-start-1",
          native_receipt: nativeReceipt,
        };
        const startText = `${JSON.stringify(startReceiptValue, null, 2)}\n`;
        writeArtifact(root, "receipts/start.json", startText);
        const startReference = {
          label: "start receipt",
          path: "receipts/start.json",
          sha256: digest(startText),
        };
        const startInput = path.join(root, "native-starts.json");
        const expectedStart = {
          axis: "correctness_reliability",
          reviewer_id: "worker",
          model: "gpt-6-luna",
          pool_id: "local-review",
        };
        const startsPlan = {
          schema: "review-native-starts/v1",
          run_id: "adapter-test",
          phase: "review-phase",
          base: head,
          head,
          starts: [
            { expected: expectedStart, receipt: startReference },
            {
              expected: expectedStart,
              receipt: { ...startReference, label: "duplicate start receipt" },
            },
          ],
        };
        writeFileSync(startInput, `${JSON.stringify(startsPlan, null, 2)}\n`);
        const accountingOutput = path.join(root, "start-accounting.json");
        execFileSync(
          "node",
          [
            "--experimental-strip-types",
            cli,
            "count-starts",
            "--input",
            startInput,
            "--output",
            accountingOutput,
          ],
          { cwd: repoRoot },
        );
        const accounting = Schema.decodeUnknownSync(
          Schema.Struct({
            unique_start_count: Schema.Number,
            duplicate_receipts_collapsed: Schema.Number,
          }),
        )(JSON.parse(readFileSync(accountingOutput, "utf8")));
        expect(accounting).toEqual({ unique_start_count: 1, duplicate_receipts_collapsed: 1 });
        const excessiveStartsInput = path.join(root, "excessive-starts.json");
        writeFileSync(
          excessiveStartsInput,
          `${JSON.stringify(
            {
              ...startsPlan,
              starts: Array.from({ length: 81 }, () => ({
                expected: expectedStart,
                receipt: startReference,
              })),
            },
            null,
            2,
          )}\n`,
        );
        expect(() =>
          execFileSync(
            "node",
            [
              "--experimental-strip-types",
              cli,
              "count-starts",
              "--input",
              excessiveStartsInput,
              "--output",
              path.join(root, "excessive-starts-output.json"),
            ],
            { cwd: repoRoot },
          ),
        ).toThrow();

        const timingInput = path.join(root, "timing.json");
        writeFileSync(
          timingInput,
          `${JSON.stringify(
            {
              schema: "review-timing/v1",
              events: [
                {
                  id: "review-a",
                  stage: "review",
                  start_at: "2026-01-01T00:00:00Z",
                  end_at: "2026-01-01T00:00:10Z",
                },
                {
                  id: "review-b",
                  stage: "review",
                  start_at: "2026-01-01T00:00:05Z",
                  end_at: "2026-01-01T00:00:15Z",
                },
                { id: "unknown", stage: "service_wait", start_at: null, end_at: null },
              ],
            },
            null,
            2,
          )}\n`,
        );
        const timingOutput = path.join(root, "timing-summary.json");
        execFileSync(
          "node",
          [
            "--experimental-strip-types",
            cli,
            "timing",
            "--input",
            timingInput,
            "--output",
            timingOutput,
          ],
          { cwd: repoRoot },
        );
        const timingSummary = Schema.decodeUnknownSync(
          Schema.Struct({ status: Schema.String, known_interval_union_seconds: Schema.Number }),
        )(JSON.parse(readFileSync(timingOutput, "utf8")));
        expect(timingSummary).toEqual({
          status: "partial_unknown_timestamps",
          known_interval_union_seconds: 15,
        });

        const reservationText = `${JSON.stringify(
          {
            schema: "review-quota-reservation/v1",
            reservation_id: "reservation-1",
            pool: "local-review",
            phase: "review-phase",
            head,
            coordinator_thread_id: "coordinator-1",
            status: "reserved",
            remaining_invocations: 1,
          },
          null,
          2,
        )}\n`;
        const reservationRef = writeArtifact(root, "receipts/reservation.json", reservationText);
        const nativeGrantText = '{"delivery":"started"}\n';
        const nativeGrantRef = writeArtifact(root, "receipts/native-grant.json", nativeGrantText);
        const grantReceiptText = `${JSON.stringify(
          {
            schema: "conditional-review-grant-receipt/v1",
            grant_id: "grant-1",
            phase: "review-phase",
            coordinator_thread_id: "coordinator-1",
            worker_thread_id: "worker",
            head,
            capture_id: "capture-test",
            reservation_ids: ["reservation-1"],
            delivery: "started",
            native_receipt_identity: {
              target_worker_id: "worker",
              request_id: "grant-1",
              delivery: "started",
              native_result_id: "native-grant-result",
            },
            native_receipt: nativeGrantRef,
          },
          null,
          2,
        )}\n`;
        const grantReceiptRef = writeArtifact(root, "receipts/grant.json", grantReceiptText);
        const grantInput = path.join(root, "conditional-grant.json");
        writeFileSync(
          grantInput,
          `${JSON.stringify(
            {
              schema: "conditional-review-grant/v1",
              grant_id: "grant-1",
              phase: "review-phase",
              coordinator_thread_id: "coordinator-1",
              worker_thread_id: "worker",
              base: head,
              head,
              capture_id: "capture-test",
              required_invocations: 1,
              required_prerequisite_ids: ["required-check"],
              capture_receipt: plan.source.capture_receipt,
              prerequisites: [],
              reservation: {
                id: "reservation-1",
                pool: "local-review",
                state_receipt: reservationRef,
              },
              grant_receipt: grantReceiptRef,
            },
            null,
            2,
          )}\n`,
        );
        const grantOutput = path.join(root, "grant-check.json");
        expect(() =>
          execFileSync(
            "node",
            [
              "--experimental-strip-types",
              cli,
              "check-grant",
              "--input",
              grantInput,
              "--output",
              grantOutput,
            ],
            { cwd: repoRoot },
          ),
        ).toThrow();
        const grantCheck = Schema.decodeUnknownSync(
          Schema.Struct({
            status: Schema.String,
            grants_capacity: Schema.Boolean,
            performs_native_start: Schema.Boolean,
          }),
        )(JSON.parse(readFileSync(grantOutput, "utf8")));
        expect(grantCheck).toEqual({
          status: "reconcile",
          grants_capacity: false,
          performs_native_start: false,
        });
        const leakagePlan = {
          ...plan,
          reviewers: {
            ...plan.reviewers,
            correctness_reliability: {
              ...plan.reviewers.correctness_reliability,
              prior_findings: [
                {
                  id: "foreign-axis-finding",
                  axis: "security_privacy",
                  status: "unresolved",
                  assigned_reviewer: {
                    id: "worker",
                    model: "gpt-6-luna",
                    reasoning_effort: "medium",
                  },
                  evidence: writeArtifact(root, "findings/foreign.md", "Finding evidence.\n"),
                },
              ],
            },
          },
        };
        writeFileSync(input, `${JSON.stringify(leakagePlan, null, 2)}\n`);
        expect(() =>
          execFileSync(
            "node",
            [
              "--experimental-strip-types",
              cli,
              "bundle",
              "--input",
              input,
              "--axis",
              "correctness_reliability",
              "--output",
              path.join(root, "leakage"),
            ],
            { cwd: repoRoot },
          ),
        ).toThrow();
      }),
    15_000,
  );
});
