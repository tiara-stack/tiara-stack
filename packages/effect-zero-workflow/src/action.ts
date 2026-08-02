import { Context, Effect, Layer, Predicate, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { Activity, Workflow } from "effect/unstable/workflow";

export interface ActionContextService {
  /**
   * Runs one database operation intended for reads in a fresh, short
   * transaction. The distinction from `mutate` is advisory; database
   * permissions remain authoritative. The transaction is never retained across
   * an external effect or durable suspension.
   */
  readonly query: <A, E, R = never>(
    operation: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError.SqlError, R>;
  /**
   * Runs one database mutation in a fresh, short transaction. This is the
   * action equivalent of a Convex query/mutation boundary.
   */
  readonly mutate: <A, E, R = never>(
    operation: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError.SqlError, R>;
}

export class ActionContext extends Context.Service<ActionContext, ActionContextService>()(
  "effect-zero-workflow/ActionContext",
) {}

export const actionContextSqlLayer = Layer.effect(
  ActionContext,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runInTransaction = <A, E, R>(
      operation: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
    ) => sql.withTransaction(Effect.suspend(() => operation(sql)));
    return {
      query: runInTransaction,
      mutate: runInTransaction,
    };
  }),
);

/**
 * Defines one typed, versioned activity behind a durable Effect Workflow. The
 * input is captured by value in the workflow payload and the activity receives
 * a stable execution ID for downstream idempotency keys.
 */
export const makeAction = <
  const Name extends string,
  Input extends Workflow.AnyStructSchema,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never,
  Requirements = never,
>(options: {
  readonly name: Name;
  readonly version: string;
  readonly input: Input;
  readonly success?: Success | undefined;
  readonly error?: Error | undefined;
  readonly idempotencyKey: (input: Input["Type"]) => string;
  readonly execute: (
    input: Input["Type"],
    context: {
      readonly executionId: string;
      readonly idempotencyKey: string;
    },
  ) => Effect.Effect<Success["Type"], Error["Type"], Requirements | ActionContext>;
}) => {
  const idempotencyKeyFor = (input: Input["Type"]) =>
    `${options.version}:${options.idempotencyKey(input)}`;
  const successSchema = Predicate.isUndefined(options.success) ? {} : { success: options.success };
  const errorSchema = Predicate.isUndefined(options.error) ? {} : { error: options.error };
  const workflow = Workflow.make({
    name: options.name,
    payload: options.input,
    ...successSchema,
    ...errorSchema,
    idempotencyKey: idempotencyKeyFor,
  });
  const toLayer = () =>
    workflow.toLayer((input, executionId) =>
      Activity.make({
        name: `${options.name}@${options.version}`,
        ...successSchema,
        ...errorSchema,
        execute: options.execute(input, {
          executionId,
          idempotencyKey: idempotencyKeyFor(input),
        }),
      }),
    );
  return {
    name: options.name,
    version: options.version,
    workflow,
    toLayer,
    execute: workflow.execute,
    /** Alias that deduplicates by execution ID and waits for the existing execution's result. */
    await: workflow.execute,
  };
};
