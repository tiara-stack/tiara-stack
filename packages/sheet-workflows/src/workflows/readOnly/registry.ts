import { Effect, Layer, Schema } from "effect";
import {
  makeWorkflowTransportHandler,
  validateWorkflowContractRegistrations,
  type ExecutableWorkflowContractRegistration,
  type WorkflowInvocationStore,
} from "effect-zero-workflow";
import {
  WorkflowInvocationUnauthorized,
  WorkflowTransportUnavailable,
} from "effect-zero-workflow/contract/transport";
import type { AnyWorkflowContract } from "effect-zero-workflow/contract";
import {
  enqueueSheetWorkflowContractInvocationInZeroTransaction,
  makeSheetWorkflowZeroGroups,
  type EnqueueSheetWorkflowContract,
  type SheetWorkflowZeroContext,
} from "sheet-zero-server";
import type { ZeroApiGroup } from "typhoon-zero/zeroApi";
import { ReadOnlyWorkflowAuthorization, ownerKeyForEffectivePrincipal } from "./authorization";
import { ReadOnlySheetWorkflowContracts, readOnlySheetWorkflowDefinitionVersion } from "./catalog";

export type ReadOnlyWorkflowRegistration = ExecutableWorkflowContractRegistration<
  AnyWorkflowContract,
  SheetWorkflowZeroContext,
  ReadOnlyWorkflowAuthorization
>;

const ownerMatchesPrincipal = (context: SheetWorkflowZeroContext) =>
  context.ownerKey === ownerKeyForEffectivePrincipal(context.principal)
    ? Effect.void
    : Effect.fail(
        new WorkflowInvocationUnauthorized({
          message: "Workflow owner does not match the effective principal",
        }),
      );

const unavailable = (operation: "Enqueue" | "Observe") =>
  new WorkflowTransportUnavailable({
    operation,
    retryable: true,
    message: `Workflow ${operation.toLowerCase()} transport is unavailable`,
  });

const makeRegistration = <Contract extends AnyWorkflowContract>(
  contract: Contract,
): ReadOnlyWorkflowRegistration => ({
  contract,
  definitionVersion: readOnlySheetWorkflowDefinitionVersion,
  authorize: (context: SheetWorkflowZeroContext, input: unknown) =>
    ownerMatchesPrincipal(context).pipe(
      Effect.andThen(
        Effect.flatMap(ReadOnlyWorkflowAuthorization, (authorization) =>
          authorization.authorize(contract, context.principal, input),
        ),
      ),
      Effect.tapError((error) =>
        Schema.is(WorkflowInvocationUnauthorized)(error)
          ? Effect.void
          : Effect.logWarning("Workflow authorization lookup failed").pipe(
              Effect.annotateLogs({
                contractIdentity: contract.identity,
                errorCategory: "AuthorizationLookupFailure",
                ownerKey: context.ownerKey,
                wireVersion: contract.wireVersion,
              }),
            ),
      ),
      Effect.mapError((error) =>
        Schema.is(WorkflowInvocationUnauthorized)(error) ? error : unavailable("Enqueue"),
      ),
    ),
  authorizeObservation: ownerMatchesPrincipal,
});

export const ReadOnlySheetWorkflowRegistrations: ReadonlyArray<ReadOnlyWorkflowRegistration> =
  Object.freeze(ReadOnlySheetWorkflowContracts.map(makeRegistration));

export const readOnlySheetWorkflowRegistrationValidationLayer = Layer.effectDiscard(
  validateWorkflowContractRegistrations(
    ReadOnlySheetWorkflowContracts,
    ReadOnlySheetWorkflowRegistrations,
  ),
);

export const makeReadOnlyWorkflowTransportHandler = (
  store: WorkflowInvocationStore<
    SheetWorkflowZeroContext["principal"],
    ReadOnlyWorkflowAuthorization,
    NonNullable<SheetWorkflowZeroContext["actorProvenance"]>
  >,
) =>
  makeWorkflowTransportHandler({
    contracts: ReadOnlySheetWorkflowContracts,
    registrations: ReadOnlySheetWorkflowRegistrations,
    store,
  });

const transactionStore = (
  transaction: Parameters<EnqueueSheetWorkflowContract>[0]["transaction"],
): WorkflowInvocationStore<
  SheetWorkflowZeroContext["principal"],
  never,
  NonNullable<SheetWorkflowZeroContext["actorProvenance"]>
> => ({
  enqueue: (invocation) =>
    Effect.tryPromise({
      try: () => enqueueSheetWorkflowContractInvocationInZeroTransaction(transaction, invocation),
      catch: (cause) => cause,
    }).pipe(
      Effect.tapError(() =>
        Effect.logWarning("Workflow transaction enqueue failed").pipe(
          Effect.annotateLogs({
            contractIdentity: invocation.fingerprint.contractIdentity,
            errorCategory: "TransactionEnqueueFailure",
            invocationId: invocation.fingerprint.invocationId,
            wireVersion: invocation.fingerprint.wireVersion,
          }),
        ),
      ),
      Effect.mapError(() => unavailable("Enqueue")),
    ),
  get: () => Effect.fail(unavailable("Observe")),
  list: () => Effect.fail(unavailable("Observe")),
});

export const makeReadOnlySheetWorkflowZeroEnqueue = Effect.gen(function* () {
  const authorization = yield* ReadOnlyWorkflowAuthorization;
  const enqueue: EnqueueSheetWorkflowContract = ({ contract, request, context, transaction }) =>
    Effect.runPromise(
      makeReadOnlyWorkflowTransportHandler(transactionStore(transaction)).pipe(
        Effect.flatMap((handler) => handler.enqueue(contract, context, request)),
        Effect.asVoid,
        Effect.provideService(ReadOnlyWorkflowAuthorization, authorization),
      ),
    );
  return enqueue;
});

export const makeReadOnlySheetWorkflowZeroGroups = (
  enqueue: EnqueueSheetWorkflowContract,
  workflowRun?: Parameters<typeof makeSheetWorkflowZeroGroups>[1],
): ReadonlyArray<ZeroApiGroup.Any> =>
  makeSheetWorkflowZeroGroups(enqueue, workflowRun, ReadOnlySheetWorkflowContracts);
