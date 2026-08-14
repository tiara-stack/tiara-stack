import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { DeliveryReceipt, EditMessageReceipt, RespondReceipt } from "sheet-bot-api";
import { tentativeRoomOrderPinAcknowledgementMessage } from "sheet-message-content/roomOrderMessage";
import { InteractiveDeclaredFailure, RoomOrdersPinTentative } from "sheet-workflow-contracts";
import {
  AuthorizedRoomOrderNavigateContext,
  type AuthorizedRoomOrderPinTentativeContext,
} from "../readOnly/authorization";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";
import {
  authorizeRoomOrdersPinTentativeWorkflow as authorize,
  interactiveAuthorizationRevoked,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { roomOrderSheetWorkflowDefinitionVersion } from "./catalog";
import { makeRoomOrderTentativePinClaimId, makeRoomOrderTentativePinDeliveryKey } from "./keys";
import {
  RoomOrderTentativePinAttempt,
  RoomOrderTentativePinClaim,
  RoomOrderTentativePinClaimExecution,
  RoomOrderTentativePinCommit,
  RoomOrderTentativePinCommitExecution,
  RoomOrderTentativePinExecution,
  RoomOrderTentativePinFinalizationExecution,
  RoomOrderTentativePinRecordDisposition,
  RoomOrderTentativePinReleaseExecution,
  RoomOrderTentativePinResponse,
  RoomOrderTentativePinResponseExecution,
  RoomOrderTentativePinView,
  RoomOrderTentativePinViewExecution,
} from "./pinTentativeSchema";
import { RoomOrderTentativePinOperations } from "./pinTentativeService";

const name = workflowContractKey(RoomOrdersPinTentative);
const actionName = RoomOrdersPinTentative.identity;
const sameCanonicalContext = Schema.toEquivalence(AuthorizedRoomOrderNavigateContext);

const canonicalContext = ({
  sendClaimId: _sendClaimId,
  sentMessageId: _sentMessageId,
  sentConversationId: _sentConversationId,
  tentativeUpdateClaimId: _tentativeUpdateClaimId,
  tentativePinClaimId: _tentativePinClaimId,
  tentativePinnedAt: _tentativePinnedAt,
  ...context
}: AuthorizedRoomOrderPinTentativeContext) => context;

const reauthorize = (
  execution: typeof RoomOrderTentativePinExecution.Type,
  expected: AuthorizedRoomOrderPinTentativeContext,
) =>
  Effect.gen(function* () {
    const current = yield* preserveDeclaredFailure(authorize(execution));
    return sameCanonicalContext(canonicalContext(current), canonicalContext(expected))
      ? current
      : yield* Effect.fail(
          interactiveAuthorizationRevoked(RoomOrdersPinTentative.authorizationPolicy.policy),
        );
  });

const executeClaimAction = (execution: typeof RoomOrderTentativePinExecution.Type) =>
  Effect.gen(function* () {
    const context = yield* preserveDeclaredFailure(authorize(execution));
    const operations = yield* RoomOrderTentativePinOperations;
    return yield* preserveDeclaredFailure(
      operations.claim(
        context,
        makeRoomOrderTentativePinClaimId(execution.invocationId),
        RoomOrdersPinTentative.authorizationPolicy.policy,
      ),
    );
  });

const executeLoadViewAction = (execution: typeof RoomOrderTentativePinClaimExecution.Type) =>
  Effect.gen(function* () {
    yield* reauthorize(execution, execution.claim.context);
    const operations = yield* RoomOrderTentativePinOperations;
    return yield* preserveDeclaredFailure(
      operations.loadView(execution.claim, RoomOrdersPinTentative.authorizationPolicy.policy),
    );
  });

const executePinAction = (execution: typeof RoomOrderTentativePinViewExecution.Type) =>
  Effect.gen(function* () {
    yield* reauthorize(execution, execution.view.context);
    const operations = yield* RoomOrderTentativePinOperations;
    return yield* preserveDeclaredFailure(
      operations.pin(
        execution.view,
        makeRoomOrderTentativePinDeliveryKey(execution.invocationId, "pin-tentative-room-order"),
        RoomOrdersPinTentative.authorizationPolicy.policy,
      ),
    );
  });

const executeRecordAction = (execution: typeof RoomOrderTentativePinCommitExecution.Type) =>
  Effect.gen(function* () {
    yield* reauthorize(execution, execution.commit.view.context);
    const operations = yield* RoomOrderTentativePinOperations;
    return yield* preserveDeclaredFailure(
      operations.record(execution.commit, RoomOrdersPinTentative.authorizationPolicy.policy),
    );
  });

const executeFinalizeAction = (execution: typeof RoomOrderTentativePinFinalizationExecution.Type) =>
  Effect.gen(function* () {
    yield* reauthorize(execution, execution.finalization.view.context);
    const operations = yield* RoomOrderTentativePinOperations;
    return yield* preserveDeclaredFailure(
      operations.finalize(
        execution.finalization,
        makeRoomOrderTentativePinDeliveryKey(
          execution.invocationId,
          "finalize-tentative-room-order",
        ),
        RoomOrdersPinTentative.authorizationPolicy.policy,
      ),
    );
  });

const executeRespondAction = (execution: typeof RoomOrderTentativePinResponseExecution.Type) =>
  Effect.gen(function* () {
    yield* reauthorize(execution, execution.response.context);
    const input = yield* decodeWorkflowContractInputOrDie(RoomOrdersPinTentative, execution.input);
    const operations = yield* RoomOrderTentativePinOperations;
    return yield* preserveDeclaredFailure(
      operations.respond(
        execution.response,
        input.responseReference,
        makeRoomOrderTentativePinDeliveryKey(execution.invocationId, "respond"),
        RoomOrdersPinTentative.authorizationPolicy.policy,
      ),
    );
  });

const executeReleaseAction = (execution: typeof RoomOrderTentativePinReleaseExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* RoomOrderTentativePinOperations;
    return yield* preserveDeclaredFailure(operations.release(execution.claim));
  });

const ClaimTentativePinAction = makeAction({
  name: `${actionName}.claim-tentative-pin`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderTentativePinExecution,
  success: RoomOrderTentativePinClaim,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeClaimAction,
});

const LoadTentativePinViewAction = makeAction({
  name: `${actionName}.load-tentative-pin-view`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderTentativePinClaimExecution,
  success: RoomOrderTentativePinView,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeLoadViewAction,
});

const PinTentativeRoomOrderAction = makeAction({
  name: `${actionName}.pin-tentative-room-order`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderTentativePinViewExecution,
  success: RoomOrderTentativePinAttempt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executePinAction,
});

const RecordTentativePinAction = makeAction({
  name: `${actionName}.record-tentative-pin`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderTentativePinCommitExecution,
  success: RoomOrderTentativePinRecordDisposition,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeRecordAction,
});

const FinalizeTentativeRoomOrderAction = makeAction({
  name: `${actionName}.finalize-tentative-room-order`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderTentativePinFinalizationExecution,
  success: EditMessageReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeFinalizeAction,
});

const RespondAction = makeAction({
  name: `${actionName}.respond`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderTentativePinResponseExecution,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeRespondAction,
});

const ReleaseTentativePinClaimAction = makeAction({
  name: `${actionName}.release-tentative-pin-claim`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderTentativePinReleaseExecution,
  success: Schema.Void,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeReleaseAction,
});

const RoomOrdersPinTentativeWorkflow = Workflow.make({
  name,
  payload: RoomOrderTentativePinExecution,
  success: RoomOrdersPinTentative.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

type DeclaredFailure = typeof InteractiveDeclaredFailure.Type;

const failureFrom = (exit: Exit.Exit<unknown, DeclaredFailure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

// CollectAll failure precedence is shared across committed interactive workflows.
// fallow-ignore-next-line code-duplication
const combineFailedExits = (
  exits: ReadonlyArray<Exit.Exit<unknown, DeclaredFailure>>,
): Effect.Effect<never, DeclaredFailure> => {
  const failures = exits.map(failureFrom).filter(Predicate.isNotUndefined);
  const authorization = failures.find(Predicate.isTagged("AuthorizationRevoked"));
  if (Predicate.isNotUndefined(authorization)) return Effect.fail(authorization);
  const delivery = failures.find(Predicate.isTagged("DeliveryRejected"));
  if (Predicate.isNotUndefined(delivery)) return Effect.fail(delivery);
  if (failures.length > 0) return Effect.fail(failures[0]!);
  const causes = exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []));
  const [first, ...remaining] = causes;
  if (Predicate.isUndefined(first)) return Effect.die("Missing workflow failure cause");
  let combined = first;
  for (const cause of remaining) combined = Cause.combine(combined, cause);
  return Effect.failCause(combined);
};

const completePostCommit = (
  commit: typeof RoomOrderTentativePinCommit.Type,
  collected: ReadonlyArray<{
    readonly operation: string;
    readonly exit: Exit.Exit<unknown, DeclaredFailure>;
  }>,
) =>
  // The disposition log intentionally mirrors the established CollectAll audit shape.
  // fallow-ignore-next-line code-duplication
  Effect.gen(function* () {
    const failed = collected.filter(({ exit }) => Exit.isFailure(exit));
    if (failed.length === 0) return;
    yield* Effect.logWarning("Tentative room-order pin committed with recovery required").pipe(
      Effect.annotateLogs({
        committedReference: commit.view.context.messageId,
        dispositions: collected.map(({ operation, exit }) => ({
          operation,
          status: Exit.isSuccess(exit) ? "confirmed" : "failed",
          ...(Exit.isFailure(exit) ? { failureTag: failureFrom(exit)?._tag ?? "Defect" } : {}),
        })),
      }),
    );
    return yield* combineFailedExits(failed.map(({ exit }) => exit));
  });

const compensateAndFail = <A, RRelease>(
  cause: Cause.Cause<DeclaredFailure>,
  release: Effect.Effect<void, DeclaredFailure, RRelease>,
): Effect.Effect<A, DeclaredFailure, RRelease> =>
  Effect.uninterruptible(release).pipe(
    Effect.catchCause((releaseCause) => Effect.failCause(Cause.combine(cause, releaseCause))),
    Effect.andThen(Effect.failCause(cause)),
  );

// Denial responses intentionally share the stable interactive acknowledgement envelope.
// fallow-ignore-next-line code-duplication
const responseFromDenied = (
  claim: typeof RoomOrderTentativePinClaim.Type,
): typeof RoomOrderTentativePinResponse.Type => ({
  context: claim.context,
  commit: null,
  messageId: claim.context.messageId,
  messageConversationId: claim.context.conversationId,
  status: "denied",
  detail: claim.detail ?? "room order is temporarily unavailable.",
  message: { content: claim.detail ?? "room order is temporarily unavailable." },
});

const commitFromAlreadyPinned = (view: typeof RoomOrderTentativePinView.Type) => {
  if (Predicate.isNull(view.context.tentativePinnedAt)) {
    return Effect.die("An already-pinned claim is missing its canonical pin timestamp");
  }
  return Effect.succeed({
    view,
    source: "already-pinned" as const,
    pinnedAt: view.context.tentativePinnedAt,
    receipt: null,
  });
};

const commitFromAttempt = (attempt: typeof RoomOrderTentativePinAttempt.Type) => {
  if (
    attempt.status !== "pinned" ||
    Predicate.isNull(attempt.pinnedAt) ||
    Predicate.isNull(attempt.receipt)
  ) {
    return Effect.die("A confirmed tentative pin is missing its commit evidence");
  }
  return Effect.succeed({
    view: attempt.view,
    source: "pinned" as const,
    pinnedAt: attempt.pinnedAt,
    receipt: attempt.receipt,
  });
};

const responseFromRejected = (
  view: typeof RoomOrderTentativePinView.Type,
  cleanupExit: Exit.Exit<typeof EditMessageReceipt.Type, DeclaredFailure>,
): typeof RoomOrderTentativePinResponse.Type => {
  const cleanedUp = Exit.isSuccess(cleanupExit);
  const detail = cleanedUp
    ? "tentative room-order pin was rejected; message controls were removed."
    : "tentative room-order pin could not be confirmed; cleanup failed and its claim was preserved.";
  return {
    context: view.context,
    commit: null,
    messageId: view.context.messageId,
    messageConversationId: view.context.conversationId,
    status: cleanedUp ? "failed" : "partial",
    detail,
    message: { content: detail },
  };
};

// The branches encode the committed tracking/cleanup result matrix directly.
// fallow-ignore-next-line complexity
const responseFromCommit = (
  commit: typeof RoomOrderTentativePinCommit.Type,
  recordExit: Exit.Exit<typeof RoomOrderTentativePinRecordDisposition.Type, DeclaredFailure>,
  cleanupExit: Exit.Exit<typeof EditMessageReceipt.Type, DeclaredFailure>,
): typeof RoomOrderTentativePinResponse.Type => {
  const record = Exit.isSuccess(recordExit) ? recordExit.value : undefined;
  const trackingConfirmed = record?.status === "tracked" || record?.status === "not-required";
  const cleanedUp = Exit.isSuccess(cleanupExit);
  let detail: string;
  if (!trackingConfirmed) {
    detail = record?.detail ?? "pinned tentative room order, but tracking could not be confirmed.";
  } else if (commit.source === "already-pinned") {
    detail = cleanedUp
      ? "tentative room order is already pinned."
      : "tentative room order is pinned, but its message still needs cleanup.";
  } else {
    detail = tentativeRoomOrderPinAcknowledgementMessage(cleanedUp).content;
  }
  return {
    context: commit.view.context,
    commit,
    messageId: commit.view.context.messageId,
    messageConversationId: commit.view.context.conversationId,
    status: trackingConfirmed && cleanedUp ? "pinned" : "partial",
    detail,
    message: { content: detail },
  };
};

export const makeRoomOrdersPinTentativeWorkflowBody = <
  RClaim,
  RLoad,
  RPin,
  RRecord,
  RFinalize,
  RRespond,
  RRelease,
>(actions: {
  readonly claim: (
    execution: typeof RoomOrderTentativePinExecution.Type,
  ) => Effect.Effect<typeof RoomOrderTentativePinClaim.Type, DeclaredFailure, RClaim>;
  readonly load: (
    execution: typeof RoomOrderTentativePinClaimExecution.Type,
  ) => Effect.Effect<typeof RoomOrderTentativePinView.Type, DeclaredFailure, RLoad>;
  readonly pin: (
    execution: typeof RoomOrderTentativePinViewExecution.Type,
  ) => Effect.Effect<typeof RoomOrderTentativePinAttempt.Type, DeclaredFailure, RPin>;
  readonly record: (
    execution: typeof RoomOrderTentativePinCommitExecution.Type,
  ) => Effect.Effect<typeof RoomOrderTentativePinRecordDisposition.Type, DeclaredFailure, RRecord>;
  readonly finalize: (
    execution: typeof RoomOrderTentativePinFinalizationExecution.Type,
  ) => Effect.Effect<typeof EditMessageReceipt.Type, DeclaredFailure, RFinalize>;
  readonly respond: (
    execution: typeof RoomOrderTentativePinResponseExecution.Type,
  ) => Effect.Effect<typeof RespondReceipt.Type, DeclaredFailure, RRespond>;
  readonly release: (
    execution: typeof RoomOrderTentativePinReleaseExecution.Type,
  ) => Effect.Effect<void, DeclaredFailure, RRelease>;
}) =>
  // The durable graph is intentionally linear until the explicit post-commit CollectAll fork.
  // fallow-ignore-next-line complexity
  Effect.fnUntraced(function* (execution: typeof RoomOrderTentativePinExecution.Type) {
    // The denial entry sequence intentionally matches the established interactive graph shape.
    // fallow-ignore-next-line code-duplication
    yield* decodeWorkflowContractInputOrDie(RoomOrdersPinTentative, execution.input);
    const claim = yield* actions.claim(execution);
    if (claim.status === "denied") {
      const response = responseFromDenied(claim);
      const receipt = yield* actions.respond({ ...execution, response });
      return {
        messageId: response.messageId,
        messageConversationId: response.messageConversationId,
        status: response.status,
        detail: response.detail,
        deliveryReceipts: [receipt],
      };
    }

    const load = actions.load({ ...execution, claim });
    const view = yield* claim.status === "claimed"
      ? load.pipe(
          Effect.catchCause((cause) =>
            compensateAndFail<typeof RoomOrderTentativePinView.Type, RRelease>(
              cause,
              actions.release({ ...execution, claim }),
            ),
          ),
        )
      : load;

    let commit: typeof RoomOrderTentativePinCommit.Type;
    if (claim.status === "already-pinned") {
      commit = yield* commitFromAlreadyPinned(view);
    } else {
      const attempt = yield* actions.pin({ ...execution, view });
      if (attempt.status === "rejected") {
        const finalization = {
          view,
          committed: false,
          committedReference: null,
        };
        const cleanupExit = yield* Effect.exit(actions.finalize({ ...execution, finalization }));
        const response = responseFromRejected(view, cleanupExit);
        const responseExit = yield* Effect.exit(actions.respond({ ...execution, response }));
        const releaseExit = Exit.isSuccess(cleanupExit)
          ? yield* Effect.exit(actions.release({ ...execution, claim }))
          : Exit.void;
        const failed: Array<Exit.Exit<unknown, DeclaredFailure>> = [];
        if (Exit.isFailure(cleanupExit)) failed.push(cleanupExit);
        if (Exit.isFailure(responseExit)) failed.push(responseExit);
        if (Exit.isFailure(releaseExit)) failed.push(releaseExit);
        if (failed.length > 0) return yield* combineFailedExits(failed);
        if (!Exit.isSuccess(cleanupExit) || !Exit.isSuccess(responseExit)) {
          return yield* Effect.die("Successful tentative pin rejection handling lost its receipts");
        }

        return {
          messageId: response.messageId,
          messageConversationId: response.messageConversationId,
          status: response.status,
          detail: response.detail,
          deliveryReceipts: [cleanupExit.value, responseExit.value],
        };
      }
      commit = yield* commitFromAttempt(attempt);
    }

    const committedExecution = { ...execution, commit };
    const finalization = {
      view: commit.view,
      committed: true,
      committedReference: commit.view.context.messageId,
    };
    const [recordExit, cleanupExit] = yield* Effect.all(
      [
        Effect.exit(actions.record(committedExecution)),
        Effect.exit(actions.finalize({ ...execution, finalization })),
      ] as const,
      { concurrency: "unbounded" },
    );
    const response = responseFromCommit(commit, recordExit, cleanupExit);
    const responseExit = yield* Effect.exit(actions.respond({ ...execution, response }));
    yield* completePostCommit(commit, [
      { operation: "record-tentative-pin", exit: recordExit },
      { operation: "finalize-tentative-room-order", exit: cleanupExit },
      { operation: "respond", exit: responseExit },
    ]);

    const deliveryReceipts: Array<typeof DeliveryReceipt.Type> = [];
    if (Predicate.isNotNull(commit.receipt)) deliveryReceipts.push(commit.receipt);
    if (Exit.isSuccess(cleanupExit)) deliveryReceipts.push(cleanupExit.value);
    if (Exit.isSuccess(responseExit)) deliveryReceipts.push(responseExit.value);
    return {
      messageId: response.messageId,
      messageConversationId: response.messageConversationId,
      status: response.status,
      detail: response.detail,
      deliveryReceipts,
    };
  });

export const makeRoomOrdersPinTentativeDefinition = () => ({
  contract: RoomOrdersPinTentative,
  workflow: RoomOrdersPinTentativeWorkflow,
  actions: [
    ClaimTentativePinAction,
    LoadTentativePinViewAction,
    PinTentativeRoomOrderAction,
    RecordTentativePinAction,
    FinalizeTentativeRoomOrderAction,
    RespondAction,
    ReleaseTentativePinClaimAction,
  ],
  workflowLayer: RoomOrdersPinTentativeWorkflow.toLayer(
    makeRoomOrdersPinTentativeWorkflowBody({
      claim: (execution) => ClaimTentativePinAction.await(execution),
      load: (execution) => LoadTentativePinViewAction.await(execution),
      pin: (execution) => PinTentativeRoomOrderAction.await(execution),
      record: (execution) => RecordTentativePinAction.await(execution),
      finalize: (execution) => FinalizeTentativeRoomOrderAction.await(execution),
      respond: (execution) => RespondAction.await(execution),
      release: (execution) => ReleaseTentativePinClaimAction.await(execution),
    }),
  ),
});
