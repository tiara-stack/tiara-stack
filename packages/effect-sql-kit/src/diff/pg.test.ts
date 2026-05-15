import { describe, expect, it } from "vitest";
import { diffPg } from "./pg";
import { emptySnapshot, type SchemaSnapshot } from "../snapshot";

describe("Postgres push diff", () => {
  it("creates tables and marks drops as destructive", () => {
    const next: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        users: {
          name: "users",
          schema: "public",
          columns: {
            id: { fieldName: "id", name: "id", kind: "uuid", notNull: true, primaryKey: true },
          },
          primaryKey: ["id"],
          indexes: [],
        },
      },
    };
    const create = diffPg(emptySnapshot("postgresql"), next);
    const drop = diffPg(next, emptySnapshot("postgresql"));

    expect(create.statements[0]?.sql).toContain('create table "public"."users"');
    expect(drop.statements[0]?.destructive).toBe(true);
  });

  it("matches existing columns by SQL name", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        users: {
          name: "users",
          schema: "public",
          columns: {
            id: { fieldName: "id", name: "id", kind: "uuid", notNull: true, primaryKey: true },
            display_name: {
              fieldName: "display_name",
              name: "display_name",
              kind: "text",
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
      dialect: "postgresql",
      tables: {
        users: {
          name: "users",
          schema: "public",
          columns: {
            id: { fieldName: "id", name: "id", kind: "uuid", notNull: true, primaryKey: true },
            displayName: {
              fieldName: "displayName",
              name: "display_name",
              kind: "text",
              notNull: true,
              primaryKey: false,
            },
          },
          primaryKey: ["id"],
          indexes: [],
        },
      },
    };

    expect(diffPg(prev, next).statements).toEqual([]);
  });

  it("matches primary keys by SQL name", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        users: {
          name: "users",
          schema: "public",
          columns: {
            user_id: {
              fieldName: "user_id",
              name: "user_id",
              kind: "uuid",
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
      dialect: "postgresql",
      tables: {
        users: {
          name: "users",
          schema: "public",
          columns: {
            userId: {
              fieldName: "userId",
              name: "user_id",
              kind: "uuid",
              notNull: true,
              primaryKey: true,
            },
          },
          primaryKey: ["userId"],
          indexes: [],
        },
      },
    };

    expect(diffPg(prev, next).statements).toEqual([]);
  });

  it("matches composite primary keys by SQL names", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        userRoles: {
          name: "user_roles",
          schema: "public",
          columns: {
            user_id: {
              fieldName: "user_id",
              name: "user_id",
              kind: "uuid",
              notNull: true,
              primaryKey: true,
            },
            role_id: {
              fieldName: "role_id",
              name: "role_id",
              kind: "uuid",
              notNull: true,
              primaryKey: true,
            },
          },
          primaryKey: ["user_id", "role_id"],
          indexes: [],
        },
      },
    };
    const next: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        userRoles: {
          name: "user_roles",
          schema: "public",
          columns: {
            userId: {
              fieldName: "userId",
              name: "user_id",
              kind: "uuid",
              notNull: true,
              primaryKey: true,
            },
            roleId: {
              fieldName: "roleId",
              name: "role_id",
              kind: "uuid",
              notNull: true,
              primaryKey: true,
            },
          },
          primaryKey: ["userId", "roleId"],
          indexes: [],
        },
      },
    };

    expect(diffPg(prev, next).statements).toEqual([]);
  });

  it("matches indexes by SQL column names", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        tasks: {
          name: "tasks",
          schema: "public",
          columns: {
            id: { fieldName: "id", name: "id", kind: "uuid", notNull: true, primaryKey: true },
            account_id: {
              fieldName: "account_id",
              name: "account_id",
              kind: "uuid",
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
      dialect: "postgresql",
      tables: {
        tasks: {
          name: "tasks",
          schema: "public",
          columns: {
            id: { fieldName: "id", name: "id", kind: "uuid", notNull: true, primaryKey: true },
            accountId: {
              fieldName: "accountId",
              name: "account_id",
              kind: "uuid",
              notNull: true,
              primaryKey: false,
            },
          },
          primaryKey: ["id"],
          indexes: [{ name: "tasks_account_id_idx", unique: false, fields: ["accountId"] }],
        },
      },
    };

    expect(diffPg(prev, next).statements).toEqual([]);
  });

  it("matches multi-column indexes by SQL column names", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        userRoles: {
          name: "user_roles",
          schema: "public",
          columns: {
            id: { fieldName: "id", name: "id", kind: "uuid", notNull: true, primaryKey: true },
            user_id: {
              fieldName: "user_id",
              name: "user_id",
              kind: "uuid",
              notNull: true,
              primaryKey: false,
            },
            role_id: {
              fieldName: "role_id",
              name: "role_id",
              kind: "uuid",
              notNull: true,
              primaryKey: false,
            },
          },
          primaryKey: ["id"],
          indexes: [
            {
              name: "user_roles_user_id_role_id_idx",
              unique: false,
              fields: ["user_id", "role_id"],
            },
          ],
        },
      },
    };
    const next: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        userRoles: {
          name: "user_roles",
          schema: "public",
          columns: {
            id: { fieldName: "id", name: "id", kind: "uuid", notNull: true, primaryKey: true },
            userId: {
              fieldName: "userId",
              name: "user_id",
              kind: "uuid",
              notNull: true,
              primaryKey: false,
            },
            roleId: {
              fieldName: "roleId",
              name: "role_id",
              kind: "uuid",
              notNull: true,
              primaryKey: false,
            },
          },
          primaryKey: ["id"],
          indexes: [
            { name: "user_roles_user_id_role_id_idx", unique: false, fields: ["userId", "roleId"] },
          ],
        },
      },
    };

    expect(diffPg(prev, next).statements).toEqual([]);
  });

  it("emits index drop and create statements for changed indexes", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        tasks: {
          name: "tasks",
          schema: "public",
          columns: {
            id: { fieldName: "id", name: "id", kind: "uuid", notNull: true, primaryKey: true },
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

    expect(diffPg(prev, next).statements.map((statement) => statement.sql)).toEqual([
      `drop index "public"."tasks_title_idx"`,
      `create unique index "tasks_title_idx" on "public"."tasks" ("title")`,
    ]);
  });

  it("does not explicitly drop indexes removed by dropped columns", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        tasks: {
          name: "tasks",
          schema: "public",
          columns: {
            id: { fieldName: "id", name: "id", kind: "uuid", notNull: true, primaryKey: true },
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
          columns: {
            id: prev.tables.tasks!.columns.id!,
          },
          indexes: [],
        },
      },
    };

    expect(diffPg(prev, next).statements.map((statement) => statement.sql)).toEqual([
      `alter table "public"."tasks" drop column "title"`,
    ]);
  });

  it("schema-qualifies removed index drops", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        tasks: {
          name: "tasks",
          schema: "public",
          columns: {
            id: { fieldName: "id", name: "id", kind: "uuid", notNull: true, primaryKey: true },
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
          indexes: [],
        },
      },
    };

    expect(diffPg(prev, next).statements.map((statement) => statement.sql)).toEqual([
      `drop index "public"."tasks_title_idx"`,
    ]);
  });

  it("treats same-field SQL name changes as manual renames", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        users: {
          name: "users",
          schema: "public",
          columns: {
            id: { fieldName: "id", name: "id", kind: "uuid", notNull: true, primaryKey: true },
            displayName: {
              fieldName: "displayName",
              name: "display_name",
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
            displayName: {
              fieldName: "displayName",
              name: "full_name",
              kind: "text",
              notNull: false,
              primaryKey: false,
            },
          },
        },
      },
    };

    expect(diffPg(prev, next).statements).toEqual([
      {
        sql: `alter table "public"."users" add column "full_name" text`,
      },
      {
        sql: "",
        unsupported: true,
        reason: `column rename on users.displayName from "display_name" to "full_name" may require a manual migration`,
      },
    ]);
  });

  it("uses the previous schema for existing index drops", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        tasks: {
          name: "tasks",
          schema: "old_schema",
          columns: {
            id: { fieldName: "id", name: "id", kind: "uuid", notNull: true, primaryKey: true },
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
          schema: "new_schema",
          indexes: [{ name: "tasks_title_idx", unique: true, fields: ["title"] }],
        },
      },
    };

    expect(diffPg(prev, next).statements.map((statement) => statement.sql)).toEqual([
      `drop index "old_schema"."tasks_title_idx"`,
      `create unique index "tasks_title_idx" on "new_schema"."tasks" ("title")`,
    ]);
  });
});
