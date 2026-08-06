import type { Query, Schema as ZeroSchema, Transaction } from "@rocicorp/zero";
import { Effect, Option, Schema, Stream } from "effect";
import { ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import {
  InvocationId,
  WorkflowRunListFilter,
  defaultWorkflowRunListLimit,
  makeRunReferenceSchema,
  type AnyWorkflowContract,
  type WorkflowClient,
  type WorkflowEnqueueOptions,
  type WorkflowRun,
} from "./contract";
import {
  WorkflowEnqueueRequest,
  workflowContractZeroGroupIdentifier,
  type WorkflowEnqueueError,
  type WorkflowObservationError,
} from "./contract-transport";
import { materializeWorkflowRun, type MaterializedWorkflowRunRow } from "./contract-server";

export const ZeroMaterializedWorkflowRunRow = Schema.Struct({
  runId: Schema.String,
  status: Schema.Literals(["pending", "running", "succeeded", "failed", "cancelled"]),
  result: Schema.Unknown,
  error: Schema.Unknown,
  completedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export type ZeroMaterializedWorkflowRunRow = Schema.Schema.Type<
  typeof ZeroMaterializedWorkflowRunRow
>;

export interface WorkflowZeroGroupOptions<
  TSchema extends ZeroSchema,
  Context,
  WrappedTransaction = unknown,
> {
  readonly get: (options: {
    readonly contract: AnyWorkflowContract;
    readonly invocationId: InvocationId;
    readonly context: Context;
  }) => Query<keyof TSchema["tables"] & string, TSchema, unknown>;
  readonly list: (options: {
    readonly contract: AnyWorkflowContract;
    readonly filter: typeof WorkflowRunListFilter.Type;
    readonly context: Context;
  }) => Query<keyof TSchema["tables"] & string, TSchema, unknown>;
  readonly enqueue: (options: {
    readonly contract: AnyWorkflowContract;
    readonly request: { readonly invocationId: InvocationId; readonly input: unknown };
    readonly context: Context;
    readonly transaction: Transaction<TSchema, WrappedTransaction>;
  }) => Promise<void>;
}

export const makeWorkflowZeroGroup = <
  Contract extends AnyWorkflowContract,
  TSchema extends ZeroSchema,
  Context,
  WrappedTransaction = unknown,
>(
  contract: Contract,
  options: WorkflowZeroGroupOptions<TSchema, Context, WrappedTransaction>,
) => {
  const enqueueRequest = WorkflowEnqueueRequest(contract);
  const getRequest = makeRunReferenceSchema(contract);
  const getSuccess = Schema.OptionFromNullishOr(ZeroMaterializedWorkflowRunRow);
  const listSuccess = Schema.Array(ZeroMaterializedWorkflowRunRow);

  return ZeroApiGroup.make(workflowContractZeroGroupIdentifier(contract)).add(
    ZeroApiEndpoint.mutator<"enqueue", typeof enqueueRequest, TSchema, Context, WrappedTransaction>(
      "enqueue",
      {
        request: enqueueRequest,
        mutator: ({ args, ctx, tx }) =>
          options.enqueue({
            contract,
            request: args,
            context: ctx,
            transaction: tx,
          }),
      },
    ),
    ZeroApiEndpoint.query<
      "get",
      typeof getRequest,
      typeof getSuccess,
      TSchema,
      keyof TSchema["tables"] & string,
      unknown,
      Context
    >("get", {
      request: getRequest,
      success: getSuccess,
      query: ({ args, ctx }) =>
        options.get({ contract, invocationId: args.invocationId, context: ctx }),
    }),
    ZeroApiEndpoint.query<
      "list",
      typeof WorkflowRunListFilter,
      typeof listSuccess,
      TSchema,
      keyof TSchema["tables"] & string,
      unknown,
      Context
    >("list", {
      request: WorkflowRunListFilter,
      success: listSuccess,
      query: ({ args, ctx }) =>
        options.list({
          contract,
          filter: { ...args, limit: args.limit ?? defaultWorkflowRunListLimit },
          context: ctx,
        }),
    }),
  );
};

export const workflowZeroProcedureManifest = (contracts: ReadonlyArray<AnyWorkflowContract>) =>
  Object.freeze(
    contracts.flatMap((contract) => {
      const group = workflowContractZeroGroupIdentifier(contract);
      return [`${group}.enqueue`, `${group}.get`, `${group}.list`] as const;
    }),
  );

export interface WorkflowZeroExecutor<Requirements = never> {
  readonly enqueue: <Contract extends AnyWorkflowContract>(
    contract: Contract,
    request: { readonly invocationId: InvocationId; readonly input: unknown },
  ) => Effect.Effect<void, WorkflowEnqueueError, Requirements>;
  readonly get: <Contract extends AnyWorkflowContract>(
    contract: Contract,
    invocationId: InvocationId,
  ) => Stream.Stream<
    Option.Option<MaterializedWorkflowRunRow>,
    WorkflowObservationError,
    Requirements
  >;
  readonly list: <Contract extends AnyWorkflowContract>(
    contract: Contract,
    filter: typeof WorkflowRunListFilter.Type,
  ) => Stream.Stream<
    ReadonlyArray<MaterializedWorkflowRunRow>,
    WorkflowObservationError,
    Requirements
  >;
}

const makeInvocationId = (): InvocationId =>
  Schema.decodeUnknownSync(InvocationId)(globalThis.crypto.randomUUID());

export const makeWorkflowZeroClient = <Contract extends AnyWorkflowContract, Requirements = never>(
  contract: Contract,
  executor: WorkflowZeroExecutor<Requirements>,
): WorkflowClient<
  Contract,
  WorkflowEnqueueError,
  WorkflowObservationError,
  Requirements,
  Requirements
> => ({
  enqueue: (input, options?: WorkflowEnqueueOptions) => {
    const invocationId = options?.invocationId ?? makeInvocationId();
    return executor.enqueue(contract, { invocationId, input }).pipe(
      Effect.as({
        invocationId,
        contractIdentity: contract.identity,
        wireVersion: contract.wireVersion,
      }),
    );
  },
  get: (reference) =>
    executor.get(contract, reference.invocationId).pipe(
      Stream.mapEffect(
        Option.match({
          onNone: () => Effect.succeed(Option.none<WorkflowRun<Contract>>()),
          onSome: (row) => Effect.map(materializeWorkflowRun(contract, row), Option.some),
        }),
      ),
    ),
  list: (filter = {}) =>
    executor
      .list(contract, filter)
      .pipe(
        Stream.mapEffect((rows) =>
          Effect.forEach(rows, (row) => materializeWorkflowRun(contract, row)),
        ),
      ),
});
