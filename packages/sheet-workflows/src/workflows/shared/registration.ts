import { Effect, Layer, Schema } from "effect";
import {
  makeWorkflowTransportHandler,
  validateWorkflowContractRegistrations,
  type ExecutableWorkflowContractRegistration,
  type WorkflowInvocationStore,
} from "effect-zero-workflow";
import type { AnyWorkflowContract } from "effect-zero-workflow/contract";
import {
  WorkflowInvocationUnauthorized,
  WorkflowTransportUnavailable,
} from "effect-zero-workflow/contract/transport";
import {
  enqueueSheetWorkflowContractInvocationInZeroTransaction,
  makeSheetWorkflowZeroGroups,
  type EnqueueSheetWorkflowContract,
  type SheetWorkflowZeroContext,
} from "sheet-zero-server";
import type { ZeroApiGroup } from "typhoon-zero/zeroApi";
import {
  ownerKeyForEffectivePrincipal,
  ReadOnlyWorkflowAuthorization,
} from "../readOnly/authorization";

export type SheetWorkflowRegistration = ExecutableWorkflowContractRegistration<
  AnyWorkflowContract,
  SheetWorkflowZeroContext,
  ReadOnlyWorkflowAuthorization
>;

const isWorkflowInvocationUnauthorized = Schema.is(WorkflowInvocationUnauthorized);

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

export const makeSheetWorkflowRegistration =
  (definitionVersion: string) =>
  <Contract extends AnyWorkflowContract>(contract: Contract): SheetWorkflowRegistration => ({
    contract,
    definitionVersion,
    authorize: (context: SheetWorkflowZeroContext, input: unknown) =>
      ownerMatchesPrincipal(context).pipe(
        Effect.andThen(
          Effect.flatMap(ReadOnlyWorkflowAuthorization, (authorization) =>
            authorization.authorize(contract, context.principal, input),
          ),
        ),
        Effect.tapError((error) =>
          isWorkflowInvocationUnauthorized(error)
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
          isWorkflowInvocationUnauthorized(error) ? error : unavailable("Enqueue"),
        ),
      ),
    authorizeObservation: ownerMatchesPrincipal,
  });

export const makeSheetWorkflowRegistrationValidationLayer = (
  contracts: ReadonlyArray<AnyWorkflowContract>,
  registrations: ReadonlyArray<SheetWorkflowRegistration>,
) => Layer.effectDiscard(validateWorkflowContractRegistrations(contracts, registrations));

export const makeSheetWorkflowTransportHandler = (
  contracts: ReadonlyArray<AnyWorkflowContract>,
  registrations: ReadonlyArray<SheetWorkflowRegistration>,
  store: WorkflowInvocationStore<
    SheetWorkflowZeroContext["principal"],
    ReadOnlyWorkflowAuthorization,
    NonNullable<SheetWorkflowZeroContext["actorProvenance"]>
  >,
) => makeWorkflowTransportHandler({ contracts, registrations, store });

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

export const makeSheetWorkflowZeroEnqueue = (
  contracts: ReadonlyArray<AnyWorkflowContract>,
  registrations: ReadonlyArray<SheetWorkflowRegistration>,
) =>
  Effect.gen(function* () {
    const effectContext = yield* Effect.context<ReadOnlyWorkflowAuthorization>();
    const enqueue: EnqueueSheetWorkflowContract = ({
      contract,
      request,
      context: invocationContext,
      transaction,
    }) =>
      Effect.runPromiseWith(effectContext)(
        makeSheetWorkflowTransportHandler(
          contracts,
          registrations,
          transactionStore(transaction),
        ).pipe(
          Effect.flatMap((handler) => handler.enqueue(contract, invocationContext, request)),
          Effect.asVoid,
        ),
      );
    return enqueue;
  });

export const makeSheetWorkflowZeroGroupsFor = (
  contracts: ReadonlyArray<AnyWorkflowContract>,
  enqueue: EnqueueSheetWorkflowContract,
  workflowRun?: Parameters<typeof makeSheetWorkflowZeroGroups>[1],
): ReadonlyArray<ZeroApiGroup.Any> => makeSheetWorkflowZeroGroups(enqueue, workflowRun, contracts);
