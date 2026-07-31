import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { Activity, Workflow } from "effect/unstable/workflow";

interface ActionContextService {
  /**
   * Runs one database read in a fresh, short transaction. The transaction is
   * never retained across an external effect or durable suspension.
   */
  readonly query: <A, E>(
    operation: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | SqlError.SqlError>;
  /**
   * Runs one database mutation in a fresh, short transaction. This is the
   * action equivalent of a Convex query/mutation boundary.
   */
  readonly mutate: <A, E>(
    operation: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | SqlError.SqlError>;
}

export class ActionContext extends Context.Service<ActionContext, ActionContextService>()(
  "effect-zero/workflow/ActionContext",
) {}

export const actionContextSqlLayer = Layer.effect(
  ActionContext,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      query: <A, E>(operation: (client: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
        sql.withTransaction(operation(sql)),
      mutate: <A, E>(operation: (client: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
        sql.withTransaction(operation(sql)),
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
  const workflow = Workflow.make({
    name: options.name,
    payload: options.input,
    ...(options.success === undefined ? {} : { success: options.success }),
    ...(options.error === undefined ? {} : { error: options.error }),
    idempotencyKey: (input) => `${options.version}:${options.idempotencyKey(input)}`,
  });
  const toLayer = () =>
    workflow.toLayer((input, executionId) =>
      Activity.make({
        name: `${options.name}@${options.version}`,
        ...(options.success === undefined ? {} : { success: options.success }),
        ...(options.error === undefined ? {} : { error: options.error }),
        execute: options.execute(input, {
          executionId,
          idempotencyKey: executionId,
        }),
      }),
    );
  return {
    name: options.name,
    version: options.version,
    workflow,
    toLayer,
    execute: workflow.execute,
    await: workflow.execute,
  };
};
