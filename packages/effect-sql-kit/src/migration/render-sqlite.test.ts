import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { renderEffectMigration } from "./render";

describe("SQLite migrate output", () => {
  it("renders Effect migration modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "effect-sql-kit-migrate-"));
    try {
      const file = join(dir, "0001_initial.ts");
      await writeFile(
        file,
        renderEffectMigration([{ sql: "create table users (id text primary key)" }]),
      );

      const content = await readFile(file, "utf8");
      expect(content).toContain("Effect.gen");
      expect(content).toContain("create table users");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
