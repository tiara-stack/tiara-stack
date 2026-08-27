import type { Query, Transaction } from "@rocicorp/zero";
import { Predicate, Schema } from "effect";
import { ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import {
  DelegatedWorkflowEnqueueRequest,
  PublicWorkflowRun,
  WorkflowCommandRequest,
  WorkflowEnqueueRequest,
  WorkflowEventRequest,
  type WorkflowZeroContext,
} from "./schemas";
import { makeWorkflowZeroTransaction, type WorkflowZeroSchema } from "./transaction";
import type { AcceptedWorkflowInvocation } from "../contract-server";

export type ZeroWorkflowComponentOptions<TSchema extends WorkflowZeroSchema> = {
  readonly schema: TSchema;
  readonly workflowRun: Query<"workflowRun", TSchema>;
  readonly tablePrefix: string;
  readonly delegatedContext: (principalId: string) => WorkflowZeroContext;
};

export const makeZeroWorkflowComponent = <TSchema extends WorkflowZeroSchema>(
  options: ZeroWorkflowComponentOptions<TSchema>,
) => {
  const transaction = makeWorkflowZeroTransaction({
    tablePrefix: options.tablePrefix,
  });
  // The component only uses its public run table. Narrowing the host schema
  // hides unrelated application tables while preserving the same transaction
  // and query implementations at runtime.
  const workflowRun = options.workflowRun as unknown as Query<"workflowRun", WorkflowZeroSchema>;
  const componentTransaction = (tx: Transaction<TSchema>) =>
    tx as unknown as Transaction<WorkflowZeroSchema>;
  const enqueueWorkflowInZeroTransaction = (
    tx: Transaction<TSchema>,
    context: WorkflowZeroContext,
    input: typeof WorkflowEnqueueRequest.Type,
  ) => transaction.enqueueWorkflowInZeroTransaction(componentTransaction(tx), context, input);
  const enqueueContractInvocationInZeroTransaction = <Principal, Provenance>(
    tx: Transaction<TSchema>,
    invocation: AcceptedWorkflowInvocation<Principal, Provenance>,
  ) => transaction.enqueueContractInvocationInZeroTransaction(componentTransaction(tx), invocation);
  const mutateWithWorkflow = async (
    tx: Transaction<TSchema>,
    context: WorkflowZeroContext,
    input: typeof WorkflowEnqueueRequest.Type,
    mutateDomain: (tx: Transaction<TSchema>) => Promise<void>,
  ) =>
    transaction.mutateWithWorkflow(componentTransaction(tx), context, input, () =>
      mutateDomain(tx),
    );
  const enqueueWorkflowCommandInZeroTransaction = (
    tx: Transaction<TSchema>,
    context: WorkflowZeroContext,
    input: typeof WorkflowCommandRequest.Type,
  ) =>
    transaction.enqueueWorkflowCommandInZeroTransaction(componentTransaction(tx), context, input);
  const enqueueWorkflowEventInZeroTransaction = (
    tx: Transaction<TSchema>,
    context: WorkflowZeroContext,
    input: typeof WorkflowEventRequest.Type,
  ) => transaction.enqueueWorkflowEventInZeroTransaction(componentTransaction(tx), context, input);

  const runsGroup = ZeroApiGroup.make("runs").add(
    ZeroApiEndpoint.query("get", {
      visibility: "public",
      request: Schema.Struct({ runId: Schema.String }),
      success: Schema.OptionFromNullishOr(PublicWorkflowRun),
      query: ({
        args: { runId },
        ctx,
      }: {
        readonly args: { readonly runId: string };
        readonly ctx: WorkflowZeroContext;
      }) =>
        workflowRun.where("runId", "=", runId).where("visibilityKey", "=", ctx.visibilityKey).one(),
    }),
    ZeroApiEndpoint.query("list", {
      visibility: "public",
      request: Schema.Struct({
        cursor: Schema.optional(
          Schema.Struct({
            updatedAt: Schema.Number,
            runId: Schema.String,
          }),
        ),
      }),
      success: Schema.Array(PublicWorkflowRun),
      query: ({
        args,
        ctx,
      }: {
        readonly args: {
          readonly cursor?:
            | {
                readonly updatedAt: number;
                readonly runId: string;
              }
            | undefined;
        };
        readonly ctx: WorkflowZeroContext;
      }) => {
        const query = workflowRun
          .where("visibilityKey", "=", ctx.visibilityKey)
          .orderBy("updatedAt", "desc")
          .orderBy("runId", "desc")
          .limit(100);
        return Predicate.isUndefined(args.cursor)
          ? query
          : query.start(args.cursor, { inclusive: false });
      },
    }),
    ZeroApiEndpoint.mutator("enqueue", {
      visibility: "internal",
      request: WorkflowEnqueueRequest,
      mutator: ({
        args,
        ctx,
        tx,
      }: {
        readonly args: WorkflowEnqueueRequest;
        readonly ctx: WorkflowZeroContext;
        readonly tx: Transaction<TSchema>;
      }) => enqueueWorkflowInZeroTransaction(tx, ctx, args),
    }),
    // `service` controls catalog exposure only. Host authorization must require
    // both `service` and `workflow.enqueue`; this mutator trusts the delegated
    // caller principal in its arguments rather than the request context.
    ZeroApiEndpoint.mutator("enqueueAsCaller", {
      visibility: "service",
      request: DelegatedWorkflowEnqueueRequest,
      mutator: ({
        args,
        tx,
      }: {
        readonly args: DelegatedWorkflowEnqueueRequest;
        readonly ctx: WorkflowZeroContext;
        readonly tx: Transaction<TSchema>;
      }) =>
        enqueueWorkflowInZeroTransaction(
          tx,
          options.delegatedContext(args.caller.principalId),
          args.workflow,
        ),
    }),
    ZeroApiEndpoint.mutator("command", {
      visibility: "internal",
      request: WorkflowCommandRequest,
      mutator: ({
        args,
        ctx,
        tx,
      }: {
        readonly args: WorkflowCommandRequest;
        readonly ctx: WorkflowZeroContext;
        readonly tx: Transaction<TSchema>;
      }) => enqueueWorkflowCommandInZeroTransaction(tx, ctx, args),
    }),
    ZeroApiEndpoint.mutator("sendEvent", {
      visibility: "internal",
      request: WorkflowEventRequest,
      mutator: ({
        args,
        ctx,
        tx,
      }: {
        readonly args: WorkflowEventRequest;
        readonly ctx: WorkflowZeroContext;
        readonly tx: Transaction<TSchema>;
      }) => enqueueWorkflowEventInZeroTransaction(tx, ctx, args),
    }),
  );

  return {
    enqueueContractInvocationInZeroTransaction,
    enqueueWorkflowCommandInZeroTransaction,
    enqueueWorkflowEventInZeroTransaction,
    enqueueWorkflowInZeroTransaction,
    mutateWithWorkflow,
    runsGroup,
  } as const;
};

export type ZeroWorkflowComponent<TSchema extends WorkflowZeroSchema> = ReturnType<
  typeof makeZeroWorkflowComponent<TSchema>
>;
