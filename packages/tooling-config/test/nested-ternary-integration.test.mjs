import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { diagnostics, runPnpm } from "./lint-fixture-helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tempDirectory = mkdtempSync(path.join(os.tmpdir(), "tiara-oxlint-policy-"));
const fixtureDirectory = path.join(root, "packages/developer-launcher/src");
const deployDirectory = path.join(root, "deploy/kubernetes/scripts");
const liveFixtureDirectory = path.join(root, "packages/effect-zero/src/cli");
const fixtureName = `.tia230-nested-${String(process.pid)}.test.ts`;
const duplicateName = `.tia230-nested-duplicate-${String(process.pid)}.ts`;
const deployFixtureName = `.tia230-root-nested-${String(process.pid)}.ts`;
const liveFixtureName = `tia230-live-site-${String(process.pid)}.test.ts`;
const replacementFixtureName = `tia230-live-site-replacement-${String(process.pid)}.test.ts`;
const removedFixtureName = `tia230-live-site-removed-${String(process.pid)}.test.ts`;
const fixturePath = path.join(fixtureDirectory, fixtureName);
const duplicatePath = path.join(fixtureDirectory, duplicateName);
const deployFixturePath = path.join(deployDirectory, deployFixtureName);
const liveFixturePath = path.join(liveFixtureDirectory, liveFixtureName);
const replacementFixturePath = path.join(liveFixtureDirectory, replacementFixtureName);
const removedFixturePath = path.join(liveFixtureDirectory, removedFixtureName);
const fixtureRelative = path.relative(root, fixturePath).split(path.sep).join("/");
const residualNestedPath =
  "packages/sheet-workflows/src/workflows/configuration/legacyConfiguration.ts";
const deployFixtureRelative = path.relative(root, deployFixturePath).split(path.sep).join("/");
const liveFixtureRelative = path.relative(root, liveFixturePath).split(path.sep).join("/");
const replacementFixtureRelative = path
  .relative(root, replacementFixturePath)
  .split(path.sep)
  .join("/");
const removedFixtureRelative = path.relative(root, removedFixturePath).split(path.sep).join("/");
const baselineOverride = path.join(tempDirectory, "baseline.json");
const legacyGenerateEffectKeys = [
  'Program.body/ExpressionStatement.expression/CallExpression.arguments[1]/ArrowFunctionExpression.body/BlockStatement.body/ExpressionStatement.expression/CallExpression.arguments[1]/ArrowFunctionExpression.body/CallExpression.callee/MemberExpression.object/CallExpression.arguments[0]/ArrowFunctionExpression.body/CallExpression.arguments[0]/FunctionExpression.body/BlockStatement.body[3]/VariableDeclaration.declarations[0]/VariableDeclarator.init/YieldExpression.argument/CallExpression.arguments[0]/ArrowFunctionExpression.body::["variable:output"]::readFile(outputPath, "utf-8")::callbacks:["callback:[\\"cli generation\\"]","callback:[\\"generates and signs a schema file\\"]"]::test-sites:[{"mode":"effect","labels":["generates and signs a schema file"],"sibling":0}]',
  'Program.body/ExpressionStatement.expression/CallExpression.arguments[1]/ArrowFunctionExpression.body/BlockStatement.body/ExpressionStatement.expression/CallExpression.arguments[1]/ArrowFunctionExpression.body/CallExpression.callee/MemberExpression.object/CallExpression.arguments[0]/ArrowFunctionExpression.body/CallExpression.arguments[0]/FunctionExpression.body/BlockStatement.body[3]/VariableDeclaration.declarations[0]/VariableDeclarator.init/YieldExpression.argument/CallExpression.arguments[0]/ArrowFunctionExpression.body::["variable:output"]::readFile(outputPath, "utf-8")::callbacks:["callback:[\\"cli generation\\"]","callback:[\\"refuses to overwrite modified generated files without force\\"]"]::test-sites:[{"mode":"effect","labels":["refuses to overwrite modified generated files without force"],"sibling":0}]',
  'Program.body/ExpressionStatement.expression/CallExpression.arguments[1]/ArrowFunctionExpression.body/BlockStatement.body/ExpressionStatement.expression/CallExpression.arguments[1]/ArrowFunctionExpression.body/CallExpression.callee/MemberExpression.object/CallExpression.arguments[0]/ArrowFunctionExpression.body/CallExpression.arguments[0]/FunctionExpression.body/BlockStatement.body[4]/ExpressionStatement.expression/YieldExpression.argument/CallExpression.arguments[0]/ArrowFunctionExpression.body::[]::writeFile(outputPath, `${output}\\n// manual edit\\n`)::callbacks:["callback:[\\"cli generation\\"]","callback:[\\"refuses to overwrite modified generated files without force\\"]"]::test-sites:[{"mode":"effect","labels":["refuses to overwrite modified generated files without force"],"sibling":0}]',
];
const inherited = `const value = true ? (false ? 1 : 2) : 3;`;
const sourceWithDirective = (expression) =>
  `const first = 1;\n// oxlint-disable-next-line no-nested-ternary -- fixture baseline\n${String(expression)}\n`;

const run = (args, { cwd = root, env = {} } = {}) => runPnpm(args, { cwd, env });
const createFixtureBaseline = (source = sourceWithDirective(inherited)) => {
  writeFileSync(baselineOverride, "{}\n");
  writeFileSync(fixturePath, source);
  const result = run(["exec", "vp", "lint", "-f", "json", fixtureRelative], {
    env: {
      TIARA_NESTED_TERNARY_BASELINE_MODE: "1",
      TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride,
    },
  });
  const item = diagnostics(result).find(
    ({ code }) => code === "tiara-effect-policy(no-nested-ternary-adoption)",
  );
  if (!item) throw new Error(`Failed to generate fixture site identity: ${String(result.stderr)}`);
  const parsed = JSON.parse(item.message.slice("baseline:".length));
  const defaultBaseline = JSON.parse(
    readFileSync(
      path.join(root, "packages/tooling-config/src/oxlint-plugins/no-nested-ternary-baseline.json"),
      "utf8",
    ),
  );
  writeFileSync(
    baselineOverride,
    JSON.stringify({ ...defaultBaseline, [fixtureRelative]: [parsed.key] }),
  );
};

afterAll(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});
afterEach(() => {
  rmSync(fixturePath, { force: true });
  rmSync(duplicatePath, { force: true });
  rmSync(deployFixturePath, { force: true });
  rmSync(liveFixturePath, { force: true });
  rmSync(replacementFixturePath, { force: true });
  rmSync(removedFixturePath, { force: true });
});

const policySiteKey = ({ file, rule, key }) => `${file}::${rule}::${key}`;
const generatedEffectRecords = (result, diagnostics) =>
  diagnostics(result)
    .filter(({ code }) => code === "tiara-effect-policy(effect-live-test)")
    .map(({ message }) => {
      const { file, rule, key } = JSON.parse(message.slice("policybaseline:".length));
      const marker = "::test-sites:";
      const markerIndex = key.lastIndexOf(marker);
      expect(markerIndex).toBeGreaterThanOrEqual(0);
      return { file, rule, key, testSites: JSON.parse(key.slice(markerIndex + marker.length)) };
    });
const generatedLegacyRecords = (result, diagnostics) =>
  diagnostics(result)
    .filter(({ code }) => code === "tiara-effect-policy(effect-live-test)")
    .map(({ filename, labels, message }) => {
      const { rule, key } = JSON.parse(message.slice("policybaseline:".length));
      return { filename, line: labels[0].span.line, rule, key };
    });
const generatedLegacyEntries = (records) =>
  records
    .map(({ rule, key }) => ({ rule, key }))
    .sort((left, right) => left.key.localeCompare(right.key));
const legacyGeneratorTestBlock = (source, title) => {
  const marker = `  it.live(\n    ${JSON.stringify(title)}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing current generator test block: ${title}`);
  const nextTest = source.indexOf("\n\n  it.", start + marker.length);
  if (nextTest < 0) throw new Error(`Missing following generator test block: ${title}`);
  return source.slice(start, nextTest).replace("  it.live(", "  it.effect(");
};
const isolatedLegacyGeneratorSource = (currentSource) =>
  [
    'import { NodeServices } from "@effect/platform-node";',
    'import { readFile, writeFile } from "node:fs/promises";',
    'import path from "node:path";',
    'import { describe, expect, it } from "@effect/vitest";',
    'import { Effect } from "effect";',
    'import { generate, writeGeneratedFile } from "./generate";',
    'import { checkSignature } from "./signature";',
    'const writeTempProject = async (): Promise<string> => "";',
    "const withTempProject = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>",
    "  Effect.acquireUseRelease(Effect.promise(writeTempProject), use, () => Effect.promise(async () => undefined));",
    'describe("cli generation", () => {',
    "  // Inert setup isolates the exact inherited callbacks without extra helper filesystem sites.",
    legacyGeneratorTestBlock(currentSource, "generates and signs a schema file"),
    legacyGeneratorTestBlock(
      currentSource,
      "refuses to overwrite modified generated files without force",
    ),
    "});",
    "",
  ].join("\n");
const currentBaselineEffectSites = (baseline, paths) =>
  paths.flatMap((filename) =>
    (baseline.$policy?.[filename] ?? [])
      .filter(({ rule }) => rule === "effect-live-test")
      .map(({ rule, key }) => `${filename}::${rule}::${key}`),
  );
const currentEffectModeRecords = (records) =>
  records.filter(({ testSites }) => testSites.some((site) => site.mode === "effect"));
const unsupportedGenerationModeRecords = (records) =>
  records.filter(({ testSites }) =>
    testSites.some((site) => !["effect", "live"].includes(site.mode)),
  );
const liveOrHelperGenerationRecords = (records) =>
  records.filter(({ testSites }) => testSites.every((site) => site.mode === "live"));
const assertCurrentGenerationPartition = (records) => {
  expect(currentEffectModeRecords(records)).toEqual([]);
  expect(unsupportedGenerationModeRecords(records)).toEqual([]);
  expect(liveOrHelperGenerationRecords(records).map(policySiteKey).sort()).toEqual(
    records.map(policySiteKey).sort(),
  );
};
const assertCurrentResolvedSites = ({ paths, root, run, diagnostics }) => {
  const inheritedResult = run(["exec", "vp", "lint", "-f", "json", ...paths]);
  expect(inheritedResult.status).toBe(0);
  expect(
    diagnostics(inheritedResult).filter(
      ({ code }) => code === "tiara-effect-policy(effect-live-test)",
    ),
  ).toEqual([]);
  const baseline = JSON.parse(
    readFileSync(
      path.join(root, "packages/tooling-config/src/oxlint-plugins/no-nested-ternary-baseline.json"),
      "utf8",
    ),
  );
  expect(currentBaselineEffectSites(baseline, paths)).toEqual([]);
  for (const filename of paths) expect(baseline.$policy?.[filename] ?? []).toEqual([]);
  const currentGeneration = run(["exec", "vp", "lint", "-f", "json", ...paths], {
    env: { TIARA_POLICY_BASELINE_MODE: "1" },
  });
  assertCurrentGenerationPartition(generatedEffectRecords(currentGeneration, diagnostics));
  return baseline;
};
const assertExactLegacyGeneratorSites = (records) => {
  expect(generatedLegacyEntries(records)).toEqual(
    legacyGenerateEffectKeys
      .map((key) => ({ rule: "effect-live-test", key }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  );
};
const assertLegacySiteVariants = ({
  acceptedFixture,
  replacementFixture,
  removedFixture,
  entries,
  records,
  baseline,
  baselineOverride,
  run,
  diagnostics,
}) => {
  const replacementEntries = entries.map((entry) => ({ ...entry }));
  const replacedKey = replacementEntries[0].key;
  replacementEntries[0] = { ...replacementEntries[0], key: `${replacedKey}::replacement` };
  const sourceRecord = records.find(({ key }) => key === replacedKey);
  expect(sourceRecord).toBeDefined();
  const combinedBaseline = {
    $builtins: baseline.$builtins,
    $policy: {
      [acceptedFixture]: entries,
      [replacementFixture]: replacementEntries,
    },
  };
  writeFileSync(baselineOverride, `${JSON.stringify(combinedBaseline)}\n`);
  const result = run(
    ["exec", "vp", "lint", "-f", "json", acceptedFixture, replacementFixture, removedFixture],
    {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    },
  );
  const siteDiagnostics = diagnostics(result).filter(
    ({ code }) => code === "tiara-effect-policy(effect-live-test)",
  );
  const sitesFor = (fixture) => siteDiagnostics.filter(({ filename }) => filename === fixture);
  expect(result.status).not.toBe(0);
  expect(sitesFor(acceptedFixture)).toEqual([]);
  const replacementSites = sitesFor(replacementFixture)
    .map(({ filename, labels }) => `${filename}:${labels[0].span.line}`)
    .sort();
  expect(replacementSites).toEqual([`${replacementFixture}:${sourceRecord.line}`]);
  const removedSites = sitesFor(removedFixture)
    .map(({ filename, labels }) => `${filename}:${labels[0].span.line}`)
    .sort();
  expect(removedSites).toEqual(records.map(({ line }) => `${removedFixture}:${line}`).sort());
};
const assertResolvedEffectSiteAdoption = ({
  paths,
  root,
  run,
  diagnostics,
  baselineOverride,
  liveFixturePath,
  liveFixtureRelative,
}) => {
  const baseline = assertCurrentResolvedSites({ paths, root, run, diagnostics });
  const currentSource = readFileSync(path.join(root, paths[1]), "utf8");
  const legacySource = isolatedLegacyGeneratorSource(currentSource);
  expect(legacySource).not.toBe(currentSource);
  writeFileSync(liveFixturePath, legacySource);
  writeFileSync(replacementFixturePath, legacySource);
  writeFileSync(removedFixturePath, legacySource);
  const generated = run(["exec", "vp", "lint", "-f", "json", liveFixtureRelative], {
    env: { TIARA_POLICY_BASELINE_MODE: "1" },
  });
  const records = generatedLegacyRecords(generated, diagnostics);
  const entries = generatedLegacyEntries(records);
  assertExactLegacyGeneratorSites(records);
  assertLegacySiteVariants({
    acceptedFixture: liveFixtureRelative,
    replacementFixture: replacementFixtureRelative,
    removedFixture: removedFixtureRelative,
    entries,
    records,
    baseline,
    baselineOverride,
    run,
    diagnostics,
  });
};

describe("nested ternary adoption in Vite+ lint paths", () => {
  it("rejects custom baseline paths outside explicit test-fixture mode", () => {
    writeFileSync(baselineOverride, "{}\n");
    writeFileSync(fixturePath, "export {};\n");
    const result = run(["exec", "vp", "lint", "-f", "json", fixtureRelative], {
      env: {
        NODE_ENV: "production",
        TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride,
        TIARA_NESTED_TERNARY_TEST_BASELINE: "0",
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${String(result.stdout)}\n${String(result.stderr)}`).toContain(
      "only available to test fixtures",
    );
  }, 90_000);

  it("rejects orphan entries for the linted file without scanning unlinted files", () => {
    createFixtureBaseline();
    const baseline = JSON.parse(readFileSync(baselineOverride, "utf8"));
    writeFileSync(fixturePath, "export {}; const value = 1; void value;\n");
    const orphaned = run(["exec", "vp", "lint", "-f", "json", fixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(orphaned.status).not.toBe(0);
    expect(
      diagnostics(orphaned).some(
        ({ code, message }) =>
          code === "tiara-effect-policy(no-nested-ternary-adoption)" &&
          message.includes("baseline entry no longer has a matching site"),
      ),
    ).toBe(true);

    delete baseline[fixtureRelative];
    writeFileSync(baselineOverride, `${JSON.stringify(baseline)}\n`);
    const partial = run(["exec", "vp", "lint", "-f", "json", fixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(partial.status, `${String(partial.stdout)}\n${String(partial.stderr)}`).toBe(0);
  }, 90_000);

  it("accepts the exact inherited configuration site and rejects a same-count replacement key", () => {
    const inherited = run(["exec", "vp", "lint", "-f", "json", residualNestedPath]);
    expect(inherited.status).toBe(0);
    expect(
      diagnostics(inherited).filter(
        ({ code }) => code === "tiara-effect-policy(no-nested-ternary-adoption)",
      ),
    ).toEqual([]);

    const baseline = JSON.parse(
      readFileSync(
        path.join(
          root,
          "packages/tooling-config/src/oxlint-plugins/no-nested-ternary-baseline.json",
        ),
        "utf8",
      ),
    );
    const sites = baseline[residualNestedPath];
    const siteIndex = sites.findIndex(
      (key) =>
        key.includes('variable:parseTeams","variable:isv') &&
        key.includes('isvKind === "combined" && isvRanges.length === 1'),
    );
    expect(siteIndex).toBeGreaterThanOrEqual(0);
    const sameCountBaseline = [...sites];
    sameCountBaseline[siteIndex] = `${sameCountBaseline[siteIndex]}::replacement`;
    writeFileSync(
      baselineOverride,
      JSON.stringify({ ...baseline, [residualNestedPath]: sameCountBaseline }),
    );

    const changedIdentity = run(["exec", "vp", "lint", "-f", "json", residualNestedPath], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    const residuals = diagnostics(changedIdentity)
      .filter(({ code }) => code === "tiara-effect-policy(no-nested-ternary-adoption)")
      .map(({ filename, labels }) => `${filename}:${labels[0].span.line}:${labels[0].span.column}`);

    expect(changedIdentity.status).not.toBe(0);
    expect(residuals.sort()).toEqual(
      [`${residualNestedPath}:1:1`, `${residualNestedPath}:453:9`].sort(),
    );
  }, 30_000);

  it("rejects the same expression moved to a different same-shaped function site", () => {
    const sourceFor = (name) =>
      `function ${name}() {\n  // oxlint-disable-next-line no-nested-ternary -- fixture baseline\n  const status = true ? (false ? 1 : 2) : 3;\n  return status;\n}\n`;
    createFixtureBaseline(sourceFor("OriginalSite"));
    writeFileSync(fixturePath, sourceFor("ReplacementSite"));

    const result = run(["exec", "vp", "lint", "-f", "json", fixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });

    expect(result.status).not.toBe(0);
    expect(
      diagnostics(result).some(
        ({ code }) => code === "tiara-effect-policy(no-nested-ternary-adoption)",
      ),
    ).toBe(true);
  }, 30_000);

  it("does not normalize suppression text inside a changed string literal", () => {
    const original = sourceWithDirective('const value = flag ? (next ? 1 : 2) : "";');
    createFixtureBaseline(original);
    const changed = sourceWithDirective(
      'const value = flag ? (next ? 1 : 2) : "// oxlint-disable-line no-nested-ternary -- inherited master site";',
    );
    writeFileSync(fixturePath, changed);

    const result = run(["exec", "vp", "lint", "-f", "json", fixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });

    expect(result.status).not.toBe(0);
    expect(
      diagnostics(result).some(
        ({ code }) => code === "tiara-effect-policy(no-nested-ternary-adoption)",
      ),
    ).toBe(true);
  }, 30_000);

  it("preserves regex literal semantics in inherited nested-ternary identities", () => {
    const sourceWithRegexDirective = (expression) =>
      [
        "const ready = true;",
        'const input = "foo";',
        "const left = 1;",
        "const right = 2;",
        "const fallback = 3;",
        "// oxlint-disable-next-line no-nested-ternary -- fixture baseline",
        String(expression),
        "void value;",
        "",
      ].join("\n");
    const original = sourceWithRegexDirective(
      "const value = ready ? /foo  bar/.test(input) ? left : right : fallback;",
    );
    createFixtureBaseline(original);

    const inherited = run(["exec", "vp", "lint", "-f", "json", fixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(inherited.status, `${String(inherited.stdout)}\n${String(inherited.stderr)}`).toBe(0);

    writeFileSync(
      fixturePath,
      sourceWithRegexDirective(
        "const value = ready ? /foo bar/.test(input) ? left : right : fallback;",
      ),
    );
    const changedPattern = run(["exec", "vp", "lint", "-f", "json", fixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(changedPattern.status).not.toBe(0);
    expect(
      diagnostics(changedPattern).some(
        ({ code }) => code === "tiara-effect-policy(no-nested-ternary-adoption)",
      ),
    ).toBe(true);

    writeFileSync(
      fixturePath,
      sourceWithRegexDirective(
        "const value = ready ? /foo  bar/i.test(input) ? left : right : fallback;",
      ),
    );
    const changedFlags = run(["exec", "vp", "lint", "-f", "json", fixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(changedFlags.status).not.toBe(0);
    expect(
      diagnostics(changedFlags).some(
        ({ code }) => code === "tiara-effect-policy(no-nested-ternary-adoption)",
      ),
    ).toBe(true);

    writeFileSync(
      fixturePath,
      sourceWithRegexDirective(
        "const value = ready\n  ? /foo  bar/.test(input)\n    ? left\n    : right\n  : fallback;",
      ),
    );
    const formatted = run(["exec", "vp", "lint", "-f", "json", fixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(formatted.status, `${String(formatted.stdout)}\n${String(formatted.stderr)}`).toBe(0);
  }, 30_000);

  it("distinguishes replacement tests but keeps inherited sites stable after unrelated insertion", () => {
    const liveSource = (suite, test) =>
      `import { Effect } from "effect";\nimport { it } from "@effect/vitest";\nimport { writeFile } from "node:fs/promises";\nit.effect(${JSON.stringify(suite + " / " + test)}, () => Effect.promise(() => writeFile("fixture", "value")));\n`;
    const original = liveSource("original suite", "writes fixture");
    writeFileSync(baselineOverride, "{}\n");
    writeFileSync(liveFixturePath, original);
    const generated = run(["exec", "vp", "lint", "-f", "json", liveFixtureRelative], {
      env: {
        TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride,
        TIARA_POLICY_BASELINE_MODE: "1",
      },
    });
    const policyDiagnostic = diagnostics(generated).find(
      ({ code }) => code === "tiara-effect-policy(effect-live-test)",
    );
    expect(policyDiagnostic).toBeDefined();
    const generatedSite = JSON.parse(policyDiagnostic.message.slice("policybaseline:".length));
    const baseline = JSON.parse(readFileSync(baselineOverride, "utf8"));
    baseline.$policy = {
      [liveFixtureRelative]: [{ rule: generatedSite.rule, key: generatedSite.key }],
    };
    writeFileSync(baselineOverride, `${JSON.stringify(baseline)}\n`);

    writeFileSync(liveFixturePath, liveSource("replacement suite", "writes replacement"));
    const replacement = run(["exec", "vp", "lint", "-f", "json", liveFixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });

    expect(replacement.status).not.toBe(0);
    expect(
      diagnostics(replacement).some(({ code }) => code === "tiara-effect-policy(effect-live-test)"),
    ).toBe(true);

    writeFileSync(liveFixturePath, `const unrelated = 1;\nvoid unrelated;\n${original}`);
    const shifted = run(["exec", "vp", "lint", "-f", "json", liveFixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(shifted.status, JSON.stringify(diagnostics(shifted))).toBe(0);
    expect(
      diagnostics(shifted).some(({ code }) => code === "tiara-effect-policy(effect-live-test)"),
    ).toBe(false);
  }, 30_000);

  it("separates Effect test modes and same-label callback occurrences", () => {
    const sourceFor = (mode, calls = 1) =>
      `import { Effect } from "effect";\nimport { it } from "@effect/vitest";\nimport { writeFile } from "node:fs/promises";\n${Array.from(
        { length: calls },
        () =>
          `it.${mode}("same label", () => Effect.promise(() => writeFile("fixture", "value")));`,
      ).join("\n")}\n`;
    const generateBaseline = (source) => {
      writeFileSync(baselineOverride, "{}\n");
      writeFileSync(liveFixturePath, source);
      const generated = run(["exec", "vp", "lint", "-f", "json", liveFixtureRelative], {
        env: {
          TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride,
          TIARA_POLICY_BASELINE_MODE: "1",
        },
      });
      const generatedSites = diagnostics(generated)
        .filter(({ code }) => code === "tiara-effect-policy(effect-live-test)")
        .map(({ message }) => JSON.parse(message.slice("policybaseline:".length)));
      expect(generatedSites).toHaveLength(source.match(/writeFile\(/g).length);
      const baseline = JSON.parse(readFileSync(baselineOverride, "utf8"));
      baseline.$policy = {
        [liveFixtureRelative]: generatedSites.map(({ rule, key }) => ({ rule, key })),
      };
      writeFileSync(baselineOverride, `${JSON.stringify(baseline)}\n`);
    };

    generateBaseline(sourceFor("live"));
    writeFileSync(liveFixturePath, sourceFor("effect"));
    const reversedMode = run(["exec", "vp", "lint", "-f", "json", liveFixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(
      diagnostics(reversedMode).filter(
        ({ code }) => code === "tiara-effect-policy(effect-live-test)",
      ),
    ).toHaveLength(1);

    generateBaseline(sourceFor("effect"));
    writeFileSync(liveFixturePath, sourceFor("effect", 2));
    const duplicate = run(["exec", "vp", "lint", "-f", "json", liveFixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(
      diagnostics(duplicate).filter(({ code }) => code === "tiara-effect-policy(effect-live-test)"),
    ).toHaveLength(1);
  }, 30_000);

  it("does not transfer a same-label allowance between enclosing suite callbacks", () => {
    const inheritedTest =
      'it.effect("same test", () => Effect.promise(() => writeFile("fixture", "value")));';
    const suite = (body) => `group("same suite", () => { ${body} });`;
    const original = `import { Effect } from "effect";\nimport { describe as group, it } from "@effect/vitest";\nimport { writeFile } from "node:fs/promises";\n${suite(inheritedTest)}\n`;
    writeFileSync(baselineOverride, "{}\n");
    writeFileSync(liveFixturePath, original);
    const generated = run(["exec", "vp", "lint", "-f", "json", liveFixtureRelative], {
      env: {
        TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride,
        TIARA_POLICY_BASELINE_MODE: "1",
      },
    });
    const generatedSite = diagnostics(generated).find(
      ({ code }) => code === "tiara-effect-policy(effect-live-test)",
    );
    expect(generatedSite).toBeDefined();
    const detail = JSON.parse(generatedSite.message.slice("policybaseline:".length));
    writeFileSync(
      baselineOverride,
      `${JSON.stringify({ $policy: { [liveFixtureRelative]: [{ rule: detail.rule, key: detail.key }] } })}\n`,
    );

    const movedToDuplicateSuite = `import { Effect } from "effect";\nimport { describe as group, it } from "@effect/vitest";\nimport { writeFile } from "node:fs/promises";\n${suite('it.effect("replacement", () => Effect.succeed(undefined));')}\n${suite(inheritedTest)}\n`;
    writeFileSync(liveFixturePath, movedToDuplicateSuite);
    const result = run(["exec", "vp", "lint", "-f", "json", liveFixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(
      diagnostics(result).some(({ code }) => code === "tiara-effect-policy(effect-live-test)"),
    ).toBe(true);
  }, 30_000);

  it("does not carry a suite allowance to a shadowed describe function", () => {
    const test =
      'it.effect("same test", () => Effect.promise(() => writeFile("fixture", "value")));';
    const original = `import { Effect } from "effect";\nimport { describe, it } from "@effect/vitest";\nimport { writeFile } from "node:fs/promises";\ndescribe("same suite", () => { ${test} });\n`;
    writeFileSync(baselineOverride, "{}\n");
    writeFileSync(liveFixturePath, original);
    const generated = run(["exec", "vp", "lint", "-f", "json", liveFixtureRelative], {
      env: {
        TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride,
        TIARA_POLICY_BASELINE_MODE: "1",
      },
    });
    const site = diagnostics(generated).find(
      ({ code }) => code === "tiara-effect-policy(effect-live-test)",
    );
    expect(site).toBeDefined();
    const detail = JSON.parse(site.message.slice("policybaseline:".length));
    writeFileSync(
      baselineOverride,
      `${JSON.stringify({ $policy: { [liveFixtureRelative]: [{ rule: detail.rule, key: detail.key }] } })}\n`,
    );

    const shadowed = `import { Effect } from "effect";\nimport { it } from "@effect/vitest";\nimport { writeFile } from "node:fs/promises";\nconst describe = (_label, callback) => callback();\ndescribe("same suite", () => { ${test} });\n`;
    writeFileSync(liveFixturePath, shadowed);
    const result = run(["exec", "vp", "lint", "-f", "json", liveFixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(
      diagnostics(result).some(({ code }) => code === "tiara-effect-policy(effect-live-test)"),
    ).toBe(true);
  }, 30_000);

  it("keeps an aliased suite site stable after an unrelated statement inside the suite", () => {
    const test =
      'it.effect("same test", () => Effect.promise(() => writeFile("fixture", "value")));';
    const source = (inserted = "") =>
      `import { Effect } from "effect";\nimport { describe as group, it } from "@effect/vitest";\nimport { writeFile } from "node:fs/promises";\ngroup("same suite", () => { ${inserted}${test} });\n`;
    writeFileSync(baselineOverride, "{}\n");
    writeFileSync(liveFixturePath, source());
    const generated = run(["exec", "vp", "lint", "-f", "json", liveFixtureRelative], {
      env: {
        TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride,
        TIARA_POLICY_BASELINE_MODE: "1",
      },
    });
    const site = diagnostics(generated).find(
      ({ code }) => code === "tiara-effect-policy(effect-live-test)",
    );
    expect(site).toBeDefined();
    const detail = JSON.parse(site.message.slice("policybaseline:".length));
    writeFileSync(
      baselineOverride,
      `${JSON.stringify({ $policy: { [liveFixtureRelative]: [{ rule: detail.rule, key: detail.key }] } })}\n`,
    );

    writeFileSync(liveFixturePath, source("const unrelated = 1; void unrelated; "));
    const shifted = run(["exec", "vp", "lint", "-f", "json", liveFixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(shifted.status, JSON.stringify(diagnostics(shifted))).toBe(0);
    expect(
      diagnostics(shifted).some(({ code }) => code === "tiara-effect-policy(effect-live-test)"),
    ).toBe(false);
  }, 30_000);

  it("accepts a moved inherited site but rejects a changed same-count site and a duplicate", () => {
    createFixtureBaseline();
    writeFileSync(fixturePath, `\n\n${sourceWithDirective(inherited)}`);
    const inheritedResult = run(["exec", "vp", "lint", "-f", "json", fixtureRelative], {
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(inheritedResult.status).toBe(0);

    writeFileSync(
      fixturePath,
      sourceWithDirective(
        `const value = true ? (false ? 1 : 4) : 3;\nconst duplicate = true ? (false ? 7 : 8) : 9;`,
      ),
    );
    writeFileSync(duplicatePath, `const second = true ? (false ? 4 : 5) : 6;\n`);
    const changedResult = run(
      ["exec", "vp", "lint", "-f", "json", fixtureRelative, path.relative(root, duplicatePath)],
      { env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride } },
    );
    expect(changedResult.status).not.toBe(0);
    const emitted = diagnostics(changedResult).filter(
      ({ code }) => code === "tiara-effect-policy(no-nested-ternary-adoption)",
    );
    expect(emitted.map(({ filename }) => filename)).toContain(fixtureRelative);
    expect(emitted.map(({ filename }) => filename)).toContain(
      path.relative(root, duplicatePath).split(path.sep).join("/"),
    );
    const fixtureDiagnostics = emitted.filter(({ filename }) => filename === fixtureRelative);
    expect(fixtureDiagnostics).toHaveLength(3);
    expect(fixtureDiagnostics.filter(({ message }) => message === "nested")).toHaveLength(2);
    expect(
      fixtureDiagnostics.some(({ message }) =>
        message.includes("baseline entry no longer has a matching site"),
      ),
    ).toBe(true);
  }, 30_000);

  it("loads policy through the package lint path", () => {
    createFixtureBaseline();
    writeFileSync(fixturePath, sourceWithDirective(`const value = true ? (false ? 1 : 4) : 3;`));
    const result = run(["exec", "vp", "lint", "-f", "json", `src/${fixtureName}`], {
      cwd: path.join(root, "packages/developer-launcher"),
      env: { TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(result.status).not.toBe(0);
    const policyDiagnostics = diagnostics(result).filter(
      ({ code }) => code === "tiara-effect-policy(no-nested-ternary-adoption)",
    );
    expect(
      policyDiagnostics,
      `${String(JSON.stringify(policyDiagnostics))}\n${String(result.stderr)}`,
    ).toHaveLength(2);
    expect(policyDiagnostics.filter(({ message }) => message === "nested")).toHaveLength(1);
    expect(
      policyDiagnostics.some(({ message }) =>
        message.includes("baseline entry no longer has a matching site"),
      ),
    ).toBe(true);
    expect(policyDiagnostics[0].filename.endsWith(fixtureName)).toBe(true);
  }, 30_000);

  it("rejects a new nested ternary through the isolated staged-file path", () => {
    writeFileSync(duplicatePath, `const staged = true ? (false ? 1 : 2) : 3;\n`);
    const isolatedIndex = path.join(tempDirectory, "index");
    execFileSync("git", ["read-tree", "HEAD"], {
      cwd: root,
      env: { ...process.env, GIT_INDEX_FILE: isolatedIndex },
    });
    execFileSync("git", ["add", "--", path.relative(root, duplicatePath)], {
      cwd: root,
      env: { ...process.env, GIT_INDEX_FILE: isolatedIndex },
    });
    const result = run(["exec", "vp", "staged", "--no-stash", "--verbose"], {
      env: { GIT_INDEX_FILE: isolatedIndex, TIARA_NESTED_TERNARY_BASELINE_PATH: baselineOverride },
    });
    expect(result.status).not.toBe(0);
    const output = `${String(result.stdout)}\n${String(result.stderr)}`;
    expect(output).toContain("eslint(no-nested-ternary)");
    expect(output).toContain("tiara-effect-policy(no-nested-ternary-adoption)");
  }, 30_000);

  it("covers inherited and new staged-root files outside package src", () => {
    const inheritedResult = run([
      "exec",
      "vp",
      "lint",
      "-f",
      "json",
      "deploy/kubernetes/scripts/parity-gate.ts",
    ]);
    const inheritedNested = diagnostics(inheritedResult).filter(({ code }) =>
      ["eslint(no-nested-ternary)", "tiara-effect-policy(no-nested-ternary-adoption)"].includes(
        code,
      ),
    );
    expect(inheritedNested).toHaveLength(0);

    writeFileSync(deployFixturePath, "const outsidePackage = true ? (false ? 1 : 2) : 3;\n");
    const rootLintResult = run(["exec", "vp", "lint", "-f", "json", deployFixtureRelative]);
    const rootDiagnostics = diagnostics(rootLintResult);
    expect(rootDiagnostics.some(({ code }) => code === "eslint(no-nested-ternary)")).toBe(true);
    expect(
      rootDiagnostics.some(
        ({ code }) => code === "tiara-effect-policy(no-nested-ternary-adoption)",
      ),
    ).toBe(true);

    const isolatedIndex = path.join(tempDirectory, "deploy-index");
    execFileSync("git", ["read-tree", "HEAD"], {
      cwd: root,
      env: { ...process.env, GIT_INDEX_FILE: isolatedIndex },
    });
    execFileSync("git", ["add", "--", deployFixtureRelative], {
      cwd: root,
      env: { ...process.env, GIT_INDEX_FILE: isolatedIndex },
    });
    const stagedResult = run(["exec", "vp", "staged", "--no-stash", "--verbose"], {
      env: { GIT_INDEX_FILE: isolatedIndex },
    });
    const stagedOutput = `${String(stagedResult.stdout)}\n${String(stagedResult.stderr)}`;
    expect(stagedResult.status).not.toBe(0);
    expect(stagedOutput).toContain("eslint(no-nested-ternary)");
    expect(stagedOutput).toContain("tiara-effect-policy(no-nested-ternary-adoption)");
  }, 30_000);

  it(
    "keeps resolved Effect sites live and rejects removed or replaced custom identities",
    () =>
      assertResolvedEffectSiteAdoption({
        paths: [
          "packages/effect-zero/src/cli/config.test.ts",
          "packages/effect-zero/src/cli/generate.test.ts",
        ],
        root,
        run,
        diagnostics,
        baselineOverride,
        liveFixturePath,
        liveFixtureRelative,
      }),
    30_000,
  );
});
