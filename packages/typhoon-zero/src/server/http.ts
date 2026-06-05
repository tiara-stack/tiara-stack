import {
  type MutatorDefinitions,
  type MutatorRegistry,
  type Query,
  type QueryDefinitions,
  type QueryRegistry,
  type ReadonlyJSONValue,
  type Schema as ZeroSchema,
} from "@rocicorp/zero";
import { handleMutateRequest, handleQueryRequest, type Database } from "@rocicorp/zero/server";
import { Effect, Layer, Predicate, Schema } from "effect";
import { HttpApiBuilder, type HttpApi, type HttpApiGroup } from "effect/unstable/httpapi";
import { ZeroHttpApi } from "./api";

export const removeUndefinedFields = (obj: ReadonlyJSONValue | undefined): ReadonlyJSONValue => {
  if (Array.isArray(obj)) {
    return obj.map(removeUndefinedFields);
  }
  if (typeof obj === "object" && obj !== null) {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([_, value]) => value !== undefined)
        .map(([key, value]) => [key, removeUndefinedFields(value)]),
    );
  }
  return obj !== undefined ? obj : null;
};

export interface ZeroHttpLiveOptions<
  S extends ZeroSchema,
  QD extends QueryDefinitions,
  MD extends MutatorDefinitions,
  ZqlEffect extends Effect.Effect<Database<unknown>, any, any>,
  Context,
  ContextEffect extends Effect.Effect<Context, any, any> | undefined,
> {
  readonly schema: S;
  readonly queries: QueryRegistry<QD, S>;
  readonly mutators: MutatorRegistry<MD, S>;
  readonly zql: ZqlEffect;
  readonly context?: ContextEffect;
}

interface ZeroQueryHandler<Context> {
  readonly fn: (options: {
    readonly args: ReadonlyJSONValue | undefined;
    readonly ctx: Context;
  }) => Query<string, ZeroSchema, unknown>;
}

interface ZeroMutatorHandler<Context, Tx> {
  readonly fn: (options: {
    readonly args: ReadonlyJSONValue | undefined;
    readonly ctx: Context;
    readonly tx: Tx;
  }) => Promise<void>;
}

type ZeroHandlerWithFn = {
  readonly fn: unknown;
};

const ZeroHandlerWithFnSchema = Schema.declare(
  (handler): handler is ZeroHandlerWithFn =>
    (Predicate.isObject(handler) || Predicate.isFunction(handler)) &&
    typeof Reflect.get(handler, "fn") === "function",
);

export const hasZeroHandlerFn = (handler: unknown): handler is ZeroHandlerWithFn => {
  try {
    Schema.decodeUnknownSync(ZeroHandlerWithFnSchema)(handler);
    return true;
  } catch {
    return false;
  }
};

const mustGetPath = (registry: object, name: string): unknown => {
  let current: unknown = registry;
  for (const part of name.split(".")) {
    if (!Predicate.hasProperty(current, part)) {
      throw new Error(`Zero handler not found: ${name}`);
    }
    current = Reflect.get(current, part);
  }
  return current;
};

const mustGetQueryHandler = <Context>(
  registry: object,
  name: string,
): ZeroQueryHandler<Context> => {
  const query = mustGetPath(registry, name);
  if (!hasZeroHandlerFn(query)) {
    throw new Error(`Zero query handler not found: ${name}`);
  }
  return query as ZeroQueryHandler<Context>;
};

const mustGetMutatorHandler = <Context, Tx>(
  registry: object,
  name: string,
): ZeroMutatorHandler<Context, Tx> => {
  const mutator = mustGetPath(registry, name);
  if (!hasZeroHandlerFn(mutator)) {
    throw new Error(`Zero mutator handler not found: ${name}`);
  }
  return mutator as ZeroMutatorHandler<Context, Tx>;
};

export const makeZeroHttpLive = <
  ApiId extends string,
  S extends ZeroSchema,
  QD extends QueryDefinitions,
  MD extends MutatorDefinitions,
  ZqlEffect extends Effect.Effect<Database<unknown>, any, any>,
  Context = Record<string, never>,
  ContextEffect extends Effect.Effect<Context, any, any> | undefined = undefined,
>(
  api: HttpApi.HttpApi<ApiId, typeof ZeroHttpApi>,
  options: ZeroHttpLiveOptions<S, QD, MD, ZqlEffect, Context, ContextEffect>,
): Layer.Layer<
  HttpApiGroup.ApiGroup<ApiId, "zero">,
  Effect.Error<ZqlEffect> | Effect.Error<NonNullable<ContextEffect>>,
  Effect.Services<ZqlEffect> | Effect.Services<NonNullable<ContextEffect>>
> =>
  HttpApiBuilder.group(
    api,
    "zero",
    Effect.fnUntraced(function* (handlers) {
      const zql = yield* options.zql;
      const context: Context = options.context ? yield* options.context : ({} as Context);

      return handlers
        .handle("query", ({ payload }) =>
          Effect.promise(() =>
            handleQueryRequest(
              (name, args) => {
                const query = mustGetQueryHandler<Context>(options.queries, name);
                return query.fn({ args, ctx: context });
              },
              options.schema,
              payload,
            ),
          ).pipe(Effect.map(removeUndefinedFields)),
        )
        .handle("mutate", ({ query, payload }) =>
          Effect.promise(() =>
            handleMutateRequest(
              zql,
              (transact) =>
                transact((tx, name, args) => {
                  const mutator = mustGetMutatorHandler<Context, unknown>(options.mutators, name);
                  return mutator.fn({
                    args,
                    tx,
                    ctx: context,
                  });
                }),
              query,
              payload,
            ),
          ).pipe(Effect.map(removeUndefinedFields)),
        );
    }),
  );
