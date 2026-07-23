import { Effect, Match, pipe, Schema, Context, Types } from "effect";
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
} from "../error/zeroQueryError";
import { DefaultTaggedClass } from "typhoon-core/schema";

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
    QueryResultAppError | QueryResultParseError | Schema.SchemaError,
    never
  >;
  mutate: (request: MutateRequest<any, S, C, any>) => Effect.Effect<
    {
      client: () => Effect.Effect<
        void | MutatorResultAppError | MutatorResultZeroError,
        Schema.SchemaError,
        never
      >;
      server: () => Effect.Effect<
        void | MutatorResultAppError | MutatorResultZeroError,
        Schema.SchemaError,
        never
      >;
    },
    never,
    never
  >;
}

const parseQueryErrorResultDetails = (error: ErroredQuery) =>
  pipe(
    error,
    Schema.decodeEffect(
      Schema.Union([
        DefaultTaggedClass(QueryResultAppError),
        DefaultTaggedClass(QueryResultParseError),
      ]),
    ),
  );

const makeUnknownQueryError = (): ErroredQuery => ({
  error: "app",
  id: "unknown",
  name: "unknown",
  message: "Zero query failed without error details",
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
        mutate: Effect.fn("ZeroClient.mutate")(function* (request: MutateRequest<any, S, C, any>) {
          const { client, server } = yield* Effect.sync(() => zero.mutate(request));

          return {
            client: Effect.fn("ZeroClient.mutate.client")(() =>
              Effect.promise(() => client).pipe(Effect.flatMap(parseMutatorResultDetails)),
            ),
            server: Effect.fn("ZeroClient.mutate.server")(() =>
              pipe(
                Effect.promise(() => server),
                Effect.flatMap(parseMutatorResultDetails),
              ),
            ),
          };
        }),
      }),
  });
