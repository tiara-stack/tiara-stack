import { Context, Predicate } from "effect";
import type { Pipeable } from "effect/Pipeable";
import { pipeArguments } from "effect/Pipeable";
import * as ZeroApiGroup from "./zeroApiGroup";

const TypeId = "~typhoon-zero/ZeroApi";

export interface ZeroApi<
  out Id extends string,
  out Groups extends ZeroApiGroup.Any = never,
> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly identifier: Id;
  readonly groups: Record<string, Groups>;
  readonly annotations: Context.Context<never>;

  add<A extends readonly [ZeroApiGroup.Any, ...ZeroApiGroup.Any[]]>(
    ...groups: A
  ): ZeroApi<Id, Groups | A[number]>;

  annotate<I, S>(tag: Context.Key<I, S>, value: S): ZeroApi<Id, Groups>;
}

export interface Any {
  readonly [TypeId]: typeof TypeId;
  readonly identifier: string;
  readonly groups: Record<string, ZeroApiGroup.Any>;
  readonly annotations: Context.Context<never>;
}

export type Groups<Api> = Api extends ZeroApi<any, infer Groups> ? Groups : never;

export type GroupWithIdentifier<Api, Name extends string> = ZeroApiGroup.WithIdentifier<
  Groups<Api>,
  Name
>;

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments);
  },
  add(this: Any, ...toAdd: readonly ZeroApiGroup.Any[]) {
    const groups = { ...this.groups };
    for (const group of toAdd) {
      groups[group.identifier] = group;
    }
    return makeProto({
      identifier: this.identifier,
      groups,
      annotations: this.annotations,
    });
  },
  annotate(this: Any, tag: Context.Key<any, any>, value: any) {
    return makeProto({
      identifier: this.identifier,
      groups: this.groups,
      annotations: Context.add(this.annotations, tag, value),
    });
  },
};

const makeProto = <Id extends string, Groups extends ZeroApiGroup.Any>(options: {
  readonly identifier: Id;
  readonly groups: Record<string, Groups>;
  readonly annotations: Context.Context<never>;
}): ZeroApi<Id, Groups> => {
  function ZeroApi() {}
  Object.setPrototypeOf(ZeroApi, Proto);
  return Object.assign(ZeroApi, options) as any;
};

export const make = <const Id extends string>(identifier: Id): ZeroApi<Id, never> =>
  makeProto({
    identifier,
    groups: {},
    annotations: Context.empty(),
  });

export const isZeroApi = (input: unknown): input is Any =>
  Predicate.isFunction(input) && Predicate.hasProperty(input, TypeId);
