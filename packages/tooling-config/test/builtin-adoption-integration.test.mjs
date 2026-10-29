import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parseAst } from "vite/rolldown/parseAst";
import { diagnostics, runCommand, runPnpm } from "./lint-fixture-helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const reactStartPackagePath = realpathSync(
  path.join(root, "packages/sheet-web/node_modules/@tanstack/react-start"),
);
const startPluginCorePath = path.join(
  path.resolve(reactStartPackagePath, "../.."),
  "@tanstack/start-plugin-core",
);
const tempDirectory = mkdtempSync(path.join(os.tmpdir(), "tiara-oxlint-builtins-"));
const sourceDirectory = path.join(root, "packages/developer-launcher/src");
const suffix = String(process.pid);
const inheritedName = `tia230-builtin-inherited-${suffix}.ts`;
const newName = `tia230-builtin-new-${suffix}.ts`;
const stagedName = `tia230-builtin-staged-${suffix}.ts`;
const inheritedPath = path.join(sourceDirectory, inheritedName);
const newPath = path.join(sourceDirectory, newName);
const stagedPath = path.join(sourceDirectory, stagedName);
const inheritedRelative = `packages/developer-launcher/src/${inheritedName}`;
const newRelative = `packages/developer-launcher/src/${newName}`;
const stagedRelative = `packages/developer-launcher/src/${stagedName}`;
const generatedRouteTree = "packages/sheet-web/src/routeTree.gen.ts";
const baseRouteTreeFixtureName = `tia230-routeTree-base-${suffix}.ts`;
const baseRouteTreeFixturePath = path.join(
  root,
  "packages/sheet-web/src",
  baseRouteTreeFixtureName,
);
const baseRouteTreeFixtureRelative = `packages/sheet-web/src/${baseRouteTreeFixtureName}`;
const stagedRouteName = `tia230-routeTree-staged-${suffix}.ts`;
const stagedRoutePath = path.join(root, "packages/sheet-web/src", stagedRouteName);
const stagedRouteRelative = `packages/sheet-web/src/${stagedRouteName}`;
const baselinePath = path.join(tempDirectory, "baseline.json");
const baselineMigrationFixturePaths = [];
const ignoredAstKeys = new Set(["parent", "range", "start", "end", "loc", "tokens", "comments"]);
const normalizeExecutableAst = (value) => {
  if (Array.isArray(value)) return value.map(normalizeExecutableAst);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !ignoredAstKeys.has(key))
      .sort()
      .map((key) => [key, normalizeExecutableAst(value[key])]),
  );
};
const executableAstFingerprint = (source) =>
  createHash("sha256")
    .update(JSON.stringify(normalizeExecutableAst(parseAst(source, { lang: "ts" }))))
    .digest("hex");

const run = (args, env = {}, timeoutMs = 25_000) => runPnpm(args, { cwd: root, env, timeoutMs });
const compareStrings = (left, right) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const pairedSite = (rule, expression) =>
  (() => {
    const assertion = expression.lastIndexOf(" as ");
    if (assertion < 0) throw new Error("paired assertion fixture must include an as clause");
    return `${expression.slice(0, assertion)} /* oxlint-disable ${rule} -- inherited master site */${expression.slice(assertion)} /* oxlint-enable ${rule} -- inherited master site */`;
  })();
const pairedTemplate = (rule, expression) =>
  "`" + "${" + pairedInterpolation(rule, expression) + "}" + "`";
const pairedInterpolation = (rule, expression) =>
  `/* oxlint-disable ${rule} -- inherited master site */${expression}/* oxlint-enable ${rule} -- inherited master site */`;
const siblingTemplateSource = (firstType, secondType, directiveIndex) => {
  const firstExpression =
    directiveIndex === 0
      ? pairedInterpolation("typescript/restrict-template-expressions", "inheritedMaybe")
      : "inheritedMaybe";
  const secondExpression =
    directiveIndex === 1
      ? pairedInterpolation("typescript/restrict-template-expressions", "addedMaybe")
      : "addedMaybe";
  const template =
    "const siblingTemplate = `" + "${" + firstExpression + "}${" + secondExpression + "}`;";
  return [
    "export {};",
    `declare const inheritedMaybe: ${firstType};`,
    `declare const addedMaybe: ${secondType};`,
    template,
    "void siblingTemplate;",
    "",
  ].join("\n");
};
describe("lint diagnostic output", () => {
  it("collects every JSON report and retains wrapper output between reports", () => {
    const stdout = [
      JSON.stringify({ diagnostics: [{ code: "first", message: 'brace } and "quote"' }] }, null, 2),
      "undefined",
      JSON.stringify({ diagnostics: [{ code: "second" }] }),
      "package-manager footer",
    ].join("\n");
    const result = { stdout };

    expect(diagnostics(result).map(({ code }) => code)).toEqual(["first", "second"]);
    expect(result.jsonDocuments).toHaveLength(2);
    expect(result.unstructuredStdout).toBe("\nundefined\n\npackage-manager footer");
  });

  it("fails clearly when lint output has no JSON document", () => {
    expect(() => diagnostics({ stdout: "pnpm lint failed without a JSON report" })).toThrow(
      /Expected JSON lint diagnostics/,
    );
  });

  it("bounds synchronous fixture children and reports timeout, spawn, and signal errors", () => {
    expect(() =>
      runCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
        cwd: root,
        timeoutMs: 250,
      }),
    ).toThrow(/timed out after 250 ms/);

    expect(() =>
      runCommand(path.join(tempDirectory, "missing-command"), [], { cwd: root }),
    ).toThrow(/Could not start fixture subprocess/);

    expect(() =>
      runCommand(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], {
        cwd: root,
      }),
    ).toThrow(/terminated by SIGTERM/);

    const failed = runCommand(
      process.execPath,
      ["-e", "process.stdout.write('stdout'); process.stderr.write('stderr'); process.exit(7)"],
      { cwd: root },
    );
    expect(failed.status).toBe(7);
    expect(failed.stdout).toBe("stdout");
    expect(failed.stderr).toBe("stderr");
  });
});

describe("pinned TanStack Start patch artifacts", () => {
  it("keeps the caller-plugin runtime source map aligned with its shipped source", () => {
    const runtimePath = path.join(startPluginCorePath, "dist/esm/start-router-plugin/plugin.js");
    const sourcePath = path.join(startPluginCorePath, "src/start-router-plugin/plugin.ts");
    const mapPath = `${runtimePath}.map`;
    const runtime = readFileSync(runtimePath, "utf8");
    const source = readFileSync(sourcePath, "utf8");
    const map = JSON.parse(readFileSync(mapPath, "utf8"));

    expect(runtime).toContain("plugins.push(...(routerConfig.plugins ?? []));");
    expect(source).toContain("plugins.push(...(routerConfig.plugins ?? []))");
    expect(map.sourcesContent).toEqual([source]);
  });
});

const inheritedLines = [
  "export {};",
  "declare const inheritedUnknown: unknown;",
  "declare const inheritedMaybe: string | undefined;",
  `const inheritedAssertion = ${pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as string")};`,
  `const inheritedInterpolation = ${pairedTemplate("typescript/restrict-template-expressions", "inheritedMaybe")};`,
  'const safeWidening = "literal" as string;',
  "void [inheritedAssertion, inheritedInterpolation, safeWidening];",
];
const inheritedSource = () => `${inheritedLines.join("\n")}\n`;
const installFixtureBaseline = (fixturePaths = [inheritedRelative], expectedSites = 2) => {
  const baseline = JSON.parse(
    readFileSync(
      path.join(root, "packages/tooling-config/src/oxlint-plugins/no-nested-ternary-baseline.json"),
      "utf8",
    ),
  );
  writeFileSync(baselinePath, `${JSON.stringify(baseline)}\n`);
  for (const fixturePath of fixturePaths) {
    const generated = run(["exec", "vp", "lint", "-f", "json", fixturePath], {
      TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath,
      TIARA_BUILTIN_BASELINE_MODE: "1",
    });
    const generatedDiagnostics = diagnostics(generated).filter(
      ({ code }) => code === "tiara-effect-policy(builtin-site-adoption)",
    );
    const malformedGeneration = generatedDiagnostics.filter(
      ({ message }) => !message.startsWith("builtinbaseline:"),
    );
    if (malformedGeneration.length > 0)
      throw new Error(JSON.stringify({ fixturePath, diagnostics: generatedDiagnostics }));
    const sites = generatedDiagnostics
      .map(({ message }) => JSON.parse(message.slice("builtinbaseline:".length)))
      .map(({ rule, site, source }) => ({
        rule,
        site,
        source,
      }));
    if (sites.length !== expectedSites)
      throw new Error(
        `Expected ${expectedSites} baseline-mode sites for ${fixturePath}; received ${sites.length}`,
      );
    baseline.$builtins[fixturePath] = sites;
  }
  writeFileSync(baselinePath, `${JSON.stringify(baseline)}\n`);
};

afterAll(() => rmSync(tempDirectory, { recursive: true, force: true }));
afterEach(() => {
  for (const file of [
    inheritedPath,
    newPath,
    stagedPath,
    stagedRoutePath,
    baseRouteTreeFixturePath,
    ...baselineMigrationFixturePaths,
  ])
    rmSync(file, { force: true });
  baselineMigrationFixturePaths.length = 0;
});

const readTemplateStartingSource = (sourcePath) =>
  sourcePath === undefined ? undefined : JSON.parse(readFileSync(sourcePath, "utf8"));

const templateStartingIdentities = (source) =>
  new Map((source?.trackedPaths ?? []).map((entry) => [entry.path, entry]));

const templateRuleFiles = (manifest) =>
  Object.entries(manifest.$builtins)
    .map(([filename, entries]) => ({
      filename,
      entries: entries.flatMap((entry, manifestEntryIndex) => {
        if (entry.rule === "typescript/restrict-template-expressions")
          return [{ entry, manifestEntryIndex }];
        return [];
      }),
    }))
    .filter(({ entries }) => entries.length > 0);

const readTemplateBaselineInputs = () => {
  const base = "416a69d554f4fab5926c768b1d3537e94ab9adca";
  const currentManifestPath = path.join(
    root,
    "packages/tooling-config/src/oxlint-plugins/no-nested-ternary-baseline.json",
  );
  const manifestPath = process.env.TIA230_STARTING_BASELINE_PATH ?? currentManifestPath;
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const startingSourcePath = process.env.TIA230_STARTING_SOURCE_PATH;
  const startingSource = readTemplateStartingSource(startingSourcePath);
  return {
    base,
    manifestBytes,
    manifest,
    manifestPath,
    startingSourcePath,
    startingSource,
    startingIdentities: templateStartingIdentities(startingSource),
    files: templateRuleFiles(manifest),
  };
};

const assertTemplateSourceIdentity = (filename, sourceBytes, startingIdentity) => {
  if (startingIdentity === undefined) return;
  expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(startingIdentity.sha256);
  expect(sourceBytes.byteLength).toBe(startingIdentity.bytes);
};

const templateGitBlob = (sourceBytes) =>
  createHash("sha1").update(`blob ${sourceBytes.byteLength}\0`).update(sourceBytes).digest("hex");

const templateSourceMetadata = (sourceBytes, startingIdentity) => ({
  currentHeadBlob: startingIdentity?.blob ?? templateGitBlob(sourceBytes),
  currentHeadContentSha256: createHash("sha256").update(sourceBytes).digest("hex"),
  currentHeadBytes: sourceBytes.byteLength,
});

const createTemplateBaselineFixture = (filename, fileIndex, startingIdentities) => {
  const currentSource = readFileSync(path.join(root, filename), "utf8");
  const extension = path.extname(filename);
  const name = `tia230-template-base-${suffix}-${fileIndex}${extension}`;
  const absolutePath = path.join(root, path.dirname(filename), name);
  const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
  writeFileSync(absolutePath, currentSource);
  baselineMigrationFixturePaths.push(absolutePath);
  const sourceBytes = Buffer.from(currentSource, "utf8");
  const startingIdentity = startingIdentities.get(filename);
  assertTemplateSourceIdentity(filename, sourceBytes, startingIdentity);
  return {
    filename,
    currentSource,
    relativePath,
    sourceMetadata: templateSourceMetadata(sourceBytes, startingIdentity),
  };
};

const createTemplateBaselineFixtures = (files, startingIdentities) => {
  const fixtureToSource = new Map();
  const sourceMetadata = new Map();
  const filesToLint = [];
  for (const [fileIndex, { filename }] of files.entries()) {
    const fixture = createTemplateBaselineFixture(filename, fileIndex, startingIdentities);
    fixtureToSource.set(fixture.relativePath, filename);
    sourceMetadata.set(filename, fixture.sourceMetadata);
    filesToLint.push(fixture.relativePath);
  }
  return { fixtureToSource, sourceMetadata, filesToLint };
};

const isTemplateBaselineDiagnostic = ({ code, message }) =>
  code === "tiara-effect-policy(builtin-site-adoption)" && message.startsWith("builtinbaseline:");

const parseTemplateBaselineRecords = (generatedResult, fixtureToSource) => {
  const generatedDiagnostics = diagnostics(generatedResult).filter(
    ({ code }) => code === "tiara-effect-policy(builtin-site-adoption)",
  );
  const malformedGeneration = generatedDiagnostics.filter(
    ({ message }) => !message.startsWith("builtinbaseline:"),
  );
  if (malformedGeneration.length > 0)
    throw new Error(JSON.stringify({ diagnostics: generatedDiagnostics }));
  return generatedDiagnostics
    .filter(isTemplateBaselineDiagnostic)
    .map(({ message }) => JSON.parse(message.slice("builtinbaseline:".length)))
    .filter(({ rule }) => rule === "typescript/restrict-template-expressions")
    .map((record) => ({ ...record, originalPath: fixtureToSource.get(record.file) }));
};

const expectedTemplateEntries = (files) =>
  files.flatMap(({ filename, entries }) =>
    entries.map(({ entry, manifestEntryIndex }) => ({
      filename,
      entry,
      entryIndex: manifestEntryIndex,
    })),
  );

const oldTemplateOccurrenceGroups = (entries) => {
  const groups = new Map();
  entries.forEach(({ entry, manifestEntryIndex }) => {
    const key = entry.site;
    groups.set(key, [...(groups.get(key) ?? []), { entry, entryIndex: manifestEntryIndex }]);
  });
  return groups;
};

const generatedTemplateOccurrenceGroups = (records, newMode) => {
  const groups = new Map();
  records.forEach((record) => {
    const storedIdentity = newMode ? record.site : record.previousTemplateSite;
    groups.set(storedIdentity, [...(groups.get(storedIdentity) ?? []), record]);
  });
  return groups;
};

const hasTwoElementOccurrenceRange = (range) => Array.isArray(range) && range.length === 2;

const isValidTemplateOccurrence = ({ occurrenceRange, site, expression }) =>
  hasTwoElementOccurrenceRange(occurrenceRange) &&
  typeof site === "string" &&
  typeof expression === "string";

const templateMappingsForGroup = (filename, key, oldOccurrences, newGroups, sourceMetadata) => {
  const newOccurrences = (newGroups.get(key) ?? [])
    .slice()
    .sort((left, right) => left.occurrenceRange[0] - right.occurrenceRange[0]);
  expect(newOccurrences).toHaveLength(oldOccurrences.length);
  expect(newOccurrences.every(isValidTemplateOccurrence)).toBe(true);
  expect(new Set(newOccurrences.map(({ site }) => site)).size).toBe(newOccurrences.length);
  return oldOccurrences.map(({ entry, entryIndex }, occurrenceIndex) => {
    const generated = newOccurrences[occurrenceIndex];
    return {
      path: filename,
      rule: entry.rule,
      manifestEntryIndex: entryIndex,
      manifestSite: entry.site,
      previousTemplateSite: generated.previousTemplateSite,
      interpolationSite: generated.site,
      manifestSource: entry.source,
      currentSource: generated.source,
      sourceLine: generated.line,
      expression: generated.expression,
      occurrenceRangeInCurrentHeadBlob: generated.occurrenceRange,
      ...sourceMetadata.get(filename),
    };
  });
};

const templateMappingsForFile = (filename, entries, records, sourceMetadata, newMode) => {
  const generatedForFile = records.filter(({ originalPath }) => originalPath === filename);
  const oldGroups = oldTemplateOccurrenceGroups(entries);
  const newGroups = generatedTemplateOccurrenceGroups(generatedForFile, newMode);
  expect([...newGroups.keys()].sort(compareStrings)).toEqual(
    [...oldGroups.keys()].sort(compareStrings),
  );
  const mappings = [];
  for (const [key, oldOccurrences] of oldGroups)
    mappings.push(
      ...templateMappingsForGroup(filename, key, oldOccurrences, newGroups, sourceMetadata),
    );
  return mappings;
};

const mapTemplateOccurrences = (files, records, sourceMetadata, newMode) =>
  files.flatMap(({ filename, entries }) =>
    templateMappingsForFile(filename, entries, records, sourceMetadata, newMode),
  );

const assertTemplateMappingIdentity = (mapping, newMode) => {
  expect(mapping).toHaveLength(51);
  for (const item of mapping) {
    const expectedSite = newMode ? item.interpolationSite : item.previousTemplateSite;
    expect(item.manifestSite).toBe(expectedSite);
    if (!newMode) expect(item.manifestSite).not.toBe(item.interpolationSite);
  }
};

const templateStartingSourceEvidence = (sourcePath) => {
  if (sourcePath === undefined) return {};
  return {
    startingSourcePath: sourcePath,
    startingSourceSha256: createHash("sha256").update(readFileSync(sourcePath)).digest("hex"),
  };
};

const writeTemplateBaselineMigrationProof = (inputs, currentOccurrences, mapping, newMode) => {
  const captureDirectory = process.env.TIA230_SOURCE_CAPTURE_DIR;
  if (captureDirectory === undefined || newMode) return;
  const proof = {
    schemaVersion: 1,
    status: "PRESERVED_ONE_TO_ONE_BIJECTION_PROVED",
    purpose: "template-baseline identity-only migration; no allowance growth or re-enrollment",
    base: inputs.base,
    startingHead: "8ed51f1e30a2f66043fd4f1f38a3c59e6138b7b9",
    startingTree: "9a803f80cc52f3e35dbaecdd11841d3e257b34cc",
    capturedAt: new Date().toISOString(),
    originalManifestPath: inputs.manifestPath,
    originalManifestSha256: createHash("sha256").update(inputs.manifestBytes).digest("hex"),
    originalManifestCopyPath: process.env.TIA230_STARTING_BASELINE_PATH,
    ...templateStartingSourceEvidence(inputs.startingSourcePath),
    originalManifestEntriesPreserved: 51,
    currentHeadOccurrencesBound: currentOccurrences,
    baseProvenance: {
      masterSourceExpressionAudit: inputs.manifest.$provenance.masterSourceExpressionAudit,
      identityMigrationCurrent: inputs.manifest.$provenance.identityMigrationCurrent,
      inheritedNativeChildCorrections: inputs.manifest.$provenance.inheritedNativeChildCorrections,
    },
    removedAllowances: 0,
    newAllowances: 0,
    semanticAllowanceGrowth: false,
    retainedBaseOccurrenceBijection: true,
    manifestWriteGuardPassed: true,
    expectedMode: "old_template_identity_to_new_interpolation_identity",
    mappings: mapping,
  };
  const outputPath = path.join(captureDirectory, "baseline-migration-proof-v2.json");
  writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
};

const routeDirectiveSpans = (routeProof) => {
  const spans = routeProof.mappings.flatMap(({ directives }) =>
    ["disable", "enable"].map((kind) => ({
      kind,
      start: directives[kind].start,
      end: directives[kind].end,
      removalStart: directives[kind].removalStart,
      removalText: directives[kind].removalText,
    })),
  );
  return spans.sort((left, right) => left.start - right.start);
};

const assertRouteProofEnvelope = (routeProof, routeBytes) => {
  expect(routeProof.status).toBe("PORTABLE_ROUTE_BASE_BIJECTION");
  expect(routeProof.base.path).toBe(generatedRouteTree);
  expect(routeProof.decoratedRoute.path).toBe(generatedRouteTree);
  expect(routeProof.decoratedRoute.contentSha256).toBe(
    createHash("sha256").update(routeBytes).digest("hex"),
  );
  expect(routeProof.executableAstEquality.baseFingerprintSha256).toBe(
    routeProof.executableAstEquality.decoratedFingerprintSha256,
  );
  expect(routeProof.mappings).toHaveLength(28);
  expect(routeProof.mappings.map(({ ordinal }) => ordinal)).toEqual(
    Array.from({ length: 28 }, (_, index) => index + 1),
  );
};

const assertRouteDirectiveLayout = (routeBytes, routeProof, spans) => {
  expect(spans.map(({ kind }) => kind)).toEqual(
    Array.from({ length: 28 }, () => ["disable", "enable"]).flat(),
  );
  for (let index = 1; index < spans.length; index += 1)
    expect(spans[index - 1].end).toBeLessThanOrEqual(spans[index].start);
  for (const { kind, start, end, removalStart, removalText } of spans) {
    expect(removalStart).toBe(start - 1);
    expect(routeBytes.subarray(removalStart, end).toString("utf8")).toBe(removalText);
    expect(removalText).toBe(` /* oxlint-${kind} ${routeProof.rule} -- inherited master site */`);
  }
};

const createAndAssertBaseRouteFixture = (currentSource, routeProof) => {
  const baseRouteBytes = Buffer.from(routeProof.baseReconstruction.baseContentBase64, "base64");
  expect(baseRouteBytes.byteLength).toBe(routeProof.base.bytes);
  expect(createHash("sha256").update(baseRouteBytes).digest("hex")).toBe(
    routeProof.base.contentSha256,
  );
  const gitBlobHeader = Buffer.from(`blob ${baseRouteBytes.byteLength}\0`, "utf8");
  expect(
    createHash("sha1")
      .update(Buffer.concat([gitBlobHeader, baseRouteBytes]))
      .digest("hex"),
  ).toBe(routeProof.base.blob);
  const baseRouteSource = baseRouteBytes.toString("utf8");
  expect(executableAstFingerprint(currentSource)).toBe(executableAstFingerprint(baseRouteSource));
  writeFileSync(baseRouteTreeFixturePath, baseRouteSource);
  baselineMigrationFixturePaths.push(baseRouteTreeFixturePath);
  return baseRouteSource;
};

const unsafeAssertionSites = (items, source) =>
  items
    .filter(({ code }) => code === "typescript(no-unsafe-type-assertion)")
    .map((diagnostic) => {
      const span = diagnostic.labels[0].span;
      return {
        line: span.line,
        offset: span.offset,
        length: span.length,
        expression: source.slice(span.offset, span.offset + span.length),
      };
    });

const hasCreateStartWarning = (items) =>
  items.some(
    ({ code, message }) => code === "eslint(no-unused-vars)" && message.includes("createStart"),
  );

const runRouteBijectionLint = (currentSource, baseRouteSource, routeProof) => {
  const lintPaths = [generatedRouteTree, baseRouteTreeFixtureRelative];
  const lintResult = run(["exec", "vp", "lint", "-f", "json", ...lintPaths], {}, 120_000);
  const allDiagnostics = diagnostics(lintResult);
  const routeDiagnostics = allDiagnostics.filter(({ filename }) => filename === generatedRouteTree);
  const baseDiagnostics = allDiagnostics.filter(
    ({ filename }) => filename === baseRouteTreeFixtureRelative,
  );
  const currentUnsafe = unsafeAssertionSites(routeDiagnostics, currentSource);
  const baseUnsafe = unsafeAssertionSites(baseDiagnostics, baseRouteSource);
  expect(currentUnsafe).toHaveLength(0);
  expect(baseUnsafe).toHaveLength(28);
  expect(
    baseUnsafe.map(({ line, offset, length, expression }) => ({
      line,
      offset,
      length,
      expression,
    })),
  ).toEqual(routeProof.mappings.map(({ baseMatch }) => baseMatch));
  return { lintResult, routeDiagnostics, currentUnsafe, baseUnsafe };
};

const readRouteBaselineState = () => {
  const baselinePath = path.join(
    root,
    "packages/tooling-config/src/oxlint-plugins/no-nested-ternary-baseline.json",
  );
  const baselineBytes = readFileSync(baselinePath);
  const baselineManifest = JSON.parse(baselineBytes.toString("utf8"));
  const pluginSource = readFileSync(
    path.join(root, "packages/tooling-config/src/oxlint-plugins/effect-policy.mjs"),
    "utf8",
  );
  const baselinePin = /const BASELINE_SHA256 = "([a-f0-9]+)";/.exec(pluginSource)?.[1];
  const currentBaselineSha = createHash("sha256").update(baselineBytes).digest("hex");
  const routeEntries = baselineManifest.$builtins[generatedRouteTree] ?? [];
  return { baselineManifest, baselinePin, currentBaselineSha, routeEntries };
};

it("keeps inherited-site adoption evidence repository-relative and content-addressed", () => {
  const { baselineManifest, baselinePin, currentBaselineSha } = readRouteBaselineState();
  const adoption = baselineManifest.$provenance.tia249InheritedSiteAdoption;
  const proofPath = adoption.evidencePath;
  const decisionScopePath = adoption.decisionScopePath;
  const proofBytes = readFileSync(path.join(root, proofPath));
  const decisionScopeBytes = readFileSync(path.join(root, decisionScopePath));
  const proof = JSON.parse(proofBytes.toString("utf8"));
  const decisionScope = JSON.parse(decisionScopeBytes.toString("utf8"));
  const adoptionStringValues = [];
  const collectStringValues = (value) => {
    if (typeof value === "string") adoptionStringValues.push(value);
    else if (Array.isArray(value)) value.forEach(collectStringValues);
    else if (value !== null && typeof value === "object")
      Object.entries(value).forEach(([key, nested]) => {
        adoptionStringValues.push(key);
        collectStringValues(nested);
      });
  };
  collectStringValues(adoption);

  expect(path.isAbsolute(proofPath)).toBe(false);
  expect(path.isAbsolute(decisionScopePath)).toBe(false);
  expect(
    adoptionStringValues.some((value) => path.isAbsolute(value) || path.win32.isAbsolute(value)),
  ).toBe(false);
  expect(adoption.currentSiteGenerationReceipt).toEqual({
    artifactId: "TIA-249:a143086d:capture:763a421ead7f",
    receiptSha256: "ff4fddd1aca4e47b12e42071eba9e3f45ae845c2297103582fefc761c31003b6",
    stdoutSha256: "599eb5bfef31958d78c0af7d81211eb955fec21a9e7f667882c05eb9f3a5a59b",
  });
  expect(adoption.initialLintReceipt).toEqual({
    artifactId: "TIA-249:a143086d:capture:49c70f8216e0",
    receiptSha256: "13962033f9f669a4ecc66803f736ca81ff004e4a9585d31dc3f740978987b168",
    stdoutSha256: "f10fad4e6d5f77194572ba9547bb76149dbf62fe81880b6fd3a716855f31becb",
  });
  expect(adoption.typedAdoptionLintReceipt).toEqual({
    artifactId: "TIA-249:a143086d:capture:90dcc6511bfc",
    receiptSha256: "79fc3cd0af49f9cc1ad9e34eb98223e7f61b043b9fcbb11b499dae78ba8ce827",
    stdoutSha256: "a2f94f25dcd95d4ffe602e0eb2c44d048396da1f3fa5322bf0b63fab578a23e4",
  });
  expect(adoption.evidenceSha256).toBe(createHash("sha256").update(proofBytes).digest("hex"));
  expect(adoption.decisionScopeSha256).toBe(
    createHash("sha256").update(decisionScopeBytes).digest("hex"),
  );
  expect(proof.portableArtifactId).toBe(adoption.evidenceSourceRef);
  expect(proof.sourceEvidenceSha256).toBe(adoption.evidenceSourceSha256);
  expect(proof.decisionScopeRef).toBe(adoption.decisionScopeSourceRef);
  expect(JSON.stringify(proof)).not.toContain("/opt/data/");
  expect(JSON.stringify(decisionScope)).not.toContain("/opt/data/");
  expect(adoption.decisionScopeSourceSha256).toBe(adoption.decisionScopeSha256);
  const latestRepair = adoption.latestRepairAdoption;
  const currentRows = baselineManifest.$builtins[latestRepair.targetFile] ?? [];
  const currentGeneratedRows = currentRows
    .map(({ rule, site, source }) => ({ rule, site, source }))
    .sort(
      (left, right) => left.rule.localeCompare(right.rule) || left.site.localeCompare(right.site),
    );
  expect(latestRepair).toMatchObject({
    sourceHead: "b4fdb58204482b7c6cc3552832a6ebe882c402ac",
    sourceRows: 1355,
    targetFile: "packages/developer-launcher/src/connected-preview.test.ts",
    targetBuiltinRowsBefore: 31,
    targetBuiltinRowsAfter: 27,
    currentGeneratedSiteCount: 27,
    removedRegistryRows: 4,
    removedSourceDirectivePairs: 4,
    newAllowances: 0,
    policyExpansion: false,
  });
  expect(currentGeneratedRows.map(({ site }) => site)).toEqual(
    [...latestRepair.currentGeneratedSiteIds].sort((left, right) => left.localeCompare(right)),
  );
  expect(latestRepair.removedSiteIds.map(({ site }) => site)).toEqual([
    "46510ee4447c92a912c8263d4122227833a4c516a5a052aea62b856fe43c65d1",
    "47f854a19e177db0a25ccf5693f7b59bacee57ee4b348cd40744034d94451afd",
    "8b6781f4cefa3ffd2d01c7c894a17950e0c6a6ad3926a21505295ca6c96b9d1b",
    "af2f8e5cfc25bc01fad0aa738ce2be1b3a3e53a92b7eec3a3982d5c39aebce04",
  ]);
  expect(latestRepair.currentSiteGenerationReceipt).toMatchObject({
    artifactId: "TIA-249:b4fdb582:current-site-generation:cbe2c4a95712",
    receiptSha256: "e0f5e707998348331f39acdc76efe1ed61cc3835f07f7cf679cbb120c7615c9c",
    stdoutSha256: "043f1b256771fb93e43e8ce52ac9cb634de718cc99d64cfaaf64e9755fcf3444",
  });
  expect(latestRepair.preAdoptionLintDiagnostics).toEqual({
    changedSiteDirectiveDiagnostics: 10,
    orphanMessages: 1,
    note: "Diagnostic messages are not registry row counts.",
  });
  expect(baselinePin).toBe(currentBaselineSha);
});

const routeMappingIsBaseProven = ({ baseMatch, pluginSite }) =>
  baseMatch.line === pluginSite.line && pluginSite.site === pluginSite.legacySite;

const assertRouteBaselineEntries = (routeEntries, routeProof) => {
  expect(routeEntries).toEqual(
    routeProof.mappings.map(({ pluginSite }) => ({
      rule: routeProof.rule,
      site: pluginSite.site,
      source: pluginSite.source,
    })),
  );
  expect(routeEntries).toHaveLength(28);
  expect(routeEntries.every(({ rule }) => rule === "typescript/no-unsafe-type-assertion")).toBe(
    true,
  );
  expect(new Set(routeEntries.map(({ site }) => site)).size).toBe(28);
  expect(routeProof.mappings.every(routeMappingIsBaseProven)).toBe(true);
};

const assertRouteBaselineState = (routeProof, lintResult, routeDiagnostics) => {
  const { baselineManifest, baselinePin, currentBaselineSha, routeEntries } =
    readRouteBaselineState();
  assertRouteBaselineEntries(routeEntries, routeProof);
  expect(baselinePin).toBe(currentBaselineSha);
  expect(baselineManifest.$provenance.builtinBaselineCounts).toMatchObject({
    "typescript/no-unsafe-type-assertion": 696,
    "typescript/restrict-template-expressions": 51,
  });
  expect(lintResult.status).not.toBe(0);
  expect(hasCreateStartWarning(routeDiagnostics)).toBe(true);
  expect(
    routeDiagnostics.some(({ code }) => code === "tiara-effect-policy(builtin-site-adoption)"),
  ).toBe(false);
  return currentBaselineSha;
};

const writeRouteEnrollmentArtifact = (
  routeProof,
  routeBytes,
  baselineSha,
  routeDiagnostics,
  currentUnsafe,
  baseUnsafe,
) => {
  const captureDirectory = process.env.TIA230_SOURCE_CAPTURE_DIR;
  if (captureDirectory === undefined) return;
  const enrollmentArtifact = {
    schemaVersion: 1,
    status: "ROUTE28_ENROLLMENT_INTEGRATION_ACCEPTED",
    capturedAt: new Date().toISOString(),
    base: routeProof.base.commit,
    path: generatedRouteTree,
    baseBlob: "865805b1a3839ec89b2b9ffaa3b11d62c102e57c",
    baseContentSha256: "fd18750f9ca6b2028c8181a16f23f9f56d309fd7de48823785360b1998f23c2a",
    decoratedRouteSha256: createHash("sha256").update(routeBytes).digest("hex"),
    baselineSha256: baselineSha,
    pluginBaselinePin: readRouteBaselineState().baselinePin,
    baselinePinMatchesCurrent: true,
    currentRouteDiagnostics: routeDiagnostics,
    currentUnsafeAssertionSites: currentUnsafe,
    baseUnsafeAssertionSites: baseUnsafe,
    enrolledEntryCount: routeProof.mappings.length,
    prewriteBijectionSha256: routeProof.acceptedProofSha256,
    portableFixtureSha256: createHash("sha256")
      .update(readFileSync(new URL("./fixtures/route28-base-bijection.json", import.meta.url)))
      .digest("hex"),
    executableAstEqualToBase: true,
    unrelatedCreateStartWarningRetained: true,
    rejectionControls: [
      "same-count changed or moved sites rejected",
      "duplicate and fresh sites rejected",
      "unpaired and expanded pairs rejected",
      "the same source copied to an un-enrolled path remains diagnostic",
    ],
  };
  writeFileSync(
    path.join(captureDirectory, `routeTree-enrollment-integration-${process.pid}.json`),
    `${JSON.stringify(enrollmentArtifact, null, 2)}\n`,
    { flag: "wx" },
  );
};

describe("native type-aware lint adoption", () => {
  it("accepts exact inherited sites, but rejects changed same-count, duplicate, and new sites", () => {
    writeFileSync(inheritedPath, inheritedSource());
    installFixtureBaseline();
    const env = { TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath };
    const inherited = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(inherited.status).toBe(0);

    const formatted = inheritedSource().replace(
      `${inheritedLines[3]}\n`,
      `const inheritedAssertion =\n  ${pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as string")};\n`,
    );
    writeFileSync(inheritedPath, formatted);
    const formattedResult = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(formattedResult.status).toBe(0);

    const relocated = inheritedSource()
      .replace(
        `${inheritedLines[3]}\n`,
        `const relocated = () => {\n  const inheritedAssertion = ${pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as string")};\n  void inheritedAssertion;\n};\n`,
      )
      .replace(
        "void [inheritedAssertion, inheritedInterpolation, safeWidening];",
        "void [inheritedInterpolation, safeWidening];",
      );
    writeFileSync(inheritedPath, relocated);
    const relocatedResult = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(relocatedResult.status).not.toBe(0);
    expect(
      diagnostics(relocatedResult).some(
        ({ code }) => code === "tiara-effect-policy(builtin-site-adoption)",
      ),
    ).toBe(true);

    const changed = inheritedSource().replace(
      pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as string"),
      pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as number"),
    );
    writeFileSync(inheritedPath, changed);
    const changedResult = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(changedResult.status, JSON.stringify(diagnostics(changedResult))).not.toBe(0);
    expect(
      diagnostics(changedResult).some(
        ({ code }) => code === "tiara-effect-policy(builtin-site-adoption)",
      ),
    ).toBe(true);

    writeFileSync(
      inheritedPath,
      `${inheritedSource()}{\n  ${inheritedLines[3]}\n  void inheritedAssertion;\n}\n`,
    );
    const duplicate = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(duplicate.status).not.toBe(0);
    expect(
      diagnostics(duplicate).some(
        ({ code }) => code === "tiara-effect-policy(builtin-site-adoption)",
      ),
    ).toBe(true);

    writeFileSync(
      newPath,
      "export {}; declare const freshUnknown: unknown; declare const freshMaybe: string | undefined; const unsafe = freshUnknown as string; const interpolated = `${freshMaybe}`;\n",
    );
    const fresh = run(["exec", "vp", "lint", "-f", "json", newRelative], env);
    expect(fresh.status).not.toBe(0);
    const freshCodes = diagnostics(fresh).map(({ code }) => code);
    expect(freshCodes).toContain("typescript(no-unsafe-type-assertion)");
    expect(freshCodes).toContain("typescript(restrict-template-expressions)");
  }, 90_000);

  it("rejects moving a template allowance to a sibling interpolation", () => {
    writeFileSync(inheritedPath, siblingTemplateSource("string | undefined", "string", 0));
    installFixtureBaseline([inheritedRelative], 1);
    const env = { TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath };
    const inherited = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(inherited.status, `${String(inherited.stdout)}\n${String(inherited.stderr)}`).toBe(0);

    writeFileSync(inheritedPath, siblingTemplateSource("string", "string | undefined", 1));
    const moved = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(moved.status, `${String(moved.stdout)}\n${String(moved.stderr)}`).not.toBe(0);
    expect(
      diagnostics(moved).some(({ code }) => code === "tiara-effect-policy(builtin-site-adoption)"),
    ).toBe(true);
  }, 90_000);

  it("maps every inherited template allowance to its exact base interpolation occurrence", () => {
    const inputs = readTemplateBaselineInputs();
    const fixtures = createTemplateBaselineFixtures(inputs.files, inputs.startingIdentities);
    const generatedResult = run(
      ["exec", "vp", "lint", "-f", "json", ...fixtures.filesToLint],
      {
        TIARA_BUILTIN_BASELINE_MODE: "1",
        TIARA_NESTED_TERNARY_BASELINE_MODE: "1",
      },
      120_000,
    );
    const generatedRecords = parseTemplateBaselineRecords(
      generatedResult,
      fixtures.fixtureToSource,
    );
    const expectedEntries = expectedTemplateEntries(inputs.files);
    expect(generatedRecords).toHaveLength(expectedEntries.length);
    expect(expectedEntries).toHaveLength(51);

    const newMode = process.env.TIA230_BASELINE_MIGRATION_EXPECT_OLD !== "1";
    const mapping = mapTemplateOccurrences(
      inputs.files,
      generatedRecords,
      fixtures.sourceMetadata,
      newMode,
    );
    assertTemplateMappingIdentity(mapping, newMode);
    writeTemplateBaselineMigrationProof(inputs, generatedRecords.length, mapping, newMode);
  }, 180_000);

  it("includes the enrolled generated route tree in the normal root lint target set", () => {
    const result = run(["exec", "vp", "lint", "-f", "json", generatedRouteTree], {}, 90_000);
    const routeDiagnostics = diagnostics(result);
    expect(result.jsonDocuments.some((document) => document.number_of_files > 0)).toBe(true);
    expect(
      routeDiagnostics.filter(({ code }) => code === "typescript(no-unsafe-type-assertion)"),
    ).toHaveLength(0);
    expect(routeDiagnostics.every(({ filename }) => filename === generatedRouteTree)).toBe(true);
    expect(
      routeDiagnostics.some(
        ({ code, message }) => code === "eslint(no-unused-vars)" && message.includes("createStart"),
      ),
    ).toBe(true);
    expect(result.status).toBe(0);
  }, 120_000);

  it("carries generated route coverage through the sheet-web package lint target", () => {
    const packageManifest = JSON.parse(
      readFileSync(path.join(root, "packages/sheet-web/package.json"), "utf8"),
    );
    expect(packageManifest.scripts.lint).toContain(
      "pnpm --workspace-root exec vp lint packages/sheet-web/src",
    );
    const result = run(
      ["--workspace-root", "exec", "vp", "lint", "-f", "json", "packages/sheet-web/src"],
      {},
      120_000,
    );
    const routeDiagnostics = diagnostics(result).filter(
      ({ filename }) => filename === generatedRouteTree,
    );
    expect(
      routeDiagnostics.filter(({ code }) => code === "typescript(no-unsafe-type-assertion)"),
    ).toHaveLength(0);
    expect(
      routeDiagnostics.some(
        ({ code, message }) => code === "eslint(no-unused-vars)" && message.includes("createStart"),
      ),
    ).toBe(true);
  }, 150_000);

  it("binds all 28 generated route allowances to exact base-proven assertions", () => {
    const currentSource = readFileSync(path.join(root, generatedRouteTree), "utf8");
    const routeProof = JSON.parse(
      readFileSync(new URL("./fixtures/route28-base-bijection.json", import.meta.url), "utf8"),
    );
    const routeBytes = Buffer.from(currentSource, "utf8");
    assertRouteProofEnvelope(routeProof, routeBytes);
    const directiveSpans = routeDirectiveSpans(routeProof);
    assertRouteDirectiveLayout(routeBytes, routeProof, directiveSpans);
    const baseRouteSource = createAndAssertBaseRouteFixture(currentSource, routeProof);
    const lint = runRouteBijectionLint(currentSource, baseRouteSource, routeProof);
    const baselineSha = assertRouteBaselineState(
      routeProof,
      lint.lintResult,
      lint.routeDiagnostics,
    );
    writeRouteEnrollmentArtifact(
      routeProof,
      routeBytes,
      baselineSha,
      lint.routeDiagnostics,
      lint.currentUnsafe,
      lint.baseUnsafe,
    );
  }, 180_000);

  it("carries generated-style sheet-web files through the isolated staged path", () => {
    const generatedSource = readFileSync(path.join(root, generatedRouteTree), "utf8");
    const stagedSource = [
      generatedSource,
      "declare const stagedUnknown: unknown;",
      "const stagedUnsafe = stagedUnknown as any;",
      "const stagedNested = flag ? (next ? 1 : 2) : 3;",
      "void [stagedUnsafe, stagedNested];",
      "",
    ].join("\n");
    writeFileSync(stagedRoutePath, stagedSource);

    const temporaryIndex = path.join(tempDirectory, "staged-route.index");
    const indexEnv = { GIT_INDEX_FILE: temporaryIndex };
    const initialized = runCommand("git", ["read-tree", "HEAD"], { cwd: root, env: indexEnv });
    expect(initialized.status, String(initialized.stderr)).toBe(0);
    const staged = runCommand("git", ["add", "--", stagedRouteRelative], {
      cwd: root,
      env: indexEnv,
    });
    expect(staged.status, String(staged.stderr)).toBe(0);

    const checked = run(["exec", "vp", "staged", "--no-stash", "--verbose"], indexEnv, 120_000);
    const output = `${String(checked.stdout)}\n${String(checked.stderr)}`;
    expect(checked.status).not.toBe(0);
    expect(output).toContain(stagedRouteRelative);
    expect(output).toContain("no-unsafe-type-assertion");
    expect(output).toContain("no-nested-ternary");
  }, 150_000);

  it("rejects an identical assertion moved between anonymous test callbacks", () => {
    const anonymousSource = (suite, test) =>
      [
        "export {};",
        "declare const describe: (name: string, callback: () => void) => void;",
        "declare const it: (name: string, callback: () => void) => void;",
        "declare const inheritedUnknown: unknown;",
        `describe(${JSON.stringify(suite)}, () => {`,
        `  it(${JSON.stringify(test)}, () => {`,
        `    const inheritedAssertion = ${pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as string")};`,
        "    void inheritedAssertion;",
        "  });",
        "});",
        "",
      ].join("\n");
    const fixtureSource = anonymousSource("original suite", "inherited assertion");
    writeFileSync(inheritedPath, fixtureSource);
    installFixtureBaseline([inheritedRelative], 1);

    const inherited = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], {
      TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath,
    });
    expect(inherited.status).toBe(0);

    writeFileSync(inheritedPath, `const unrelated = 1;\nvoid unrelated;\n${fixtureSource}`);
    const shifted = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], {
      TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath,
    });
    expect(shifted.status).toBe(0);

    writeFileSync(inheritedPath, anonymousSource("replacement suite", "replacement assertion"));
    const replacement = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], {
      TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath,
    });
    expect(replacement.status).not.toBe(0);
    expect(
      diagnostics(replacement).some(
        ({ code }) => code === "tiara-effect-policy(builtin-site-adoption)",
      ),
    ).toBe(true);
  }, 90_000);

  it("checks every native diagnostic outside a paired inherited site", () => {
    const sourceFor = (addedAssertion = "", addedInterpolation = "") =>
      [
        "export {};",
        "declare const inheritedUnknown: unknown;",
        "declare const introducedUnknown: unknown;",
        "declare const inheritedMaybe: string | undefined;",
        "declare const introducedMaybe: string | undefined;",
        "declare const safeText: string;",
        `const inheritedAssertion = ${pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as string")};${addedAssertion}`,
        `const inheritedInterpolation = ${pairedTemplate("typescript/restrict-template-expressions", "inheritedMaybe")};${addedInterpolation}`,
        'const safeWidening = "literal" as string;',
        "void [inheritedAssertion, inheritedInterpolation, safeWidening];",
        "",
      ].join("\n");
    writeFileSync(inheritedPath, sourceFor());
    installFixtureBaseline();
    const env = { TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath };

    writeFileSync(
      inheritedPath,
      sourceFor(
        ' const sameLineWidening = "literal" as string;',
        " const sameLineString = `${safeText}`;",
      ),
    );
    const widening = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(widening.status).toBe(0);

    writeFileSync(
      inheritedPath,
      sourceFor(
        " const introducedAssertion = introducedUnknown as number;",
        " const introducedInterpolation = `${introducedMaybe}`;",
      ),
    );
    const introduced = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(introduced.status).not.toBe(0);
    expect(
      diagnostics(introduced)
        .filter(({ code }) =>
          [
            "typescript(no-unsafe-type-assertion)",
            "typescript(restrict-template-expressions)",
          ].includes(code),
        )
        .map(({ code }) => code)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual([
      "typescript(no-unsafe-type-assertion)",
      "typescript(restrict-template-expressions)",
    ]);
  }, 90_000);

  it("keeps native diagnostics visible through ESLint-compatible directive dialects", () => {
    const cases = [
      {
        source: [
          "export {};",
          "declare const unknownValue: unknown;",
          "// eslint-disable-next-line typescript/no-unsafe-type-assertion",
          "const value = unknownValue as string;",
          "void value;",
        ].join("\n"),
        rule: "typescript(no-unsafe-type-assertion)",
      },
      {
        source: [
          "export {};",
          "declare const unknownValue: unknown;",
          "/* eslint-disable typescript/no-unsafe-type-assertion */",
          "const value = unknownValue as string;",
          "/* eslint-enable typescript/no-unsafe-type-assertion */",
          "void value;",
        ].join("\n"),
        rule: "typescript(no-unsafe-type-assertion)",
      },
      {
        source: [
          "export {};",
          "declare const maybeValue: string | undefined;",
          "const value = `${maybeValue}`; // eslint-disable-line typescript/restrict-template-expressions",
          "void value;",
        ].join("\n"),
        rule: "typescript(restrict-template-expressions)",
      },
      {
        source: [
          "export {};",
          "declare const safeValue: 'literal';",
          "const widened: string = safeValue; // eslint-disable-line typescript/no-unsafe-type-assertion",
          "void widened;",
        ].join("\n"),
        rule: "typescript(no-unsafe-type-assertion)",
        expectAbsent: true,
      },
    ];
    for (const { source, rule, expectAbsent = false } of cases) {
      writeFileSync(newPath, source);
      const result = run(["exec", "vp", "lint", "-f", "json", newRelative]);
      const hasDiagnostic = diagnostics(result).some(({ code }) => code === rule);
      expect(hasDiagnostic).toBe(!expectAbsent);
    }
  }, 90_000);

  it("keeps a nested assertion diagnostic visible outside its enclosing inherited pair", () => {
    const rule = "typescript/no-unsafe-type-assertion";
    const nestedExpression = pairedSite(rule, "(nestedUnknown as Base) as Derived");
    writeFileSync(
      inheritedPath,
      [
        "export {};",
        "type Base = { kind: string };",
        "type Derived = { kind: 'x'; extra: number };",
        "declare const nestedUnknown: unknown;",
        `const nested = ${nestedExpression};`,
        "void nested;",
        "",
      ].join("\n"),
    );
    installFixtureBaseline([inheritedRelative], 1);
    const env = { TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath };

    const nested = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(nested.status).not.toBe(0);
    const codes = diagnostics(nested).map(({ code }) => code);
    expect(codes).toContain("typescript(no-unsafe-type-assertion)");
    expect(codes).not.toContain("tiara-effect-policy(builtin-site-adoption)");
  }, 90_000);

  it("pairs each inherited same-line occurrence independently and rejects missing or expanded pairs", () => {
    const sourceFor = (withNewSites = false) => {
      const assertionSites = [
        pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as string"),
        pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as number"),
      ];
      const templateSites = [
        pairedTemplate("typescript/restrict-template-expressions", "inheritedMaybe"),
        pairedTemplate("typescript/restrict-template-expressions", "inheritedMaybe"),
      ];
      const additions = withNewSites
        ? " const introducedAssertion = introducedUnknown as object; const introducedInterpolation = `${introducedMaybe}`;"
        : "";
      const safeTemplate = "`" + "${safeText}" + "`";
      return [
        "export {};",
        "declare const inheritedUnknown: unknown;",
        "declare const introducedUnknown: unknown;",
        "declare const inheritedMaybe: string | undefined;",
        "declare const introducedMaybe: string | undefined;",
        "declare const safeText: string;",
        `const first = ${assertionSites[0]}; const second = ${assertionSites[1]}; const firstText = ${templateSites[0]}; const secondText = ${templateSites[1]}; const safeWidening = 'literal' as string; const safeInterpolation = ${safeTemplate};${additions}`,
        "void [first, second, firstText, secondText, safeWidening, safeInterpolation];",
        "",
      ].join("\n");
    };
    writeFileSync(inheritedPath, sourceFor());
    installFixtureBaseline([inheritedRelative], 4);
    const env = { TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath };

    const inherited = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(inherited.status).toBe(0);

    writeFileSync(inheritedPath, sourceFor(true));
    const expanded = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(expanded.status).not.toBe(0);
    expect(
      diagnostics(expanded)
        .filter(({ code }) =>
          [
            "typescript(no-unsafe-type-assertion)",
            "typescript(restrict-template-expressions)",
          ].includes(code),
        )
        .map(({ code }) => code)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual([
      "typescript(no-unsafe-type-assertion)",
      "typescript(restrict-template-expressions)",
    ]);

    const original = sourceFor();
    writeFileSync(
      inheritedPath,
      original.replace(
        `${pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as string")};`,
        "inheritedUnknown as string;",
      ),
    );
    const missing = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(missing.status).not.toBe(0);
    expect(
      diagnostics(missing).some(
        ({ code }) => code === "tiara-effect-policy(builtin-site-adoption)",
      ),
    ).toBe(true);

    writeFileSync(
      inheritedPath,
      original.replace(
        `${pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as string")};`,
        `/* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ inheritedUnknown as string; const expanded = introducedUnknown as object /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;`,
      ),
    );
    const expandedPair = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(expandedPair.status).not.toBe(0);
    expect(
      diagnostics(expandedPair).filter(
        ({ code }) => code === "tiara-effect-policy(builtin-site-adoption)",
      ).length,
    ).toBeGreaterThanOrEqual(2);
  }, 90_000);

  it("binds multiple pairs to separate interpolations in one template and leaves an unpaired sibling visible", () => {
    const rule = "typescript/restrict-template-expressions";
    const sourceFor = (withNewSibling = false) => {
      const template =
        "`" +
        "${" +
        pairedInterpolation(rule, "inheritedMaybe") +
        "}:" +
        "${" +
        pairedInterpolation(rule, "inheritedMaybe") +
        "}" +
        (withNewSibling ? ":${introducedMaybe}" : "") +
        "`";
      return [
        "export {};",
        "declare const inheritedMaybe: string | undefined;",
        "declare const introducedMaybe: string | undefined;",
        `const message = ${template};`,
        "void message;",
        "",
      ].join("\n");
    };
    writeFileSync(inheritedPath, sourceFor());
    installFixtureBaseline([inheritedRelative], 2);
    const env = { TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath };

    const inherited = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(inherited.status).toBe(0);

    writeFileSync(inheritedPath, sourceFor(true));
    const expanded = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    expect(expanded.status).not.toBe(0);
    expect(
      diagnostics(expanded)
        .filter(({ code }) => code === "typescript(restrict-template-expressions)")
        .map(({ code }) => code),
    ).toEqual(["typescript(restrict-template-expressions)"]);
  }, 90_000);

  it("uses the shared package config and root staged path with effective type-aware errors", () => {
    writeFileSync(inheritedPath, inheritedSource());
    writeFileSync(stagedPath, inheritedSource());
    installFixtureBaseline([inheritedRelative, stagedRelative]);
    const env = { TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath };
    const shared = run(
      [
        "--filter",
        "developer-launcher",
        "exec",
        "vp",
        "lint",
        `src/${inheritedName}`,
        "-f",
        "json",
      ],
      env,
    );
    expect(shared.status).toBe(0);

    writeFileSync(
      inheritedPath,
      [
        "export {};",
        "declare const inheritedUnknown: unknown;",
        "// eslint-disable-next-line typescript/no-unsafe-type-assertion",
        "const unsafe = inheritedUnknown as string;",
        "void unsafe;",
        "",
      ].join("\n"),
    );
    const sharedDirective = run(
      [
        "--filter",
        "developer-launcher",
        "exec",
        "vp",
        "lint",
        "-f",
        "json",
        `src/${inheritedName}`,
      ],
      env,
    );
    expect(
      diagnostics(sharedDirective).some(
        ({ code }) => code === "typescript(no-unsafe-type-assertion)",
      ),
    ).toBe(true);

    const temporaryIndex = path.join(tempDirectory, "staged.index");
    execFileSync("git", ["read-tree", "HEAD"], {
      cwd: root,
      env: { ...process.env, GIT_INDEX_FILE: temporaryIndex },
    });
    execFileSync("git", ["add", "--", stagedRelative], {
      cwd: root,
      env: { ...process.env, GIT_INDEX_FILE: temporaryIndex },
    });
    const stagedInherited = run(["exec", "vp", "staged", "--no-stash", "--verbose"], {
      ...env,
      GIT_INDEX_FILE: temporaryIndex,
    });
    expect(stagedInherited.status).toBe(0);

    writeFileSync(
      stagedPath,
      "export {}; declare const stagedUnknown: unknown; declare const stagedMaybe: string | undefined; const unsafe = stagedUnknown as string; const interpolated = `${stagedMaybe}`;\n",
    );
    execFileSync("git", ["add", "--", stagedRelative], {
      cwd: root,
      env: { ...process.env, GIT_INDEX_FILE: temporaryIndex },
    });
    const stagedNew = run(["exec", "vp", "staged", "--no-stash", "--verbose"], {
      ...env,
      GIT_INDEX_FILE: temporaryIndex,
    });
    expect(stagedNew.status).not.toBe(0);
    const output = `${stagedNew.stdout}\n${stagedNew.stderr}`;
    expect(output).toContain("no-unsafe-type-assertion");
    expect(output).toContain("restrict-template-expressions");
    expect(output).toContain(stagedRelative);
  }, 90_000);

  it("distinguishes identical assertion ASTs in anonymous test callbacks", () => {
    const sourceFor = (suiteName, testName) =>
      [
        "export {};",
        "declare const describe: (name: string, callback: () => void) => void;",
        "declare const it: (name: string, callback: () => void) => void;",
        "declare const inheritedUnknown: unknown;",
        `describe(${JSON.stringify(suiteName)}, () => {`,
        `  it(${JSON.stringify(testName)}, () => {`,
        `    const inheritedAssertion = ${pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as string")};`,
        "    void inheritedAssertion;",
        "  });",
        "});",
        "",
      ].join("\n");
    const baseline = JSON.parse(
      readFileSync(
        path.join(
          root,
          "packages/tooling-config/src/oxlint-plugins/no-nested-ternary-baseline.json",
        ),
        "utf8",
      ),
    );
    writeFileSync(inheritedPath, sourceFor("original suite", "inherited assertion"));
    writeFileSync(baselinePath, `${JSON.stringify(baseline)}\n`);

    const generated = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], {
      TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath,
      TIARA_BUILTIN_BASELINE_MODE: "1",
    });
    const generatedSites = diagnostics(generated)
      .filter(({ code }) => code === "tiara-effect-policy(builtin-site-adoption)")
      .map(({ message }) => JSON.parse(message.slice("builtinbaseline:".length)));
    expect(generatedSites).toHaveLength(1);
    baseline.$builtins[inheritedRelative] = generatedSites.map(({ rule, site, source }) => ({
      rule,
      site,
      source,
    }));
    writeFileSync(baselinePath, `${JSON.stringify(baseline)}\n`);

    const inherited = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], {
      TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath,
    });
    expect(inherited.status).toBe(0);

    writeFileSync(inheritedPath, sourceFor("replacement suite", "replacement assertion"));
    const replacement = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], {
      TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath,
    });
    expect(replacement.status).not.toBe(0);
    expect(
      diagnostics(replacement).some(
        ({ code }) => code === "tiara-effect-policy(builtin-site-adoption)",
      ),
    ).toBe(true);
  }, 90_000);

  it("keeps canonical Vitest suites index-free without accepting suite lookalikes", () => {
    const site = (name, moved) =>
      [
        ...(moved ? ["    const unrelatedBeforeSite = 1;"] : []),
        `    const ${name} = ${pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as string")};`,
        `    void ${name};`,
      ].join("\n");
    const sourceFor = (moved) =>
      [
        'import { describe as namedSuite } from "vitest";',
        'import * as vitestNamespace from "vitest";',
        'import { describe as wrongModuleSuite } from "node:test";',
        "export {};",
        "declare const inheritedUnknown: unknown;",
        "const memberSuite = { describe: (_name: string, callback: () => void) => callback() };",
        'namedSuite("canonical Vitest named suite", () => {',
        site("namedAssertion", moved),
        "});",
        'vitestNamespace.describe("canonical Vitest namespace suite", () => {',
        site("namespaceAssertion", moved),
        "});",
        'wrongModuleSuite("wrong module suite", () => {',
        site("wrongModuleAssertion", moved),
        "});",
        "{",
        "  const namedSuite: (name: string, callback: () => void) => void = (_name, callback) => callback();",
        '  namedSuite("shadowed canonical import", () => {',
        site("shadowedAssertion", moved),
        "  });",
        "}",
        'memberSuite.describe("unrelated member lookalike", () => {',
        site("memberAssertion", moved),
        "});",
        "",
      ].join("\n");

    writeFileSync(inheritedPath, sourceFor(false));
    installFixtureBaseline([inheritedRelative], 5);
    const env = { TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath };

    writeFileSync(inheritedPath, sourceFor(true));
    const moved = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], env);
    const adoption = diagnostics(moved).filter(
      ({ code }) => code === "tiara-effect-policy(builtin-site-adoption)",
    );
    const changedMarkerLines = adoption
      .filter(({ message }) => message.includes("inherited built-in diagnostic site changed"))
      .map(({ labels }) => labels[0].span.line)
      .sort((left, right) => left - right);
    const sourceLines = sourceFor(true).split("\n");
    const expectedChangedMarkerLines = [
      "wrongModuleAssertion",
      "shadowedAssertion",
      "memberAssertion",
    ]
      .flatMap((name) => {
        const line =
          sourceLines.findIndex((sourceLine) => sourceLine.includes(`const ${name} =`)) + 1;
        return [line, line];
      })
      .sort((left, right) => left - right);

    expect(moved.status).not.toBe(0);
    expect(changedMarkerLines).toEqual(expectedChangedMarkerLines);
    expect(
      adoption.filter(({ message }) =>
        message.includes("baseline entry no longer has its original source site"),
      ),
    ).toHaveLength(1);
  }, 120_000);

  it("does not remove a directive-shaped literal while recording the actual paired comment", () => {
    const disable =
      "/* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */";
    const enable =
      "/* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */";
    const line = [
      `const literalCanary = ${JSON.stringify(disable)};`,
      `const templateCanary = \`${disable}\`;`,
      "const regexCanary = /\\/\\* oxlint-disable typescript\\/no-unsafe-type-assertion -- inherited master site \\*\\//;",
      `const inherited = ${pairedSite("typescript/no-unsafe-type-assertion", "inheritedUnknown as string")};`,
    ].join(" ");
    const source = [
      "export {};",
      "declare const inheritedUnknown: unknown;",
      "declare const inheritedMaybe: string | undefined;",
      line,
      `const inheritedInterpolation = ${pairedTemplate("typescript/restrict-template-expressions", "inheritedMaybe")};`,
      "void [inherited, inheritedInterpolation];",
      "",
    ].join("\n");
    writeFileSync(inheritedPath, source);
    writeFileSync(baselinePath, `${JSON.stringify({})}\n`);
    const generated = run(["exec", "vp", "lint", "-f", "json", inheritedRelative], {
      TIARA_NESTED_TERNARY_BASELINE_PATH: baselinePath,
      TIARA_BUILTIN_BASELINE_MODE: "1",
    });
    const sourceRecord = diagnostics(generated)
      .filter(({ code }) => code === "tiara-effect-policy(builtin-site-adoption)")
      .map(({ message }) => JSON.parse(message.slice("builtinbaseline:".length)))
      .find(({ rule }) => rule === "typescript/no-unsafe-type-assertion");
    const disableStart = line.lastIndexOf(disable);
    const enableStart = line.indexOf(enable, disableStart + disable.length);
    const expected =
      line.slice(0, disableStart) +
      line.slice(disableStart + disable.length, enableStart) +
      line.slice(enableStart + enable.length);

    expect(sourceRecord).toBeDefined();
    expect(sourceRecord.source).toBe(expected.trimEnd());
    expect(sourceRecord.source).toContain(JSON.stringify(disable));
    expect(sourceRecord.source).toContain(`\`${disable}\``);
    expect(sourceRecord.source).toContain("const regexCanary = /\\/\\* oxlint-disable");
    expect(sourceRecord.source).not.toContain(disable + " as string");
  }, 30_000);
});
