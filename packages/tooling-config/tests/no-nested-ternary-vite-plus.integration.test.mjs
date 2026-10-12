import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fingerprintNestedTernarySite } from "../src/oxlint-plugins/no-nested-ternary.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const vp = resolve(repositoryRoot, "node_modules/.bin/vp");
const rootConfig = resolve(repositoryRoot, "vite.config.ts");
const pluginDirectory = resolve(repositoryRoot, "packages/tooling-config/src/oxlint-plugins");

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const writeFixture = async (directory, source) => {
  await mkdir(directory, { recursive: true });
  const filename = resolve(directory, "nested-case.ts");
  await writeFile(filename, `${source}\n`);
  return filename;
};

const expectNewExpressionRejected = (result) => {
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /tiara\(no-nested-ternary\)|no-nested-ternary/u);
};

const copyPluginFiles = async (destination) => {
  await mkdir(destination, { recursive: true });
  for (const filename of ["no-nested-ternary.mjs", "no-nested-ternary-baseline.json"]) {
    await cp(resolve(pluginDirectory, filename), resolve(destination, filename));
  }
};

const writeBaselineFixture = async (filename) => {
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(
    filename,
    [
      "const _flag = true; const _nested = false;",
      "const _legacy = ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0);",
      'const _new = _flag ? (_nested ? "a" : "b") : "c";',
    ].join("\n"),
  );
};

const lintNewExpressionsThroughRootAndSharedConfigs = async (scratch) => {
  const accepted = await writeFixture(
    resolve(scratch, "accepted"),
    'const _flag = true; const _value = _flag ? "yes" : "no";',
  );
  const rejected = await writeFixture(
    resolve(scratch, "rejected"),
    'const _flag = true; const _nested = false; const _value = _flag ? (_nested ? "a" : "b") : "c";',
  );
  for (const cwd of [repositoryRoot, resolve(repositoryRoot, "packages/developer-launcher")]) {
    assert.equal(run(vp, ["lint", accepted], cwd).status, 0);
    expectNewExpressionRejected(run(vp, ["lint", rejected], cwd));
  }
};

const lintBaselineAndNewSiteThroughRootConfig = async (scratch) => {
  const project = resolve(scratch, "baseline-project");
  await mkdir(project, { recursive: true });
  await writeFile(
    resolve(project, "package.json"),
    JSON.stringify({ name: "nested-ternary-baseline-smoke", private: true, type: "module" }),
  );
  await cp(rootConfig, resolve(project, "vite.config.ts"));
  await copyPluginFiles(resolve(project, "packages/tooling-config/src/oxlint-plugins"));
  await symlink(resolve(repositoryRoot, "node_modules"), resolve(project, "node_modules"), "dir");
  const filename = resolve(project, "packages/developer-launcher/src/owned-workflow-execution.ts");
  await writeBaselineFixture(filename);
  const result = run(vp, ["lint", filename], project);
  expectNewExpressionRejected(result);
  assert.equal(result.output.match(/tiara\(no-nested-ternary\)/gu)?.length, 1, result.output);
};

const lintBaselineAndNewSiteThroughSharedConfig = async (scratch) => {
  const project = resolve(scratch, "shared-baseline-project");
  const packageDirectory = resolve(project, "packages/developer-launcher");
  const toolingDirectory = resolve(project, "packages/tooling-config");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    resolve(project, "package.json"),
    JSON.stringify({ name: "shared-baseline-smoke", private: true, packageManager: "pnpm@11.1.1" }),
  );
  await writeFile(resolve(project, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(
    resolve(packageDirectory, "package.json"),
    JSON.stringify({ name: "developer-launcher", private: true, type: "module" }),
  );
  await mkdir(resolve(packageDirectory, "node_modules"), { recursive: true });
  await copyPluginFiles(resolve(toolingDirectory, "src/oxlint-plugins"));
  await symlink(resolve(repositoryRoot, "node_modules"), resolve(project, "node_modules"), "dir");
  await symlink(
    resolve(repositoryRoot, "packages/tooling-config"),
    resolve(packageDirectory, "node_modules/tooling-config"),
    "dir",
  );
  await cp(
    resolve(repositoryRoot, "packages/developer-launcher/vite.config.ts"),
    resolve(packageDirectory, "vite.config.ts"),
  );
  const filename = resolve(packageDirectory, "src/owned-workflow-execution.ts");
  await writeBaselineFixture(filename);
  const result = run(vp, ["lint", "src/owned-workflow-execution.ts"], packageDirectory);
  expectNewExpressionRejected(result);
  assert.equal(result.output.match(/tiara\(no-nested-ternary\)/gu)?.length, 1, result.output);
};

const rejectChangedRegexSiteAgainstRootBaseline = async (scratch) => {
  const project = resolve(scratch, "regex-baseline-project");
  const pluginFiles = resolve(project, "packages/tooling-config/src/oxlint-plugins");
  await mkdir(project, { recursive: true });
  await writeFile(
    resolve(project, "package.json"),
    JSON.stringify({ name: "nested-ternary-regex-baseline", private: true, type: "module" }),
  );
  await cp(rootConfig, resolve(project, "vite.config.ts"));
  await copyPluginFiles(pluginFiles);
  await symlink(resolve(repositoryRoot, "node_modules"), resolve(project, "node_modules"), "dir");

  const inheritedExpression = "/foo  bar/.test(input) ? enabled ? left : right : fallback";
  const changedExpression = "/foo bar/.test(input) ? enabled ? left : right : fallback";
  const inheritedSite = `const _value = ${inheritedExpression};`;
  const fingerprints = fingerprintNestedTernarySite(inheritedExpression, inheritedSite);
  const baseline = {
    schema: "tiara.no-nested-ternary-baseline.v2",
    base: "416a69d554f4fab5926c768b1d3537e94ab9adca",
    algorithm: "normalized-expression-and-enclosing-site-source-sha256-v2",
    totalOccurrences: 1,
    entries: [
      {
        path: "packages/developer-launcher/src/owned-workflow-execution.ts",
        ...fingerprints,
        count: 1,
      },
    ],
  };
  await writeFile(
    resolve(pluginFiles, "no-nested-ternary-baseline.json"),
    `${JSON.stringify(baseline, null, 2)}\n`,
  );

  const filename = resolve(project, "packages/developer-launcher/src/owned-workflow-execution.ts");
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, `const _value = ${changedExpression};\n`);
  const result = run(vp, ["lint", filename], project);
  expectNewExpressionRejected(result);
  assert.equal(result.output.match(/tiara\(no-nested-ternary\)/gu)?.length, 1, result.output);
};

const rejectNewStagedExpression = async (scratch) => {
  const project = resolve(scratch, "staged-project");
  await mkdir(project, { recursive: true });
  await writeFile(
    resolve(project, "package.json"),
    JSON.stringify({ name: "nested-ternary-staged-smoke", private: true, type: "module" }),
  );
  await cp(rootConfig, resolve(project, "vite.config.ts"));
  await copyPluginFiles(resolve(project, "packages/tooling-config/src/oxlint-plugins"));
  await symlink(resolve(repositoryRoot, "node_modules"), resolve(project, "node_modules"), "dir");
  const filename = resolve(project, "packages/sample/src/new-expression.ts");
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(
    filename,
    'const _flag = true; const _nested = false; const _value = _flag ? (_nested ? "a" : "b") : "c";\n',
  );
  assert.equal(run("git", ["init", "--quiet"], project).status, 0);
  for (const [key, value] of [
    ["user.name", "Nested Rule Test"],
    ["user.email", "nested-rule-test@example.invalid"],
  ]) {
    assert.equal(run("git", ["config", key, value], project).status, 0);
  }
  assert.equal(
    run("git", ["add", "vite.config.ts", "packages", "package.json"], project).status,
    0,
  );
  expectNewExpressionRejected(run(vp, ["staged"], project));
};

await test("root and shared Vite+ configs lint new expressions; staged check enforces the same rule", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "tiara-nested-ternary-vite-plus-"));
  try {
    await lintNewExpressionsThroughRootAndSharedConfigs(scratch);
    await lintBaselineAndNewSiteThroughRootConfig(scratch);
    await lintBaselineAndNewSiteThroughSharedConfig(scratch);
    await rejectChangedRegexSiteAgainstRootBaseline(scratch);
    await rejectNewStagedExpression(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
