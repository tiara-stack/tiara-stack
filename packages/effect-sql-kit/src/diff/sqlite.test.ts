import { describe, expect, it } from "vitest";
import { diffSqlite } from "./sqlite";
import { emptySnapshot, type SchemaSnapshot } from "../snapshot";

describe("SQLite push diff", () => {
  it("creates tables and safe columns", () => {
    const next: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        users: {
          name: "users",
          columns: {
            id: { fieldName: "id", name: "id", kind: "text", notNull: true, primaryKey: true },
          },
          primaryKey: ["id"],
          indexes: [],
        },
      },
    };

    expect(diffSqlite(emptySnapshot("sqlite"), next).statements[0]?.sql).toContain("create table");
  });

  it("aborts rebuild cases", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        users: {
          name: "users",
          columns: {
            id: { fieldName: "id", name: "id", kind: "text", notNull: true, primaryKey: true },
            name: {
              fieldName: "name",
              name: "name",
              kind: "text",
              notNull: false,
              primaryKey: false,
            },
          },
          primaryKey: ["id"],
          indexes: [],
        },
      },
    };
    const next: SchemaSnapshot = {
      ...prev,
      tables: {
        users: {
          ...prev.tables.users!,
          columns: {
            id: prev.tables.users!.columns.id!,
          },
        },
      },
    };

    expect(diffSqlite(prev, next).statements.some((statement) => statement.unsupported)).toBe(true);
  });

  it("matches existing columns by SQL name", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        users: {
          name: "users",
          columns: {
            id: { fieldName: "id", name: "id", kind: "text", notNull: true, primaryKey: true },
            display_name: {
              fieldName: "display_name",
              name: "display_name",
              kind: "text",
              notNull: true,
              primaryKey: false,
            },
            active: {
              fieldName: "active",
              name: "active",
              kind: "integer",
              notNull: true,
              primaryKey: false,
            },
          },
          primaryKey: ["id"],
          indexes: [],
        },
      },
    };
    const next: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        users: {
          name: "users",
          columns: {
            id: { fieldName: "id", name: "id", kind: "text", notNull: true, primaryKey: true },
            displayName: {
              fieldName: "displayName",
              name: "display_name",
              kind: "text",
              notNull: true,
              primaryKey: false,
            },
            active: {
              fieldName: "active",
              name: "active",
              kind: "integer",
              notNull: true,
              primaryKey: false,
              config: { mode: "boolean" },
            },
          },
          primaryKey: ["id"],
          indexes: [],
        },
      },
    };

    expect(diffSqlite(prev, next).statements).toEqual([]);
  });

  it("matches primary keys by SQL name", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        users: {
          name: "users",
          columns: {
            user_id: {
              fieldName: "user_id",
              name: "user_id",
              kind: "text",
              notNull: true,
              primaryKey: true,
            },
          },
          primaryKey: ["user_id"],
          indexes: [],
        },
      },
    };
    const next: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        users: {
          name: "users",
          columns: {
            userId: {
              fieldName: "userId",
              name: "user_id",
              kind: "text",
              notNull: true,
              primaryKey: true,
            },
          },
          primaryKey: ["userId"],
          indexes: [],
        },
      },
    };

    expect(diffSqlite(prev, next).statements).toEqual([]);
  });

  it("matches composite primary keys by SQL names", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        userRoles: {
          name: "user_roles",
          columns: {
            user_id: {
              fieldName: "user_id",
              name: "user_id",
              kind: "text",
              notNull: true,
              primaryKey: true,
            },
            org_id: {
              fieldName: "org_id",
              name: "org_id",
              kind: "text",
              notNull: true,
              primaryKey: true,
            },
          },
          primaryKey: ["user_id", "org_id"],
          indexes: [],
        },
      },
    };
    const next: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        userRoles: {
          name: "user_roles",
          columns: {
            userId: {
              fieldName: "userId",
              name: "user_id",
              kind: "text",
              notNull: true,
              primaryKey: true,
            },
            orgId: {
              fieldName: "orgId",
              name: "org_id",
              kind: "text",
              notNull: true,
              primaryKey: true,
            },
          },
          primaryKey: ["userId", "orgId"],
          indexes: [],
        },
      },
    };

    expect(diffSqlite(prev, next).statements).toEqual([]);
  });

  it("matches indexes by SQL column names", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        tasks: {
          name: "tasks",
          columns: {
            id: { fieldName: "id", name: "id", kind: "text", notNull: true, primaryKey: true },
            account_id: {
              fieldName: "account_id",
              name: "account_id",
              kind: "text",
              notNull: true,
              primaryKey: false,
            },
          },
          primaryKey: ["id"],
          indexes: [{ name: "tasks_account_id_idx", unique: false, fields: ["account_id"] }],
        },
      },
    };
    const next: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        tasks: {
          name: "tasks",
          columns: {
            id: { fieldName: "id", name: "id", kind: "text", notNull: true, primaryKey: true },
            accountId: {
              fieldName: "accountId",
              name: "account_id",
              kind: "text",
              notNull: true,
              primaryKey: false,
            },
          },
          primaryKey: ["id"],
          indexes: [{ name: "tasks_account_id_idx", unique: false, fields: ["accountId"] }],
        },
      },
    };

    expect(diffSqlite(prev, next).statements).toEqual([]);
  });

  it("matches multi-column indexes by SQL column names", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        userRoles: {
          name: "user_roles",
          columns: {
            id: { fieldName: "id", name: "id", kind: "text", notNull: true, primaryKey: true },
            a: {
              fieldName: "a",
              name: "a",
              kind: "text",
              notNull: true,
              primaryKey: false,
            },
            b: {
              fieldName: "b",
              name: "b",
              kind: "text",
              notNull: true,
              primaryKey: false,
            },
          },
          primaryKey: ["id"],
          indexes: [{ name: "user_roles_a_b_idx", unique: false, fields: ["a", "b"] }],
        },
      },
    };
    const next: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        userRoles: {
          name: "user_roles",
          columns: {
            id: { fieldName: "id", name: "id", kind: "text", notNull: true, primaryKey: true },
            aField: {
              fieldName: "aField",
              name: "a",
              kind: "text",
              notNull: true,
              primaryKey: false,
            },
            bField: {
              fieldName: "bField",
              name: "b",
              kind: "text",
              notNull: true,
              primaryKey: false,
            },
          },
          primaryKey: ["id"],
          indexes: [{ name: "user_roles_a_b_idx", unique: false, fields: ["aField", "bField"] }],
        },
      },
    };

    expect(diffSqlite(prev, next).statements).toEqual([]);
  });

  it("emits index drop and create statements for changed multi-column indexes", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        userRoles: {
          name: "user_roles",
          columns: {
            id: { fieldName: "id", name: "id", kind: "text", notNull: true, primaryKey: true },
            a: {
              fieldName: "a",
              name: "a",
              kind: "text",
              notNull: true,
              primaryKey: false,
            },
            b: {
              fieldName: "b",
              name: "b",
              kind: "text",
              notNull: true,
              primaryKey: false,
            },
          },
          primaryKey: ["id"],
          indexes: [{ name: "user_roles_a_b_idx", unique: false, fields: ["a", "b"] }],
        },
      },
    };
    const next: SchemaSnapshot = {
      ...prev,
      tables: {
        userRoles: {
          ...prev.tables.userRoles!,
          indexes: [{ name: "user_roles_a_b_idx", unique: false, fields: ["b", "a"] }],
        },
      },
    };

    expect(diffSqlite(prev, next).statements.map((statement) => statement.sql)).toEqual([
      `drop index "user_roles_a_b_idx"`,
      `create index "user_roles_a_b_idx" on "user_roles" ("b", "a")`,
    ]);
  });

  it("emits index drop and create statements for changed indexes", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        tasks: {
          name: "tasks",
          columns: {
            id: { fieldName: "id", name: "id", kind: "text", notNull: true, primaryKey: true },
            title: {
              fieldName: "title",
              name: "title",
              kind: "text",
              notNull: true,
              primaryKey: false,
            },
          },
          primaryKey: ["id"],
          indexes: [{ name: "tasks_title_idx", unique: false, fields: ["title"] }],
        },
      },
    };
    const next: SchemaSnapshot = {
      ...prev,
      tables: {
        tasks: {
          ...prev.tables.tasks!,
          indexes: [{ name: "tasks_title_idx", unique: true, fields: ["title"] }],
        },
      },
    };

    expect(diffSqlite(prev, next).statements.map((statement) => statement.sql)).toEqual([
      `drop index "tasks_title_idx"`,
      `create unique index "tasks_title_idx" on "tasks" ("title")`,
    ]);
  });
});
