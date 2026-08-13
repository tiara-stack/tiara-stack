import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { DeliveryReceipt, RespondReceipt, messageRefFrom } from "sheet-bot-api";
import { roomOrderSendAcknowledgementMessage } from "sheet-message-content/roomOrderMessage";
import { InteractiveDeclaredFailure, RoomOrdersSend } from "sheet-workflow-contracts";
import {
  AuthorizedRoomOrderNavigateContext,
  type AuthorizedRoomOrderSendContext,
} from "../readOnly/authorization";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";
import {
  authorizeRoomOrdersSendWorkflow as authorize,
  interactiveAuthorizationRevoked,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { roomOrderSheetWorkflowDefinitionVersion } from "./catalog";
import { makeRoomOrderSendClaimId, makeRoomOrderSendDeliveryKey } from "./keys";
import {
  RoomOrderSendClaim,
  RoomOrderSendClaimExecution,
  RoomOrderSendCommit,
  RoomOrderSendCommitExecution,
  RoomOrderSendExecution,
  RoomOrderSendPinDisposition,
  RoomOrderSendRecordDisposition,
  RoomOrderSendReleaseExecution,
  RoomOrderSendResponse,
  RoomOrderSendResponseExecution,
  RoomOrderSendView,
  RoomOrderSendViewExecution,
} from "./sendSchema";
import { RoomOrderSendOperations } from "./sendService";

const name = workflowContractKey(RoomOrdersSend);
const actionName = RoomOrdersSend.identity;
const sameCanonicalContext = Schema.toEquivalence(AuthorizedRoomOrderNavigateContext);

const canonicalContext = ({
  sendClaimId: _sendClaimId,
  sentMessageId: _sentMessageId,
  sentConversationId: _sentConversationId,
  tentativeUpdateClaimId: _tentativeUpdateClaimId,
  tentativePinClaimId: _tentativePinClaimId,
  tentativePinnedAt: _tentativePinnedAt,
  ...context
}: AuthorizedRoomOrderSendContext) => context;

const reauthorize = (
  execution: typeof RoomOrderSendExecution.Type,
  expected: AuthorizedRoomOrderSendContext,
) =>
  Effect.gen(function* () {
    const current = yield* preserveDeclaredFailure(authorize(execution));
    return sameCanonicalContext(canonicalContext(current), canonicalContext(expected))
      ? current
      : yield* Effect.fail(
          interactiveAuthorizationRevoked(RoomOrdersSend.authorizationPolicy.policy),
        );
  });

const executeClaimSendAction = (execution: typeof RoomOrderSendExecution.Type) =>
  Effect.gen(function* () {
    const context = yield* preserveDeclaredFailure(authorize(execution));
    const operations = yield* RoomOrderSendOperations;
    return yield* preserveDeclaredFailure(
      operations.claim(
        context,
        makeRoomOrderSendClaimId(execution.invocationId),
        RoomOrdersSend.authorizationPolicy.policy,
      ),
    );
  });

const executeLoadSendViewAction = (execution: typeof RoomOrderSendClaimExecution.Type) =>
  Effect.gen(function* () {
    yield* reauthorize(execution, execution.claim.context);
    const operations = yield* RoomOrderSendOperations;
    return yield* preserveDeclaredFailure(
      operations.loadView(execution.claim, RoomOrdersSend.authorizationPolicy.policy),
    );
  });

const executeSendRoomOrderMessageAction = (execution: typeof RoomOrderSendViewExecution.Type) =>
  Effect.gen(function* () {
    yield* reauthorize(execution, execution.view.context);
    const operations = yield* RoomOrderSendOperations;
    return yield* preserveDeclaredFailure(
      operations.send(
        execution.view,
        makeRoomOrderSendDeliveryKey(execution.invocationId, "send-room-order-message"),
        RoomOrdersSend.authorizationPolicy.policy,
      ),
    );
  });

const executeRecordRoomOrderSendAction = (execution: typeof RoomOrderSendCommitExecution.Type) =>
  Effect.gen(function* () {
    yield* reauthorize(execution, execution.commit.context);
    const operations = yield* RoomOrderSendOperations;
    return yield* preserveDeclaredFailure(
      operations.record(execution.commit, RoomOrdersSend.authorizationPolicy.policy),
    );
  });

const executePinSentRoomOrderAction = (execution: typeof RoomOrderSendCommitExecution.Type) =>
  Effect.gen(function* () {
    const current = yield* reauthorize(execution, execution.commit.context);
    if (
      execution.commit.source === "already-sent" &&
      (current.sentMessageId !== execution.commit.sentMessage.messageId ||
        current.sentConversationId !== execution.commit.sentMessage.conversation.conversationId)
    ) {
      return yield* Effect.fail(
        interactiveAuthorizationRevoked(RoomOrdersSend.authorizationPolicy.policy),
      );
    }
    const operations = yield* RoomOrderSendOperations;
    return yield* preserveDeclaredFailure(
      operations.pin(
        execution.commit,
        makeRoomOrderSendDeliveryKey(execution.invocationId, "pin-sent-room-order"),
        RoomOrdersSend.authorizationPolicy.policy,
      ),
    );
  });

const executeRespondAction = (execution: typeof RoomOrderSendResponseExecution.Type) =>
  Effect.gen(function* () {
    yield* reauthorize(execution, execution.response.context);
    const input = yield* decodeWorkflowContractInputOrDie(RoomOrdersSend, execution.input);
    const operations = yield* RoomOrderSendOperations;
    return yield* preserveDeclaredFailure(
      operations.respond(
        execution.response,
        input.responseReference,
        makeRoomOrderSendDeliveryKey(execution.invocationId, "respond"),
        RoomOrdersSend.authorizationPolicy.policy,
      ),
    );
  });

const executeReleaseSendClaimAction = (execution: typeof RoomOrderSendReleaseExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* RoomOrderSendOperations;
    return yield* preserveDeclaredFailure(operations.release(execution.claim));
  });

const ClaimSendAction = makeAction({
  name: `${actionName}.claim-send`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderSendExecution,
  success: RoomOrderSendClaim,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeClaimSendAction,
});

const LoadSendViewAction = makeAction({
  name: `${actionName}.load-send-view`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderSendClaimExecution,
  success: RoomOrderSendView,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeLoadSendViewAction,
});

const SendRoomOrderMessageAction = makeAction({
  name: `${actionName}.send-room-order-message`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderSendViewExecution,
  success: RoomOrderSendCommit,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeSendRoomOrderMessageAction,
});

const RecordRoomOrderSendAction = makeAction({
  name: `${actionName}.record-room-order-send`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderSendCommitExecution,
  success: RoomOrderSendRecordDisposition,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeRecordRoomOrderSendAction,
});

const PinSentRoomOrderAction = makeAction({
  name: `${actionName}.pin-sent-room-order`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderSendCommitExecution,
  success: RoomOrderSendPinDisposition,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executePinSentRoomOrderAction,
});

const RespondAction = makeAction({
  name: `${actionName}.respond`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderSendResponseExecution,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeRespondAction,
});

const ReleaseSendClaimAction = makeAction({
  name: `${actionName}.release-send-claim`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderSendReleaseExecution,
  success: Schema.Void,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeReleaseSendClaimAction,
});

const RoomOrdersSendWorkflow = Workflow.make({
  name,
  payload: RoomOrderSendExecution,
  success: RoomOrdersSend.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

type DeclaredFailure = typeof InteractiveDeclaredFailure.Type;

const failureFrom = (exit: Exit.Exit<unknown, DeclaredFailure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const compensateAndFail = <A, RRelease>(
  cause: Cause.Cause<DeclaredFailure>,
  release: Effect.Effect<void, DeclaredFailure, RRelease>,
): Effect.Effect<A, DeclaredFailure, RRelease> =>
  Effect.uninterruptible(release).pipe(
    Effect.catchCause((releaseCause) => Effect.failCause(Cause.combine(cause, releaseCause))),
    Effect.andThen(Effect.failCause(cause)),
  );

// The disposition log intentionally mirrors the established CollectAll audit shape.
// fallow-ignore-next-line code-duplication
const completePostCommit = (
  commit: typeof RoomOrderSendCommit.Type,
  collected: ReadonlyArray<{
    readonly operation: string;
    readonly exit: Exit.Exit<unknown, DeclaredFailure>;
  }>,
) =>
  Effect.gen(function* () {
    const failed = collected.filter(({ exit }) => Exit.isFailure(exit));
    if (failed.length === 0) return;
    const failures = failed.map(({ exit }) => failureFrom(exit)).filter(Predicate.isNotUndefined);
    yield* Effect.logWarning("Room-order send committed with recovery required").pipe(
      Effect.annotateLogs({
        committedReference: commit.sentMessage.messageId,
        dispositions: collected.map(({ operation, exit }) => ({
          operation,
          status: Exit.isSuccess(exit) ? "confirmed" : "failed",
          ...(Exit.isFailure(exit) ? { failureTag: failureFrom(exit)?._tag ?? "Defect" } : {}),
        })),
      }),
    );
    const authorization = failures.find(Predicate.isTagged("AuthorizationRevoked"));
    if (Predicate.isNotUndefined(authorization)) return yield* Effect.fail(authorization);
    const delivery = failures.find(Predicate.isTagged("DeliveryRejected"));
    if (Predicate.isNotUndefined(delivery)) return yield* Effect.fail(delivery);
    if (failures.length > 0) return yield* Effect.fail(failures[0]!);
    const causes = failed.flatMap(({ exit }) => (Exit.isFailure(exit) ? [exit.cause] : []));
    const [first, ...remaining] = causes;
    if (Predicate.isUndefined(first)) return yield* Effect.die("Missing post-commit cause");
    let combined = first;
    for (const cause of remaining) combined = Cause.combine(combined, cause);
    return yield* Effect.failCause(combined);
  });

const responseFromDenied = (
  claim: typeof RoomOrderSendClaim.Type,
): typeof RoomOrderSendResponse.Type => ({
  context: claim.context,
  commit: null,
  sourceMessageId: claim.context.messageId,
  sourceConversationId: claim.context.conversationId,
  resultMessageId: claim.context.messageId,
  resultConversationId: claim.context.conversationId,
  status: "denied",
  detail: claim.detail ?? "room order is temporarily unavailable.",
  message: { content: claim.detail ?? "room order is temporarily unavailable." },
});

// fallow-ignore-next-line complexity
const responseFromCommit = (
  commit: typeof RoomOrderSendCommit.Type,
  recordExit: Exit.Exit<typeof RoomOrderSendRecordDisposition.Type, DeclaredFailure> | undefined,
  pinExit: Exit.Exit<typeof RoomOrderSendPinDisposition.Type, DeclaredFailure>,
): typeof RoomOrderSendResponse.Type => {
  const pin = Exit.isSuccess(pinExit) ? pinExit.value : undefined;
  let status: "pinned" | "partial" = pin?.status === "pinned" ? "pinned" : "partial";
  let detail: string;
  if (commit.source === "already-sent") {
    detail =
      status === "pinned"
        ? "room order was already sent and is now pinned."
        : "room order was already sent, but pinning still failed.";
  } else {
    const record =
      Predicate.isNotUndefined(recordExit) && Exit.isSuccess(recordExit)
        ? recordExit.value
        : undefined;
    if (record?.status === "recovery-required" || record?.status === "inconsistent") {
      status = "partial";
      detail = record.detail ?? "sent room order, but failed to track it.";
    } else if (Predicate.isUndefined(record)) {
      status = "partial";
      detail = "sent room order, but tracking could not be confirmed; the claim was preserved.";
    } else if (pin?.status === "pinned") {
      detail = roomOrderSendAcknowledgementMessage(true).content;
    } else if (pin?.status === "rejected") {
      detail = roomOrderSendAcknowledgementMessage(false).content;
    } else {
      detail = "sent room order, but pinning could not be confirmed.";
    }
  }
  return {
    context: commit.context,
    commit,
    sourceMessageId: commit.context.messageId,
    sourceConversationId: commit.context.conversationId,
    resultMessageId: commit.sentMessage.messageId,
    resultConversationId: commit.sentMessage.conversation.conversationId,
    status,
    detail,
    message: { content: detail },
  };
};

const alreadySentCommit = (claim: typeof RoomOrderSendClaim.Type) => {
  if (
    Predicate.isNull(claim.context.sentMessageId) ||
    Predicate.isNull(claim.context.sentConversationId)
  ) {
    return Effect.die("An already-sent claim is missing its canonical sent-message binding");
  }
  return Effect.succeed({
    context: claim.context,
    claimId: claim.claimId,
    source: "already-sent" as const,
    sentMessage: messageRefFrom(
      { platform: claim.context.clientPlatform, clientId: claim.context.clientId },
      claim.context.workspaceId,
      claim.context.sentConversationId,
      claim.context.sentMessageId,
    ),
    sendReceipt: null,
  });
};

export const makeRoomOrdersSendWorkflowBody = <
  RClaim,
  RLoad,
  RSend,
  RRecord,
  RPin,
  RRespond,
  RRelease,
>(actions: {
  readonly claim: (
    execution: typeof RoomOrderSendExecution.Type,
  ) => Effect.Effect<typeof RoomOrderSendClaim.Type, DeclaredFailure, RClaim>;
  readonly load: (
    execution: typeof RoomOrderSendClaimExecution.Type,
  ) => Effect.Effect<typeof RoomOrderSendView.Type, DeclaredFailure, RLoad>;
  readonly send: (
    execution: typeof RoomOrderSendViewExecution.Type,
  ) => Effect.Effect<typeof RoomOrderSendCommit.Type, DeclaredFailure, RSend>;
  readonly record: (
    execution: typeof RoomOrderSendCommitExecution.Type,
  ) => Effect.Effect<typeof RoomOrderSendRecordDisposition.Type, DeclaredFailure, RRecord>;
  readonly pin: (
    execution: typeof RoomOrderSendCommitExecution.Type,
  ) => Effect.Effect<typeof RoomOrderSendPinDisposition.Type, DeclaredFailure, RPin>;
  readonly respond: (
    execution: typeof RoomOrderSendResponseExecution.Type,
  ) => Effect.Effect<typeof RespondReceipt.Type, DeclaredFailure, RRespond>;
  readonly release: (
    execution: typeof RoomOrderSendReleaseExecution.Type,
  ) => Effect.Effect<void, DeclaredFailure, RRelease>;
}) =>
  // fallow-ignore-next-line complexity
  Effect.fnUntraced(function* (execution: typeof RoomOrderSendExecution.Type) {
    yield* decodeWorkflowContractInputOrDie(RoomOrdersSend, execution.input);
    const claim = yield* actions.claim(execution);
    if (claim.status === "denied") {
      const response = responseFromDenied(claim);
      const receipt = yield* actions.respond({ ...execution, response });
      return {
        messageId: response.resultMessageId,
        messageConversationId: response.resultConversationId,
        status: response.status,
        detail: response.detail,
        deliveryReceipts: [receipt],
      };
    }

    let commit: typeof RoomOrderSendCommit.Type;
    if (claim.status === "already-sent") {
      commit = yield* alreadySentCommit(claim);
    } else {
      const view = yield* actions
        .load({ ...execution, claim })
        .pipe(
          Effect.catchCause((cause) =>
            compensateAndFail<typeof RoomOrderSendView.Type, RRelease>(
              cause,
              actions.release({ ...execution, claim }),
            ),
          ),
        );
      const sendExit = yield* Effect.exit(actions.send({ ...execution, view }));
      if (Exit.isFailure(sendExit)) {
        const failure = failureFrom(sendExit);
        if (
          Predicate.isTagged("AuthorizationRevoked")(failure) ||
          (Predicate.isTagged("DeliveryRejected")(failure) && failure.recoveryRequired === false)
        ) {
          return yield* compensateAndFail<never, RRelease>(
            sendExit.cause,
            actions.release({ ...execution, claim }),
          );
        }
        return yield* Effect.failCause(sendExit.cause);
      }
      commit = sendExit.value;
    }

    const committedExecution = { ...execution, commit };
    const [recordExit, pinExit] = yield* Effect.all(
      [
        commit.source === "sent"
          ? Effect.exit(actions.record(committedExecution)).pipe(Effect.map(Option.some))
          : Effect.succeedNone,
        Effect.exit(actions.pin(committedExecution)),
      ] as const,
      { concurrency: "unbounded" },
    );
    const maybeRecordExit = Option.getOrUndefined(recordExit);
    const response = responseFromCommit(commit, maybeRecordExit, pinExit);
    const responseExit = yield* Effect.exit(actions.respond({ ...execution, response }));
    yield* completePostCommit(commit, [
      ...(Predicate.isUndefined(maybeRecordExit)
        ? []
        : [{ operation: "record-room-order-send", exit: maybeRecordExit }]),
      { operation: "pin-sent-room-order", exit: pinExit },
      { operation: "respond", exit: responseExit },
    ]);

    const deliveryReceipts: Array<typeof DeliveryReceipt.Type> = [];
    if (Predicate.isNotNull(commit.sendReceipt)) deliveryReceipts.push(commit.sendReceipt);
    if (Exit.isSuccess(pinExit) && Predicate.isNotNull(pinExit.value.receipt)) {
      deliveryReceipts.push(pinExit.value.receipt);
    }
    if (Exit.isSuccess(responseExit)) deliveryReceipts.push(responseExit.value);
    return {
      messageId: response.resultMessageId,
      messageConversationId: response.resultConversationId,
      status: response.status,
      detail: response.detail,
      deliveryReceipts,
    };
  });

export const makeRoomOrdersSendDefinition = () => ({
  contract: RoomOrdersSend,
  workflow: RoomOrdersSendWorkflow,
  actions: [
    ClaimSendAction,
    LoadSendViewAction,
    SendRoomOrderMessageAction,
    RecordRoomOrderSendAction,
    PinSentRoomOrderAction,
    RespondAction,
    ReleaseSendClaimAction,
  ],
  workflowLayer: RoomOrdersSendWorkflow.toLayer(
    makeRoomOrdersSendWorkflowBody({
      claim: (execution) => ClaimSendAction.await(execution),
      load: (execution) => LoadSendViewAction.await(execution),
      send: (execution) => SendRoomOrderMessageAction.await(execution),
      record: (execution) => RecordRoomOrderSendAction.await(execution),
      pin: (execution) => PinSentRoomOrderAction.await(execution),
      respond: (execution) => RespondAction.await(execution),
      release: (execution) => ReleaseSendClaimAction.await(execution),
    }),
  ),
});
