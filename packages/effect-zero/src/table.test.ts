import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { Model } from "effect/unstable/schema";
import { inferTable } from "./infer";
import { table } from "./table";

class User extends Model.Class<User>("User")({
  id: Model.Generated(Schema.String),
  name: Schema.String,
  age: Schema.Int,
  active: Schema.Boolean,
  role: Schema.Literals(["admin", "member"]),
  broadRole: Schema.Union([Schema.String, Schema.Literal("admin")]),
  tags: Schema.Array(Schema.String),
  optionalName: Schema.NullOr(Schema.String),
  mixedArrays: Schema.Union([Schema.Array(Schema.String), Schema.Array(Schema.Number)]),
}) {}

describe("table", () => {
  it("creates metadata and infers Zero columns", () => {
    const users = table(User, {
      name: "users",
      serverName: "app_users",
      key: ["id"],
      columns: {
        active: false,
        optionalName: { name: "optional_name" },
      },
    });

    const inferred = inferTable(users);

    expect(inferred.name).toBe("users");
    expect(inferred.serverName).toBe("app_users");
    expect(inferred.primaryKey).toEqual(["id"]);
    expect(inferred.columns.id).toMatchObject({ type: "string", optional: false });
    expect(inferred.columns.name).toMatchObject({ type: "string", optional: false });
    expect(inferred.columns.age).toMatchObject({ type: "number", optional: false });
    expect(inferred.columns.role).toMatchObject({
      type: "string",
      optional: false,
      enumValues: ["admin", "member"],
    });
    expect(inferred.columns.broadRole).toMatchObject({ type: "string", optional: false });
    expect(inferred.columns.broadRole?.enumValues).toBeUndefined();
    expect(inferred.columns.tags).toMatchObject({ type: "json", optional: false });
    expect(inferred.columns.mixedArrays).toMatchObject({
      type: "json",
      customType: "ReadonlyJSONValue",
      optional: false,
    });
    expect(inferred.columns.optionalName).toMatchObject({
      type: "string",
      optional: true,
      serverName: "optional_name",
    });
    expect(inferred.columns.active).toBeUndefined();
  });

  it("throws for an empty key", () => {
    expect(() =>
      table(User, {
        name: "users",
        key: [],
      }),
    ).toThrow("Missing key");
  });

  it("keeps primary keys even when excluded", () => {
    const users = table(User, {
      name: "users",
      key: ["id"],
      columns: {
        id: false,
        name: false,
      },
    });

    expect(inferTable(users).columns.id).toMatchObject({ type: "string", optional: false });
    expect(inferTable(users).columns.name).toBeUndefined();
  });

  it("uses the override type when resolving custom types", () => {
    const users = table(User, {
      name: "users",
      key: ["id"],
      columns: {
        age: { type: "string" },
      },
    });

    expect(inferTable(users).columns.age).toMatchObject({
      type: "string",
      customType: "string",
    });
  });

  it("keeps inferred custom types when a column config repeats the inferred Zero type", () => {
    const users = table(User, {
      name: "users",
      key: ["id"],
      columns: {
        tags: { type: "json" },
      },
    });

    expect(inferTable(users).columns.tags).toMatchObject({
      type: "json",
      customType: "ReadonlyArray<string>",
    });
  });
});
