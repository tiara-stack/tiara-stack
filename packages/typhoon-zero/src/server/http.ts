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
import { ReadonlyJSONValue as ReadonlyJSONValueSchema } from "../schema";
import {
  ZeroDispatchBadRequestError,
  type ZeroDispatchError,
  ZeroDispatchNotFoundError,
  ZeroHttpApi,
} from "./api";

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

type ExcludedProcedureSegment = "~" | "__proto__" | "constructor" | "prototype";

type ZeroProcedureName<Registry, Prefix extends string = ""> = {
  [Key in Exclude<
    keyof Registry & string,
    ExcludedProcedureSegment
  >]: Registry[Key] extends ZeroHandlerWithFn
    ? `${Prefix}${Key}`
    : Registry[Key] extends object
      ? ZeroProcedureName<Registry[Key], `${Prefix}${Key}.`>
      : never;
}[Exclude<keyof Registry & string, ExcludedProcedureSegment>];

export type ZeroHandlerRegistry<Registry extends object> = Readonly<
  Record<ZeroProcedureName<Registry>, ZeroHandlerWithFn>
>;

const forbiddenProcedureSegments = new Set(["__proto__", "constructor", "prototype"]);

const ZeroHandlerWithFnSchema = Schema.declare(
  (handler): handler is ZeroHandlerWithFn =>
    (Predicate.isObject(handler) || Predicate.isFunction(handler)) &&
    typeof Reflect.get(handler, "fn") === "function",
);

const isZeroHandlerCandidate = (handler: unknown): boolean =>
  Predicate.isFunction(handler) ||
  Predicate.hasProperty("fn")(handler) ||
  Predicate.hasProperty("queryName")(handler) ||
  Predicate.hasProperty("mutatorName")(handler);

export const hasZeroHandlerFn = (handler: unknown): handler is ZeroHandlerWithFn => {
  try {
    Schema.decodeUnknownSync(ZeroHandlerWithFnSchema)(handler);
    return true;
  } catch {
    return false;
  }
};

export const makeZeroHandlerRegistry = <Registry extends object>(
  definitions: Registry,
): Effect.Effect<ZeroHandlerRegistry<Registry>> =>
  Effect.gen(function* () {
    const handlers: Record<string, ZeroHandlerWithFn> = Object.create(null);
    const invalidHandlers: string[] = [];

    const visit = (value: object, path: readonly string[]): void => {
      for (const [segment, child] of Object.entries(value)) {
        if (segment === "~" || forbiddenProcedureSegments.has(segment)) {
          continue;
        }

        const childPath = [...path, segment];
        if (hasZeroHandlerFn(child)) {
          handlers[childPath.join(".")] = child;
        } else if (isZeroHandlerCandidate(child)) {
          invalidHandlers.push(childPath.join("."));
        } else if (Predicate.isObject(child)) {
          visit(child, childPath);
        }
      }
    };

    visit(definitions, []);
    yield* Effect.forEach(
      invalidHandlers,
      (procedure) =>
        Effect.logWarning("Skipping invalid Zero handler definition", {
          procedure,
        }),
      { discard: true },
    );
    return Object.freeze(handlers) as ZeroHandlerRegistry<Registry>;
  });

export const getZeroHandler = <Handler extends ZeroHandlerWithFn>(
  registry: Readonly<Record<string, Handler>>,
  procedure: string,
): Effect.Effect<Handler, ZeroDispatchError> => {
  if (procedure.split(".").some((segment) => forbiddenProcedureSegments.has(segment))) {
    return Effect.fail(
      new ZeroDispatchBadRequestError({
        procedure,
        message: `Zero procedure contains a forbidden path segment: ${procedure}`,
      }),
    );
  }

  if (!Object.hasOwn(registry, procedure)) {
    return Effect.fail(
      new ZeroDispatchNotFoundError({
        procedure,
        message: `Zero procedure not found: ${procedure}`,
      }),
    );
  }

  return Effect.succeed(registry[procedure]!);
};

const QueryProcedurePayloadSchema = Schema.Tuple([
  Schema.Literal("transform"),
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      args: Schema.Array(ReadonlyJSONValueSchema),
    }),
  ),
]);

const isQueryProcedurePayload = Schema.is(QueryProcedurePayloadSchema);

const getQueryProcedureNames = (
  payload: ReadonlyJSONValue,
): Effect.Effect<readonly string[], ZeroDispatchBadRequestError> => {
  if (!isQueryProcedurePayload(payload)) {
    return Effect.fail(
      new ZeroDispatchBadRequestError({
        procedure: "query",
        message: "Invalid Zero query payload",
      }),
    );
  }

  return Effect.succeed(payload[1].map((request) => request.name));
};

const MutatorProcedurePayloadSchema = Schema.Struct({
  clientGroupID: Schema.String,
  pushVersion: Schema.Literal(1),
  schemaVersion: Schema.optional(Schema.Number),
  timestamp: Schema.Number,
  requestID: Schema.String,
  mutations: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("custom"),
      id: Schema.Number,
      clientID: Schema.String,
      name: Schema.String,
      args: Schema.Array(ReadonlyJSONValueSchema),
      timestamp: Schema.Number,
    }),
  ),
});

const isMutatorProcedurePayload = Schema.is(MutatorProcedurePayloadSchema);

const getMutatorProcedureNames = (
  payload: ReadonlyJSONValue,
): Effect.Effect<readonly string[], ZeroDispatchBadRequestError> => {
  if (!isMutatorProcedurePayload(payload)) {
    return Effect.fail(
      new ZeroDispatchBadRequestError({
        procedure: "mutate",
        message: "Invalid Zero mutate payload",
      }),
    );
  }

  return Effect.succeed(payload.mutations.map((mutation) => mutation.name));
};

const validateProcedureNames = <Handler extends ZeroHandlerWithFn>(
  registry: Readonly<Record<string, Handler>>,
  procedureNames: readonly string[],
): Effect.Effect<readonly Handler[], ZeroDispatchError> =>
  Effect.forEach(procedureNames, (name) => getZeroHandler(registry, name));

const makeValidatedHandlerResolver = <Handler extends ZeroHandlerWithFn>(
  procedureNames: readonly string[],
  handlers: readonly Handler[],
): ((procedure: string) => Effect.Effect<Handler, ZeroDispatchNotFoundError>) => {
  const handlersByProcedure = new Map<string, Handler>();
  for (const [index, procedure] of procedureNames.entries()) {
    const handler = handlers[index];
    if (handler !== undefined) {
      handlersByProcedure.set(procedure, handler);
    }
  }
  const handlerCountsMatch = procedureNames.length === handlers.length;

  return (procedure) => {
    const handler = handlersByProcedure.get(procedure);

    if (handlerCountsMatch && handler !== undefined) {
      return Effect.succeed(handler);
    }

    return Effect.fail(
      new ZeroDispatchNotFoundError({
        procedure,
        message: `Validated Zero procedure not found: ${procedure}`,
      }),
    );
  };
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
      const queryRegistry = yield* makeZeroHandlerRegistry(options.queries);
      const mutatorRegistry = yield* makeZeroHandlerRegistry(options.mutators);
      const queryHandlers = queryRegistry as Readonly<Record<string, ZeroQueryHandler<Context>>>;
      const mutatorHandlers = mutatorRegistry as Readonly<
        Record<string, ZeroMutatorHandler<Context, unknown>>
      >;
      const zql = yield* options.zql;
      const context: Context = options.context ? yield* options.context : ({} as Context);

      return handlers
        .handle("query", ({ payload }) =>
          getQueryProcedureNames(payload).pipe(
            Effect.flatMap((procedureNames) =>
              validateProcedureNames(queryHandlers, procedureNames).pipe(
                Effect.map((validatedHandlers) => ({ procedureNames, validatedHandlers })),
              ),
            ),
            Effect.flatMap(({ procedureNames, validatedHandlers }) =>
              Effect.promise(() => {
                const resolveHandler = makeValidatedHandlerResolver(
                  procedureNames,
                  validatedHandlers,
                );
                return handleQueryRequest(
                  (name, args) => Effect.runSync(resolveHandler(name)).fn({ args, ctx: context }),
                  options.schema,
                  payload,
                );
              }),
            ),
            Effect.map(removeUndefinedFields),
          ),
        )
        .handle("mutate", ({ query, payload }) =>
          getMutatorProcedureNames(payload).pipe(
            Effect.flatMap((procedureNames) =>
              validateProcedureNames(mutatorHandlers, procedureNames).pipe(
                Effect.map((validatedHandlers) => ({ procedureNames, validatedHandlers })),
              ),
            ),
            Effect.flatMap(({ procedureNames, validatedHandlers }) =>
              Effect.promise(() => {
                const resolveHandler = makeValidatedHandlerResolver(
                  procedureNames,
                  validatedHandlers,
                );
                return handleMutateRequest(
                  zql,
                  (transact, mutation) => {
                    const mutator = Effect.runSync(resolveHandler(mutation.name));
                    return transact((tx, _name, args) =>
                      mutator.fn({
                        args,
                        tx,
                        ctx: context,
                      }),
                    );
                  },
                  query,
                  payload,
                );
              }),
            ),
            Effect.map(removeUndefinedFields),
          ),
        );
    }),
  );
