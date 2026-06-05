import { Predicate } from "effect";
import type { Pipeable } from "effect/Pipeable";
import { pipeArguments } from "effect/Pipeable";
import * as ZeroApiEndpoint from "./zeroApiEndpoint";

const TypeId = "~typhoon-zero/ZeroApiGroup";

export interface ZeroApiGroup<
  out Name extends string,
  out Endpoints extends ZeroApiEndpoint.Any = never,
> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly identifier: Name;
  readonly endpoints: Record<string, Endpoints>;

  add<A extends readonly [ZeroApiEndpoint.Any, ...ZeroApiEndpoint.Any[]]>(
    ...endpoints: A
  ): ZeroApiGroup<Name, Endpoints | A[number]>;
}

export interface Any {
  readonly [TypeId]: typeof TypeId;
  readonly identifier: string;
  readonly endpoints: Record<string, ZeroApiEndpoint.Any>;
}

export type WithIdentifier<Group, Name extends string> = Extract<
  Group,
  { readonly identifier: Name }
>;

export type Identifier<Group> = Group extends ZeroApiGroup<infer Name, any> ? Name : never;

export type Endpoints<Group> = Group extends ZeroApiGroup<any, infer Endpoints> ? Endpoints : never;

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments);
  },
  add(this: Any, ...toAdd: readonly ZeroApiEndpoint.Any[]) {
    const endpoints = { ...this.endpoints };
    for (const endpoint of toAdd) {
      endpoints[endpoint.name] = endpoint;
    }
    return makeProto({
      identifier: this.identifier,
      endpoints,
    });
  },
};

const makeProto = <Name extends string, Endpoints extends ZeroApiEndpoint.Any>(options: {
  readonly identifier: Name;
  readonly endpoints: Record<string, Endpoints>;
}): ZeroApiGroup<Name, Endpoints> => {
  function ZeroApiGroup() {}
  Object.setPrototypeOf(ZeroApiGroup, Proto);
  return Object.assign(ZeroApiGroup, options) as any;
};

export const make = <const Name extends string>(identifier: Name): ZeroApiGroup<Name, never> =>
  makeProto({
    identifier,
    endpoints: {},
  });

export const isZeroApiGroup = (input: unknown): input is Any =>
  Predicate.isFunction(input) && Predicate.hasProperty(input, TypeId);
