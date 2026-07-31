import {
  defineMutator,
  defineMutators,
  defineQuery,
  defineQueries,
  type QueryDefinition,
  type QueryRegistry,
  type MutatorDefinition,
  type MutatorRegistry,
  type ReadonlyJSONValue,
  type Schema as ZeroSchema,
} from "@rocicorp/zero";
import { Schema } from "effect";
import * as ZeroApi from "./zeroApi";
import * as ZeroApiEndpoint from "./zeroApiEndpoint";
import * as ZeroApiGroup from "./zeroApiGroup";
import { collectVisibleByGroup } from "./zeroApiTraversal";

type QueryEndpointDefinition<Endpoint extends ZeroApiEndpoint.Any> =
  Endpoint extends ZeroApiEndpoint.QueryEndpoint<
    any,
    infer Request,
    any,
    infer TTable,
    any,
    infer TReturn,
    infer TContext,
    any
  >
    ? QueryDefinition<
        TTable,
        ZeroApiEndpoint.RequestEncoded<Endpoint>,
        Request["Type"] & ReadonlyJSONValue,
        TReturn,
        TContext
      >
    : never;

type MutatorEndpointDefinition<Endpoint extends ZeroApiEndpoint.Any> =
  Endpoint extends ZeroApiEndpoint.MutatorEndpoint<
    any,
    infer Request,
    any,
    infer TContext,
    infer TWrappedTransaction,
    any
  >
    ? MutatorDefinition<
        ZeroApiEndpoint.RequestEncoded<Endpoint>,
        Request["Type"] & ReadonlyJSONValue,
        TContext,
        TWrappedTransaction
      >
    : never;

export type QueryDefinitionsForGroup<
  Group extends ZeroApiGroup.Any,
  Visibility extends ZeroApiEndpoint.Visibility = "public",
> = {
  readonly [Endpoint in ZeroApiGroup.Endpoints<Group> as ZeroApiEndpoint.VisibleName<
    Endpoint,
    Visibility,
    "query"
  >]: QueryEndpointDefinition<Endpoint>;
};

export type MutatorDefinitionsForGroup<
  Group extends ZeroApiGroup.Any,
  Visibility extends ZeroApiEndpoint.Visibility = "public",
> = {
  readonly [Endpoint in ZeroApiGroup.Endpoints<Group> as ZeroApiEndpoint.VisibleName<
    Endpoint,
    Visibility,
    "mutator"
  >]: MutatorEndpointDefinition<Endpoint>;
};

export type QueryDefinitionsForApi<
  Api extends ZeroApi.Any,
  Visibility extends ZeroApiEndpoint.Visibility = "public",
> = {
  readonly [Group in ZeroApi.Groups<Api> as keyof QueryDefinitionsForGroup<
    Group,
    Visibility
  > extends never
    ? never
    : Group["identifier"]]: QueryDefinitionsForGroup<Group, Visibility>;
};

export type MutatorDefinitionsForApi<
  Api extends ZeroApi.Any,
  Visibility extends ZeroApiEndpoint.Visibility = "public",
> = {
  readonly [Group in ZeroApi.Groups<Api> as keyof MutatorDefinitionsForGroup<
    Group,
    Visibility
  > extends never
    ? never
    : Group["identifier"]]: MutatorDefinitionsForGroup<Group, Visibility>;
};

const toStandardSchema = <A extends Schema.Top>(schema: A) =>
  Schema.toStandardSchemaV1(schema as any) as any;

export interface RegistryOptions<Visibility extends ZeroApiEndpoint.Visibility> {
  readonly visibilities: readonly Visibility[];
}

const collectDefinitions = <K extends ZeroApiEndpoint.Kind>(
  api: ZeroApi.Any,
  options: RegistryOptions<ZeroApiEndpoint.Visibility> | undefined,
  kind: K,
  defineEndpoint: (endpoint: Extract<ZeroApiEndpoint.Any, { readonly kind: K }>) => unknown,
) =>
  collectVisibleByGroup<Extract<ZeroApiEndpoint.Any, { readonly kind: K }>, unknown>(
    api,
    options?.visibilities,
    (_group, endpoint) => defineEndpoint(endpoint),
    ZeroApiEndpoint.isKind(kind),
  );

export function toQueries<Api extends ZeroApi.Any, S extends ZeroSchema = ZeroSchema>(
  api: Api,
): QueryRegistry<QueryDefinitionsForApi<Api, "public">, S>;
export function toQueries<
  Api extends ZeroApi.Any,
  S extends ZeroSchema = ZeroSchema,
  const Visibility extends ZeroApiEndpoint.Visibility = ZeroApiEndpoint.Visibility,
>(
  api: Api,
  options: RegistryOptions<Visibility>,
): QueryRegistry<QueryDefinitionsForApi<Api, Visibility>, S>;
export function toQueries(api: ZeroApi.Any, options?: RegistryOptions<ZeroApiEndpoint.Visibility>) {
  return defineQueries(
    collectDefinitions(api, options, "query", (endpoint) => {
      return defineQuery(toStandardSchema(endpoint.request), ({ args, ctx }: any) =>
        endpoint.query({ args, ctx }),
      );
    }) as any,
  ) as QueryRegistry<any, ZeroSchema>;
}

export function toMutators<Api extends ZeroApi.Any, S extends ZeroSchema = ZeroSchema>(
  api: Api,
): MutatorRegistry<MutatorDefinitionsForApi<Api, "public">, S>;
export function toMutators<
  Api extends ZeroApi.Any,
  S extends ZeroSchema = ZeroSchema,
  const Visibility extends ZeroApiEndpoint.Visibility = ZeroApiEndpoint.Visibility,
>(
  api: Api,
  options: RegistryOptions<Visibility>,
): MutatorRegistry<MutatorDefinitionsForApi<Api, Visibility>, S>;
export function toMutators(
  api: ZeroApi.Any,
  options?: RegistryOptions<ZeroApiEndpoint.Visibility>,
) {
  return defineMutators(
    collectDefinitions(api, options, "mutator", (endpoint) => {
      return defineMutator(toStandardSchema(endpoint.request), ({ args, ctx, tx }: any) =>
        endpoint.mutator({ args, ctx, tx }),
      );
    }) as any,
  ) as MutatorRegistry<any, ZeroSchema>;
}
