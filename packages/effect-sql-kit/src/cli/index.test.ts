import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const withTempDir = async <A>(f: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "effect-sql-kit-cli-"));
  try {
    await symlink(join(packageRoot, "node_modules"), join(dir, "node_modules"), "dir");
    return await f(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const writeCustomNameSchema = (path: string) =>
  writeFile(
    path,
    `import { schema, sqlite } from "effect-sql-schema";

class Account extends sqlite.Class<Account>("Account")({
  table: "accounts",
  fields: {
    id: sqlite.text().primaryKey(),
    email: sqlite.text().notNull(),
    displayName: sqlite.text("display_name").notNull(),
    createdAt: sqlite.integer("created_at", { mode: "timestamp" }).notNull(),
  },
  indexes: [sqlite.uniqueIndex("accounts_email_uq").on("email")],
}) {}

class Task extends sqlite.Class<Task>("Task")({
  table: "tasks",
  fields: {
    id: sqlite.text().primaryKey(),
    accountId: sqlite.text("account_id").notNull(),
    title: sqlite.text().notNull(),
    completed: sqlite.integer("completed", { mode: "boolean" }).notNull(),
    priority: sqlite.integer().notNull(),
  },
  indexes: [sqlite.index("tasks_account_id_idx").on("accountId")],
}) {}

export default schema({ accounts: Account, tasks: Task });
`,
  );

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
    expect(output).toContain("--table-prefix");
    expect(output).toContain("--table");
    expect(output).toContain("--db-schema");
  });

  it("prints push help", async () => {
    const output = await runCli("push", "--help");

    expect(output).toContain("--schema");
    expect(output).toContain("--url");
    expect(output).toContain("--table-prefix");
    expect(output).toContain("--strict");
    expect(output).toContain("--verbose");
    expect(output).toContain("--force");
  });

  it(
    "generates from a TypeScript config and schema",
    async () =>
      withTempDir(async (dir) => {
        const schemaPath = join(dir, "schema.ts");
        const out = join(dir, "migrations");
        const configPath = join(dir, "effect-sql.config.ts");
        await writeCustomNameSchema(schemaPath);
        await writeFile(
          configPath,
          `export default {
  dialect: "sqlite",
  schema: ${JSON.stringify(schemaPath)},
  out: ${JSON.stringify(out)},
  dbCredentials: {
    url: ${JSON.stringify(join(dir, "migrate.sqlite"))},
  },
};
`,
        );

        const output = await runCli("generate", "--config", configPath, "--name", "initial");

        expect(output).toContain("effect-sql-kit: generated");
        expect(output).toContain("0001_initial.ts");
      }),
    20_000,
  );

  it(
    "push is idempotent for TypeScript schemas with custom SQLite column names",
    async () =>
      withTempDir(async (dir) => {
        const schemaPath = join(dir, "schema.ts");
        const dbPath = join(dir, "push.sqlite");
        await writeCustomNameSchema(schemaPath);

        const first = await runCli(
          "push",
          "--dialect",
          "sqlite",
          "--schema",
          schemaPath,
          "--url",
          dbPath,
          "--force",
        );
        const second = await runCli(
          "push",
          "--dialect",
          "sqlite",
          "--schema",
          schemaPath,
          "--url",
          dbPath,
          "--force",
        );

        expect(first).toContain("effect-sql-kit: applied");
        expect(second).toContain("effect-sql-kit: no changes detected");
      }),
    20_000,
  );

  it(
    "push is idempotent with table prefixes",
    async () =>
      withTempDir(async (dir) => {
        const schemaPath = join(dir, "schema.ts");
        const dbPath = join(dir, "push-prefixed.sqlite");
        await writeCustomNameSchema(schemaPath);

        const first = await runCli(
          "push",
          "--dialect",
          "sqlite",
          "--schema",
          schemaPath,
          "--url",
          dbPath,
          "--table-prefix",
          "app",
          "--force",
        );
        const second = await runCli(
          "push",
          "--dialect",
          "sqlite",
          "--schema",
          schemaPath,
          "--url",
          dbPath,
          "--table-prefix",
          "app",
          "--force",
        );

        expect(first).toContain("effect-sql-kit: applied");
        expect(second).toContain("effect-sql-kit: no changes detected");
      }),
    20_000,
  );
});
