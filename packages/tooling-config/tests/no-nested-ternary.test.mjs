import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "oxlint/plugins-dev";
import plugin, {
  fingerprintNestedTernaryExpression,
  fingerprintNestedTernarySite,
  normalizeNestedTernaryExpression,
  validateNestedTernaryBaseline,
} from "../src/oxlint-plugins/no-nested-ternary.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const rule = plugin.rules["no-nested-ternary"];
const ruleTester = new RuleTester();
const baselineFilename = resolve(
  repositoryRoot,
  "packages/developer-launcher/src/owned-workflow-execution.ts",
);

ruleTester.run("no-nested-ternary", rule, {
  valid: [
    "const result = flag ? left : right;",
    "const leftResult = left ? 1 : 0; const rightResult = right ? 1 : 0;",
    'const message = "flag ? left ? nested : value : other"; // left ? nested : text',
    {
      code: 'type Result<T> = T extends string ? (T extends "x" ? 1 : 2) : 3;',
      filename: "conditional-type.ts",
    },
    {
      code: [
        "const _unrelated = 1;",
        "const _compare = ([left], [right]) =>",
        "  (left < right ? -1 : left > right ? 1 : 0);",
      ].join("\n"),
      filename: baselineFilename,
      options: [{ baseline: "project" }],
    },
  ],
  invalid: [
    {
      code: "const result = flag ? (nested ? left : right) : other;",
      errors: [{ messageId: "nested" }],
    },
    {
      code: "const result = flag ? left : nested ? right : other;",
      errors: [{ messageId: "nested" }],
    },
    {
      code: "const result = flag ? (nested ? left : other) : fallback;",
      errors: [{ messageId: "nested" }],
    },
    {
      code: "const result = a ? b : c ? d : e ? f : g;",
      errors: [{ messageId: "nested" }, { messageId: "nested" }],
    },
    {
      code: "left < right ? -1 : left >= right ? 1 : 0",
      filename: baselineFilename,
      options: [{ baseline: "project" }],
      errors: [{ messageId: "nested" }],
    },
    {
      code: [
        "const _legacy = ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0);",
        "const _added = a ? b : c ? d : e;",
      ].join("\n"),
      filename: baselineFilename,
      options: [{ baseline: "project" }],
      errors: [{ messageId: "nested" }],
    },
    {
      code: "const added = a ? b : c ? d : e;",
      filename: baselineFilename,
      options: [{ baseline: "project" }],
      errors: [{ messageId: "nested" }],
    },
    // Removing the inherited arrow site must not let its expression move into a new declarator.
    {
      code: "const moved = left < right ? -1 : left > right ? 1 : 0;",
      filename: baselineFilename,
      options: [{ baseline: "project" }],
      errors: [{ messageId: "nested" }],
    },
    {
      code: [
        "const _first = ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0);",
        "const _second = ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0);",
      ].join("\n"),
      filename: baselineFilename,
      options: [{ baseline: "project" }],
      errors: [{ messageId: "nested" }],
    },
  ],
});

const baseline = JSON.parse(
  await readFile(
    new URL("../src/oxlint-plugins/no-nested-ternary-baseline.json", import.meta.url),
    "utf8",
  ),
);

assert.equal(baseline.totalOccurrences, 205);
assert.equal(baseline.base, "416a69d554f4fab5926c768b1d3537e94ab9adca");
assert.equal(
  baseline.entries.find(
    (entry) => entry.path === "packages/developer-launcher/src/owned-workflow-execution.ts",
  )?.expressionFingerprint,
  fingerprintNestedTernaryExpression("left < right ? -1 : left > right ? 1 : 0"),
);
assert.equal(
  baseline.entries.find(
    (entry) => entry.path === "packages/developer-launcher/src/owned-workflow-execution.ts",
  )?.fingerprint,
  fingerprintNestedTernarySite(
    "left < right ? -1 : left > right ? 1 : 0",
    "([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)",
  ).fingerprint,
);
assert.equal(
  normalizeNestedTernaryExpression("left  <\n right ? -1 : left > right ? 1 : 0"),
  "left < right ? -1 : left > right ? 1 : 0",
);
const spacedRegexExpression = "/foo  bar/.test(input) ? enabled ? left : right : fallback";
const compactRegexExpression = "/foo bar/.test(input) ? enabled ? left : right : fallback";
assert.notEqual(
  fingerprintNestedTernaryExpression(spacedRegexExpression),
  fingerprintNestedTernaryExpression(compactRegexExpression),
);
assert.notEqual(
  fingerprintNestedTernarySite(spacedRegexExpression, `const result = ${spacedRegexExpression};`)
    .fingerprint,
  fingerprintNestedTernarySite(compactRegexExpression, `const result = ${compactRegexExpression};`)
    .fingerprint,
);
assert.equal(
  fingerprintNestedTernarySite(spacedRegexExpression, `const result = ${spacedRegexExpression};`)
    .fingerprint,
  fingerprintNestedTernarySite(
    "/foo  bar/.test(input) ?\n  enabled\n    ? left\n    : right\n  : fallback",
    `const result =\n  /foo  bar/.test(input) ?\n    enabled ? left : right : fallback;`,
  ).fingerprint,
);
assert.throws(
  () => validateNestedTernaryBaseline({ ...baseline, totalOccurrences: 204 }),
  /occurrence count/u,
);
assert.throws(
  () =>
    validateNestedTernaryBaseline({
      ...baseline,
      entries: [{ path: "../outside.ts", fingerprint: "a".repeat(64), count: 205 }],
    }),
  /baseline entry/u,
);

for (const path of new Set(baseline.entries.map((entry) => entry.path))) {
  const filename = resolve(repositoryRoot, path);
  const code = await readFile(filename, "utf8");
  ruleTester.run(`inherited baseline ${path}`, rule, {
    valid: [{ code, filename, options: [{ baseline: "project" }] }],
    invalid: [],
  });
}
