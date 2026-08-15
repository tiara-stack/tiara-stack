import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { BotOutboundMessage, ConversationRef } from "sheet-bot-api";
import { makeEmbed } from "sheet-message-content/rendering";
import { AnnouncementsDeliverUpdate, AutonomousDeclaredFailure } from "sheet-workflow-contracts";
import type { AnnouncementsDeliverUpdateInput } from "sheet-workflow-contracts/values";
import { config } from "@/config";
import { UpdateAnnouncementDeliveryEntity } from "@/entities/updateAnnouncementDelivery";
import {
  authorizeInteractiveWorkflow as authorize,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { announcementSheetWorkflowDefinitionVersion } from "./catalog";
import {
  makeUpdateAnnouncementActionKey,
  makeUpdateAnnouncementClaimId,
  makeUpdateAnnouncementDeliveryKey,
  makeUpdateAnnouncementSerializationKey,
} from "./keys";
import {
  UpdateAnnouncementClaim,
  UpdateAnnouncementClaimExecution,
  UpdateAnnouncementCommit,
  UpdateAnnouncementCommitExecution,
  UpdateAnnouncementDeliveryExecution,
  UpdateAnnouncementExecution,
  UpdateAnnouncementRecordDisposition,
} from "./schema";
import { UpdateAnnouncementWorkflowOperations } from "./service";

const name = workflowContractKey(AnnouncementsDeliverUpdate);
const actionName = AnnouncementsDeliverUpdate.identity;
const policy = AnnouncementsDeliverUpdate.authorizationPolicy.policy;

// Action replay decoding intentionally matches the operations-layer boundary decoder.
// fallow-ignore-next-line code-duplication
const decodeInput = (input: unknown) =>
  Schema.is(AnnouncementsDeliverUpdate.input)(input)
    ? Effect.succeed(input)
    : Schema.decodeUnknownEffect(AnnouncementsDeliverUpdate.input)(input).pipe(Effect.orDie);

export const makeUpdateAnnouncementMessage = (
  input: AnnouncementsDeliverUpdateInput,
): typeof BotOutboundMessage.Type => ({
  embeds: [
    makeEmbed({
      title: input.announcement.title,
      description: input.announcement.description,
      ...(Predicate.isNumber(input.announcement.color) ? { color: input.announcement.color } : {}),
    }),
  ],
  allowedMentions: "none",
});

const executeClaimAction = (execution: typeof UpdateAnnouncementExecution.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(AnnouncementsDeliverUpdate, execution));
    const operations = yield* UpdateAnnouncementWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.claim(execution, makeUpdateAnnouncementClaimId(execution.invocationId), policy),
    );
  });

const executeSelectAction = (execution: typeof UpdateAnnouncementClaimExecution.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(AnnouncementsDeliverUpdate, execution));
    const operations = yield* UpdateAnnouncementWorkflowOperations;
    return yield* preserveDeclaredFailure(operations.select(execution, execution.claim, policy));
  });

const executeDeliverAction = (execution: typeof UpdateAnnouncementDeliveryExecution.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(AnnouncementsDeliverUpdate, execution));
    const operations = yield* UpdateAnnouncementWorkflowOperations;
    const input = yield* decodeInput(execution.input);
    return yield* preserveDeclaredFailure(
      operations.deliver(
        execution,
        execution.claim,
        execution.conversation,
        makeUpdateAnnouncementMessage(input),
        makeUpdateAnnouncementDeliveryKey(execution.invocationId),
        policy,
      ),
    );
  });

const executeRecordAction = (execution: typeof UpdateAnnouncementCommitExecution.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(AnnouncementsDeliverUpdate, execution));
    const operations = yield* UpdateAnnouncementWorkflowOperations;
    return yield* preserveDeclaredFailure(operations.record(execution, execution.commit, policy));
  });

const executeReleaseAction = (execution: typeof UpdateAnnouncementClaimExecution.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(AnnouncementsDeliverUpdate, execution));
    const operations = yield* UpdateAnnouncementWorkflowOperations;
    return yield* preserveDeclaredFailure(operations.release(execution, execution.claim, policy));
  });

export const ClaimUpdateAnnouncementDeliveryAction = makeAction({
  name: `${actionName}.claim-update-announcement-delivery`,
  version: announcementSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: UpdateAnnouncementExecution,
  success: UpdateAnnouncementClaim,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeUpdateAnnouncementActionKey(invocationId, "claim-update-announcement-delivery"),
  execute: executeClaimAction,
});

const SelectAction = makeAction({
  name: `${actionName}.select-update-announcement-conversation`,
  version: announcementSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: UpdateAnnouncementClaimExecution,
  success: ConversationRef,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeUpdateAnnouncementActionKey(invocationId, "select-update-announcement-conversation"),
  execute: executeSelectAction,
});

const DeliverAction = makeAction({
  name: `${actionName}.deliver-update-announcement`,
  version: announcementSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: UpdateAnnouncementDeliveryExecution,
  success: UpdateAnnouncementCommit,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeUpdateAnnouncementActionKey(invocationId, "deliver-update-announcement"),
  execute: executeDeliverAction,
});

const RecordAction = makeAction({
  name: `${actionName}.record-update-announcement-delivery`,
  version: announcementSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: UpdateAnnouncementCommitExecution,
  success: UpdateAnnouncementRecordDisposition,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeUpdateAnnouncementActionKey(invocationId, "record-update-announcement-delivery"),
  execute: executeRecordAction,
});

const ReleaseAction = makeAction({
  name: `${actionName}.release-update-announcement-claim`,
  version: announcementSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: UpdateAnnouncementClaimExecution,
  success: Schema.Void,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeUpdateAnnouncementActionKey(invocationId, "release-update-announcement-claim"),
  execute: executeReleaseAction,
});

const AnnouncementsDeliverUpdateWorkflow = Workflow.make({
  name,
  payload: UpdateAnnouncementExecution,
  success: AnnouncementsDeliverUpdate.success,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const claimThroughEntity = (execution: typeof UpdateAnnouncementExecution.Type) =>
  Effect.gen(function* () {
    const input = yield* decodeInput(execution.input);
    const clientId = yield* config.sheetBotClientId;
    const clientFor = yield* UpdateAnnouncementDeliveryEntity.client;
    return yield* clientFor(
      makeUpdateAnnouncementSerializationKey(clientId, input.workspaceId, input.announcement.id),
    ).claim(execution);
  }).pipe(preserveDeclaredFailure);

// Compensation preserves the same primary/cleanup cause structure as other claimed workflows.
// fallow-ignore-next-line code-duplication
type DeclaredFailure = typeof AutonomousDeclaredFailure.Type;

const failureFrom = (exit: Exit.Exit<unknown, DeclaredFailure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const compensateAndFail = <A, R>(
  cause: Cause.Cause<DeclaredFailure>,
  release: Effect.Effect<void, DeclaredFailure, R>,
): Effect.Effect<A, DeclaredFailure, R> =>
  Effect.uninterruptible(release).pipe(
    Effect.catchCause((releaseCause) => Effect.failCause(Cause.combine(cause, releaseCause))),
    Effect.andThen(Effect.failCause(cause)),
  );

const skippedResult = (
  input: AnnouncementsDeliverUpdateInput,
  status: "skipped_not_gated" | "skipped_already_claimed" | "skipped_already_delivered",
  delivery: (typeof UpdateAnnouncementClaim.Type)["delivery"],
) => ({
  workspaceId: input.workspaceId,
  announcementId: input.announcement.id,
  status,
  announcementConversationId: delivery?.conversation.conversationId ?? null,
  announcementMessageId: delivery?.messageId ?? null,
  deliveryReceipts: [],
});

export const makeAnnouncementsDeliverUpdateWorkflowBody = <
  RClaim,
  RSelect,
  RDeliver,
  RRecord,
  RRelease,
>(actions: {
  readonly claim: (
    execution: typeof UpdateAnnouncementExecution.Type,
  ) => Effect.Effect<typeof UpdateAnnouncementClaim.Type, DeclaredFailure, RClaim>;
  readonly select: (
    execution: typeof UpdateAnnouncementClaimExecution.Type,
  ) => Effect.Effect<typeof ConversationRef.Type, DeclaredFailure, RSelect>;
  readonly deliver: (
    execution: typeof UpdateAnnouncementDeliveryExecution.Type,
  ) => Effect.Effect<typeof UpdateAnnouncementCommit.Type, DeclaredFailure, RDeliver>;
  readonly record: (
    execution: typeof UpdateAnnouncementCommitExecution.Type,
  ) => Effect.Effect<typeof UpdateAnnouncementRecordDisposition.Type, DeclaredFailure, RRecord>;
  readonly release: (
    execution: typeof UpdateAnnouncementClaimExecution.Type,
  ) => Effect.Effect<void, DeclaredFailure, RRelease>;
}) =>
  Effect.fnUntraced(function* (execution: typeof UpdateAnnouncementExecution.Type) {
    const input = yield* decodeInput(execution.input);
    const claim = yield* actions.claim(execution);
    if (claim.status !== "owned") return skippedResult(input, claim.status, claim.delivery);

    const selectExit = yield* Effect.exit(actions.select({ ...execution, claim }));
    if (Exit.isFailure(selectExit)) {
      const failure = failureFrom(selectExit);
      return Predicate.isTagged("ResourceNotFound")(failure)
        ? yield* compensateAndFail<never, RRelease>(
            selectExit.cause,
            actions.release({ ...execution, claim }),
          )
        : yield* Effect.failCause(selectExit.cause);
    }

    const deliverExit = yield* Effect.exit(
      actions.deliver({ ...execution, claim, conversation: selectExit.value }),
    );
    if (Exit.isFailure(deliverExit)) {
      const failure = failureFrom(deliverExit);
      return Predicate.isTagged("DeliveryRejected")(failure) && failure.recoveryRequired === false
        ? yield* compensateAndFail<never, RRelease>(
            deliverExit.cause,
            actions.release({ ...execution, claim }),
          )
        : yield* Effect.failCause(deliverExit.cause);
    }

    const commit = deliverExit.value;
    yield* actions.record({ ...execution, commit });
    return {
      workspaceId: input.workspaceId,
      announcementId: input.announcement.id,
      status: "sent" as const,
      announcementConversationId: commit.conversation.conversationId,
      announcementMessageId: commit.receipt.target.message.messageId,
      deliveryReceipts: [commit.receipt],
    };
  });

export const makeAnnouncementsDeliverUpdateDefinition = () => ({
  contract: AnnouncementsDeliverUpdate,
  workflow: AnnouncementsDeliverUpdateWorkflow,
  actions: [
    ClaimUpdateAnnouncementDeliveryAction,
    SelectAction,
    DeliverAction,
    RecordAction,
    ReleaseAction,
  ] as const,
  workflowLayer: AnnouncementsDeliverUpdateWorkflow.toLayer(
    makeAnnouncementsDeliverUpdateWorkflowBody({
      claim: claimThroughEntity,
      select: (execution) => SelectAction.await(execution),
      deliver: (execution) => DeliverAction.await(execution),
      record: (execution) => RecordAction.await(execution),
      release: (execution) => ReleaseAction.await(execution),
    }),
  ),
});
