import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";

type Json = Record<string, unknown>;
type ArtifactInput = { label: string; path: string; sha256: string };
type Axis = "spec_conformance" | "correctness_reliability";
type CanonicalAxis = "spec" | "standards";
type Reviewer = { id: string; model: string; reasoning_effort: string };
type Scope = {
  paths: Array<string>;
  changed_paths: Array<string>;
  deleted_paths: Array<string>;
  required_coverage: Array<string>;
  included_coverage: Array<string>;
};
type PriorFindingPlan = {
  id: string;
  axis: Axis;
  raw_severity: string;
  assigned_reviewer: Reviewer;
  source_record: ArtifactInput;
  source_evidence: ArtifactInput;
};
type PriorCoveragePlan = {
  coverage_id: string;
  head: string;
  paths: Array<string>;
  coverage: Array<string>;
  identity: Json;
  record: ArtifactInput;
  impact: { status: string; evidence: ArtifactInput };
};
type AxisPlan = {
  reviewer: Reviewer;
  scope: Scope;
  delta: ArtifactInput;
  review_contract: ArtifactInput;
  configuration: ArtifactInput;
  source_files: Array<{ label: string; ref: ArtifactInput }>;
  rules: Array<{ ref: ArtifactInput; sections: Array<string> }>;
  requirements: Array<ArtifactInput>;
  specification_identity: Array<ArtifactInput>;
  generated_inputs: Array<ArtifactInput>;
  dependencies: Array<ArtifactInput>;
  prior_findings: Array<PriorFindingPlan>;
  prior_coverage: Array<PriorCoveragePlan>;
};

const INPUT_SCHEMA = "tiara-review-input/v1";
const PHASE_SCHEMA = "tiara-review-phase/v1";
const SOURCE_SCHEMA = "review-source-capture/v1";
const FINDING_SCHEMA = "tiara-review-finding/v1";
const COVERAGE_SCHEMA = "tiara-review-coverage/v1";
const AXIS: Record<CanonicalAxis, Axis> = {
  spec: "spec_conformance",
  standards: "correctness_reliability",
};

const InputHeader = Schema.Struct({ schema: Schema.Literal(INPUT_SCHEMA) });
const ReviewerConfigurationRecord = Schema.Struct({
  schema: Schema.Literal("tiara-reviewer-config/v1"),
  reviewer: Schema.Struct({
    id: Schema.String,
    model: Schema.String,
    reasoning_effort: Schema.String,
  }),
});
const PhaseRecord = Schema.Struct({
  schema: Schema.Literal(PHASE_SCHEMA),
  run_id: Schema.String,
  phase_id: Schema.String,
  grant_id: Schema.String,
  handoff_id: Schema.String,
  base: Schema.String,
  head: Schema.String,
  capture_id: Schema.String,
  source_identity_sha256: Schema.String,
  worker_thread_id: Schema.String,
});
const SourceCaptureRecord = Schema.Struct({
  schema: Schema.Literal(SOURCE_SCHEMA),
  run_id: Schema.String,
  base: Schema.String,
  head: Schema.String,
  capture_id: Schema.String,
  deltas: Schema.Record(Schema.String, Schema.Unknown),
});
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const stableJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const compactJson = (value: unknown) => JSON.stringify(value);
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
};

const strings = (value: unknown, label: string): Array<string> => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((item, index) => string(item, `${label}[${index}]`));
  const duplicates = result.filter((item, index) => result.indexOf(item) !== index);
  if (duplicates.length) throw new Error(`${label} contains duplicate values: ${duplicates.join(", ")}`);
  return result;
};

const record = (value: unknown, label: string): Json => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
};

const artifactInput = (value: unknown, label: string): ArtifactInput => {
  const artifact = record(value, label);
  const sha256 = string(artifact.sha256, `${label}.sha256`);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`${label}.sha256 must be lowercase SHA-256`);
  return {
    label: string(artifact.label, `${label}.label`),
    path: string(artifact.path, `${label}.path`),
    sha256,
  };
};

const same = (left: unknown, right: unknown) => compactJson(left) === compactJson(right);
const slug = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "artifact";

/**
 * Produces the shared helper's versioned plan from TiaraStack's canonical
 * phase, source, contract, finding, rule, coverage, and receipt records.
 * All input artifacts are verified and copied to content-addressed snapshots.
 */
export const produceReviewPlan = (args: { inputPath: string; outputDirectory: string }) =>
  // fallow-ignore-next-line complexity
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const inputPath = path.resolve(args.inputPath);
    const inputDirectory = path.dirname(inputPath);
    const inputBytes = yield* fs.readFile(inputPath);
    const inputText = new TextDecoder().decode(inputBytes);
    const decoded: unknown = JSON.parse(inputText);
    Schema.decodeUnknownSync(InputHeader)(decoded);
    const input = record(decoded, "input");
    const errors: Array<string> = [];
    const safe = <A>(where: string, action: () => A): A | undefined => {
      try {
        return action();
      } catch (error) {
        errors.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    };

    const phaseRef = safe("phase", () => artifactInput(input.phase, "phase"));
    const sourceRef = safe("source", () => artifactInput(input.source, "source"));
    const rulesInput = safe("rules", () => {
      if (!Array.isArray(input.rules)) throw new Error("rules must be an array");
      return input.rules
        .map((rule: unknown, index: number) => safe(`rules[${index}]`, () => record(rule, `rules[${index}]`)))
        .filter((rule): rule is Json => rule !== undefined);
    }) ?? [];
    const findingsInput = safe("findings", () => {
      if (!Array.isArray(input.findings)) throw new Error("findings must be an array");
      return input.findings;
    }) ?? [];
    const coverageInput = safe("coverage", () => {
      if (!Array.isArray(input.coverage)) throw new Error("coverage must be an array");
      return input.coverage;
    }) ?? [];
    for (const [index, rule] of rulesInput.entries()) {
      if (rule.schema !== "tiara-review-rule/v1") errors.push(`rules[${index}]: expected tiara-review-rule/v1`);
      if (rule.axis !== "spec" && rule.axis !== "standards") errors.push(`rules[${index}]: axis must be spec or standards`);
    }

    const readJsonRef = (ref: ArtifactInput | undefined, label: string) =>
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        if (!ref) return undefined;
        const absolute = path.resolve(inputDirectory, ref.path);
        const bytes = yield* fs.readFile(absolute).pipe(
          Effect.catch((error) => {
            errors.push(`${label}: cannot read ${ref.path}: ${String(error)}`);
            return Effect.succeed(undefined);
          }),
        );
        if (!bytes) return undefined;
        const actualHash = digest(bytes);
        if (actualHash !== ref.sha256) {
          errors.push(`${label}: SHA-256 mismatch for ${ref.path}, expected ${ref.sha256}, found ${actualHash}`);
          return undefined;
        }
        try {
          const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
          return value;
        } catch (error) {
          errors.push(`${label}: invalid JSON in ${ref.path}: ${String(error)}`);
          return undefined;
        }
      });

    const phaseValue = yield* readJsonRef(phaseRef, "phase record");
    const phase = phaseValue === undefined ? undefined : safe("phase", () => Schema.decodeUnknownSync(PhaseRecord)(phaseValue));
    const sourceCaptureValue = yield* readJsonRef(sourceRef, "source capture");
    const sourceCapture = sourceCaptureValue === undefined ? undefined : safe("source capture", () => Schema.decodeUnknownSync(SourceCaptureRecord)(sourceCaptureValue));

    const reviewersInput = safe("reviewers", () => record(input.reviewers, "reviewers"));
    const sourceFilesInput = safe("source.source_files", () => {
      if (!Array.isArray(input.source_files)) throw new Error("source_files must be an array");
      return input.source_files
        .map((item: unknown, index: number) => safe(`source_files[${index}]`, () => record(item, `source_files[${index}]`)))
        .filter((item): item is Json => item !== undefined);
    }) ?? [];

    const axisPlans: Partial<Record<Axis, AxisPlan>> = {};
    const refsToSnapshot: Array<{ ref: ArtifactInput; where: string }> = [];
    if (phaseRef) refsToSnapshot.push({ ref: phaseRef, where: "phase" });
    if (sourceRef) refsToSnapshot.push({ ref: sourceRef, where: "source capture" });

    for (const canonicalAxis of ["spec", "standards"] as const) {
      const axis = AXIS[canonicalAxis];
      const inputAxis = safe(`reviewers.${canonicalAxis}`, () => record(reviewersInput?.[canonicalAxis], `reviewers.${canonicalAxis}`));
      if (!inputAxis) continue;
      const delta = safe(`reviewers.${canonicalAxis}.delta`, () => artifactInput(inputAxis.delta, "delta"));
      const contract = safe(`reviewers.${canonicalAxis}.review_contract`, () => artifactInput(inputAxis.review_contract, "review_contract"));
      const configuration = safe(`reviewers.${canonicalAxis}.configuration`, () => artifactInput(inputAxis.configuration, "configuration"));
      const configurationRecord = yield* readJsonRef(configuration, `${canonicalAxis} reviewer configuration`);
      if ("reviewer" in inputAxis) {
        errors.push(`reviewers.${canonicalAxis}: reviewer identity must come from the referenced configuration record`);
      }
      const reviewer = safe(`reviewers.${canonicalAxis}.configuration`, () => {
        const value = Schema.decodeUnknownSync(ReviewerConfigurationRecord)(configurationRecord).reviewer;
        return {
          id: string(value.id, "configuration.reviewer.id"),
          model: string(value.model, "configuration.reviewer.model"),
          reasoning_effort: string(value.reasoning_effort, "configuration.reviewer.reasoning_effort"),
        };
      });
      // fallow-ignore-next-line complexity
      const scope = safe(`reviewers.${canonicalAxis}.scope`, () => {
        const value = record(inputAxis.scope, "scope");
        const paths = strings(value.paths, "scope.paths").sort();
        const changedPaths = strings(value.changed_paths, "scope.changed_paths").sort();
        const deletedPaths = strings(value.deleted_paths ?? [], "scope.deleted_paths").sort();
        const required = strings(value.required_coverage, "scope.required_coverage").sort();
        const included = strings(value.included_coverage, "scope.included_coverage").sort();
        if (!same(required, included)) errors.push(`reviewers.${canonicalAxis}.scope: coverage mismatch, missing [${required.filter((item) => !included.includes(item)).join(", ")}], extra [${included.filter((item) => !required.includes(item)).join(", ")}]`);
        if (!changedPaths.every((item) => paths.includes(item))) errors.push(`reviewers.${canonicalAxis}.scope: changed paths must be covered by paths`);
        if (!deletedPaths.every((item) => changedPaths.includes(item))) errors.push(`reviewers.${canonicalAxis}.scope: deleted paths must be changed paths`);
        return { paths, changed_paths: changedPaths, deleted_paths: deletedPaths, required_coverage: required, included_coverage: included };
      });

      if (delta) refsToSnapshot.push({ ref: delta, where: `${canonicalAxis} delta` });
      if (contract) refsToSnapshot.push({ ref: contract, where: `${canonicalAxis} contract` });
      if (configuration) refsToSnapshot.push({ ref: configuration, where: `${canonicalAxis} configuration` });

      // fallow-ignore-next-line complexity
      const sourceFiles = sourceFilesInput.filter((item) => {
        if (item.axes === undefined) return true;
        if (!Array.isArray(item.axes) || !item.axes.every((axis: unknown) => axis === "spec" || axis === "standards")) {
          errors.push("source_files: axes must contain only spec or standards");
          return false;
        }
        return item.axes.includes(canonicalAxis);
      // fallow-ignore-next-line complexity
      }).map((item, index) => {
        const ref = safe(`source_files[${index}]`, () => artifactInput(item.artifact, `source_files[${index}].artifact`));
        const filePath = safe(`source_files[${index}].path`, () => string(item.path, `source_files[${index}].path`));
        if (ref && filePath) refsToSnapshot.push({ ref, where: `source file ${filePath}` });
        return ref && filePath ? { label: filePath, ref } : undefined;
      }).filter((item): item is { label: string; ref: ArtifactInput } => item !== undefined);
      if (scope) {
        const expectedFiles = scope.paths.filter((item: string) => !scope.deleted_paths.includes(item)).sort();
        const actualFiles = sourceFiles.map((item) => item.label).sort();
        if (!same(expectedFiles, actualFiles)) errors.push(`source_files.${canonicalAxis}: expected [${expectedFiles.join(", ")}], found [${actualFiles.join(", ")}]`);
      }

      const getRefs = (field: string) => safe(`reviewers.${canonicalAxis}.${field}`, () => {
        const values = inputAxis[field] ?? [];
        if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
        return values.map((item, index) => artifactInput(item, `${field}[${index}]`));
      }) ?? [];
      const requirements = getRefs("requirements");
      const specificationIdentity = getRefs("specification_identity");
      const generatedInputs = getRefs("generated_inputs");
      const dependencies = getRefs("dependencies");
      for (const [name, values] of Object.entries({ requirements, specificationIdentity, generatedInputs, dependencies })) {
        for (const ref of values) refsToSnapshot.push({ ref, where: `${canonicalAxis} ${name}` });
      }
      const ruleEntries = rulesInput.filter((item) => item.axis === canonicalAxis).map((item, index) => {
        const ref = safe(`rules.${canonicalAxis}[${index}]`, () => artifactInput(item.artifact, "rule artifact"));
        if (ref) refsToSnapshot.push({ ref, where: `${canonicalAxis} rule` });
        const sections = safe(`rules.${canonicalAxis}[${index}].sections`, () => strings(item.sections ?? [], "rule.sections"));
        return ref ? { ref, sections: sections ?? [] } : undefined;
      }).filter((item): item is { ref: ArtifactInput; sections: Array<string> } => item !== undefined);
      if (canonicalAxis === "spec" && ruleEntries.length > 0) errors.push("rules: Spec input cannot include Standards rules");
      if (canonicalAxis === "standards" && requirements.length > 0) errors.push("reviewers.standards: requirements belong only to the Spec axis");
      if (canonicalAxis === "spec" && requirements.length === 0) errors.push("reviewers.spec: at least one raw requirement artifact is required");
      if (!scope || !delta || !reviewer || !contract || !configuration) continue;

      const findings: Array<PriorFindingPlan> = [];
      for (const [index, findingRefValue] of findingsInput.entries()) {
        const findingRef = safe(`findings[${index}]`, () => artifactInput(findingRefValue, `findings[${index}]`));
        if (!findingRef) continue;
        const findingValue = yield* readJsonRef(findingRef, `finding ${index}`);
        const finding = findingValue === undefined ? undefined : safe(`findings[${index}]`, () => record(findingValue, `findings[${index}]`));
        if (!finding) continue;
        if (finding.schema !== FINDING_SCHEMA) {
          errors.push(`findings[${index}]: expected ${FINDING_SCHEMA}`);
          continue;
        }
        if (finding.axis !== "spec" && finding.axis !== "standards") {
          errors.push(`findings[${index}]: unsupported own-axis identity ${String(finding.axis)}`);
          continue;
        }
        if (typeof finding.raw_severity !== "string" || finding.raw_severity.trim() === "") {
          errors.push(`findings[${index}]: raw_severity is required and must be preserved`);
          continue;
        }
        if (finding.axis !== canonicalAxis) continue;
        if (!["unresolved", "resolved", "accepted", "superseded"].includes(String(finding.status))) {
          errors.push(`finding ${String(finding.id)}: unsupported status ${String(finding.status)}`);
          continue;
        }
        if (finding.status !== "unresolved") continue;
        const findingId = safe(`finding ${index}.id`, () => string(finding.id, `findings[${index}].id`));
        if (!findingId) continue;
        const assignedReviewer = safe(`finding ${findingId}.assigned_reviewer`, () => record(finding.assigned_reviewer, "assigned_reviewer"));
        if (assignedReviewer && (assignedReviewer.id !== reviewer.id || assignedReviewer.model !== reviewer.model || assignedReviewer.reasoning_effort !== reviewer.reasoning_effort)) {
          errors.push(`finding ${findingId}: assigned reviewer/model/reasoning must match the configured ${canonicalAxis} reviewer`);
        }
        const evidence = safe(`finding ${findingId}.evidence`, () => artifactInput(finding.evidence, "finding evidence"));
        if (!evidence) continue;
        refsToSnapshot.push({ ref: evidence, where: `finding ${findingId} evidence` });
        refsToSnapshot.push({ ref: findingRef, where: `finding ${findingId} source record` });
        findings.push({
          id: findingId,
          axis,
          raw_severity: finding.raw_severity,
          assigned_reviewer: reviewer,
          source_record: findingRef,
          source_evidence: evidence,
        });
      }

      const coverage: Array<PriorCoveragePlan> = [];
      for (const [index, coverageRefValue] of coverageInput.entries()) {
        const coverageRef = safe(`coverage[${index}]`, () => artifactInput(coverageRefValue, `coverage[${index}]`));
        if (!coverageRef) continue;
        const rowValue = yield* readJsonRef(coverageRef, `coverage ${index}`);
        const row = rowValue === undefined ? undefined : safe(`coverage[${index}]`, () => record(rowValue, `coverage[${index}]`));
        if (!row) continue;
        if (row.schema !== COVERAGE_SCHEMA) {
          errors.push(`coverage[${index}]: expected ${COVERAGE_SCHEMA}`);
          continue;
        }
        if (row.axis !== "spec" && row.axis !== "standards") {
          errors.push(`coverage[${index}]: unsupported own-axis identity ${String(row.axis)}`);
          continue;
        }
        if (row.axis !== canonicalAxis) continue;
        const coverageId = safe(`coverage[${index}].coverage_id`, () => string(row.coverage_id, `coverage[${index}].coverage_id`));
        if (!coverageId) continue;
        const impact = safe(`coverage ${coverageId}.impact`, () => record(row.impact, "coverage.impact"));
        const canonicalRecord = safe(`coverage ${coverageId}.record`, () => artifactInput(row.record, "coverage record"));
        const impactEvidence = safe(`coverage ${coverageId}.impact.evidence`, () => artifactInput(impact?.evidence, "impact evidence"));
        if (!canonicalRecord || !impactEvidence) continue;
        const normalizedCoverage = safe(`coverage ${coverageId}`, () => {
          const impactStatus = string(impact?.status, "coverage.impact.status");
          if (!["unaffected", "affected", "uncertain"].includes(impactStatus)) {
            throw new Error("impact.status must be unaffected, affected, or uncertain");
          }
          return {
            coverage_id: coverageId,
            head: string(row.head, "coverage.head"),
            paths: strings(row.paths, "coverage.paths").sort(),
            coverage: strings(row.coverage, "coverage.coverage").sort(),
            identity: record(row.identity, "coverage.identity"),
            record: canonicalRecord,
            impact: { status: impactStatus, evidence: impactEvidence },
          };
        });
        if (!normalizedCoverage) continue;
        refsToSnapshot.push({ ref: canonicalRecord, where: `coverage ${coverageId}` });
        refsToSnapshot.push({ ref: impactEvidence, where: `coverage ${coverageId} impact` });
        coverage.push(normalizedCoverage);
      }

      axisPlans[axis] = {
        reviewer,
        scope,
        delta,
        review_contract: contract,
        configuration,
        source_files: sourceFiles,
        rules: ruleEntries,
        requirements,
        specification_identity: specificationIdentity,
        generated_inputs: generatedInputs,
        dependencies,
        prior_findings: findings,
        prior_coverage: coverage,
      };
    }

    if (!phase) errors.push("phase: unable to read canonical phase record");
    if (!sourceCapture) errors.push("source: unable to read source capture record");
    if (!phaseRef || !sourceRef) errors.push("input: phase and source artifact references are required");
    if (phase && sourceCapture) {
      for (const key of ["run_id", "base", "head", "capture_id"] as const) {
        if (phase[key] !== sourceCapture[key]) errors.push(`phase/source identity mismatch for ${key}`);
      }
      if (phase.source_identity_sha256 !== sourceRef?.sha256) {
        errors.push("phase/source identity mismatch for source_identity_sha256, expected the exact source capture hash");
      }
    }
    if (!axisPlans.spec_conformance || !axisPlans.correctness_reliability) errors.push("reviewers: both Spec and Standards contracts are required");

    if (sourceCapture) {
      for (const canonicalAxis of ["spec", "standards"] as const) {
        const axis = AXIS[canonicalAxis];
        const entry = axisPlans[axis];
        const deltaRef = entry?.delta;
        if (!entry || !deltaRef) continue;
        const deltaPath = path.resolve(inputDirectory, deltaRef.path);
        const deltaBytes = yield* fs.readFile(deltaPath).pipe(Effect.catch((error) => {
          errors.push(`${canonicalAxis} delta: cannot read ${deltaRef.path}: ${String(error)}`);
          return Effect.succeed(undefined);
        }));
        if (deltaBytes && digest(deltaBytes) !== deltaRef.sha256) errors.push(`${canonicalAxis} delta: SHA-256 mismatch`);
        const captureDeltaValue = sourceCapture.deltas[axis];
        const captureDelta = captureDeltaValue === undefined ? undefined : safe(`${canonicalAxis} capture delta`, () => record(captureDeltaValue, `${canonicalAxis} capture delta`));
        if (!captureDelta) errors.push(`source capture is missing the ${axis} delta identity`);
        else if (captureDelta.sha256 !== deltaRef.sha256) errors.push(`${canonicalAxis} delta hash differs from source capture`);
        else {
          const capturedPaths = safe(`${canonicalAxis} capture changed_paths`, () => strings(captureDelta.changed_paths, "capture changed_paths").sort());
          if (capturedPaths && !same(capturedPaths, entry.scope.changed_paths)) errors.push(`${canonicalAxis} changed paths differ from source capture`);
        }
      }
    }

    // Verify every referenced source before creating the output directory.
    // This keeps bad hashes and unreadable evidence out of partial publications.
    const preflightRefs = new Map<string, { ref: ArtifactInput; where: string }>();
    for (const item of refsToSnapshot) {
      preflightRefs.set(`${item.ref.path}\0${item.ref.sha256}\0${item.ref.label}`, item);
    }
    for (const { ref, where } of preflightRefs.values()) {
      const bytes = yield* fs.readFile(path.resolve(inputDirectory, ref.path)).pipe(Effect.catch((error) => {
        errors.push(`${where}: cannot read ${ref.path}: ${String(error)}`);
        return Effect.succeed(undefined);
      }));
      if (bytes) {
        if (digest(bytes) !== ref.sha256) errors.push(`${where}: SHA-256 mismatch for ${ref.path}`);
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          errors.push(`${where}: ${ref.path} is not readable UTF-8 text`);
        }
      }
    }

    if (errors.length > 0) throw new Error(`Review input preflight found ${errors.length} issue(s):\n${errors.map((item) => `- ${item}`).join("\n")}`);
    if (!phase || !sourceRef) throw new Error("Review input preflight could not resolve its phase and source records");

    const outputDirectory = path.resolve(args.outputDirectory);
    if (yield* fs.exists(outputDirectory)) throw new Error(`Output directory already exists: ${outputDirectory}`);
    yield* fs.makeDirectory(outputDirectory, { recursive: false });
    const artifactDirectory = path.join(outputDirectory, "artifacts");
    yield* fs.makeDirectory(artifactDirectory);
    const artifactStats = new Map<string, number>();

    const snapshot = (inputRef: ArtifactInput, where: string) =>
      Effect.gen(function* () {
        const inputAbsolute = path.resolve(inputDirectory, inputRef.path);
        const bytes = yield* fs.readFile(inputAbsolute);
        const found = digest(bytes);
        if (found !== inputRef.sha256) throw new Error(`${where}: SHA-256 mismatch for ${inputRef.path}, expected ${inputRef.sha256}, found ${found}`);
        const relative = `artifacts/${found}-${slug(inputRef.label)}`;
        const target = path.join(outputDirectory, relative);
        if (yield* fs.exists(target)) {
          const existing = yield* fs.readFile(target);
          if (digest(existing) !== found) throw new Error(`Immutable artifact path collision at ${target}`);
        } else {
          yield* fs.writeFile(target, bytes, { flag: "wx" });
        }
        artifactStats.set(relative, bytes.byteLength);
        return { label: inputRef.label, path: relative, sha256: found };
      });

    const imported = new Map<string, ArtifactInput>();
    for (const item of refsToSnapshot) {
      const key = `${item.ref.path}\0${item.ref.sha256}\0${item.ref.label}`;
      if (imported.has(key)) continue;
      imported.set(key, yield* snapshot(item.ref, item.where));
    }
    const toPlanRef = (ref: ArtifactInput): ArtifactInput => {
      const key = `${ref.path}\0${ref.sha256}\0${ref.label}`;
      const result = imported.get(key);
      if (!result) throw new Error(`Internal error: artifact was not snapshotted: ${ref.label}`);
      return result;
    };

    const buildFindingEvidence = (finding: PriorFindingPlan) =>
      Effect.gen(function* () {
        const sourceRecord = toPlanRef(finding.source_record);
        const sourceEvidence = toPlanRef(finding.source_evidence);
        const recordBytes = yield* fs.readFile(path.join(outputDirectory, sourceRecord.path));
        const evidenceBytes = yield* fs.readFile(path.join(outputDirectory, sourceEvidence.path));
        const recordText = new TextDecoder("utf-8", { fatal: true }).decode(recordBytes);
        const evidenceText = new TextDecoder("utf-8", { fatal: true }).decode(evidenceBytes);
        const content = [
          `Finding ${finding.id}`,
          `Axis: ${finding.axis}`,
          `Status: unresolved`,
          `Raw severity: ${finding.raw_severity}`,
          `Reviewer: ${finding.assigned_reviewer.id} (${finding.assigned_reviewer.model}, ${finding.assigned_reviewer.reasoning_effort})`,
          "",
          "## Canonical finding record",
          "",
          "```json",
          recordText.trimEnd(),
          "```",
          "",
          "## Full finding-specific evidence",
          "",
          evidenceText.trimEnd(),
          "",
        ].join("\n");
        const bytes = new TextEncoder().encode(content);
        const sha256 = digest(bytes);
        const label = `${finding.id} finding evidence`;
        const relative = `artifacts/${sha256}-${slug(label)}`;
        yield* fs.writeFile(path.join(outputDirectory, relative), bytes, { flag: "wx" });
        artifactStats.set(relative, bytes.byteLength);
        return { label, path: relative, sha256 };
      });

    const reviewers: Record<string, unknown> = {};
    for (const axis of ["spec_conformance", "correctness_reliability"] as const) {
      const axisPlan = axisPlans[axis];
      if (!axisPlan) continue;
      const priorFindings = [];
      for (const finding of axisPlan.prior_findings) {
        priorFindings.push({
          id: finding.id,
          axis,
          status: "unresolved",
          assigned_reviewer: axisPlan.reviewer,
          evidence: yield* buildFindingEvidence(finding),
        });
      }
      reviewers[axis] = {
        reviewer: axisPlan.reviewer,
        scope: axisPlan.scope,
        delta: toPlanRef(axisPlan.delta),
        review_contract: toPlanRef(axisPlan.review_contract),
        configuration: toPlanRef(axisPlan.configuration),
        source_files: axisPlan.source_files.map((row) => ({ ...toPlanRef(row.ref), label: row.label })),
        rules: axisPlan.rules.map((row) => ({ ...toPlanRef(row.ref), ...(row.sections.length ? { sections: row.sections } : {}) })),
        requirements: axisPlan.requirements.map(toPlanRef),
        specification_identity: axisPlan.specification_identity.map(toPlanRef),
        generated_inputs: axisPlan.generated_inputs.map(toPlanRef),
        dependencies: axisPlan.dependencies.map(toPlanRef),
        prior_findings: priorFindings,
        prior_coverage: axisPlan.prior_coverage.map((row) => ({
          coverage_id: row.coverage_id,
          head: row.head,
          paths: row.paths,
          coverage: row.coverage,
          identity: row.identity,
          record: toPlanRef(row.record),
          impact: { status: row.impact.status, evidence: toPlanRef(row.impact.evidence) },
        })),
      };
    }
    const plan = {
      schema: "review-plan/v1",
      run_id: phase.run_id,
      source: {
        base: phase.base,
        head: phase.head,
        capture_id: phase.capture_id,
        capture_receipt: toPlanRef(sourceRef!),
      },
      reviewers,
    };
    const planBytes = new TextEncoder().encode(stableJson(plan));
    const planHash = digest(planBytes);
    const planPath = path.join(outputDirectory, `review-plan-${planHash}.json`);
    yield* fs.writeFile(planPath, planBytes, { flag: "wx" });
    const artifactBytes = [...artifactStats.values()].reduce((sum, bytes) => sum + bytes, 0);
    const largest = [...artifactStats.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8);
    return {
      planPath,
      planSha256: planHash,
      planBytes: planBytes.byteLength,
      artifacts: artifactStats.size,
      artifactBytes,
      largestArtifacts: largest,
    };
  }).pipe(
    Effect.catchDefect((defect) => Effect.fail(defect instanceof Error ? defect : new Error(String(defect)))),
  );

/** Checks completion and native delivery against the current phase grant. */
export const checkCurrentPhaseCompletion = (args: { inputPath: string; outputPath: string }) =>
  // fallow-ignore-next-line complexity
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.dirname(path.resolve(args.inputPath));
    const read = (ref: unknown, label: string) =>
      Effect.gen(function* () {
        const item = artifactInput(ref, label);
        const bytes = yield* fs.readFile(path.resolve(root, item.path));
        const found = digest(bytes);
        if (found !== item.sha256) throw new Error(`${label}: SHA-256 mismatch, expected ${item.sha256}, found ${found}`);
        return { value: JSON.parse(new TextDecoder().decode(bytes)), sha256: found };
      });
    const input = record(JSON.parse(yield* fs.readFileString(path.resolve(args.inputPath))), "completion check");
    if (input.schema !== "tiara-review-completion-check/v1") throw new Error("Expected tiara-review-completion-check/v1");
    const [phaseRef, completionRef, deliveryRef] = yield* Effect.all([
      read(input.phase, "phase"), read(input.completion, "completion"), read(input.delivery, "native delivery"),
    ], { concurrency: 3 });
    const phase = isRecord(phaseRef.value) ? phaseRef.value : {};
    const completion = isRecord(completionRef.value) ? completionRef.value : {};
    const delivery = isRecord(deliveryRef.value) ? deliveryRef.value : {};
    const keys = ["run_id", "phase_id", "grant_id", "handoff_id", "base", "head", "capture_id", "source_identity_sha256"] as const;
    // fallow-ignore-next-line complexity
    const expectedValue = (key: (typeof keys)[number]): string | null => {
      const value = phase[key];
      if (typeof value !== "string" || value.trim() === "") return null;
      if ((key === "base" || key === "head") && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) return null;
      if (key === "source_identity_sha256" && !/^[a-f0-9]{64}$/u.test(value)) return null;
      return value;
    };
    const expected = {
      run_id: expectedValue("run_id"),
      phase_id: expectedValue("phase_id"),
      grant_id: expectedValue("grant_id"),
      handoff_id: expectedValue("handoff_id"),
      base: expectedValue("base"),
      head: expectedValue("head"),
      capture_id: expectedValue("capture_id"),
      source_identity_sha256: expectedValue("source_identity_sha256"),
    };
    const expectedWorker = typeof phase.worker_thread_id === "string" && phase.worker_thread_id.trim() !== ""
      ? phase.worker_thread_id
      : null;
    const checks = [
      ["phase schema", phase.schema === PHASE_SCHEMA],
      ["completion schema", completion.schema === "tiara-review-completion/v1"],
      ["completion status", completion.status === "completed"],
      ...keys.flatMap((key) => [
        [`phase ${key}`, expected[key] !== null] as [string, boolean],
        [`completion ${key}`, expected[key] !== null && completion[key] === expected[key]] as [string, boolean],
      ]),
      ["delivery schema", delivery.schema === "tiara-native-delivery/v1"],
      ["delivery status", ["started", "queued", "steered"].includes(String(delivery.delivery))],
      ...keys.map((key) => [`delivery ${key}`, expected[key] !== null && delivery[key] === expected[key]] as [string, boolean]),
      ["phase worker_thread_id", expectedWorker !== null],
      ["delivery target", expectedWorker !== null && delivery.target_id === expectedWorker],
      ["native delivery identity", typeof delivery.native_delivery_id === "string" && delivery.native_delivery_id.length > 0],
    ] as Array<[string, boolean]>;
    const reconciliation = checks.filter(([, passed]) => !passed).map(([name]) => name);
    const result = {
      schema: "tiara-review-phase-completion-check/v1",
      status: reconciliation.length === 0 ? "complete" : "reconcile",
      expected: { ...expected, worker_thread_id: expectedWorker },
      completion_sha256: completionRef.sha256,
      delivery_sha256: deliveryRef.sha256,
      checks: checks.map(([id, passed]) => ({ id, passed })),
      reconciliation,
      updates_coordinator_state: false,
      sends_native_messages: false,
    };
    const outputPath = path.resolve(args.outputPath);
    yield* fs.writeFile(outputPath, new TextEncoder().encode(stableJson(result)), { flag: "wx" });
    return { outputPath, result };
  }).pipe(
    Effect.catchDefect((defect) => Effect.fail(defect instanceof Error ? defect : new Error(String(defect)))),
  );
