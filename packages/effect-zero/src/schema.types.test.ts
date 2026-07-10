import { Schema } from "effect";
import { Model } from "effect/unstable/schema";
import { pg } from "effect-sql-schema";
import { expectTypeOf, it } from "vitest";
import { schema } from "./schema";
import { table } from "./table";
import type { ColumnType } from "./types";

class SqlUser extends pg.Class<SqlUser>("SqlUser")({
  table: "users",
  fields: {
    id: pg.uuid().primaryKey(),
    displayName: pg.text("display_name").notNull(),
  },
}) {}

class AuditEvent extends Model.Class<AuditEvent>("AuditEvent")({
  id: Schema.String,
  createdAt: Schema.Number,
}) {}

const auditEvents = table(AuditEvent, {
  name: "auditEvents",
  serverName: "audit_events",
  key: ["id"],
});

const normalized = schema(
  {
    users: SqlUser,
    auditEvents,
  },
  { prefix: "app" },
);

it("preserves SQL and native Zero table shapes through normalization", () => {
  expectTypeOf(normalized.tables).toHaveProperty("users");
  expectTypeOf(normalized.tables).toHaveProperty("auditEvents");
  expectTypeOf(normalized.tables.auditEvents).toEqualTypeOf<typeof auditEvents>();
  expectTypeOf<ColumnType<typeof normalized, "users", "id">>().toEqualTypeOf<string>();
  expectTypeOf<ColumnType<typeof normalized, "users", "displayName">>().toEqualTypeOf<string>();
  expectTypeOf<ColumnType<typeof normalized, "auditEvents", "createdAt">>().toEqualTypeOf<number>();
});
