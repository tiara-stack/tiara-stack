import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

const runCli = async (...args: readonly string[]) => {
  const result = await execFileAsync("node", ["--import", "tsx", "src/cli/index.ts", ...args], {
    cwd: packageRoot,
  });
  return `${result.stdout}${result.stderr}`;
};

describe("effect-zero Effect CLI", () => {
  it("prints root help", async () => {
    const output = await runCli("--help");

    expect(output).toContain("effect-zero");
    expect(output).toContain("generate");
  }, 15_000);

  it("prints generate help", async () => {
    const output = await runCli("generate", "--help");

    expect(output).toContain("--config");
    expect(output).toContain("--output");
    expect(output).toContain("--tsconfig");
    expect(output).toContain("--format");
    expect(output).toContain("--force");
  });
});
