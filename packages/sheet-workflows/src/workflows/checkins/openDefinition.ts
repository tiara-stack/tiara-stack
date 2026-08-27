import { Cause, Effect, Exit, Match, Option, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  DeliveryReceipt,
  EditMessageReceipt,
  SendDirectMessageReceipt,
  SendMessageReceipt,
} from "sheet-bot-api";
import { shouldSendTentativeRoomOrder } from "sheet-bot-api/actions";
import { monitorPingMessage, reminderMessage } from "sheet-message-content/checkinMessages";
import { CheckinsOpen, InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { config } from "@/config";
import { CheckinsOpenEntity, makeCheckinsOpenEntityLayer } from "@/entities/checkinsOpen";
import {
  interactiveConfigurationMissing,
  preserveInteractiveDeclaredFailure,
} from "../shared/interactive";
import { checkinSheetWorkflowDefinitionVersion } from "./catalog";
import {
  checkinsOpenActionIdentities,
  makeCheckinsOpenActionKey,
  makeCheckinsOpenDeliveryKey,
  makeCheckinsOpenSerializationKey,
} from "./keys";
import {
  CheckinsOpenCommit,
  CheckinsOpenCommittedExecution,
  CheckinsOpenContext,
  CheckinsOpenExecution,
  CheckinsOpenPrimaryDelivery,
  CheckinsOpenResolvedExecution,
} from "./openSchema";
import { CheckinsOpenWorkflowOperations } from "./openService";

const name = workflowContractKey(CheckinsOpen);
const actionName = CheckinsOpen.identity;

const executeResolveContext = (execution: typeof CheckinsOpenExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* CheckinsOpenWorkflowOperations;
    return yield* preserveInteractiveDeclaredFailure(operations.resolve(execution));
  });

const executeDeliverCheckin = (execution: typeof CheckinsOpenResolvedExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* CheckinsOpenWorkflowOperations;
    return yield* preserveInteractiveDeclaredFailure(
      operations.deliverCheckin(
        execution,
        makeCheckinsOpenDeliveryKey(
          execution.invocationId,
          checkinsOpenActionIdentities.deliverCheckin,
        ),
        makeCheckinsOpenDeliveryKey(
          execution.invocationId,
          checkinsOpenActionIdentities.cleanupCheckin,
        ),
      ),
    );
  });

const executeFinalizeCheckin = (execution: typeof CheckinsOpenCommittedExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* CheckinsOpenWorkflowOperations;
    return yield* preserveInteractiveDeclaredFailure(
      operations.finalizeCheckin(
        execution,
        execution.committed,
        makeCheckinsOpenDeliveryKey(
          execution.invocationId,
          checkinsOpenActionIdentities.finalizeCheckin,
        ),
      ),
    );
  });

const executeDeliverPrimary = (execution: typeof CheckinsOpenResolvedExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* CheckinsOpenWorkflowOperations;
    return yield* preserveInteractiveDeclaredFailure(
      operations.deliverPrimary(
        execution,
        makeCheckinsOpenDeliveryKey(
          execution.invocationId,
          checkinsOpenActionIdentities.deliverPrimary,
        ),
        makeCheckinsOpenDeliveryKey(
          execution.invocationId,
          checkinsOpenActionIdentities.finalizePrimary,
        ),
        makeCheckinsOpenDeliveryKey(
          execution.invocationId,
          checkinsOpenActionIdentities.cleanupCheckin,
          "monitor",
        ),
      ),
    );
  });

const CheckinsOpenParticipantExecution = Schema.Struct({
  ...CheckinsOpenResolvedExecution.fields,
  userId: Schema.String,
});

const executeDeliverParticipantDm = (execution: typeof CheckinsOpenParticipantExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* CheckinsOpenWorkflowOperations;
    return yield* preserveInteractiveDeclaredFailure(
      operations.deliverParticipantDm(
        execution,
        execution.userId,
        reminderMessage({
          client: {
            platform: execution.context.clientPlatform,
            clientId: execution.context.clientId,
          },
          workspaceId: execution.context.workspaceId,
          runningConversationId: execution.context.generated.runningConversationId,
          checkinConversationId: execution.context.generated.checkinConversationId,
          hour: execution.context.generated.hour,
        }),
        makeCheckinsOpenDeliveryKey(
          execution.invocationId,
          checkinsOpenActionIdentities.deliverParticipantDm,
          execution.userId,
        ),
      ),
    );
  });

const executeDeliverMonitorDm = (execution: typeof CheckinsOpenResolvedExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* CheckinsOpenWorkflowOperations;
    return yield* preserveInteractiveDeclaredFailure(
      operations.deliverMonitorDm(
        execution,
        monitorPingMessage({
          client: {
            platform: execution.context.clientPlatform,
            clientId: execution.context.clientId,
          },
          workspaceId: execution.context.workspaceId,
          runningConversationId: execution.context.generated.runningConversationId,
          checkinConversationId: execution.context.generated.checkinConversationId,
          ...(execution.context.generated.monitorConversationId === null
            ? {}
            : { monitorConversationId: execution.context.generated.monitorConversationId }),
          hour: execution.context.generated.hour,
        }),
        makeCheckinsOpenDeliveryKey(
          execution.invocationId,
          checkinsOpenActionIdentities.deliverMonitorDm,
        ),
      ),
    );
  });

const executeDeliverTentativeRoomOrder = (execution: typeof CheckinsOpenResolvedExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* CheckinsOpenWorkflowOperations;
    return yield* preserveInteractiveDeclaredFailure(
      operations.deliverTentativeRoomOrder(
        execution,
        makeCheckinsOpenDeliveryKey(
          execution.invocationId,
          checkinsOpenActionIdentities.deliverTentativeRoomOrder,
        ),
        makeCheckinsOpenDeliveryKey(
          execution.invocationId,
          checkinsOpenActionIdentities.deliverTentativeRoomOrder,
          "finalize",
        ),
        makeCheckinsOpenDeliveryKey(
          execution.invocationId,
          checkinsOpenActionIdentities.cleanupTentativeRoomOrder,
        ),
      ),
    );
  });

const ResolveCheckinsOpenContextAction = makeAction({
  name: `${actionName}.${checkinsOpenActionIdentities.resolveContext}`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: CheckinsOpenExecution,
  success: CheckinsOpenContext,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeCheckinsOpenActionKey(invocationId, checkinsOpenActionIdentities.resolveContext),
  execute: executeResolveContext,
});

const DeliverCheckinsOpenCheckinAction = makeAction({
  name: `${actionName}.${checkinsOpenActionIdentities.deliverCheckin}`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: CheckinsOpenResolvedExecution,
  success: CheckinsOpenCommit,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeCheckinsOpenActionKey(invocationId, checkinsOpenActionIdentities.deliverCheckin),
  execute: executeDeliverCheckin,
});

const FinalizeCheckinsOpenCheckinAction = makeAction({
  name: `${actionName}.${checkinsOpenActionIdentities.finalizeCheckin}`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: CheckinsOpenCommittedExecution,
  success: EditMessageReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeCheckinsOpenActionKey(invocationId, checkinsOpenActionIdentities.finalizeCheckin),
  execute: executeFinalizeCheckin,
});

const DeliverCheckinsOpenPrimaryAction = makeAction({
  name: `${actionName}.${checkinsOpenActionIdentities.deliverPrimary}`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: CheckinsOpenResolvedExecution,
  success: CheckinsOpenPrimaryDelivery,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeCheckinsOpenActionKey(invocationId, checkinsOpenActionIdentities.deliverPrimary),
  execute: executeDeliverPrimary,
});

const DeliverCheckinsOpenParticipantDmAction = makeAction({
  name: `${actionName}.${checkinsOpenActionIdentities.deliverParticipantDm}`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: CheckinsOpenParticipantExecution,
  success: SendDirectMessageReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId, userId }) =>
    makeCheckinsOpenActionKey(
      invocationId,
      checkinsOpenActionIdentities.deliverParticipantDm,
      userId,
    ),
  execute: executeDeliverParticipantDm,
});

const DeliverCheckinsOpenMonitorDmAction = makeAction({
  name: `${actionName}.${checkinsOpenActionIdentities.deliverMonitorDm}`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: CheckinsOpenResolvedExecution,
  success: SendDirectMessageReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeCheckinsOpenActionKey(invocationId, checkinsOpenActionIdentities.deliverMonitorDm),
  execute: executeDeliverMonitorDm,
});

const DeliverCheckinsOpenTentativeRoomOrderAction = makeAction({
  name: `${actionName}.${checkinsOpenActionIdentities.deliverTentativeRoomOrder}`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: CheckinsOpenResolvedExecution,
  success: Schema.Union([SendMessageReceipt, EditMessageReceipt]),
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeCheckinsOpenActionKey(invocationId, checkinsOpenActionIdentities.deliverTentativeRoomOrder),
  execute: executeDeliverTentativeRoomOrder,
});

export const CheckinsOpenWorkflow = Workflow.make({
  name,
  payload: CheckinsOpenExecution,
  success: CheckinsOpen.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

type DeclaredFailure = typeof InteractiveDeclaredFailure.Type;

const failureFrom = (exit: Exit.Exit<unknown, DeclaredFailure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

// The workflow envelope and reference extraction intentionally mirror the established definition shape.
// fallow-ignore-next-line code-duplication
const primaryMessageId = (receipt: (typeof CheckinsOpenPrimaryDelivery.Type)["receipt"]): string =>
  Match.type<typeof receipt.target>().pipe(
    Match.discriminatorsExhaustive("_tag")({
      Response: ({ message }) => message?.messageId ?? "",
      Message: ({ message }) => message.messageId,
    }),
  )(receipt.target);

type CheckinsOpenWorkflowActions<R> = {
  readonly deliverCheckin: (
    execution: typeof CheckinsOpenResolvedExecution.Type,
  ) => Effect.Effect<typeof CheckinsOpenCommit.Type, DeclaredFailure, R>;
  readonly finalizeCheckin: (
    execution: typeof CheckinsOpenCommittedExecution.Type,
  ) => Effect.Effect<typeof EditMessageReceipt.Type, DeclaredFailure, R>;
  readonly deliverPrimary: (
    execution: typeof CheckinsOpenResolvedExecution.Type,
  ) => Effect.Effect<typeof CheckinsOpenPrimaryDelivery.Type, DeclaredFailure, R>;
  readonly deliverParticipantDm: (
    execution: typeof CheckinsOpenParticipantExecution.Type,
  ) => Effect.Effect<typeof SendDirectMessageReceipt.Type, DeclaredFailure, R>;
  readonly deliverMonitorDm: (
    execution: typeof CheckinsOpenResolvedExecution.Type,
  ) => Effect.Effect<typeof SendDirectMessageReceipt.Type, DeclaredFailure, R>;
  readonly deliverTentativeRoomOrder: (
    execution: typeof CheckinsOpenResolvedExecution.Type,
  ) => Effect.Effect<
    typeof SendMessageReceipt.Type | typeof EditMessageReceipt.Type,
    DeclaredFailure,
    R
  >;
};

const bestEffort = <A, R>(
  operation: string,
  effect: Effect.Effect<A, DeclaredFailure, R>,
): Effect.Effect<Option.Option<A>, never, R> =>
  Effect.exit(effect).pipe(
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit)
        ? Effect.succeed(Option.some(exit.value))
        : Cause.hasInterruptsOnly(exit.cause)
          ? Effect.interrupt
          : Effect.logWarning("CheckinsOpen post-commit delivery failed").pipe(
              Effect.annotateLogs({ operation, failureTag: failureFrom(exit)?._tag ?? "Defect" }),
              Effect.as(Option.none<A>()),
            ),
    ),
  );

export const makeCheckinsOpenWorkflowBody =
  <R>(actions: CheckinsOpenWorkflowActions<R>) =>
  (execution: typeof CheckinsOpenResolvedExecution.Type) =>
    // The body keeps the commit point and post-commit recovery policy visible as one orchestration unit.
    // fallow-ignore-next-line complexity
    Effect.gen(function* () {
      const concurrency = yield* config.autoCheckinConcurrency.pipe(
        Effect.mapError(() => interactiveConfigurationMissing("AUTO_CHECKIN_CONCURRENCY")),
      );
      const context = execution.context;
      const deliveryReceipts: Array<typeof DeliveryReceipt.Type> = [];
      let checkinMessageId: string | null = null;

      if (context.initialMessage !== null) {
        const committed: CheckinsOpenCommit = yield* actions.deliverCheckin(execution);
        checkinMessageId = committed.message.messageId;
        deliveryReceipts.push(committed.receipt);
        deliveryReceipts.push(yield* actions.finalizeCheckin({ ...execution, committed }));
      }

      const primary = yield* actions.deliverPrimary(execution);
      const primaryId = primaryMessageId(primary.receipt);
      if (primaryId.length === 0) {
        return yield* Effect.fail({
          _tag: "DeliveryRejected" as const,
          operation: `${CheckinsOpen.identity}.deliver-primary`,
          message: "The primary check-in delivery did not return a message reference",
          recoveryRequired: true,
          ...(checkinMessageId === null ? {} : { committedReference: checkinMessageId }),
        });
      }
      deliveryReceipts.push(primary.receipt, ...primary.additionalReceipts);

      const participantDms =
        context.principalKind === "service" && context.initialMessage !== null
          ? yield* Effect.forEach(
              [...new Set(context.generated.fillIds)],
              (userId) =>
                bestEffort(
                  `${CheckinsOpen.identity}.deliver-participant-dm`,
                  actions.deliverParticipantDm({ ...execution, userId }),
                ),
              { concurrency },
            )
          : [];
      const shouldSendMonitorDm =
        context.principalKind === "service" &&
        context.generated.monitorUserId !== null &&
        ((context.generated.monitorConversationId !== null &&
          context.generated.monitorCheckinRequired) ||
          (context.generated.monitorConversationId === null && context.initialMessage !== null));
      const monitorDm = shouldSendMonitorDm
        ? yield* bestEffort(
            `${CheckinsOpen.identity}.deliver-monitor-dm`,
            actions.deliverMonitorDm(execution),
          )
        : Option.none<typeof SendDirectMessageReceipt.Type>();
      const tentativeRoomOrder =
        context.initialMessage !== null && shouldSendTentativeRoomOrder(context.generated.fillCount)
          ? yield* bestEffort(
              `${CheckinsOpen.identity}.deliver-tentative-room-order`,
              actions.deliverTentativeRoomOrder(execution),
            )
          : Option.none<typeof SendMessageReceipt.Type | typeof EditMessageReceipt.Type>();

      for (const receipt of participantDms) {
        if (Option.isSome(receipt)) deliveryReceipts.push(receipt.value);
      }
      if (Option.isSome(monitorDm)) deliveryReceipts.push(monitorDm.value);
      const tentativeRoomOrderMessageId = Option.match(tentativeRoomOrder, {
        onNone: () => null,
        onSome: ({ target }) => target.message.messageId,
      });
      if (Option.isSome(tentativeRoomOrder)) deliveryReceipts.push(tentativeRoomOrder.value);

      return {
        hour: context.generated.hour,
        runningConversationId: context.generated.runningConversationId,
        checkinConversationId: context.generated.checkinConversationId,
        checkinMessageId,
        primaryMessageId: primaryId,
        tentativeRoomOrderMessageId,
        deliveryReceipts,
      };
    });

const runSerializedBody = makeCheckinsOpenWorkflowBody({
  deliverCheckin: (execution) => DeliverCheckinsOpenCheckinAction.await(execution),
  finalizeCheckin: (execution) => FinalizeCheckinsOpenCheckinAction.await(execution),
  deliverPrimary: (execution) => DeliverCheckinsOpenPrimaryAction.await(execution),
  deliverParticipantDm: (execution) => DeliverCheckinsOpenParticipantDmAction.await(execution),
  deliverMonitorDm: (execution) => DeliverCheckinsOpenMonitorDmAction.await(execution),
  deliverTentativeRoomOrder: (execution) =>
    DeliverCheckinsOpenTentativeRoomOrderAction.await(execution),
});

const runThroughEntity = (execution: typeof CheckinsOpenResolvedExecution.Type) =>
  Effect.gen(function* () {
    const entityClient = yield* CheckinsOpenEntity.client;
    return yield* entityClient(
      makeCheckinsOpenSerializationKey(
        execution.context.clientId,
        execution.context.workspaceId,
        execution.context.generated.runningConversationId,
        execution.context.generated.hour,
      ),
    ).run(execution);
  }).pipe(preserveInteractiveDeclaredFailure);

export const makeCheckinsOpenDefinition = () => ({
  contract: CheckinsOpen,
  workflow: CheckinsOpenWorkflow,
  actions: [
    ResolveCheckinsOpenContextAction,
    DeliverCheckinsOpenCheckinAction,
    FinalizeCheckinsOpenCheckinAction,
    DeliverCheckinsOpenPrimaryAction,
    DeliverCheckinsOpenParticipantDmAction,
    DeliverCheckinsOpenMonitorDmAction,
    DeliverCheckinsOpenTentativeRoomOrderAction,
  ] as const,
  workflowLayer: CheckinsOpenWorkflow.toLayer(
    Effect.fnUntraced(function* (execution: typeof CheckinsOpenExecution.Type) {
      const context = yield* ResolveCheckinsOpenContextAction.await(execution);
      return yield* runThroughEntity({ ...execution, context });
    }),
  ),
  entityLayer: makeCheckinsOpenEntityLayer({ run: ({ payload }) => runSerializedBody(payload) }),
});
