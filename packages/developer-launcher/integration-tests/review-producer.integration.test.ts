import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const write = (root: string, relative: string, value: string) => {
  const destination = path.join(root, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, value);
  return { label: relative, path: relative, sha256: sha256(value) };
};
const writeJson = (root: string, relative: string, value: unknown) =>
  write(root, relative, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (target: string) => JSON.parse(readFileSync(target, "utf8"));

type FixtureArtifact = { label: string; path: string; sha256: string };
type FixtureReviewer = { id: string; model: string; reasoning_effort: string };
type FixtureAxis = {
  review_contract: FixtureArtifact;
  configuration: FixtureArtifact;
  delta: FixtureArtifact;
  scope: {
    paths: Array<string>;
    changed_paths: Array<string>;
    deleted_paths: Array<string>;
    required_coverage: Array<string>;
    included_coverage: Array<string>;
  };
  requirements: Array<FixtureArtifact>;
};
type FixtureInput = {
  schema: string;
  phase: FixtureArtifact;
  source: FixtureArtifact;
  source_files: Array<{
    path: string;
    artifact: FixtureArtifact;
    axes?: Array<"spec" | "standards">;
  }>;
  reviewers: { spec: FixtureAxis; standards: FixtureAxis };
  rules: Array<{
    schema: string;
    axis: string;
    artifact: FixtureArtifact;
    sections: Array<string>;
  }>;
  findings: Array<FixtureArtifact>;
  coverage: Array<FixtureArtifact>;
};

const makeFixture = (
  root: string,
): {
  repoRoot: string;
  head: string;
  base: string;
  sourcePath: string;
  sourceIdentitySha256: string;
  source: FixtureArtifact;
  specDelta: FixtureArtifact;
  standardsDelta: FixtureArtifact;
  capture: FixtureArtifact;
  specReviewer: FixtureReviewer;
  standardsReviewer: FixtureReviewer;
  inputPath: string;
  input: FixtureInput;
} => {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    cwd: repoRoot,
  }).trim();
  const base = "a".repeat(40);
  const sourcePath = "packages/example/owned.ts";
  const source = write(root, sourcePath, "export const owned = true;\n");
  const specDelta = write(
    root,
    "capture/spec.diff",
    `diff --git a/${sourcePath} b/${sourcePath}\n`,
  );
  const standardsDelta = write(
    root,
    "capture/standards.diff",
    `diff --git a/${sourcePath} b/${sourcePath}\n`,
  );
  const capture = writeJson(root, "capture/source.json", {
    schema: "review-source-capture/v1",
    run_id: "run-fixture",
    base,
    head,
    capture_id: "capture-fixture",
    deltas: {
      spec_conformance: { sha256: specDelta.sha256, changed_paths: [sourcePath] },
      correctness_reliability: { sha256: standardsDelta.sha256, changed_paths: [sourcePath] },
    },
  });
  const sourceIdentitySha256 = capture.sha256;
  const specReviewer = { id: "configured-spec", model: "gpt-6-luna", reasoning_effort: "max" };
  const standardsReviewer = {
    id: "configured-standards",
    model: "gpt-6-luna",
    reasoning_effort: "max",
  };
  const specContract = write(
    root,
    "contracts/spec.md",
    "Review the configured authoritative requirements.\n",
  );
  const standardsContract = write(
    root,
    "contracts/standards.md",
    "Review the configured repository standards.\n",
  );
  const specConfig = writeJson(root, "contracts/spec-config.json", {
    schema: "tiara-reviewer-config/v1",
    reviewer: specReviewer,
  });
  const standardsConfig = writeJson(root, "contracts/standards-config.json", {
    schema: "tiara-reviewer-config/v1",
    reviewer: standardsReviewer,
  });
  const requirement = write(root, "requirements/product.md", "A user can open an owned preview.\n");
  const standardRule = write(
    root,
    "rules/effect.md",
    "Effect errors remain typed at module boundaries.\n",
  );
  const specEvidence = write(root, "findings/spec-evidence.md", "Spec finding evidence body.\n");
  const standardsEvidence = write(
    root,
    "findings/standards-evidence.md",
    "Standards finding evidence body.\n",
  );
  const specFinding = writeJson(root, "findings/spec-finding.json", {
    schema: "tiara-review-finding/v1",
    id: "SP-41",
    axis: "spec",
    status: "unresolved",
    raw_severity: "Major",
    assigned_reviewer: specReviewer,
    evidence: specEvidence,
  });
  const standardsFinding = writeJson(root, "findings/standards-finding.json", {
    schema: "tiara-review-finding/v1",
    id: "ST-11",
    axis: "standards",
    status: "unresolved",
    raw_severity: "Minor",
    assigned_reviewer: standardsReviewer,
    evidence: standardsEvidence,
  });
  writeJson(root, "phase.json", {
    schema: "tiara-review-phase/v1",
    run_id: "run-fixture",
    phase_id: "phase-fixture",
    grant_id: "grant-fixture",
    handoff_id: "handoff-fixture",
    base,
    head,
    capture_id: "capture-fixture",
    source_identity_sha256: sourceIdentitySha256,
    worker_thread_id: "worker-fixture",
  });
  const phase = write(root, "phase.json", readFileSync(path.join(root, "phase.json"), "utf8"));
  const specCoverageIdentity = {
    source_scope_sha256: sha256(JSON.stringify([{ path: sourcePath, sha256: source.sha256 }])),
    rules_sha256: sha256("[]"),
    configuration_sha256: specConfig.sha256,
    specification_sha256: sha256(
      JSON.stringify([{ label: requirement.label, sha256: requirement.sha256 }]),
    ),
    generated_inputs_sha256: sha256("[]"),
    dependencies_sha256: sha256("[]"),
    reviewer_id: specReviewer.id,
    model: specReviewer.model,
    reasoning_effort: specReviewer.reasoning_effort,
  };
  const priorCoverage = writeJson(root, "coverage/spec-coverage.json", {
    schema: "review-coverage/v1",
    coverage_id: "spec-coverage-prior",
    head: base,
    paths: [sourcePath],
    coverage: ["spec requirement acceptance"],
    identity: specCoverageIdentity,
  });
  const impactEvidence = write(
    root,
    "coverage/spec-impact.md",
    "The changed delta may affect this requirement.\n",
  );
  const coverageRow = writeJson(root, "coverage/spec-row.json", {
    schema: "tiara-review-coverage/v1",
    axis: "spec",
    coverage_id: "spec-coverage-prior",
    head: base,
    paths: [sourcePath],
    coverage: ["spec requirement acceptance"],
    identity: specCoverageIdentity,
    record: priorCoverage,
    impact: { status: "uncertain", evidence: impactEvidence },
  });
  const input: FixtureInput = {
    schema: "tiara-review-input/v1",
    phase,
    source: capture,
    source_files: [{ path: sourcePath, artifact: source }],
    reviewers: {
      spec: {
        review_contract: specContract,
        configuration: specConfig,
        delta: specDelta,
        scope: {
          paths: [sourcePath],
          changed_paths: [sourcePath],
          deleted_paths: [],
          required_coverage: ["spec requirement acceptance"],
          included_coverage: ["spec requirement acceptance"],
        },
        requirements: [requirement],
      },
      standards: {
        review_contract: standardsContract,
        configuration: standardsConfig,
        delta: standardsDelta,
        scope: {
          paths: [sourcePath],
          changed_paths: [sourcePath],
          deleted_paths: [],
          required_coverage: ["Effect and ownership behavior"],
          included_coverage: ["Effect and ownership behavior"],
        },
        requirements: [],
      },
    },
    rules: [
      {
        schema: "tiara-review-rule/v1",
        axis: "standards",
        artifact: standardRule,
        sections: ["Typed errors"],
      },
    ],
    findings: [specFinding, standardsFinding],
    coverage: [coverageRow],
  };
  const inputRef = writeJson(root, "tiara-review-input.json", input);
  return {
    repoRoot,
    head,
    base,
    sourcePath,
    sourceIdentitySha256,
    source,
    specDelta,
    standardsDelta,
    capture,
    specReviewer,
    standardsReviewer,
    inputPath: path.join(root, inputRef.path),
    input,
  };
};

const runProduce = (repoRoot: string, inputPath: string, axis: string, output: string) =>
  spawnSync(
    "pnpm",
    ["review:prep", "produce", "--input", inputPath, "--axis", axis, "--output", output],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

describe("TiaraStack canonical review input producer", () => {
  it.live(
    "maps both configured axes and creates bounded bundles through pnpm review:prep",
    () =>
      Effect.sync(() => {
        const root = mkdtempSync(path.join(tmpdir(), "tiara-review-producer-"));
        const fixture = makeFixture(root);
        const specOnlyPath = "packages/example/spec-only.ts";
        const specOnly = write(root, specOnlyPath, "export const specOnly = true;\n");
        const standardsOnlyPath = "packages/example/standards-only.ts";
        const standardsOnly = write(
          root,
          standardsOnlyPath,
          "export const standardsOnly = true;\n",
        );
        fixture.input.source_files.push(
          { path: specOnlyPath, artifact: specOnly, axes: ["spec"] },
          { path: standardsOnlyPath, artifact: standardsOnly, axes: ["standards"] },
        );
        fixture.input.reviewers.spec.scope.paths = [fixture.sourcePath, specOnlyPath];
        fixture.input.reviewers.standards.scope.paths = [fixture.sourcePath, standardsOnlyPath];
        writeJson(root, "tiara-review-input.json", fixture.input);
        const specOutput = path.join(root, "out-spec");
        const specRun = runProduce(
          fixture.repoRoot,
          fixture.inputPath,
          "spec_conformance",
          specOutput,
        );
        expect(specRun.status, `${specRun.stdout}\n${specRun.stderr}`).toBe(0);
        const specPlanName = readdirSync(specOutput).find((name) =>
          name.startsWith("review-plan-"),
        );
        expect(specPlanName).toBeDefined();
        const specPlan = readJson(path.join(specOutput, specPlanName!));
        expect(specPlan).toMatchObject({
          schema: "review-plan/v1",
          run_id: "run-fixture",
          source: { base: fixture.base, head: fixture.head, capture_id: "capture-fixture" },
          reviewers: {
            spec_conformance: {
              reviewer: fixture.specReviewer,
              scope: { required_coverage: ["spec requirement acceptance"] },
            },
            correctness_reliability: {
              reviewer: fixture.standardsReviewer,
              scope: { required_coverage: ["Effect and ownership behavior"] },
            },
          },
        });
        expect(specPlan.reviewers.spec_conformance.configuration.label).toBe(
          "contracts/spec-config.json",
        );
        const capturedSource = specPlan.reviewers.spec_conformance.source_files.find(
          (item: { label: string }) => item.label === fixture.sourcePath,
        );
        expect(capturedSource.capture_receipt.path).toMatch(/^receipts\/.+\.json$/u);
        const capturedReceiptBytes = readFileSync(
          path.join(specOutput, capturedSource.capture_receipt.path),
        );
        expect(sha256(capturedReceiptBytes)).toBe(capturedSource.capture_receipt.sha256);
        const capturedReceipt = JSON.parse(capturedReceiptBytes.toString("utf8"));
        expect(capturedReceipt).toMatchObject({
          schema: "tiara-evidence-receipt/v1",
          sha256: fixture.source.sha256,
          media_type: "text/plain",
          run_id: "run-fixture",
          source_identity_sha256: fixture.sourceIdentitySha256,
        });
        const specBundleName = readdirSync(specOutput).find((name) => name.startsWith("bundle-"));
        expect(specBundleName).toBeDefined();
        const specBundle = path.join(specOutput, specBundleName!);
        const specManifest = readJson(path.join(specBundle, "review-manifest.json"));
        expect(specManifest.reviewer).toMatchObject({
          id: "configured-spec",
          model: "gpt-6-luna",
          reasoningEffort: "max",
        });
        expect(specManifest.source).toMatchObject({
          base: fixture.base,
          head: fixture.head,
          capture_id: "capture-fixture",
          delta: { sha256: fixture.specDelta.sha256 },
          changed_paths: [fixture.sourcePath],
        });
        expect(specManifest.scope.paths).toEqual([fixture.sourcePath, specOnlyPath].sort());
        expect(specManifest.scope.required_coverage).toEqual(["spec requirement acceptance"]);
        expect(specManifest.coordinator_only.source_capture_receipt.sha256).toBe(
          fixture.capture.sha256,
        );
        expect(specManifest.coordinator_only.carry_candidates[0]).toMatchObject({
          coverage_id: "spec-coverage-prior",
          decision: "review_required",
          reasons: ["changed_path_intersects_scope", "impact_uncertain"],
          semantic_approval: false,
        });
        expect(specManifest.coordinator_only.reviewer_configuration.label).toBe(
          "contracts/spec-config.json",
        );
        const specPrompt = readFileSync(path.join(specBundle, "reviewer-input.md"), "utf8");
        expect(specPrompt).toContain("spec requirement acceptance");
        expect(specPrompt).toContain("requirements/product.md");
        expect(specPrompt).toContain(specOnlyPath);
        expect(specPrompt).not.toContain(standardsOnlyPath);
        expect(specPrompt).not.toContain("rules/effect.md");
        expect(specPrompt).toContain("SP-41");
        const specFindingPlanRef = specPlan.reviewers.spec_conformance.prior_findings[0].evidence;
        const specFindingRef = specManifest.reviewer_visible_artifacts.prior_findings[0].evidence;
        const specFindingEvidence = readFileSync(
          path.resolve(specOutput, specFindingRef.path),
          "utf8",
        );
        expect(specFindingEvidence).toContain("Raw severity: Major");
        expect(specFindingEvidence).toContain("Spec finding evidence body.");
        const specFindingReceipt = readJson(
          path.join(specOutput, specFindingPlanRef.capture_receipt.path),
        );
        const specFindingSource = fixture.input.findings.find(
          (item) => item.path === "findings/spec-finding.json",
        );
        expect(specFindingSource).toBeDefined();
        const specFindingRecord = readJson(
          path.resolve(path.dirname(fixture.inputPath), specFindingSource!.path),
        );
        const parentHashes = specFindingReceipt.derived_from_inputs.map(
          (source: { sha256: string }) => source.sha256,
        );
        expect(parentHashes).toHaveLength(2);
        expect(parentHashes).toContain(specFindingSource!.sha256);
        expect(parentHashes).toContain(specFindingRecord.evidence.sha256);
        for (const source of specFindingReceipt.derived_from_inputs) {
          const sourceReceipt = readJson(
            path.join(specOutput, "receipts", `${source.capture_id}.json`),
          );
          expect(sourceReceipt.sha256).toBe(source.sha256);
        }

        const standardsOutput = path.join(root, "out-standards");
        const standardsRun = runProduce(
          fixture.repoRoot,
          fixture.inputPath,
          "correctness_reliability",
          standardsOutput,
        );
        expect(standardsRun.status, `${standardsRun.stdout}\n${standardsRun.stderr}`).toBe(0);
        const standardsBundleName = readdirSync(standardsOutput).find((name) =>
          name.startsWith("bundle-"),
        );
        expect(standardsBundleName).toBeDefined();
        const standardsBundle = path.join(standardsOutput, standardsBundleName!);
        const standardsManifest = readJson(path.join(standardsBundle, "review-manifest.json"));
        expect(standardsManifest.reviewer).toMatchObject({
          id: "configured-standards",
          model: "gpt-6-luna",
          reasoningEffort: "max",
        });
        expect(standardsManifest.reviewer_visible_artifacts.rules).toHaveLength(1);
        expect(standardsManifest.reviewer_visible_artifacts.rules[0].label).toBe("rules/effect.md");
        expect(standardsManifest.reviewer_visible_artifacts.requirements).toHaveLength(0);
        expect(standardsManifest.source.delta.sha256).toBe(fixture.standardsDelta.sha256);
        const standardsPrompt = readFileSync(
          path.join(standardsBundle, "reviewer-input.md"),
          "utf8",
        );
        expect(standardsPrompt).toContain("rules/effect.md");
        expect(standardsPrompt).toContain(standardsOnlyPath);
        expect(standardsPrompt).not.toContain(specOnlyPath);
        expect(standardsPrompt).not.toContain("requirements/product.md");
        expect(standardsPrompt).toContain("ST-11");
        const standardsFindingRef =
          standardsManifest.reviewer_visible_artifacts.prior_findings[0].evidence;
        const standardsFindingEvidence = readFileSync(
          path.resolve(standardsOutput, standardsFindingRef.path),
          "utf8",
        );
        expect(standardsFindingEvidence).toContain("Raw severity: Minor");
        expect(standardsFindingEvidence).toContain("Standards finding evidence body.");
        expect(
          readdirSync(path.join(specOutput, "artifacts")).every((name) =>
            /^[a-f0-9]{64}-/u.test(name),
          ),
        ).toBe(true);

        const collision = runProduce(
          fixture.repoRoot,
          fixture.inputPath,
          "spec_conformance",
          specOutput,
        );
        expect(collision.status).not.toBe(0);
        expect(`${collision.stdout}\n${collision.stderr}`).toContain(
          "Output directory already exists",
        );
      }),
    30_000,
  );

  it.live(
    "aggregates mapping and hash errors before publishing artifacts",
    () =>
      Effect.sync(() => {
        const root = mkdtempSync(path.join(tmpdir(), "tiara-review-producer-errors-"));
        const fixture = makeFixture(root);
        fixture.input.reviewers.spec.scope.included_coverage = ["unmapped requirement"];
        fixture.input.reviewers.standards.requirements = [
          write(root, "requirements/leaked.md", "Should not enter standards.\n"),
        ];
        fixture.input.reviewers.standards.delta.sha256 = "0".repeat(64);
        fixture.input.source_files[0]!.artifact.path = "missing-current-source.ts";
        const binaryEvidence = Uint8Array.of(0xff, 0xfe);
        const binaryEvidencePath = path.join(root, "findings/spec-evidence.bin");
        writeFileSync(binaryEvidencePath, binaryEvidence);
        const binaryEvidenceRef = {
          label: "findings/spec-evidence.bin",
          path: "findings/spec-evidence.bin",
          sha256: sha256(binaryEvidence),
        };
        const specFinding = writeJson(root, "findings/spec-finding.json", {
          schema: "tiara-review-finding/v1",
          id: "SP-41",
          axis: "spec",
          status: "unresolved",
          raw_severity: "Major",
          assigned_reviewer: fixture.specReviewer,
          evidence: binaryEvidenceRef,
        });
        fixture.input.findings[0] = specFinding;
        const invalidCoverage = readJson(path.join(root, fixture.input.coverage[0]!.path));
        invalidCoverage.impact.status = "not-recorded";
        fixture.input.coverage = [writeJson(root, "coverage/invalid-row.json", invalidCoverage)];
        writeJson(root, "tiara-review-input.json", fixture.input);
        const output = path.join(root, "failed-output");
        const run = runProduce(fixture.repoRoot, fixture.inputPath, "spec_conformance", output);
        const detail = `${run.stdout}\n${run.stderr}`;
        expect(run.status).not.toBe(0);
        expect(detail).toContain("coverage mismatch");
        expect(detail).toContain("requirements belong only to the Spec axis");
        expect(detail).toContain("SHA-256 mismatch");
        expect(detail).toContain("cannot read missing-current-source.ts");
        expect(detail).toContain("findings/spec-evidence.bin is not readable UTF-8 text");
        expect(detail).toContain("impact.status must be unaffected, affected, or uncertain");
        expect(existsSync(output)).toBe(false);
        const invalidAxisOutput = path.join(root, "invalid-axis-output");
        const invalidAxisRun = runProduce(
          fixture.repoRoot,
          fixture.inputPath,
          "unregistered_axis",
          invalidAxisOutput,
        );
        expect(invalidAxisRun.status).not.toBe(0);
        expect(existsSync(invalidAxisOutput)).toBe(false);
      }),
    30_000,
  );

  it.live(
    "rejects a stale phase head before creating producer output",
    () =>
      Effect.sync(() => {
        const root = mkdtempSync(path.join(tmpdir(), "tiara-review-producer-stale-head-"));
        const fixture = makeFixture(root);
        const stalePhase = readJson(path.join(root, fixture.input.phase.path));
        stalePhase.head = "0".repeat(40);
        fixture.input.phase = writeJson(root, "stale-phase.json", stalePhase);
        writeJson(root, "tiara-review-input.json", fixture.input);
        const output = path.join(root, "stale-output");
        const run = runProduce(fixture.repoRoot, fixture.inputPath, "spec_conformance", output);
        expect(run.status).not.toBe(0);
        expect(`${run.stdout}\n${run.stderr}`).toContain("does not match live HEAD");
        expect(existsSync(output)).toBe(false);
      }),
    30_000,
  );

  it.live(
    "reports helper size failures with artifact contributions and keeps the evidence snapshots",
    () =>
      // fallow-ignore-next-line complexity
      Effect.sync(() => {
        const root = mkdtempSync(path.join(tmpdir(), "tiara-review-producer-budget-"));
        const fixture = makeFixture(root);
        const sourceFiles: FixtureInput["source_files"] = [];
        const paths: Array<string> = [];
        for (let index = 0; index < 120; index += 1) {
          const name = `packages/${String(index).padStart(3, "0")}/${"segment-".concat(String(index).padStart(3, "0"))}/${"long-directory-name-".repeat(7).slice(0, 132)}/owned-${String(index).padStart(3, "0")}.ts`;
          paths.push(name);
          sourceFiles.push({
            path: name,
            artifact: write(root, name, `export const item${index} = ${index};\n`),
          });
        }
        const input = fixture.input;
        input.source_files = sourceFiles;
        for (const axis of ["spec", "standards"] as const) {
          input.reviewers[axis].scope.paths = [...paths];
          input.reviewers[axis].scope.changed_paths = [fixture.sourcePath];
        }
        const sourceIndex = sourceFiles.findIndex((item) => item.path === fixture.sourcePath);
        if (sourceIndex < 0) {
          sourceFiles.push({ path: fixture.sourcePath, artifact: fixture.source });
          paths.push(fixture.sourcePath);
        }
        for (const axis of ["spec", "standards"] as const)
          input.reviewers[axis].scope.paths = [...paths];
        writeJson(root, "tiara-review-input.json", input);
        const output = path.join(root, "budget-output");
        const run = runProduce(fixture.repoRoot, fixture.inputPath, "spec_conformance", output);
        const detail = `${run.stdout}\n${run.stderr}`;
        expect(run.status).not.toBe(0);
        expect(detail).toContain("Verified input artifacts:");
        expect(detail).toMatch(
          /(?:Bundle manifest|Reviewer input) (?:exceeds \d+ bytes|is \d+ bytes \(limit \d+;)/u,
        );
        expect(readdirSync(path.join(output, "artifacts")).length).toBeGreaterThanOrEqual(120);
        const bundleName = readdirSync(output).find((name) => name.startsWith("bundle-"));
        expect(bundleName).toBeUndefined();
        const sourceSnapshot = readdirSync(path.join(output, "artifacts")).find((name) =>
          name.startsWith(`${sourceFiles[0]!.artifact.sha256}-`),
        );
        expect(sourceSnapshot).toBeDefined();
        const snapshotBytes = readFileSync(path.join(output, "artifacts", sourceSnapshot!));
        expect(sha256(snapshotBytes)).toBe(sourceSnapshot!.slice(0, 64));
      }),
    30_000,
  );

  it.live(
    "rejects an oversized reviewer input without shortening the configured requirement reference",
    () =>
      Effect.sync(() => {
        const root = mkdtempSync(path.join(tmpdir(), "tiara-review-producer-prompt-budget-"));
        const fixture = makeFixture(root);
        fixture.input.reviewers.spec.requirements[0]!.label = "requirement-".concat(
          "x".repeat(34_000),
        );
        writeJson(root, "tiara-review-input.json", fixture.input);
        const output = path.join(root, "prompt-budget-output");
        const run = runProduce(fixture.repoRoot, fixture.inputPath, "spec_conformance", output);
        const detail = `${run.stdout}\n${run.stderr}`;
        expect(run.status).not.toBe(0);
        expect(detail).toMatch(
          /Reviewer input (?:exceeds 32768 bytes|is \d+ bytes \(limit 32768;)/u,
        );
        const planName = readdirSync(output).find((name) => name.startsWith("review-plan-"));
        expect(planName).toBeDefined();
        const plan = readJson(path.join(output, planName!));
        expect(plan.reviewers.spec_conformance.requirements[0].label).toBe(
          fixture.input.reviewers.spec.requirements[0]!.label,
        );
        const requirementArtifact = readdirSync(path.join(output, "artifacts")).find((name) =>
          name.startsWith(`${fixture.input.reviewers.spec.requirements[0]!.sha256}-`),
        );
        expect(requirementArtifact).toBeDefined();
        expect(readFileSync(path.join(output, "artifacts", requirementArtifact!), "utf8")).toBe(
          "A user can open an owned preview.\n",
        );
        expect(readdirSync(output).some((name) => name.startsWith("bundle-"))).toBe(false);
      }),
    30_000,
  );

  it.live(
    "rejects a previous repair handoff for a current resync completion",
    () =>
      Effect.sync(() => {
        const root = mkdtempSync(path.join(tmpdir(), "tiara-review-completion-"));
        const phase = writeJson(root, "phase.json", {
          schema: "tiara-review-phase/v1",
          run_id: "TIA-230",
          phase_id: "resync-600",
          grant_id: "grant-resync-600",
          handoff_id: "handoff-resync-600",
          base: "a".repeat(40),
          head: "b".repeat(40),
          capture_id: "capture-resync-600",
          source_identity_sha256: "c".repeat(64),
          worker_thread_id: "worker-1",
        });
        const completion = writeJson(root, "completion.json", {
          schema: "tiara-review-completion/v1",
          status: "completed",
          run_id: "TIA-230",
          phase_id: "repair-246",
          grant_id: "grant-repair-246",
          handoff_id: "handoff-repair-246",
          base: "a".repeat(40),
          head: "b".repeat(40),
          capture_id: "capture-resync-600",
          source_identity_sha256: "c".repeat(64),
        });
        const delivery = writeJson(root, "delivery.json", {
          schema: "tiara-native-delivery/v1",
          delivery: "started",
          run_id: "TIA-230",
          phase_id: "repair-246",
          grant_id: "grant-repair-246",
          handoff_id: "handoff-repair-246",
          base: "a".repeat(40),
          head: "b".repeat(40),
          capture_id: "capture-resync-600",
          source_identity_sha256: "c".repeat(64),
          target_id: "worker-1",
          native_delivery_id: "native-old",
        });
        const input = writeJson(root, "completion-check.json", {
          schema: "tiara-review-completion-check/v1",
          phase,
          completion,
          delivery,
        });
        const output = path.join(root, "completion-result.json");
        const repoRoot = path.resolve(process.cwd(), "../..");
        const result = spawnSync(
          "pnpm",
          [
            "review:prep",
            "check-completion",
            "--input",
            path.join(root, input.path),
            "--output",
            output,
          ],
          {
            cwd: repoRoot,
            encoding: "utf8",
          },
        );
        expect(result.status).not.toBe(0);
        expect(readJson(output)).toMatchObject({
          status: "reconcile",
          reconciliation: expect.arrayContaining([
            "completion handoff_id",
            "delivery grant_id",
            "delivery phase_id",
          ]),
        });

        const currentCompletion = writeJson(root, "current-completion.json", {
          schema: "tiara-review-completion/v1",
          status: "completed",
          run_id: "TIA-230",
          phase_id: "resync-600",
          grant_id: "grant-resync-600",
          handoff_id: "handoff-resync-600",
          base: "a".repeat(40),
          head: "b".repeat(40),
          capture_id: "capture-resync-600",
          source_identity_sha256: "c".repeat(64),
        });
        const currentDelivery = writeJson(root, "current-delivery.json", {
          schema: "tiara-native-delivery/v1",
          delivery: "started",
          run_id: "TIA-230",
          phase_id: "resync-600",
          grant_id: "grant-resync-600",
          handoff_id: "handoff-resync-600",
          base: "a".repeat(40),
          head: "b".repeat(40),
          capture_id: "capture-resync-600",
          source_identity_sha256: "c".repeat(64),
          target_id: "worker-1",
          native_delivery_id: "native-resync-600",
        });
        const currentInput = writeJson(root, "current-completion-check.json", {
          schema: "tiara-review-completion-check/v1",
          phase,
          completion: currentCompletion,
          delivery: currentDelivery,
        });
        const currentOutput = path.join(root, "current-completion-result.json");
        const currentResult = spawnSync(
          "pnpm",
          [
            "review:prep",
            "check-completion",
            "--input",
            path.join(root, currentInput.path),
            "--output",
            currentOutput,
          ],
          { cwd: repoRoot, encoding: "utf8" },
        );
        expect(currentResult.status).toBe(0);
        expect(readJson(currentOutput)).toMatchObject({ status: "complete", reconciliation: [] });
      }),
    30_000,
  );
});
