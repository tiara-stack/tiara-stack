import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  DeleteMessageReceipt,
  EditMessageReceipt,
  RespondReceipt,
  SendMessageReceipt,
  type DeliveryReceipt,
} from "sheet-bot-api";
import {
  CheckinsTestAuto,
  type CheckinsTestAutoConversationResult,
  InteractiveDeclaredFailure,
} from "sheet-workflow-contracts";
import { autoCheckinTestHour } from "sheet-message-content/rendering";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";
import { preserveInteractiveDeclaredFailure as preserveDeclaredFailure } from "../shared/interactive";
import { autoCheckinTestActionVersion } from "./catalog";
import {
  autoCheckinTestActionIdentities,
  makeAutoCheckinTestActionKey,
  makeAutoCheckinTestDeliveryKey,
} from "./autoTestKeys";
import { makeAutoCheckinTestSummaryMessage } from "./autoTestOperations";
import {
  AutoCheckinTestAnchorExecution,
  AutoCheckinTestCurrentSummaryExecution,
  AutoCheckinTestDiscovery,
  AutoCheckinTestExecution,
  AutoCheckinTestPreparation,
  AutoCheckinTestPreparedExecution,
  AutoCheckinTestPreviewDeliveryOutcome,
  AutoCheckinTestSummaryExecution,
  AutoCheckinTestTargetExecution,
} from "./autoTestSchema";
import { AutoCheckinTestWorkflowOperations } from "./autoTestService";

const name = workflowContractKey(CheckinsTestAuto);
const actionName = CheckinsTestAuto.identity;
const targetFailureMessage = "Test run failed; see server logs.";

const executeCreateAnchorAction = (execution: typeof AutoCheckinTestExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* AutoCheckinTestWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.createAnchor(
        execution,
        makeAutoCheckinTestDeliveryKey(
          execution.invocationId,
          autoCheckinTestActionIdentities.createAnchor,
        ),
      ),
    );
  });

const executeDiscoverTargetsAction = (execution: typeof AutoCheckinTestExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* AutoCheckinTestWorkflowOperations;
    return yield* preserveDeclaredFailure(operations.discoverTargets(execution));
  });

const executePrepareTargetAction = (execution: typeof AutoCheckinTestTargetExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* AutoCheckinTestWorkflowOperations;
    return yield* preserveDeclaredFailure(operations.prepareTarget(execution));
  });

const executeDeliverCheckinPreviewAction = (
  execution: typeof AutoCheckinTestPreparedExecution.Type,
) =>
  Effect.gen(function* () {
    const operations = yield* AutoCheckinTestWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.deliverCheckinPreview(
        execution,
        makeAutoCheckinTestDeliveryKey(
          execution.invocationId,
          autoCheckinTestActionIdentities.deliverCheckin,
          execution.preparation.conversationName,
        ),
      ),
    );
  });

const executeDeliverMonitorPreviewAction = (
  execution: typeof AutoCheckinTestPreparedExecution.Type,
) =>
  Effect.gen(function* () {
    const operations = yield* AutoCheckinTestWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.deliverMonitorPreview(
        execution,
        makeAutoCheckinTestDeliveryKey(
          execution.invocationId,
          autoCheckinTestActionIdentities.deliverMonitor,
          execution.preparation.conversationName,
        ),
      ),
    );
  });

const executeDeliverTentativeRoomOrderPreviewAction = (
  execution: typeof AutoCheckinTestPreparedExecution.Type,
) =>
  Effect.gen(function* () {
    const operations = yield* AutoCheckinTestWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.deliverTentativeRoomOrderPreview(
        execution,
        makeAutoCheckinTestDeliveryKey(
          execution.invocationId,
          autoCheckinTestActionIdentities.deliverTentativeRoomOrder,
          execution.preparation.conversationName,
        ),
      ),
    );
  });

const executeUpdateAnchorSummaryAction = (execution: typeof AutoCheckinTestSummaryExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* AutoCheckinTestWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.updateAnchorSummary(
        execution,
        makeAutoCheckinTestDeliveryKey(
          execution.invocationId,
          autoCheckinTestActionIdentities.updateSummary,
        ),
      ),
    );
  });

const executeCleanupAnchorAction = (execution: typeof AutoCheckinTestAnchorExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* AutoCheckinTestWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.cleanupAnchor(
        execution,
        makeAutoCheckinTestDeliveryKey(
          execution.invocationId,
          autoCheckinTestActionIdentities.cleanupAnchor,
        ),
      ),
    );
  });

const CreateAutoCheckinTestAnchorAction = makeAction({
  name: `${actionName}.${autoCheckinTestActionIdentities.createAnchor}`,
  version: autoCheckinTestActionVersion,
  shardGroup: "dispatch",
  input: AutoCheckinTestExecution,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeAutoCheckinTestActionKey(invocationId, autoCheckinTestActionIdentities.createAnchor),
  execute: executeCreateAnchorAction,
});

const DiscoverAutoCheckinTestTargetsAction = makeAction({
  name: `${actionName}.${autoCheckinTestActionIdentities.discoverTargets}`,
  version: autoCheckinTestActionVersion,
  shardGroup: "dispatch",
  input: AutoCheckinTestExecution,
  success: AutoCheckinTestDiscovery,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeAutoCheckinTestActionKey(invocationId, autoCheckinTestActionIdentities.discoverTargets),
  execute: executeDiscoverTargetsAction,
});

const PrepareAutoCheckinTestTargetAction = makeAction({
  name: `${actionName}.${autoCheckinTestActionIdentities.prepareTarget}`,
  version: autoCheckinTestActionVersion,
  shardGroup: "dispatch",
  input: AutoCheckinTestTargetExecution,
  success: AutoCheckinTestPreparation,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ conversationName, invocationId }) =>
    makeAutoCheckinTestActionKey(
      invocationId,
      autoCheckinTestActionIdentities.prepareTarget,
      conversationName,
    ),
  execute: executePrepareTargetAction,
});

const DeliverAutoCheckinTestCheckinPreviewAction = makeAction({
  name: `${actionName}.${autoCheckinTestActionIdentities.deliverCheckin}`,
  version: autoCheckinTestActionVersion,
  shardGroup: "dispatch",
  input: AutoCheckinTestPreparedExecution,
  success: AutoCheckinTestPreviewDeliveryOutcome,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId, preparation }) =>
    makeAutoCheckinTestActionKey(
      invocationId,
      autoCheckinTestActionIdentities.deliverCheckin,
      preparation.conversationName,
    ),
  execute: executeDeliverCheckinPreviewAction,
});

const DeliverAutoCheckinTestMonitorPreviewAction = makeAction({
  name: `${actionName}.${autoCheckinTestActionIdentities.deliverMonitor}`,
  version: autoCheckinTestActionVersion,
  shardGroup: "dispatch",
  input: AutoCheckinTestPreparedExecution,
  success: AutoCheckinTestPreviewDeliveryOutcome,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId, preparation }) =>
    makeAutoCheckinTestActionKey(
      invocationId,
      autoCheckinTestActionIdentities.deliverMonitor,
      preparation.conversationName,
    ),
  execute: executeDeliverMonitorPreviewAction,
});

const DeliverAutoCheckinTestTentativeRoomOrderPreviewAction = makeAction({
  name: `${actionName}.${autoCheckinTestActionIdentities.deliverTentativeRoomOrder}`,
  version: autoCheckinTestActionVersion,
  shardGroup: "dispatch",
  input: AutoCheckinTestPreparedExecution,
  success: AutoCheckinTestPreviewDeliveryOutcome,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId, preparation }) =>
    makeAutoCheckinTestActionKey(
      invocationId,
      autoCheckinTestActionIdentities.deliverTentativeRoomOrder,
      preparation.conversationName,
    ),
  execute: executeDeliverTentativeRoomOrderPreviewAction,
});

const UpdateAutoCheckinTestAnchorSummaryAction = makeAction({
  name: `${actionName}.${autoCheckinTestActionIdentities.updateSummary}`,
  version: autoCheckinTestActionVersion,
  shardGroup: "dispatch",
  input: AutoCheckinTestSummaryExecution,
  success: EditMessageReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeAutoCheckinTestActionKey(invocationId, autoCheckinTestActionIdentities.updateSummary),
  execute: executeUpdateAnchorSummaryAction,
});

const CleanupAutoCheckinTestAnchorAction = makeAction({
  name: `${actionName}.${autoCheckinTestActionIdentities.cleanupAnchor}`,
  version: autoCheckinTestActionVersion,
  shardGroup: "dispatch",
  input: AutoCheckinTestAnchorExecution,
  success: DeleteMessageReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeAutoCheckinTestActionKey(invocationId, autoCheckinTestActionIdentities.cleanupAnchor),
  execute: executeCleanupAnchorAction,
});

const CheckinsTestAutoWorkflow = Workflow.make({
  name,
  payload: AutoCheckinTestExecution,
  success: CheckinsTestAuto.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

type PreviewDeliveryState = "none" | "committed" | "unknown" | "committed-and-unknown";

const withUnknownDelivery = (state: PreviewDeliveryState): PreviewDeliveryState =>
  state === "committed" || state === "committed-and-unknown" ? "committed-and-unknown" : "unknown";

type TargetOutcome = {
  readonly result: CheckinsTestAutoConversationResult;
  readonly receipts: ReadonlyArray<typeof SendMessageReceipt.Type>;
  readonly deliveryState: PreviewDeliveryState;
  readonly terminalCause?: Cause.Cause<ActionFailure>;
};

type ActionFailure = typeof InteractiveDeclaredFailure.Type;
const isActionFailure = Schema.is(InteractiveDeclaredFailure);
const isLegacyPreviewReceipt = Schema.is(SendMessageReceipt);

const declaredFailureFrom = (cause: Cause.Cause<unknown>): ActionFailure | undefined => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  return isActionFailure(error) ? error : undefined;
};

const isAuthorizationCause = (cause: Cause.Cause<unknown>): boolean =>
  Predicate.isTagged("AuthorizationRevoked")(declaredFailureFrom(cause));

const failedTarget = (conversationName: string, hour: number): TargetOutcome => ({
  result: {
    conversationName,
    runningConversationId: null,
    checkinConversationId: null,
    hour,
    status: "failed",
    error: targetFailureMessage,
  },
  receipts: [],
  deliveryState: "none",
});

const completeFailedDelivery = (
  conversationName: string,
  preparation: typeof AutoCheckinTestPreparation.Type,
  receipts: ReadonlyArray<typeof SendMessageReceipt.Type>,
  deliveryState: PreviewDeliveryState,
  terminalCause?: Cause.Cause<ActionFailure>,
): TargetOutcome => ({
  result: {
    conversationName,
    runningConversationId: preparation.runningConversationId,
    checkinConversationId: preparation.checkinConversationId,
    hour: preparation.hour,
    status: "failed",
    error: targetFailureMessage,
  },
  receipts,
  deliveryState,
  ...(Predicate.isUndefined(terminalCause) ? {} : { terminalCause }),
});

const runPreparedTarget = <R>(
  preparedExecution: typeof AutoCheckinTestPreparedExecution.Type,
  actions: {
    readonly deliverCheckin: (
      execution: typeof AutoCheckinTestPreparedExecution.Type,
    ) => Effect.Effect<typeof AutoCheckinTestPreviewDeliveryOutcome.Type, ActionFailure, R>;
    readonly deliverMonitor: (
      execution: typeof AutoCheckinTestPreparedExecution.Type,
    ) => Effect.Effect<typeof AutoCheckinTestPreviewDeliveryOutcome.Type, ActionFailure, R>;
    readonly deliverTentativeRoomOrder: (
      execution: typeof AutoCheckinTestPreparedExecution.Type,
    ) => Effect.Effect<typeof AutoCheckinTestPreviewDeliveryOutcome.Type, ActionFailure, R>;
  },
) =>
  Effect.gen(function* () {
    const preparation = preparedExecution.preparation;
    const receipts: Array<typeof SendMessageReceipt.Type> = [];
    let deliveryState: PreviewDeliveryState = "none";
    const finishDelivery = (
      exit: Exit.Exit<typeof AutoCheckinTestPreviewDeliveryOutcome.Type, ActionFailure>,
    ): Option.Option<TargetOutcome> => {
      if (Exit.isFailure(exit)) {
        const failure = declaredFailureFrom(exit.cause);
        if (Predicate.isTagged("DeliveryRejected")(failure) && failure.recoveryRequired) {
          deliveryState = withUnknownDelivery(deliveryState);
        }
        return Option.some(
          completeFailedDelivery(
            preparation.conversationName,
            preparation,
            receipts,
            deliveryState,
            isAuthorizationCause(exit.cause) ? exit.cause : undefined,
          ),
        );
      }
      if (isLegacyPreviewReceipt(exit.value)) {
        receipts.push(exit.value);
        deliveryState = "committed";
        return Option.none();
      }
      if (Predicate.isTagged("Committed")(exit.value)) {
        receipts.push(exit.value.receipt);
        deliveryState = "committed";
        return Option.none();
      }
      deliveryState = withUnknownDelivery(deliveryState);
      return Option.some(
        completeFailedDelivery(
          preparation.conversationName,
          preparation,
          receipts,
          deliveryState,
          Predicate.isTagged("AuthorizationRevoked")(exit.value.failure)
            ? Cause.fail(exit.value.failure)
            : undefined,
        ),
      );
    };
    if (Predicate.isNotNull(preparation.checkinPreview)) {
      const exit = yield* Effect.exit(actions.deliverCheckin(preparedExecution));
      const failed = finishDelivery(exit);
      if (Option.isSome(failed)) return failed.value;
    }
    const monitorExit = yield* Effect.exit(actions.deliverMonitor(preparedExecution));
    const monitorFailed = finishDelivery(monitorExit);
    if (Option.isSome(monitorFailed)) return monitorFailed.value;

    // Optional preview delivery intentionally mirrors the earlier check-in delivery branch.
    if (Predicate.isNotNull(preparation.tentativeRoomOrderPreview)) {
      const roomOrderExit = yield* Effect.exit(
        actions.deliverTentativeRoomOrder(preparedExecution),
      );
      const roomOrderFailure = finishDelivery(roomOrderExit);
      if (Option.isSome(roomOrderFailure)) return roomOrderFailure.value;
    }
    return {
      result: {
        conversationName: preparation.conversationName,
        runningConversationId: preparation.runningConversationId,
        checkinConversationId: preparation.checkinConversationId,
        hour: preparation.hour,
        status: preparation.status,
        error: preparation.error,
      },
      receipts,
      deliveryState,
    } satisfies TargetOutcome;
  });

// The body keeps the commit-point and CollectAll recovery policy visible as one orchestration unit.
// fallow-ignore-next-line complexity
export const makeCheckinsTestAutoWorkflowBody = <R>(actions: {
  readonly createAnchor: (
    execution: typeof AutoCheckinTestExecution.Type,
  ) => Effect.Effect<typeof RespondReceipt.Type, ActionFailure, R>;
  readonly discover: (
    execution: typeof AutoCheckinTestExecution.Type,
  ) => Effect.Effect<typeof AutoCheckinTestDiscovery.Type, ActionFailure, R>;
  readonly prepare: (
    execution: typeof AutoCheckinTestTargetExecution.Type,
  ) => Effect.Effect<typeof AutoCheckinTestPreparation.Type, ActionFailure, R>;
  readonly deliverCheckin: (
    execution: typeof AutoCheckinTestPreparedExecution.Type,
  ) => Effect.Effect<typeof AutoCheckinTestPreviewDeliveryOutcome.Type, ActionFailure, R>;
  readonly deliverMonitor: (
    execution: typeof AutoCheckinTestPreparedExecution.Type,
  ) => Effect.Effect<typeof AutoCheckinTestPreviewDeliveryOutcome.Type, ActionFailure, R>;
  readonly deliverTentativeRoomOrder: (
    execution: typeof AutoCheckinTestPreparedExecution.Type,
  ) => Effect.Effect<typeof AutoCheckinTestPreviewDeliveryOutcome.Type, ActionFailure, R>;
  readonly updateSummary: (
    execution: typeof AutoCheckinTestCurrentSummaryExecution.Type,
  ) => Effect.Effect<typeof EditMessageReceipt.Type, ActionFailure, R>;
  readonly cleanup: (
    execution: typeof AutoCheckinTestAnchorExecution.Type,
  ) => Effect.Effect<typeof DeleteMessageReceipt.Type, ActionFailure, R>;
}) =>
  // fallow-ignore-next-line complexity
  Effect.fnUntraced(function* (execution: typeof AutoCheckinTestExecution.Type) {
    const input = yield* decodeWorkflowContractInputOrDie(CheckinsTestAuto, execution.input);
    const hour = input.hour ?? autoCheckinTestHour;
    const anchorReceipt = yield* actions.createAnchor(execution);
    const anchor = anchorReceipt.target.message;
    if (Predicate.isUndefined(anchor)) {
      return yield* Effect.die("The validated auto-checkin anchor receipt had no message target");
    }
    const anchorExecution = { ...execution, anchor };
    const cleanupBeforeCommit = (
      cause: Cause.Cause<ActionFailure>,
    ): Effect.Effect<never, ActionFailure, R> =>
      Effect.gen(function* () {
        const cleanupExit = yield* Effect.exit(actions.cleanup(anchorExecution));
        if (Exit.isFailure(cleanupExit)) {
          yield* Effect.logError(
            "The auto-checkin test aborted before the preview commit point",
            cause,
          );
          yield* Effect.logError(
            "Failed to clean up the provisional auto-checkin test anchor",
            cleanupExit.cause,
          );
          return yield* Effect.failCause(cause);
        }
        return yield* Effect.failCause(cause);
      });

    const discoveryExit = yield* Effect.exit(actions.discover(execution));
    if (Exit.isFailure(discoveryExit)) return yield* cleanupBeforeCommit(discoveryExit.cause);
    const discovery = discoveryExit.value;
    const targetExits = yield* Effect.forEach(
      discovery.conversationNames,
      (conversationName) =>
        Effect.exit(
          Effect.gen(function* () {
            const targetExecution = { ...anchorExecution, conversationName };
            const preparationExit = yield* Effect.exit(actions.prepare(targetExecution));
            if (Exit.isFailure(preparationExit)) {
              if (isAuthorizationCause(preparationExit.cause)) {
                return yield* Effect.failCause(preparationExit.cause);
              }
              yield* Effect.logWarning(
                "Auto-checkin test target preparation failed",
                preparationExit.cause,
              ).pipe(Effect.annotateLogs({ conversationName }));
              return failedTarget(conversationName, hour);
            }
            return yield* runPreparedTarget(
              { ...targetExecution, preparation: preparationExit.value },
              actions,
            );
          }),
        ),
      { concurrency: discovery.concurrency },
    );
    const outcomes: Array<TargetOutcome> = [];
    const terminalCauses: Array<Cause.Cause<ActionFailure>> = [];
    for (const [index, exit] of targetExits.entries()) {
      if (Exit.isSuccess(exit)) {
        outcomes.push(exit.value);
        if (Predicate.isNotUndefined(exit.value.terminalCause)) {
          terminalCauses.push(exit.value.terminalCause);
        }
      } else if (isAuthorizationCause(exit.cause)) {
        terminalCauses.push(exit.cause);
      } else {
        const conversationName = discovery.conversationNames[index]!;
        yield* Effect.logWarning("Auto-checkin test target failed unexpectedly", exit.cause).pipe(
          Effect.annotateLogs({ conversationName }),
        );
        outcomes.push(failedTarget(conversationName, hour));
      }
    }
    const previewReceipts = outcomes.flatMap(({ receipts }) => receipts);
    const previewHasCommitted = outcomes.some(
      ({ deliveryState }) =>
        deliveryState === "committed" || deliveryState === "committed-and-unknown",
    );
    const previewHasUnknown = outcomes.some(
      ({ deliveryState }) =>
        deliveryState === "unknown" || deliveryState === "committed-and-unknown",
    );
    const previewDeliveryState: PreviewDeliveryState = previewHasCommitted
      ? previewHasUnknown
        ? "committed-and-unknown"
        : "committed"
      : previewHasUnknown
        ? "unknown"
        : "none";
    const previewMayHaveCommitted = previewDeliveryState !== "none";
    const terminalCause = terminalCauses[0];
    if (Predicate.isNotUndefined(terminalCause)) {
      if (!previewMayHaveCommitted) return yield* cleanupBeforeCommit(terminalCause);
      yield* Effect.logWarning(
        "Auto-checkin test requires forward recovery after authorization loss",
      ).pipe(Effect.annotateLogs({ anchorMessageId: anchor.messageId, previewDeliveryState }));
      return yield* Effect.failCause(terminalCause);
    }
    const conversations = outcomes.map(({ result }) => result);
    const summaryExit = yield* Effect.exit(
      actions.updateSummary({ ...anchorExecution, conversations, previewMayHaveCommitted }),
    );
    if (Exit.isFailure(summaryExit)) {
      if (!previewMayHaveCommitted) return yield* cleanupBeforeCommit(summaryExit.cause);
      yield* Effect.logWarning("Auto-checkin test summary update requires forward recovery").pipe(
        Effect.annotateLogs({ anchorMessageId: anchor.messageId, previewDeliveryState }),
      );
      return yield* Effect.failCause(summaryExit.cause);
    }
    const counts = makeAutoCheckinTestSummaryMessage(conversations, hour);
    const deliveryReceipts: ReadonlyArray<DeliveryReceipt> = [
      anchorReceipt,
      ...previewReceipts,
      summaryExit.value,
    ];
    return {
      workspaceId: input.workspaceId,
      hour,
      conversationCount: conversations.length,
      sentCount: counts.sentCount,
      skippedCount: counts.skippedCount,
      failedCount: counts.failedCount,
      conversations,
      deliveryReceipts,
    };
  });

export const makeCheckinsTestAutoDefinition = () => ({
  contract: CheckinsTestAuto,
  workflow: CheckinsTestAutoWorkflow,
  actions: [
    CreateAutoCheckinTestAnchorAction,
    DiscoverAutoCheckinTestTargetsAction,
    PrepareAutoCheckinTestTargetAction,
    DeliverAutoCheckinTestCheckinPreviewAction,
    DeliverAutoCheckinTestMonitorPreviewAction,
    DeliverAutoCheckinTestTentativeRoomOrderPreviewAction,
    UpdateAutoCheckinTestAnchorSummaryAction,
    CleanupAutoCheckinTestAnchorAction,
  ] as const,
  workflowLayer: CheckinsTestAutoWorkflow.toLayer(
    makeCheckinsTestAutoWorkflowBody({
      createAnchor: (execution) => CreateAutoCheckinTestAnchorAction.await(execution),
      discover: (execution) => DiscoverAutoCheckinTestTargetsAction.await(execution),
      prepare: (execution) => PrepareAutoCheckinTestTargetAction.await(execution),
      deliverCheckin: (execution) => DeliverAutoCheckinTestCheckinPreviewAction.await(execution),
      deliverMonitor: (execution) => DeliverAutoCheckinTestMonitorPreviewAction.await(execution),
      deliverTentativeRoomOrder: (execution) =>
        DeliverAutoCheckinTestTentativeRoomOrderPreviewAction.await(execution),
      updateSummary: (execution) => UpdateAutoCheckinTestAnchorSummaryAction.await(execution),
      cleanup: (execution) => CleanupAutoCheckinTestAnchorAction.await(execution),
    }),
  ),
});
