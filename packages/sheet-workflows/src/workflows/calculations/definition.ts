import { Cause, Duration, Effect, Exit, Option, Predicate, Schedule, Schema } from "effect";
import { ClusterError, ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  CalculationDeclaredFailure,
  CalculationsRecalculateSheet,
  SheetReference,
} from "sheet-workflow-contracts";
import { CalculationProjectionEntity } from "@/entities/calculationProjection";
import { calculateProjection, calculationFailureProjection } from "./calculation";
import { calculationActionVersion } from "./catalog";
import {
  calculationActionIdentities,
  makeCalculationActionKey,
  makeCalculationSerializationKey,
} from "./keys";
import { canonicalCalculationSheetRef } from "./range";
import {
  calculationExternalOperationRejected,
  calculationExternalOperationCodes,
  calculationInvalidRequest,
  calculationInvalidRequestCodes,
  preserveCalculationDeclaredFailure as preserveDeclaredFailure,
} from "./failure";
import {
  CalculationExecution,
  CalculationSource,
  CalculationWriteExecution,
  CalculationWriteReceipt,
  CanonicalCalculationExecution,
  isCalculationWriteExecutionWithinPersistedPayloadLimit,
  isCalculationWriteExecutionShape,
  isPersistedCalculationRows,
} from "./schema";
import type { CalculationProjection } from "./schema";
import { CalculationWorkflowOperations } from "./service";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";

const name = workflowContractKey(CalculationsRecalculateSheet);
const actionName = CalculationsRecalculateSheet.identity;
const calculationEntityRetrySchedule = Schedule.exponential("500 millis").pipe(Schedule.jittered);
const calculationEntityRetryTimes = 5;
const calculationEntityTimeout = Duration.minutes(2);
const calculationEntityUnavailable = () =>
  calculationExternalOperationRejected(
    calculationExternalOperationCodes.calculationProjectionEntityUnavailable,
    "The calculation projection entity could not be scheduled",
  );
const isUnwritableCalculationSourceFailure = (
  failure: typeof CalculationDeclaredFailure.Type,
): boolean =>
  Predicate.isTagged("InvalidRequest")(failure) &&
  failure.code === calculationInvalidRequestCodes.payloadTooLarge;

const RetryableCalculationClusterError = Schema.Union([
  ClusterError.EntityNotAssignedToRunner,
  ClusterError.RunnerNotRegistered,
  ClusterError.RunnerUnavailable,
  ClusterError.MailboxFull,
  ClusterError.AlreadyProcessingMessage,
  ClusterError.PersistenceError,
]);
const isRetryableCalculationEntityError = Schema.is(RetryableCalculationClusterError);
const CalculationClusterError = Schema.Union([
  ...RetryableCalculationClusterError.members,
  ClusterError.MalformedMessage,
]);
const isCalculationClusterError = Schema.is(CalculationClusterError);

const spreadsheetIdFromActionInput = (
  input: typeof CalculationsRecalculateSheet.input.Type,
): string => input.spreadsheetId;

const executeLoadAction = (execution: typeof CanonicalCalculationExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* CalculationWorkflowOperations;
    return yield* preserveDeclaredFailure(operations.load(execution));
  });

const executeWriteAction = (execution: typeof CalculationWriteExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* CalculationWorkflowOperations;
    return yield* preserveDeclaredFailure(operations.write(execution));
  });

const LoadCalculationSourceAction = makeAction({
  name: `${actionName}.${calculationActionIdentities.load}`,
  version: calculationActionVersion,
  shardGroup: "dispatch",
  input: CanonicalCalculationExecution,
  success: CalculationSource,
  error: CalculationDeclaredFailure,
  idempotencyKey: ({ canonicalSheetRef, invocationId, input }) =>
    makeCalculationActionKey(
      invocationId,
      calculationActionIdentities.load,
      spreadsheetIdFromActionInput(input),
      canonicalSheetRef,
    ),
  execute: executeLoadAction,
});

const WriteCalculationProjectionAction = makeAction({
  name: `${actionName}.${calculationActionIdentities.write}`,
  version: calculationActionVersion,
  shardGroup: "dispatch",
  input: CalculationWriteExecution,
  success: CalculationWriteReceipt,
  error: CalculationDeclaredFailure,
  idempotencyKey: ({ canonicalSheetRef, invocationId, input }) =>
    makeCalculationActionKey(
      invocationId,
      calculationActionIdentities.write,
      spreadsheetIdFromActionInput(input),
      canonicalSheetRef,
    ),
  execute: executeWriteAction,
});

const CalculationsRecalculateSheetWorkflow = Workflow.make({
  name,
  payload: CalculationExecution,
  success: CalculationsRecalculateSheet.success,
  error: CalculationDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const declaredFailureFrom = (
  cause: Cause.Cause<unknown>,
): typeof CalculationDeclaredFailure.Type | undefined => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  return Schema.is(CalculationDeclaredFailure)(error) ? error : undefined;
};

const validateCalculationWriteExecution = (
  execution: typeof CalculationWriteExecution.Type,
  options: { readonly allowOversizedPreWriteProjection?: boolean } = {},
): Effect.Effect<typeof CalculationWriteExecution.Type, typeof CalculationDeclaredFailure.Type> => {
  const executionForValidation = options.allowOversizedPreWriteProjection
    ? { ...execution, source: { ...execution.source, preWriteProjection: [] } }
    : execution;
  const schemaValid = Schema.is(CalculationWriteExecution)(executionForValidation);
  // CalculationWriteExecution embeds persisted-row bounds. Keep its unbounded structural shape
  // available so oversized rows become a declared payload failure instead of an action defect.
  if (!schemaValid && !isCalculationWriteExecutionShape(executionForValidation)) {
    return Effect.die(
      new Error("calculation write execution has an unrecognized structural shape"),
    );
  }
  if (
    (!options.allowOversizedPreWriteProjection &&
      !isPersistedCalculationRows(execution.source.preWriteProjection)) ||
    !isPersistedCalculationRows(execution.projection.rows) ||
    !isCalculationWriteExecutionWithinPersistedPayloadLimit(executionForValidation)
  ) {
    return Effect.fail(
      calculationInvalidRequest(
        calculationInvalidRequestCodes.payloadTooLarge,
        "The calculation write exceeds the supported persisted payload limit",
      ),
    );
  }
  if (!schemaValid) {
    return Effect.die(
      new Error("calculation write execution failed schema validation for a non-size constraint"),
    );
  }
  return Effect.succeed(execution);
};

export const makeCalculationsRecalculateSheetSerializedBody = <RLoad, RWrite>(actions: {
  readonly load: (
    execution: typeof CanonicalCalculationExecution.Type,
  ) => Effect.Effect<typeof CalculationSource.Type, typeof CalculationDeclaredFailure.Type, RLoad>;
  readonly write: (
    execution: typeof CalculationWriteExecution.Type,
  ) => Effect.Effect<
    typeof CalculationWriteReceipt.Type,
    typeof CalculationDeclaredFailure.Type,
    RWrite
  >;
}) =>
  Effect.fnUntraced(function* (execution: typeof CanonicalCalculationExecution.Type) {
    const input = yield* decodeWorkflowContractInputOrDie(
      CalculationsRecalculateSheet,
      execution.input,
    );
    const source = yield* actions.load(execution);
    const sourceFailure = source.failure;
    // Write declared source failures as bounded projections; skip only when the write payload is unsafe.
    if (Predicate.isNotNull(sourceFailure) && isUnwritableCalculationSourceFailure(sourceFailure)) {
      return yield* Effect.fail(sourceFailure);
    }
    const calculation = yield* Effect.exit(calculateProjection(input, source));
    let calculationFailure: typeof CalculationDeclaredFailure.Type | undefined;
    let projection: CalculationProjection;
    if (Exit.isSuccess(calculation)) {
      projection = calculation.value;
    } else {
      const failure = declaredFailureFrom(calculation.cause);
      if (Predicate.isUndefined(failure)) return yield* Effect.failCause(calculation.cause);
      calculationFailure = failure;
      projection = calculationFailureProjection(input.hour, failure);
    }
    const writeExecution = yield* validateCalculationWriteExecution(
      {
        ...execution,
        source,
        projection,
      },
      { allowOversizedPreWriteProjection: Predicate.isNotUndefined(calculationFailure) },
    );
    const receipt = yield* actions.write(writeExecution);
    if (Predicate.isNotUndefined(calculationFailure)) {
      return yield* Effect.fail(calculationFailure);
    }
    const sheetRef = yield* Schema.decodeUnknownEffect(SheetReference)(
      execution.canonicalSheetRef,
    ).pipe(Effect.orDie);
    return {
      spreadsheetId: input.spreadsheetId,
      sheetRef,
      hour: input.hour,
      outputRange: receipt.outputRange,
      roomCount: receipt.roomCount,
    };
  });

export const runCalculationsRecalculateSheetSerialized = (
  execution: typeof CanonicalCalculationExecution.Type,
) =>
  makeCalculationsRecalculateSheetSerializedBody({
    load: (input) => LoadCalculationSourceAction.await(input),
    write: (input) => WriteCalculationProjectionAction.await(input),
  })(execution);

const runThroughEntity = (execution: typeof CanonicalCalculationExecution.Type) =>
  Effect.gen(function* () {
    const input = yield* decodeWorkflowContractInputOrDie(
      CalculationsRecalculateSheet,
      execution.input,
    );
    const clientFor = yield* CalculationProjectionEntity.client;
    return yield* clientFor(
      makeCalculationSerializationKey(input.spreadsheetId, execution.canonicalSheetRef),
    ).run(execution);
  }).pipe(
    Effect.retry({
      schedule: calculationEntityRetrySchedule,
      times: calculationEntityRetryTimes,
      while: isRetryableCalculationEntityError,
    }),
    // The persisted, single-concurrency entity may finish an accepted request after this
    // timeout reports unavailability. Invocation-keyed workflow/action idempotency makes
    // caller retries safe despite that at-least-once outcome.
    Effect.timeoutOrElse({
      duration: calculationEntityTimeout,
      orElse: () => Effect.fail(calculationEntityUnavailable()),
    }),
    Effect.catch((error) =>
      isCalculationClusterError(error)
        ? Effect.fail(calculationEntityUnavailable())
        : Effect.fail(error),
    ),
    preserveDeclaredFailure,
  );

export const makeCalculationsRecalculateSheetWorkflowBody = <R>(actions: {
  readonly runSerialized: (
    execution: typeof CanonicalCalculationExecution.Type,
  ) => Effect.Effect<
    typeof CalculationsRecalculateSheet.success.Type,
    typeof CalculationDeclaredFailure.Type,
    R
  >;
}) =>
  Effect.fnUntraced(function* (execution: typeof CalculationExecution.Type) {
    const input = yield* decodeWorkflowContractInputOrDie(
      CalculationsRecalculateSheet,
      execution.input,
    );
    const canonical = canonicalCalculationSheetRef(input.sheetRef);
    if (Predicate.isUndefined(canonical)) {
      return yield* Effect.fail(
        calculationInvalidRequest(
          calculationInvalidRequestCodes.invalidSheetReference,
          "sheetRef must address one sheet's exact AX30:CC projection",
        ),
      );
    }
    return yield* actions.runSerialized({
      ...execution,
      sheetTitle: canonical.sheetTitle,
      canonicalSheetRef: canonical.sheetRef,
    });
  });

export const makeCalculationsRecalculateSheetDefinition = () => ({
  contract: CalculationsRecalculateSheet,
  workflow: CalculationsRecalculateSheetWorkflow,
  actions: [LoadCalculationSourceAction, WriteCalculationProjectionAction] as const,
  workflowLayer: CalculationsRecalculateSheetWorkflow.toLayer(
    makeCalculationsRecalculateSheetWorkflowBody({ runSerialized: runThroughEntity }),
  ),
});
