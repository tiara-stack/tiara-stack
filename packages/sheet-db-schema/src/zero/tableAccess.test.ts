import { Schema } from "effect";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { defineZeroTableAccess } from "./tableAccess";

const model = {
  insert: Schema.Struct({ id: Schema.String }),
  update: Schema.Struct({ id: Schema.String }),
  json: Schema.Struct({ id: Schema.String }),
  jsonCreate: Schema.Struct({ id: Schema.String }),
  jsonUpdate: Schema.Struct({ id: Schema.String }),
};

describe("defineZeroTableAccess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves existing createdAt and refreshes updatedAt on upsert", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(200);

    const access = defineZeroTableAccess(
      model,
      {},
      {
        primaryKey: ["id"],
        softDelete: "deletedAt",
        timestamps: {
          createdAt: "createdAt",
          updatedAt: "updatedAt",
        },
      },
    );

    expect(access.upsertWithTimestamps({ id: "1" }, { createdAt: 100 })).toEqual({
      id: "1",
      createdAt: 100,
      updatedAt: 200,
    });
  });

  it("normalizes existing createdAt to integer milliseconds on upsert", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(250);

    const access = defineZeroTableAccess(
      model,
      {},
      {
        primaryKey: ["id"],
        timestamps: {
          createdAt: "createdAt",
          updatedAt: "updatedAt",
        },
      },
    );

    expect(access.upsertWithTimestamps({ id: "1" }, { createdAt: 100.75 })).toEqual({
      id: "1",
      createdAt: 100,
      updatedAt: 250,
    });
  });

  it("initializes createdAt and updatedAt on new upserts", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(400);

    const access = defineZeroTableAccess(
      model,
      {},
      {
        primaryKey: ["id"],
        timestamps: {
          createdAt: "createdAt",
          updatedAt: "updatedAt",
        },
      },
    );

    expect(access.upsertWithTimestamps({ id: "1" })).toEqual({
      id: "1",
      createdAt: 400,
      updatedAt: 400,
    });
  });

  it("refreshes updatedAt on updates", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(500);

    const access = defineZeroTableAccess(
      model,
      {},
      {
        primaryKey: ["id"],
        timestamps: {
          createdAt: "createdAt",
          updatedAt: "updatedAt",
        },
      },
    );

    expect(access.updateWithTimestamp({ id: "1", name: "next" })).toEqual({
      id: "1",
      name: "next",
      updatedAt: 500,
    });
  });

  it("adds an active soft-delete filter when configured", () => {
    const access = defineZeroTableAccess(
      model,
      {},
      {
        primaryKey: ["id"],
        softDelete: "deletedAt",
      },
    );
    const query = {
      filters: [] as Array<readonly [string, string, unknown]>,
      where(field: string, operator: string, value: unknown) {
        this.filters.push([field, operator, value]);
        return this;
      },
    };

    expect(access.listActiveWhere(query).filters).toEqual([["deletedAt", "IS", null]]);
  });

  it("builds primary-key query filters", () => {
    const access = defineZeroTableAccess(
      model,
      {},
      {
        primaryKey: ["id", "scope"],
      },
    );
    const query = {
      filters: [] as Array<readonly [string, string, unknown]>,
      where(field: string, operator: string, value: unknown) {
        this.filters.push([field, operator, value]);
        return this;
      },
      one() {
        return this.filters;
      },
    };

    expect(access.getByPrimaryKey(query, { id: "1", scope: "main" })).toEqual([
      ["id", "=", "1"],
      ["scope", "=", "main"],
    ]);
  });

  it("builds active primary-key query filters", () => {
    const access = defineZeroTableAccess(
      model,
      {},
      {
        primaryKey: ["id"],
        softDelete: "deletedAt",
      },
    );
    const query = {
      filters: [] as Array<readonly [string, string, unknown]>,
      where(field: string, operator: string, value: unknown) {
        this.filters.push([field, operator, value]);
        return this;
      },
      one() {
        return this.filters;
      },
    };

    expect(access.getActiveByPrimaryKey(query, { id: "1" })).toEqual([
      ["id", "=", "1"],
      ["deletedAt", "IS", null],
    ]);
  });

  it("builds soft-delete updates with update timestamps", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(300);

    const access = defineZeroTableAccess(
      model,
      {},
      {
        primaryKey: ["id"],
        softDelete: "deletedAt",
        timestamps: {
          createdAt: "createdAt",
          updatedAt: "updatedAt",
        },
      },
    );

    expect(access.softDeleteByPrimaryKey({ id: "1" })).toEqual({
      id: "1",
      deletedAt: 300,
      updatedAt: 300,
    });
    expect(now).toHaveBeenCalledTimes(1);
  });
});
