import { createBuilder, createSchema, string, table } from "@rocicorp/zero";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as ZeroApi from "./zeroApi";
import * as ZeroApiEndpoint from "./zeroApiEndpoint";
import * as ZeroApiGroup from "./zeroApiGroup";
import { collectVisibleByGroup } from "./zeroApiTraversal";

const schema = createSchema({
  tables: [table("item").columns({ id: string() }).primaryKey("id")],
});
const zql = createBuilder(schema);

const publicQuery = ZeroApiEndpoint.query("publicQuery", {
  request: Schema.Void,
  success: Schema.Unknown,
  query: () => zql.item,
});
const publicMutation = ZeroApiEndpoint.mutator("publicMutation", {
  request: Schema.Void,
  mutator: () => Promise.resolve(),
});
const serviceMutation = ZeroApiEndpoint.mutator("serviceMutation", {
  visibility: "service",
  request: Schema.Void,
  mutator: () => Promise.resolve(),
});
const internalMutation = ZeroApiEndpoint.mutator("internalMutation", {
  visibility: "internal",
  request: Schema.Void,
  mutator: () => Promise.resolve(),
});

const Api = ZeroApi.make("test").add(
  ZeroApiGroup.make("mixed").add(publicQuery, publicMutation, serviceMutation),
  ZeroApiGroup.make("internalOnly").add(internalMutation),
);

describe("collectVisibleByGroup", () => {
  it("filters endpoint visibility and prunes empty groups", () => {
    const collected = collectVisibleByGroup(
      Api,
      ["public"],
      (group, endpoint) => `${group.identifier}.${endpoint.name}`,
    );

    expect(collected).toEqual({
      mixed: {
        publicMutation: "mixed.publicMutation",
        publicQuery: "mixed.publicQuery",
      },
    });
    expect(collected).not.toHaveProperty("internalOnly");
    expect(collected.mixed).not.toHaveProperty("serviceMutation");
  });

  it("narrows endpoints through the include type guard", () => {
    const collected = collectVisibleByGroup<
      ZeroApiEndpoint.AnyMutator,
      ZeroApiEndpoint.AnyMutator["mutator"]
    >(
      Api,
      ["public", "service"],
      (_group, endpoint) => endpoint.mutator,
      ZeroApiEndpoint.isKind("mutator"),
    );
    const mutations = collected.mixed!;

    expect(Object.keys(mutations)).toEqual(["publicMutation", "serviceMutation"]);

    const internal = collectVisibleByGroup(Api, ["internal"], (_group, endpoint) => endpoint.name);
    expect(internal).toEqual({
      internalOnly: {
        internalMutation: "internalMutation",
      },
    });
  });
});
