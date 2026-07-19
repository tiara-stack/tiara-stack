import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const schemaPath = new URL("../src/zero/schema.ts", import.meta.url);
const baselinePath = new URL("./zero-schema-assertions.baseline.json", import.meta.url);

const [schema, baselineSource] = await Promise.all([
  readFile(schemaPath, "utf8"),
  readFile(baselinePath, "utf8"),
]);
const baseline = JSON.parse(baselineSource);
const assertions = {
  "as unknown as": schema.match(/\bas unknown as\b/g)?.length ?? 0,
  "as never": schema.match(/\bas never\b/g)?.length ?? 0,
};

for (const assertion of Object.keys(assertions)) {
  const ceiling = baseline[assertion];
  if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
    throw new TypeError(
      `Invalid generated Zero schema assertion baseline for \`${assertion}\`: expected a non-negative safe integer.`,
    );
  }
}

const failures = Object.entries(assertions).filter(
  ([assertion, count]) => count > baseline[assertion],
);

if (failures.length > 0) {
  for (const [assertion, count] of failures) {
    console.error(
      `Generated Zero schema contains ${count} \`${assertion}\` assertions; baseline is ${baseline[assertion]}.`,
    );
  }
  console.error(
    "Improve the generator or explicitly update scripts/zero-schema-assertions.baseline.json.",
  );
  process.exitCode = 1;
} else {
  console.log(
    `Generated Zero schema assertion counts match their ceilings (${Object.entries(assertions)
      .map(([assertion, count]) => `${assertion}: ${count}/${baseline[assertion]}`)
      .join(", ")}) in ${packageRoot}.`,
  );
}
