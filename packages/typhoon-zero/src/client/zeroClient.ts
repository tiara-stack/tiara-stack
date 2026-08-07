import {
  Cause,
  Context,
  Effect,
  Exit,
  Match,
  pipe,
  Predicate,
  Queue,
  Schema,
  Stream,
  Types,
} from "effect";
import type {
  Zero,
  Schema as ZeroSchema,
  CustomMutatorDefs,
  QueryOrQueryRequest,
  RunOptions,
  HumanReadable,
  MutateRequest,
  MutatorResultDetails,
  ErroredQuery,
} from "@rocicorp/zero";
import {
  MutatorResultAppError,
  MutatorResultZeroError,
  QueryResultAppError,
  QueryResultParseError,
  ZeroClientExecutorError,
} from "../error/zeroQueryError";
import { DefaultTaggedClass } from "typhoon-core/schema";
export { ZeroClientExecutorError } from "../error/zeroQueryError";

const argumentErrorDetails = (
  cause: unknown,
): { readonly code?: string | undefined; readonly message?: string | undefined } => {
  if (!Predicate.isTagged("ArgumentError")(cause)) return {};
  const code =
    Predicate.hasProperty(cause, "cause") &&
    Predicate.hasProperty(cause.cause, "code") &&
    Predicate.isString(cause.cause.code)
      ? cause.cause.code
      : undefined;
  const message =
    Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
      ? cause.message
      : undefined;
  return { code, message };
};

const executorErrorDetails = (
  cause: unknown,
  depth = 0,
): { readonly code?: string | undefined; readonly message?: string | undefined } => {
  if (depth >= 5) return {};
  const nested = Predicate.hasProperty(cause, "cause")
    ? executorErrorDetails(cause.cause, depth + 1)
    : {};
  const application = argumentErrorDetails(cause);
  return {
    code: application.code ?? nested.code,
    message: application.message ?? nested.message,
  };
};

export const makeExecutorError = (operation: string, message: string, cause: unknown) => {
  const details = executorErrorDetails(cause);
  return new ZeroClientExecutorError({
    operation,
    message: details.message ?? message,
    code: details.code,
  });
};

const ZeroClientTypeId = Symbol("ZeroClientTypeId");
export type ZeroClientTypeId = typeof ZeroClientTypeId;

interface Variance<out S extends ZeroSchema, out MD extends CustomMutatorDefs | undefined, out C> {
  [ZeroClientTypeId]: {
    _S: Types.Covariant<S>;
    _MD: Types.Covariant<MD>;
    _C: Types.Covariant<C>;
  };
}

/**
 * ZeroClientTag provides access to a Zero instance.
 */
export interface ZeroClientTag<
  S extends ZeroSchema,
  MD extends CustomMutatorDefs | undefined,
  C,
> extends Variance<S, MD, C> {}

/**
 * ZeroClient wraps access to a Zero instance.
 */
export interface ZeroClient<S extends ZeroSchema, MD extends CustomMutatorDefs | undefined, C> {
  zero: Zero<S, MD, C>;
  run: ZeroClientExecutor<S, C>["run"];
  stream: ZeroClientExecutor<S, C>["stream"];
  mutate: ZeroClientExecutor<S, C>["mutate"];
}

/**
 * The authoritative execution surface consumed by ZeroApiClient.
 *
 * Server-side and test adapters do not need to manufacture a reactive `Zero`
 * instance when they only execute generated queries and mutators.
 */
export interface ZeroClientExecutor<S extends ZeroSchema, C> {
  run: <TReturn>(
    query: QueryOrQueryRequest<any, any, any, S, TReturn, C>,
    runOptions?: RunOptions,
  ) => Effect.Effect<
    HumanReadable<TReturn>,
    QueryResultAppError | QueryResultParseError | Schema.SchemaError | ZeroClientExecutorError,
    never
  >;
  stream: <TReturn>(
    query: QueryOrQueryRequest<any, any, any, S, TReturn, C>,
    runOptions?: RunOptions,
  ) => Stream.Stream<
    HumanReadable<TReturn>,
    QueryResultAppError | QueryResultParseError | Schema.SchemaError | ZeroClientExecutorError
  >;
  mutate: (request: MutateRequest<any, S, C, any>) => Effect.Effect<
    {
      client: () => Effect.Effect<
        void | MutatorResultAppError | MutatorResultZeroError,
        Schema.SchemaError | ZeroClientExecutorError,
        never
      >;
      server: () => Effect.Effect<
        void | MutatorResultAppError | MutatorResultZeroError,
        Schema.SchemaError | ZeroClientExecutorError,
        never
      >;
    },
    never,
    never
  >;
}

const QueryErrorSchema = Schema.Union([
  DefaultTaggedClass(QueryResultAppError),
  DefaultTaggedClass(QueryResultParseError),
]);

const decodeQueryError = Schema.decodeUnknownExit(QueryErrorSchema);

const parseQueryErrorResultDetails = (error: ErroredQuery) =>
  Schema.decodeUnknownEffect(QueryErrorSchema)(error);

const makeUnknownQueryError = (): ErroredQuery => ({
  error: "app",
  id: "unknown",
  name: "unknown",
  message: "Zero query failed without error details",
});

type ParsedQueryError = QueryResultAppError | QueryResultParseError | Schema.SchemaError;

const parsedQueryErrorCause = (error: ErroredQuery): Cause.Cause<ParsedQueryError> =>
  Exit.match(decodeQueryError(error), {
    onFailure: (cause) => cause,
    onSuccess: Cause.fail,
  });

const runQuery = <S extends ZeroSchema, MD extends CustomMutatorDefs | undefined, C, TReturn>(
  zero: Zero<S, MD, C>,
  query: QueryOrQueryRequest<any, any, any, S, TReturn, C>,
  runOptions?: RunOptions,
) =>
  Effect.suspend(() => {
    const view = zero.materialize(query, { ttl: runOptions?.ttl });

    if (runOptions?.type !== "complete") {
      const data = view.data as HumanReadable<TReturn>;
      view.destroy();
      return Effect.succeed(data);
    }

    return Effect.callback<HumanReadable<TReturn>, ErroredQuery>((resume) => {
      let removeListener: (() => void) | undefined;
      let done = false;

      const cleanup = () => {
        removeListener?.();
        view.destroy();
      };

      const complete = (effect: Effect.Effect<HumanReadable<TReturn>, ErroredQuery>) => {
        if (done) {
          return;
        }
        done = true;
        cleanup();
        resume(effect);
      };

      removeListener = view.addListener((data, resultType, error) => {
        if (resultType === "complete") {
          complete(Effect.succeed(data as HumanReadable<TReturn>));
        } else if (resultType === "error") {
          complete(Effect.fail(error ?? makeUnknownQueryError()));
        }
      });

      if (done) {
        removeListener();
      }

      return Effect.sync(() => {
        done = true;
        cleanup();
      });
    });
  });

const parseMutatorResultDetails = (result: MutatorResultDetails) =>
  pipe(
    Match.value(result),
    Match.discriminatorsExhaustive("type")({
      success: () => Effect.void,
      error: (error) =>
        pipe(
          error.error,
          Schema.decodeEffect(
            Schema.Union([
              DefaultTaggedClass(MutatorResultAppError),
              DefaultTaggedClass(MutatorResultZeroError),
            ]),
          ),
        ),
    }),
  );

const parseMutatorPromise = (origin: "client" | "server", result: Promise<MutatorResultDetails>) =>
  Effect.tryPromise({
    try: () => result,
    catch: (cause) =>
      makeExecutorError(`run ${origin} mutation`, `Zero ${origin} mutation failed`, cause),
  }).pipe(Effect.flatMap(parseMutatorResultDetails));

/**
 * ZeroClient provides access to a Zero instance.
 */
export const ZeroClient = <S extends ZeroSchema, MD extends CustomMutatorDefs | undefined, C>() =>
  Context.Service<ZeroClientTag<S, MD, C>, ZeroClient<S, MD, C>>()("ZeroClient", {
    make: (zero: Zero<S, MD, C>) =>
      Effect.succeed({
        zero,
        run: Effect.fn("ZeroClient.run")(function* <TReturn>(
          query: QueryOrQueryRequest<any, any, any, S, TReturn, C>,
          runOptions?: RunOptions,
        ) {
          return yield* runQuery(zero, query, runOptions).pipe(
            Effect.catch((error) =>
              parseQueryErrorResultDetails(error).pipe(Effect.flatMap(Effect.fail)),
            ),
          );
        }),
        stream: <TReturn>(
          query: QueryOrQueryRequest<any, any, any, S, TReturn, C>,
          runOptions?: RunOptions,
        ) =>
          Stream.callback<
            HumanReadable<TReturn>,
            QueryResultAppError | QueryResultParseError | Schema.SchemaError
          >((queue) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                const requireComplete = runOptions?.type === "complete";
                const view = zero.materialize(query, { ttl: runOptions?.ttl });
                let emitted = false;
                const offer = (data: unknown) => {
                  emitted = true;
                  Queue.offerUnsafe(queue, data as HumanReadable<TReturn>);
                };
                const removeListener = view.addListener((data, resultType, error) => {
                  if (resultType === "error") {
                    emitted = true;
                    Queue.failCauseUnsafe(
                      queue,
                      parsedQueryErrorCause(error ?? makeUnknownQueryError()),
                    );
                    return;
                  }
                  if (requireComplete && resultType !== "complete") {
                    return;
                  }
                  offer(data);
                });
                if (!requireComplete && !emitted) {
                  offer(view.data);
                }
                return { removeListener, view };
              }),
              ({ removeListener, view }) =>
                Effect.sync(() => {
                  removeListener();
                  view.destroy();
                }),
            ),
          ),
        mutate: Effect.fn("ZeroClient.mutate")(function* (request: MutateRequest<any, S, C, any>) {
          const { client, server } = yield* Effect.sync(() => zero.mutate(request));

          return {
            client: Effect.fn("ZeroClient.mutate.client")(() =>
              parseMutatorPromise("client", client),
            ),
            server: Effect.fn("ZeroClient.mutate.server")(() =>
              parseMutatorPromise("server", server),
            ),
          };
        }),
      }),
  });
