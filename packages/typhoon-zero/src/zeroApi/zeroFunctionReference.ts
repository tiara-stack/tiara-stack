import * as ZeroApi from "./zeroApi";
import * as ZeroApiEndpoint from "./zeroApiEndpoint";
import * as ZeroApiGroup from "./zeroApiGroup";
import { collectVisibleByGroup } from "./zeroApiTraversal";

const TypeId = "~typhoon-zero/ZeroFunctionReference";

export interface FunctionReference<
  out Group extends string,
  out Endpoint extends ZeroApiEndpoint.Any,
  out Owner extends string = string,
> {
  readonly [TypeId]: typeof TypeId;
  readonly api: Owner;
  readonly group: Group;
  readonly kind: Endpoint["kind"];
  readonly name: Endpoint["name"];
  readonly visibility: Endpoint["visibility"];
  readonly endpoint: Endpoint;
}

export type AnyFunctionReference = FunctionReference<string, ZeroApiEndpoint.Any, string>;
export type AnyQueryReference = FunctionReference<string, ZeroApiEndpoint.AnyQuery, string>;
export type AnyMutatorReference = FunctionReference<string, ZeroApiEndpoint.AnyMutator, string>;

export type ForApi<Api extends ZeroApi.Any> =
  ZeroApi.Groups<Api> extends infer Group
    ? Group extends ZeroApiGroup.Any
      ? ZeroApiGroup.Endpoints<Group> extends infer Endpoint
        ? Endpoint extends ZeroApiEndpoint.Any
          ? FunctionReference<Group["identifier"], Endpoint, Api["identifier"]>
          : never
        : never
      : never
    : never;

export type QueryForApi<
  Api extends ZeroApi.Any,
  Visibility extends ZeroApiEndpoint.Visibility = "public",
> = Extract<ForApi<Api>, { readonly kind: "query"; readonly visibility: Visibility }>;

export type MutatorForApi<
  Api extends ZeroApi.Any,
  Visibility extends ZeroApiEndpoint.Visibility = "public",
> = Extract<ForApi<Api>, { readonly kind: "mutator"; readonly visibility: Visibility }>;

type ReferencesForGroup<
  Group extends ZeroApiGroup.Any,
  Visibility extends ZeroApiEndpoint.Visibility,
  Owner extends string,
> = {
  readonly [Endpoint in ZeroApiGroup.Endpoints<Group> as ZeroApiEndpoint.VisibleName<
    Endpoint,
    Visibility
  >]: FunctionReference<Group["identifier"], Endpoint, Owner>;
};

export type References<Api extends ZeroApi.Any, Visibility extends ZeroApiEndpoint.Visibility> = {
  readonly [Group in ZeroApi.Groups<Api> as keyof ReferencesForGroup<
    Group,
    Visibility,
    Api["identifier"]
  > extends never
    ? never
    : Group["identifier"]]: ReferencesForGroup<Group, Visibility, Api["identifier"]>;
};

const makeReference = <
  Owner extends string,
  Group extends string,
  Endpoint extends ZeroApiEndpoint.Any,
>(
  api: Owner,
  group: Group,
  endpoint: Endpoint,
): FunctionReference<Group, Endpoint, Owner> => ({
  [TypeId]: TypeId,
  api,
  group,
  kind: endpoint.kind,
  name: endpoint.name,
  visibility: endpoint.visibility,
  endpoint,
});

export const makeReferences = <
  Api extends ZeroApi.Any,
  const Visibility extends ZeroApiEndpoint.Visibility,
>(
  api: Api,
  visibilities: readonly Visibility[],
): References<Api, Visibility> =>
  collectVisibleByGroup(api, visibilities, (group, endpoint) =>
    makeReference(api.identifier, group.identifier, endpoint),
  ) as References<Api, Visibility>;
