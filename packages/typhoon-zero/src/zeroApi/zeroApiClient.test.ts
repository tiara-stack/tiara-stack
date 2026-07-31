import {
  createBuilder,
  createSchema,
  number,
  string,
  table,
  type MutateRequest,
  type QueryOrQueryRequest,
  type RunOptions,
  type Schema as ZeroSchema,
} from "@rocicorp/zero";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Predicate, Schema, Stream } from "effect";
import * as ZeroClient from "../client/zeroClient";
import * as ZeroApi from "./zeroApi";
import * as ZeroApiClient from "./zeroApiClient";
import * as ZeroApiEndpoint from "./zeroApiEndpoint";
import * as ZeroApiGroup from "./zeroApiGroup";
import * as ZeroApiRegistry from "./zeroApiRegistry";
import * as ZeroFunctionReference from "./zeroFunctionReference";

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

const serviceItem = ZeroApiEndpoint.query("serviceItem", {
  visibility: "service",
  request: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ id: Schema.String, count: Schema.Number }),
  query: ({ args }) => builder.item.where("id", "=", args.id).one(),
});

const internalSetCount = ZeroApiEndpoint.mutator("internalSetCount", {
  visibility: "internal",
  request: Schema.Struct({ id: Schema.String, count: Schema.Number }),
  mutator: async ({ args, tx }) => {
    await tx.mutate.item!.update(args);
  },
});

const OperationsGroup = ZeroApiGroup.make("operations").add(serviceItem, internalSetCount);
const PrivilegedApi = ZeroApi.make("privileged").add(ItemsGroup, OperationsGroup);

type FakeZeroClient = ZeroClient.ZeroClient<ZeroSchema, any, any>;

const provideFakeZero = <A, E>(
  effect: Effect.Effect<A, E, ZeroClient.ZeroClientTag<ZeroSchema, any, any>>,
  service: FakeZeroClient,
) =>
  Effect.provideService(
    effect,
    ZeroClient.ZeroClient<ZeroSchema, any, any>(),
    service,
  ) as Effect.Effect<A, E, never>;

const makeFakeZeroClient = (options: Partial<FakeZeroClient>): FakeZeroClient =>
  ({
    zero: {} as never,
    run: () => Effect.void,
    stream: () => Stream.empty,
    mutate: () =>
      Effect.succeed({
        client: () => Effect.void,
        server: () => Effect.void,
      }),
    ...options,
  }) as FakeZeroClient;

describe("ZeroApiClient", () => {
  it.effect(
    "decodes query success values",
    Effect.fnUntraced(function* () {
      const client = yield* provideFakeZero(
        ZeroApiClient.make(TestApi),
        makeFakeZeroClient({
          run: (() => Effect.succeed({ id: "item-1", count: 1 })) as FakeZeroClient["run"],
        }),
      );

      const result = yield* client.items.getItem({ id: "item-1" });

      expect(result).toEqual({ id: "item-1", count: 1 });
    }),
  );

  it.effect(
    "fails query methods on invalid success values",
    Effect.fnUntraced(function* () {
      const client = yield* provideFakeZero(
        ZeroApiClient.make(TestApi),
        makeFakeZeroClient({
          run: (() => Effect.succeed({ id: "item-1", count: "bad" })) as FakeZeroClient["run"],
        }),
      );

      const exit = yield* Effect.exit(client.items.getItem({ id: "item-1" }));

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect(
    "encodes query request values before building Zero requests",
    Effect.fnUntraced(function* () {
      let capturedArgs: unknown;
      const client = yield* provideFakeZero(
        ZeroApiClient.make(TestApi),
        makeFakeZeroClient({
          run: ((request: QueryOrQueryRequest<any, any, any, any, any, any>) => {
            capturedArgs = "args" in request ? request.args : undefined;
            return Effect.succeed([{ id: "item-1", count: 3 }]);
          }) as FakeZeroClient["run"],
        }),
      );

      const result = yield* client.items.getByCount({ count: 3 });

      expect(capturedArgs).toEqual({ count: "3" });
      expect(result).toEqual([{ id: "item-1", count: 3 }]);
    }),
  );

  it.effect("exposes query construction without materializing the result", () =>
    Effect.gen(function* () {
      let runCount = 0;
      const client = yield* provideFakeZero(
        ZeroApiClient.make(TestApi),
        makeFakeZeroClient({
          run: (() => {
            runCount++;
            return Effect.succeed([]);
          }) as FakeZeroClient["run"],
        }),
      );

      const request = yield* client.items.getByCount.query({ count: 3 });

      expect("args" in request ? request.args : undefined).toEqual({ count: "3" });
      expect(runCount).toBe(0);
    }),
  );

  it.effect("invokes public function references through the general client", () =>
    Effect.gen(function* () {
      const grouped = yield* provideFakeZero(
        ZeroApiClient.make(TestApi),
        makeFakeZeroClient({
          run: (() => Effect.succeed({ id: "item-1", count: 4 })) as FakeZeroClient["run"],
        }),
      );
      const client = ZeroApiClient.makeFunctionClient(grouped);
      const api = ZeroFunctionReference.makeReferences(TestApi, ["public"]);

      const result = yield* client.fetch(api.items.getItem, { id: "item-1" });

      expect(result).toEqual({ id: "item-1", count: 4 });
    }),
  );

  it.effect("prunes hidden groups and exposes explicitly selected privileged functions", () =>
    Effect.gen(function* () {
      let mutationRuns = 0;
      const client = yield* ZeroApiClient.makeFunctionsWithVisibilities(
        PrivilegedApi,
        makeFakeZeroClient({
          run: (() => Effect.succeed({ id: "item-1", count: 4 })) as FakeZeroClient["run"],
          mutate: (() =>
            Effect.succeed({
              client: () => Effect.void,
              server: () =>
                Effect.sync(() => {
                  mutationRuns++;
                }),
            })) as FakeZeroClient["mutate"],
        }),
        { visibilities: ["service", "internal"] },
      );
      const privileged = ZeroFunctionReference.makeReferences(PrivilegedApi, [
        "service",
        "internal",
      ]);

      expect(Object.keys(client.grouped).sort()).toEqual(["operations"]);
      expect(Object.keys(client.grouped.operations).sort()).toEqual([
        "internalSetCount",
        "serviceItem",
      ]);
      expect(yield* client.fetch(privileged.operations.serviceItem, { id: "item-1" })).toEqual({
        id: "item-1",
        count: 4,
      });
      yield* client.execute(privileged.operations.internalSetCount, {
        id: "item-1",
        count: 5,
      });
      expect(mutationRuns).toBe(1);
    }),
  );

  it.effect("fails when a visible query is missing from an explicit registry", () =>
    Effect.gen(function* () {
      const exit = yield* ZeroApiClient.makeWithVisibilities(
        PrivilegedApi,
        makeFakeZeroClient({}),
        {
          visibilities: ["service", "internal"],
          queries: { operations: {} } as never,
        },
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          'No query registry method found for visible endpoint "operations.serviceItem"',
        );
      }
    }),
  );

  it.effect("dies when a function reference has no registered client method", () =>
    Effect.gen(function* () {
      const client = yield* ZeroApiClient.makeFunctionsWithVisibilities(
        PrivilegedApi,
        makeFakeZeroClient({}),
        { visibilities: ["service"] },
      );
      const publicReferences = ZeroFunctionReference.makeReferences(PrivilegedApi, ["public"]);
      const fetch = client.fetch as (
        reference: ZeroFunctionReference.AnyQueryReference,
        args: unknown,
      ) => Effect.Effect<unknown, ZeroApiClient.QueryError>;

      const exit = yield* Effect.exit(fetch(publicReferences.items.getItem, { id: "item-1" }));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.some(
            (reason) =>
              Cause.isDieReason(reason) &&
              Predicate.isError(reason.defect) &&
              reason.defect.message.includes(
                'No client method registered for function reference "items.getItem"',
              ),
          ),
        ).toBe(true);
        expect(Cause.pretty(exit.cause)).toContain(
          'No client method registered for function reference "items.getItem"',
        );
      }
    }),
  );

  it.effect("decodes reactive query updates through function references", () =>
    Effect.gen(function* () {
      let capturedRunOptions: RunOptions | undefined;
      const grouped = yield* provideFakeZero(
        ZeroApiClient.make(TestApi),
        makeFakeZeroClient({
          stream: ((_query, runOptions) => {
            capturedRunOptions = runOptions;
            return Stream.make({ id: "item-1", count: 1 }, { id: "item-1", count: 2 });
          }) as FakeZeroClient["stream"],
        }),
      );
      const client = ZeroApiClient.makeFunctionClient(grouped);
      const api = ZeroFunctionReference.makeReferences(TestApi, ["public"]);

      const updates = yield* client
        .stream(api.items.getItem, { id: "item-1" })
        .pipe(Stream.runCollect);

      expect(updates).toEqual([
        { id: "item-1", count: 1 },
        { id: "item-1", count: 2 },
      ]);
      expect(capturedRunOptions).toEqual({ type: "complete" });
    }),
  );

  it.effect("propagates reactive query decoding failures", () =>
    Effect.gen(function* () {
      const grouped = yield* provideFakeZero(
        ZeroApiClient.make(TestApi),
        makeFakeZeroClient({
          stream: (() => Stream.make({ id: "item-1", count: "bad" })) as FakeZeroClient["stream"],
        }),
      );
      const client = ZeroApiClient.makeFunctionClient(grouped);
      const api = ZeroFunctionReference.makeReferences(TestApi, ["public"]);

      const exit = yield* client
        .stream(api.items.getItem, { id: "item-1" })
        .pipe(Stream.runCollect, Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isFailReason(reason) && Schema.isSchemaError(reason.error),
          ),
        ).toBe(true);
        expect(Cause.pretty(exit.cause)).toContain("count");
      }
    }),
  );

  it.effect(
    "runs the server mutation phase by default",
    Effect.fnUntraced(function* () {
      let clientRuns = 0;
      let serverRuns = 0;
      let capturedArgs: unknown;
      const client = yield* provideFakeZero(
        ZeroApiClient.make(TestApi),
        makeFakeZeroClient({
          mutate: (request: MutateRequest<any, any, any, any>) => {
            capturedArgs = request.args;
            return Effect.succeed({
              client: () =>
                Effect.sync(() => {
                  clientRuns++;
                }),
              server: () =>
                Effect.sync(() => {
                  serverRuns++;
                }),
            });
          },
        }),
      );

      yield* client.items.setCount({ id: "item-1", count: 2 });

      expect(capturedArgs).toEqual({ id: "item-1", count: 2 });
      expect(clientRuns).toBe(0);
      expect(serverRuns).toBe(1);
    }),
  );

  it.effect(
    "uses supplied mutator registries when building mutation requests",
    Effect.fnUntraced(function* () {
      let capturedMutator: unknown;
      const registeredMutators = ZeroApiRegistry.toMutators(TestApi);
      const client = yield* ZeroApiClient.makeWithService(
        TestApi,
        {
          run: makeFakeZeroClient({}).run,
          stream: makeFakeZeroClient({}).stream,
          mutate: ((request: MutateRequest<any, any, any, any>) => {
            capturedMutator = request.mutator;
            return Effect.succeed({
              client: () => Effect.void,
              server: () => Effect.void,
            });
          }) as FakeZeroClient["mutate"],
        },
        { mutators: registeredMutators },
      );

      yield* client.items.setCount({ id: "item-1", count: 2 });

      expect(capturedMutator).toBe(registeredMutators.items.setCount);
    }),
  );

  it.effect(
    "exposes explicit mutation phases through mutate",
    Effect.fnUntraced(function* () {
      let clientRuns = 0;
      let serverRuns = 0;
      const client = yield* provideFakeZero(
        ZeroApiClient.make(TestApi),
        makeFakeZeroClient({
          mutate: (() =>
            Effect.succeed({
              client: () =>
                Effect.sync(() => {
                  clientRuns++;
                }),
              server: () =>
                Effect.sync(() => {
                  serverRuns++;
                }),
            })) as FakeZeroClient["mutate"],
        }),
      );

      const mutation = yield* client.items.setCount.mutate({ id: "item-1", count: 2 });
      yield* mutation.client();
      yield* mutation.server();

      expect(clientRuns).toBe(1);
      expect(serverRuns).toBe(1);
    }),
  );

  it.effect(
    "keeps mixed query and mutator endpoints under one group",
    Effect.fnUntraced(function* () {
      const client = yield* provideFakeZero(ZeroApiClient.make(TestApi), makeFakeZeroClient({}));

      expect(client.items.getItem).toBeTypeOf("function");
      expect(client.items.getByCount).toBeTypeOf("function");
      expect(client.items.getByCount.query).toBeTypeOf("function");
      expect(client.items.getByCount.stream).toBeTypeOf("function");
      expect(client.items.setCount).toBeTypeOf("function");
      expect(client.items.setCount.mutate).toBeTypeOf("function");
    }),
  );
});
