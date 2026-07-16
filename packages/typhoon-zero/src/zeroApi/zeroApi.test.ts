import { createBuilder, createSchema, number, string, table } from "@rocicorp/zero";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as ZeroApi from "./zeroApi";
import * as ZeroApiEndpoint from "./zeroApiEndpoint";
import * as ZeroApiGroup from "./zeroApiGroup";
import * as ZeroApiRegistry from "./zeroApiRegistry";

const zeroSchema = createSchema({
  tables: [
    table("item")
      .columns({
        id: string(),
        count: number(),
      })
      .primaryKey("id"),
  ],
});

const builder = createBuilder(zeroSchema);

const getItem = ZeroApiEndpoint.query("getItem", {
  request: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ id: Schema.String, count: Schema.Number }),
  query: ({ args }) => builder.item.where("id", "=", args.id).one(),
});

const getByCount = ZeroApiEndpoint.query("getByCount", {
  request: Schema.Struct({ count: Schema.NumberFromString }),
  success: Schema.Array(Schema.Struct({ id: Schema.String, count: Schema.Number })),
  query: ({ args }) => builder.item.where("count", "=", args.count),
});

const setCount = ZeroApiEndpoint.mutator("setCount", {
  request: Schema.Struct({ id: Schema.String, count: Schema.Number }),
  mutator: async ({ args, tx }) => {
    await tx.mutate.item!.update(args);
  },
});

const ItemsGroup = ZeroApiGroup.make("items").add(getItem, getByCount, setCount);
const TestApi = ZeroApi.make("test").add(ItemsGroup);

describe("ZeroApi", () => {
  it("preserves groups and endpoints by identifier", () => {
    expect(TestApi.groups.items).toBe(ItemsGroup);
    expect(ItemsGroup.endpoints.getItem).toBe(getItem);
    expect(ItemsGroup.endpoints.setCount).toBe(setCount);
  });

  it("generates callable query and mutator registries", () => {
    const queries = ZeroApiRegistry.toQueries(TestApi);
    const mutators = ZeroApiRegistry.toMutators(TestApi);

    const queryRequest = queries.items.getItem({ id: "item-1" });
    const mutateRequest = mutators.items.setCount({ id: "item-1", count: 2 });

    expect(queryRequest.args).toEqual({ id: "item-1" });
    expect(queryRequest.query.queryName).toBe("items.getItem");
    expect(mutateRequest.args).toEqual({ id: "item-1", count: 2 });
    expect(mutateRequest.mutator.mutatorName).toBe("items.setCount");
  });

  it("generates registries for only matching endpoint kinds", () => {
    const queries = ZeroApiRegistry.toQueries(TestApi) as any;
    const mutators = ZeroApiRegistry.toMutators(TestApi) as any;

    expect(queries.items.getItem).toBeTypeOf("function");
    expect(queries.items.getByCount).toBeTypeOf("function");
    expect(queries.items.setCount).toBeUndefined();
    expect(mutators.items.setCount).toBeTypeOf("function");
    expect(mutators.items.getItem).toBeUndefined();
  });

  it("validates encoded registry args before calling query definitions", () => {
    let receivedCount: number | undefined;
    const queryWithSideEffect = ZeroApiEndpoint.query("queryWithSideEffect", {
      request: Schema.Struct({ count: Schema.NumberFromString }),
      success: Schema.Array(Schema.Struct({ id: Schema.String, count: Schema.Number })),
      query: ({ args }) => {
        receivedCount = args.count;
        return builder.item.where("count", "=", args.count);
      },
    });
    const api = ZeroApi.make("test").add(ZeroApiGroup.make("items").add(queryWithSideEffect));
    const queries = ZeroApiRegistry.toQueries(api);
    const request = queries.items.queryWithSideEffect({ count: "3" });

    request.query.fn({ args: request.args, ctx: undefined });

    expect(receivedCount).toBe(3);
  });

  it("infers endpoint request and success types", () => {
    const request: ZeroApiEndpoint.RequestType<typeof getItem> = { id: "item-1" };
    const success: ZeroApiEndpoint.SuccessType<typeof getItem> = {
      id: "item-1",
      count: 1,
    };
    const mutatorRequest: ZeroApiEndpoint.RequestType<typeof setCount> = {
      id: "item-1",
      count: 1,
    };

    expect(request.id).toBe("item-1");
    expect(success.count).toBe(1);
    expect(mutatorRequest.count).toBe(1);
  });
});
