import { existsSync } from "node:fs";
import path from "node:path";
import { auditSheetPackageBoundaries } from "./audit";
import { sheetPackageBoundaryPolicy } from "./policy";

const findRepositoryRoot = (start: string): string => {
  let current = path.resolve(start);
  while (!existsSync(path.join(current, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Could not find repository root from ${start}`);
    current = parent;
  }
  return current;
};

const repositoryRoot = findRepositoryRoot(process.cwd());
const audit = auditSheetPackageBoundaries(repositoryRoot, sheetPackageBoundaryPolicy);

if (audit.violations.length === 0) {
  console.log(
    `Sheet package boundaries passed (${audit.suppressed.length} explicit transitional exceptions).`,
  );
} else {
  console.error("Sheet package boundary violations:");
  for (const violation of audit.violations) {
    console.error(`- [${violation.code}] ${violation.message}`);
  }
  process.exitCode = 1;
}
