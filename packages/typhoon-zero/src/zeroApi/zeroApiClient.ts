import type {
  MutatorRegistry,
  MutateRequest,
  QueryRegistry,
  QueryOrQueryRequest,
  RunOptions,
  Schema as ZeroSchema,
} from "@rocicorp/zero";
import { Context, Effect, Match, Predicate, Schema, Stream } from "effect";
import * as ZeroApi from "./zeroApi";
import * as ZeroApiEndpoint from "./zeroApiEndpoint";
import * as ZeroApiGroup from "./zeroApiGroup";
import * as ZeroApiRegistry from "./zeroApiRegistry";
import { collectVisibleByGroup } from "./zeroApiTraversal";
import * as ZeroFunctionReference from "./zeroFunctionReference";
import type { OptionalArgs } from "./zeroApiClientTypes";
import {
  type MutatorError,
  MutatorResultAppError,
  MutatorResultZeroError,
  type QueryError,
} from "./zeroApiError";
import * as ZeroClient from "../client/zeroClient";

export type { QueryError, MutatorError } from "./zeroApiError";

type ServiceContext = ZeroClient.ZeroClientTag<ZeroSchema, any, any>;

/**
 * Registry overrides for advanced Zero API client construction.
 *
 * These allow callers to reuse the same query or mutator registry instances
 * passed to Zero, which preserves object identity for mutator validation. The
 * registry shapes are intentionally dynamic, so these options stay typed as
 * `any`.
 */
interface ClientRegistryOptions<
  Api extends ZeroApi.Any,
  Visibility extends ZeroApiEndpoint.Visibility,
> {
  readonly queries?: QueryRegistry<ZeroApiRegistry.QueryDefinitionsForApi<Api, Visibility>, any>;
  readonly mutators?: MutatorRegistry<
    ZeroApiRegistry.MutatorDefinitionsForApi<Api, Visibility>,
    any
  >;
}

interface VisibleClientRegistryOptions<
  Api extends ZeroApi.Any,
  Visibility extends ZeroApiEndpoint.Visibility,
> extends ClientRegistryOptions<Api, Visibility> {
  readonly visibilities: readonly Visibility[];
}

type RunMutationPhase = () => Effect.Effect<void, MutatorError, never>;

export interface MutatorClientMethod<Args> {
  (...args: OptionalArgs<Args>): Effect.Effect<void, MutatorError, never>;
  readonly mutate: (...args: OptionalArgs<Args>) => Effect.Effect<
    {
      readonly client: RunMutationPhase;
      readonly server: RunMutationPhase;
    },
    Schema.SchemaError,
    never
  >;
}

export interface QueryClientMethod<Args, Success> {
  (...args: OptionalArgs<Args>): Effect.Effect<Success, QueryError, never>;
  readonly query: (
    ...args: OptionalArgs<Args>
  ) => Effect.Effect<QueryOrQueryRequest<any, any, any, any, any, any>, Schema.SchemaError, never>;
  readonly stream: (...args: OptionalArgs<Args>) => Stream.Stream<Success, QueryError>;
}

export type ClientEndpoint<Endpoint extends ZeroApiEndpoint.Any> =
  Endpoint extends ZeroApiEndpoint.AnyQuery
    ? QueryClientMethod<
        ZeroApiEndpoint.RequestType<Endpoint>,
        ZeroApiEndpoint.SuccessType<Endpoint>
      >
    : Endpoint extends ZeroApiEndpoint.AnyMutator
      ? MutatorClientMethod<ZeroApiEndpoint.RequestType<Endpoint>>
      : never;

type EndpointNames<
  Group extends ZeroApiGroup.Any,
  Visibility extends ZeroApiEndpoint.Visibility,
> = ZeroApiEndpoint.VisibleName<ZeroApiGroup.Endpoints<Group>, Visibility>;

type EndpointWithName<Group extends ZeroApiGroup.Any, Name extends string> = Extract<
  ZeroApiGroup.Endpoints<Group>,
  { readonly name: Name }
>;

export type ClientGroup<
  Group extends ZeroApiGroup.Any,
  Visibility extends ZeroApiEndpoint.Visibility,
> = {
  readonly [Name in EndpointNames<Group, Visibility>]: ClientEndpoint<
    EndpointWithName<Group, Name>
  >;
};

export type Client<
  Api extends ZeroApi.Any,
  Visibility extends ZeroApiEndpoint.Visibility = "public",
> = {
  readonly [Group in ZeroApi.Groups<Api> as keyof ClientGroup<Group, Visibility> extends never
    ? never
    : Group["identifier"]]: ClientGroup<Group, Visibility>;
};

const defaultRunOptions: RunOptions = { type: "complete" };

const flattenMutationPhase = (
  phase: () => Effect.Effect<
    void | MutatorResultAppError | MutatorResultZeroError,
    MutatorError,
    never
  >,
): RunMutationPhase =>
  Effect.fn("ZeroApiClient.mutationPhase")(function* () {
    const result = yield* phase();
    if (result instanceof MutatorResultAppError || result instanceof MutatorResultZeroError) {
      return yield* result;
    }
  });

const getArgs = (args: readonly unknown[]): unknown => (args.length > 0 ? args[0] : undefined);

const defineMethodProperty = (
  target: object,
  name: "mutate" | "query" | "stream",
  value: unknown,
) => {
  Object.defineProperty(target, name, {
    value,
    configurable: true,
    enumerable: true,
    writable: false,
  });
};

const makeQueryMethod = (
  zeroClient: ZeroClient.ZeroClientExecutor<any, any>,
  registryMethod: (args?: unknown) => QueryOrQueryRequest<any, any, any, any, any, any>,
  group: ZeroApiGroup.Any,
  endpoint: ZeroApiEndpoint.AnyQuery,
) => {
  const runOptions = endpoint.runOptions ?? defaultRunOptions;
  const query = Effect.fn(`ZeroApiClient.${group.identifier}.${endpoint.name}.query`)(function* (
    ...args: readonly unknown[]
  ) {
    const encoded = yield* Schema.encodeEffect(endpoint.request)(getArgs(args));
    return registryMethod(encoded as any);
  });
  const method = Effect.fn(`ZeroApiClient.${group.identifier}.${endpoint.name}`)(function* (
    ...args: readonly unknown[]
  ) {
    const queryRequest = yield* query(...args);
    const result = yield* zeroClient.run(queryRequest, runOptions);
    return yield* Schema.decodeUnknownEffect(endpoint.success)(result);
  });
  const streamEffect = Effect.fn(`ZeroApiClient.${group.identifier}.${endpoint.name}.stream`)(
    function* (...args: readonly unknown[]) {
      const queryRequest = yield* query(...args);
      return zeroClient
        .stream(queryRequest, runOptions)
        .pipe(Stream.mapEffect((value) => Schema.decodeUnknownEffect(endpoint.success)(value)));
    },
  );

  defineMethodProperty(method, "query", query);
  defineMethodProperty(method, "stream", (...args: readonly unknown[]) =>
    Stream.unwrap(streamEffect(...args)),
  );

  return method as QueryClientMethod<unknown, unknown>;
};

const makeMutatorMethod = (
  zeroClient: ZeroClient.ZeroClientExecutor<any, any>,
  registryMethod: (args?: unknown) => MutateRequest<any, any, any, any>,
  group: ZeroApiGroup.Any,
  endpoint: ZeroApiEndpoint.AnyMutator,
) => {
  const mutate = Effect.fn(`ZeroApiClient.${group.identifier}.${endpoint.name}.mutate`)(function* (
    ...args: readonly unknown[]
  ) {
    const encoded = yield* Schema.encodeEffect(endpoint.request)(getArgs(args));
    const mutation = yield* zeroClient.mutate(registryMethod(encoded as any));
    return {
      client: flattenMutationPhase(mutation.client),
      server: flattenMutationPhase(mutation.server),
    };
  });

  const method = Effect.fn(`ZeroApiClient.${group.identifier}.${endpoint.name}`)(function* (
    ...args: readonly unknown[]
  ) {
    const mutation = yield* mutate(...args);
    return yield* mutation.server();
  });

  defineMethodProperty(method, "mutate", mutate);

  return method as MutatorClientMethod<unknown>;
};

const requireRegistryMethod = (
  registry: Record<string, Record<string, unknown>>,
  group: ZeroApiGroup.Any,
  endpoint: ZeroApiEndpoint.Any,
) => {
  const method = registry[group.identifier]?.[endpoint.name];
  if (Predicate.isUndefined(method)) {
    throw new Error(
      `No ${endpoint.kind} registry method found for visible endpoint "${group.identifier}.${endpoint.name}"`,
    );
  }
  return method;
};

const makeClientEndpoint = (
  zeroClient: ZeroClient.ZeroClientExecutor<any, any>,
  queries: Record<string, Record<string, unknown>>,
  mutators: Record<string, Record<string, unknown>>,
  group: ZeroApiGroup.Any,
  endpoint: ZeroApiEndpoint.Any,
) =>
  Match.value(endpoint).pipe(
    Match.discriminatorsExhaustive("kind")({
      query: (queryEndpoint) => {
        const registryMethod = requireRegistryMethod(queries, group, queryEndpoint);
        return makeQueryMethod(zeroClient, registryMethod as any, group, queryEndpoint);
      },
      mutator: (mutatorEndpoint) => {
        const registryMethod = requireRegistryMethod(mutators, group, mutatorEndpoint);
        return makeMutatorMethod(zeroClient, registryMethod as any, group, mutatorEndpoint);
      },
    }),
  );

const makeClient = <Api extends ZeroApi.Any, Visibility extends ZeroApiEndpoint.Visibility>(
  api: Api,
  zeroClient: ZeroClient.ZeroClientExecutor<any, any>,
  visibilities: readonly Visibility[],
  registryOptions?: ClientRegistryOptions<Api, Visibility>,
): Client<Api, Visibility> => {
  const queries = (registryOptions?.queries ??
    ZeroApiRegistry.toQueries(api, { visibilities })) as Record<string, Record<string, unknown>>;
  const mutators = (registryOptions?.mutators ??
    ZeroApiRegistry.toMutators(api, { visibilities })) as Record<string, Record<string, unknown>>;
  return collectVisibleByGroup(api, visibilities, (group, endpoint) =>
    makeClientEndpoint(zeroClient, queries, mutators, group, endpoint),
  ) as Client<Api, Visibility>;
};

const publicVisibilities = ["public"] as const;

export const makeWithService = <Api extends ZeroApi.Any>(
  api: Api,
  zeroClient: ZeroClient.ZeroClientExecutor<any, any>,
  registryOptions?: ClientRegistryOptions<Api, "public">,
): Effect.Effect<Client<Api, "public">, never, never> =>
  Effect.sync(() => makeClient(api, zeroClient, publicVisibilities, registryOptions));

export const makeWithVisibilities = <
  Api extends ZeroApi.Any,
  Visibility extends ZeroApiEndpoint.Visibility,
>(
  api: Api,
  zeroClient: ZeroClient.ZeroClientExecutor<any, any>,
  registryOptions: VisibleClientRegistryOptions<Api, Visibility>,
): Effect.Effect<Client<Api, Visibility>, never, never> =>
  Effect.sync(() =>
    makeClient<Api, Visibility>(api, zeroClient, registryOptions.visibilities, registryOptions),
  );

export const make = <Api extends ZeroApi.Any>(
  api: Api,
): Effect.Effect<Client<Api, "public">, never, ServiceContext> =>
  Effect.gen(function* () {
    const zeroClient = yield* ZeroClient.ZeroClient<ZeroSchema, any, any>();
    return yield* makeWithService(api, zeroClient);
  });

export const Service =
  <Self>() =>
  <const Id extends string, Api extends ZeroApi.Any>(
    id: Id,
    options: {
      readonly api: Api;
    },
  ) =>
    Context.Service<Self, Client<Api, "public">>()(id, {
      make: make(options.api),
    });

export interface FunctionClient<
  Api extends ZeroApi.Any,
  Visibility extends ZeroApiEndpoint.Visibility = "public",
> {
  readonly query: <Reference extends ZeroFunctionReference.QueryForApi<Api, Visibility>>(
    reference: Reference,
    ...args: OptionalArgs<ZeroApiEndpoint.RequestType<Reference["endpoint"]>>
  ) => Effect.Effect<ZeroApiEndpoint.QueryRequest<Reference["endpoint"]>, Schema.SchemaError>;
  readonly fetch: <Reference extends ZeroFunctionReference.QueryForApi<Api, Visibility>>(
    reference: Reference,
    ...args: OptionalArgs<ZeroApiEndpoint.RequestType<Reference["endpoint"]>>
  ) => Effect.Effect<ZeroApiEndpoint.SuccessType<Reference["endpoint"]>, QueryError>;
  readonly stream: <Reference extends ZeroFunctionReference.QueryForApi<Api, Visibility>>(
    reference: Reference,
    ...args: OptionalArgs<ZeroApiEndpoint.RequestType<Reference["endpoint"]>>
  ) => Stream.Stream<ZeroApiEndpoint.SuccessType<Reference["endpoint"]>, QueryError>;
  readonly mutate: <Reference extends ZeroFunctionReference.MutatorForApi<Api, Visibility>>(
    reference: Reference,
    ...args: OptionalArgs<ZeroApiEndpoint.RequestType<Reference["endpoint"]>>
  ) => Effect.Effect<
    {
      readonly client: RunMutationPhase;
      readonly server: RunMutationPhase;
    },
    Schema.SchemaError
  >;
  readonly execute: <Reference extends ZeroFunctionReference.MutatorForApi<Api, Visibility>>(
    reference: Reference,
    ...args: OptionalArgs<ZeroApiEndpoint.RequestType<Reference["endpoint"]>>
  ) => Effect.Effect<void, MutatorError>;
  readonly grouped: Client<Api, Visibility>;
}

export const makeFunctionClient = <
  Api extends ZeroApi.Any,
  Visibility extends ZeroApiEndpoint.Visibility = "public",
>(
  grouped: Client<Api, Visibility>,
): FunctionClient<Api, Visibility> => {
  const method = (reference: ZeroFunctionReference.AnyFunctionReference) =>
    Effect.suspend(() => {
      const found = (grouped as Record<string, Record<string, unknown>>)[reference.group]?.[
        reference.name
      ];
      return Predicate.isUndefined(found)
        ? Effect.die(
            new Error(
              `No client method registered for function reference "${reference.group}.${reference.name}"`,
            ),
          )
        : Effect.succeed(found);
    });

  const invoke = <A, E>(
    reference: ZeroFunctionReference.AnyFunctionReference,
    args: readonly unknown[],
    call: (registered: unknown, args: OptionalArgs<unknown>) => Effect.Effect<A, E, never>,
  ): Effect.Effect<A, E, never> =>
    method(reference).pipe(
      Effect.flatMap((registered) => call(registered, args as OptionalArgs<unknown>)),
    );

  const client = {
    query: (reference: ZeroFunctionReference.AnyQueryReference, ...args: readonly unknown[]) =>
      invoke(reference, args, (registered, optionalArgs) =>
        (registered as QueryClientMethod<unknown, unknown>).query(...optionalArgs),
      ),
    fetch: (reference: ZeroFunctionReference.AnyQueryReference, ...args: readonly unknown[]) =>
      invoke(reference, args, (registered, optionalArgs) =>
        (registered as QueryClientMethod<unknown, unknown>)(...optionalArgs),
      ) as Effect.Effect<any, QueryError>,
    stream: (reference: ZeroFunctionReference.AnyQueryReference, ...args: readonly unknown[]) =>
      Stream.unwrap(
        invoke(reference, args, (registered, optionalArgs) =>
          Effect.succeed(
            (registered as QueryClientMethod<unknown, unknown>).stream(...optionalArgs),
          ),
        ),
      ) as Stream.Stream<any, QueryError>,
    mutate: (reference: ZeroFunctionReference.AnyMutatorReference, ...args: readonly unknown[]) =>
      invoke(reference, args, (registered, optionalArgs) =>
        (registered as MutatorClientMethod<unknown>).mutate(...optionalArgs),
      ),
    execute: (reference: ZeroFunctionReference.AnyMutatorReference, ...args: readonly unknown[]) =>
      invoke(reference, args, (registered, optionalArgs) =>
        (registered as MutatorClientMethod<unknown>)(...optionalArgs),
      ),
    grouped,
  };
  return client as FunctionClient<Api, Visibility>;
};

export const makeFunctions = <Api extends ZeroApi.Any>(
  api: Api,
): Effect.Effect<FunctionClient<Api, "public">, never, ServiceContext> =>
  Effect.map(make(api), makeFunctionClient<Api, "public">);

export const makeFunctionsWithService = <Api extends ZeroApi.Any>(
  api: Api,
  zeroClient: ZeroClient.ZeroClientExecutor<any, any>,
  registryOptions?: ClientRegistryOptions<Api, "public">,
): Effect.Effect<FunctionClient<Api, "public">> =>
  Effect.map(makeWithService(api, zeroClient, registryOptions), makeFunctionClient<Api, "public">);

export const makeFunctionsWithVisibilities = <
  Api extends ZeroApi.Any,
  Visibility extends ZeroApiEndpoint.Visibility,
>(
  api: Api,
  zeroClient: ZeroClient.ZeroClientExecutor<any, any>,
  registryOptions: VisibleClientRegistryOptions<Api, Visibility>,
): Effect.Effect<FunctionClient<Api, Visibility>> =>
  Effect.map(
    makeWithVisibilities<Api, Visibility>(api, zeroClient, registryOptions),
    makeFunctionClient<Api, Visibility>,
  );
