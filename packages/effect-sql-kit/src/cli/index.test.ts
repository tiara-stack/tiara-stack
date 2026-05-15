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

describe("effect-sql-kit Effect CLI", () => {
  it("prints root help", async () => {
    const output = await runCli("--help");

    expect(output).toContain("effect-sql-kit");
    expect(output).toContain("generate");
    expect(output).toContain("migrate");
    expect(output).toContain("push");
  }, 15_000);

  it("prints generate help", async () => {
    const output = await runCli("generate", "--help");

    expect(output).toContain("--schema");
    expect(output).toContain("--out");
    expect(output).toContain("--name");
    expect(output).toContain("--custom");
    expect(output).toContain("--prefix");
  });

  it("prints migrate help", async () => {
    const output = await runCli("migrate", "--help");

    expect(output).toContain("--out");
    expect(output).toContain("--url");
    expect(output).toContain("--table");
    expect(output).toContain("--db-schema");
  });

  it("prints push help", async () => {
    const output = await runCli("push", "--help");

    expect(output).toContain("--schema");
    expect(output).toContain("--url");
    expect(output).toContain("--strict");
    expect(output).toContain("--verbose");
    expect(output).toContain("--force");
  });
});
