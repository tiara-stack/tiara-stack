import { createBuilder, createSchema, string, table } from "@rocicorp/zero";
import { Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as ZeroApi from "./zeroApi";
import * as ZeroApiAtom from "./zeroApiAtom";
import type * as ZeroApiClient from "./zeroApiClient";
import * as ZeroApiEndpoint from "./zeroApiEndpoint";
import * as ZeroApiGroup from "./zeroApiGroup";
import * as ZeroApiRegistry from "./zeroApiRegistry";
import * as ZeroFunctionReference from "./zeroFunctionReference";

const schema = createSchema({
  tables: [table("item").columns({ id: string() }).primaryKey("id")],
});
const zql = createBuilder(schema);

const ItemsGroup = ZeroApiGroup.make("items").add(
  ZeroApiEndpoint.query("get", {
    request: Schema.Struct({ id: Schema.String }),
    success: Schema.Unknown,
    query: ({ args }) => zql.item.where("id", "=", args.id).one(),
  }),
  ZeroApiEndpoint.query("list", {
    request: Schema.Void,
    success: Schema.Unknown,
    query: () => zql.item,
  }),
  ZeroApiEndpoint.query("flexible", {
    request: Schema.Unknown,
    success: Schema.Unknown,
    query: () => zql.item,
  }),
  ZeroApiEndpoint.mutator("serviceWrite", {
    visibility: "service",
    request: Schema.Struct({ id: Schema.String }),
    mutator: () => Promise.resolve(),
  }),
  ZeroApiEndpoint.mutator("internalWrite", {
    visibility: "internal",
    request: Schema.Struct({ id: Schema.String }),
    mutator: () => Promise.resolve(),
  }),
);
const Api = ZeroApi.make("test").add(ItemsGroup);
const OtherApi = ZeroApi.make("other").add(ItemsGroup);

describe("ZeroFunctionReference", () => {
  it("builds separate visibility catalogs", () => {
    const api = ZeroFunctionReference.makeReferences(Api, ["public"]);
    const service = ZeroFunctionReference.makeReferences(Api, ["service"]);
    const internal = ZeroFunctionReference.makeReferences(Api, ["internal"]);
    const privileged = ZeroFunctionReference.makeReferences(Api, ["service", "internal"]);

    expect(Object.keys(api.items)).toEqual(["get", "list", "flexible"]);
    expect(Object.keys(service.items)).toEqual(["serviceWrite"]);
    expect(Object.keys(internal.items)).toEqual(["internalWrite"]);
    expect(Object.keys(privileged.items)).toEqual(["serviceWrite", "internalWrite"]);
    expect(api.items.get).toMatchObject({
      api: "test",
      group: "items",
      kind: "query",
      name: "get",
      visibility: "public",
    });
  });

  it("registers only public functions unless privileged visibility is explicit", () => {
    const defaultMutators = ZeroApiRegistry.toMutators(Api);
    const privilegedMutators = ZeroApiRegistry.toMutators(Api, {
      visibilities: ["service", "internal"],
    });

    expect("items" in (defaultMutators as object)).toBe(false);
    expect("serviceWrite" in privilegedMutators.items).toBe(true);
    expect("internalWrite" in privilegedMutators.items).toBe(true);
  });

  it("reuses query atoms for the same client, reference, and arguments", () => {
    const api = ZeroFunctionReference.makeReferences(Api, ["public"]);
    const client = {
      stream: () => Stream.empty,
    } as unknown as ZeroApiClient.FunctionClient<typeof Api, "public">;
    const first = ZeroApiAtom.makeQuery(client, api.items.get, { id: "item-1" });
    const equivalentApi = ZeroFunctionReference.makeReferences(Api, ["public"]);
    const otherApi = ZeroFunctionReference.makeReferences(OtherApi, ["public"]);
    const noArgs = ZeroApiAtom.makeQuery(client, api.items.list);

    expect(first).toBe(ZeroApiAtom.makeQuery(client, api.items.get, { id: "item-1" }));
    expect(first).toBe(ZeroApiAtom.makeQuery(client, equivalentApi.items.get, { id: "item-1" }));
    expect(first).not.toBe(ZeroApiAtom.makeQuery(client, api.items.get, { id: "item-2" }));
    expect(first).not.toBe(
      ZeroApiAtom.makeQuery(
        client as unknown as ZeroApiClient.FunctionClient<typeof OtherApi, "public">,
        otherApi.items.get,
        { id: "item-1" },
      ),
    );
    expect(first).not.toBe(noArgs);
    expect(noArgs).toBe(ZeroApiAtom.makeQuery(client, api.items.list, undefined));
  });

  it("uses type-safe structural keys for atom arguments", () => {
    const api = ZeroFunctionReference.makeReferences(Api, ["public"]);
    const streamedArguments: Array<unknown> = [];
    const client = {
      stream: (_reference: unknown, argument: unknown) => {
        streamedArguments.push(argument);
        return Stream.empty;
      },
    } as unknown as ZeroApiClient.FunctionClient<typeof Api, "public">;
    const iso = "2026-07-29T00:00:00.000Z";
    const ordered = ZeroApiAtom.makeQuery(client, api.items.flexible, { a: 1, b: 2 });

    expect(ordered).toBe(ZeroApiAtom.makeQuery(client, api.items.flexible, { b: 2, a: 1 }));
    expect(ZeroApiAtom.makeQuery(client, api.items.flexible, 1)).not.toBe(
      ZeroApiAtom.makeQuery(client, api.items.flexible, "1"),
    );
    expect(ZeroApiAtom.makeQuery(client, api.items.flexible, 0)).not.toBe(
      ZeroApiAtom.makeQuery(client, api.items.flexible, -0),
    );
    expect(ZeroApiAtom.makeQuery(client, api.items.flexible, iso)).not.toBe(
      ZeroApiAtom.makeQuery(client, api.items.flexible, new Date(iso)),
    );
    expect(ZeroApiAtom.makeQuery(client, api.items.flexible, {})).not.toBe(
      ZeroApiAtom.makeQuery(client, api.items.flexible, { key: undefined }),
    );
    expect(ZeroApiAtom.makeQuery(client, api.items.flexible, [undefined])).not.toBe(
      ZeroApiAtom.makeQuery(client, api.items.flexible, [null]),
    );
    expect(streamedArguments).toContainEqual({ a: 1, b: 2 });
    expect(() => ZeroApiAtom.makeQuery(client, api.items.flexible, new Map())).toThrow(
      "Unsupported Zero atom argument",
    );
  });
});
