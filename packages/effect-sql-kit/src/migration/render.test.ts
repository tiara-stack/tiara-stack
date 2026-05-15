import { describe, expect, it } from "vitest";
import { renderEffectMigration } from "./render";

describe("generated migration module", () => {
  it("uses Effect SQL client execution", () => {
    const content = renderEffectMigration([{ sql: "select 1" }]);

    expect(content).toContain('import { Effect } from "effect"');
    expect(content).toContain('import { SqlClient } from "effect/unstable/sql"');
    expect(content).toContain("sql.unsafe(`select 1`).withoutTransform");
  });
});
