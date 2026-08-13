import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { DeliveryReceipt, EditMessageReceipt, RespondReceipt } from "sheet-bot-api";
import { InteractiveDeclaredFailure, RoomOrdersNavigate } from "sheet-workflow-contracts";
import { AuthorizedRoomOrderNavigateContext } from "../readOnly/authorization";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";
import {
  authorizeRoomOrdersNavigateWorkflow as authorize,
  interactiveAuthorizationRevoked,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { roomOrderSheetWorkflowDefinitionVersion } from "./catalog";
import { makeRoomOrderNavigationClaimId, makeRoomOrderNavigationDeliveryKey } from "./keys";
import {
  RoomOrderNavigateExecution,
  RoomOrderNavigationClaim,
  RoomOrderNavigationClaimExecution,
  RoomOrderNavigationCommitted,
  RoomOrderNavigationCommittedExecution,
  RoomOrderNavigationReleaseExecution,
  RoomOrderNavigationView,
  RoomOrderNavigationViewExecution,
} from "./schema";
import { RoomOrderNavigationOperations } from "./service";

const name = workflowContractKey(RoomOrdersNavigate);
const actionName = RoomOrdersNavigate.identity;
const sameContext = Schema.toEquivalence(AuthorizedRoomOrderNavigateContext);

const invariantContext = (context: typeof AuthorizedRoomOrderNavigateContext.Type) => ({
  ...context,
  rank: 0,
});

const reauthorize = (
  execution: typeof RoomOrderNavigateExecution.Type,
  expected: typeof AuthorizedRoomOrderNavigateContext.Type,
  expectedRank?: number,
) =>
  Effect.gen(function* () {
    const current = yield* preserveDeclaredFailure(authorize(execution));
    return sameContext(invariantContext(current), invariantContext(expected)) &&
      (Predicate.isUndefined(expectedRank) || current.rank === expectedRank)
      ? current
      : yield* Effect.fail(
          interactiveAuthorizationRevoked(RoomOrdersNavigate.authorizationPolicy.policy),
        );
  });

const executeClaimNavigationAction = (execution: typeof RoomOrderNavigateExecution.Type) =>
  Effect.gen(function* () {
    const context = yield* preserveDeclaredFailure(authorize(execution));
    const operations = yield* RoomOrderNavigationOperations;
    return yield* preserveDeclaredFailure(
      operations.claim(
        context,
        makeRoomOrderNavigationClaimId(execution.invocationId),
        RoomOrdersNavigate.authorizationPolicy.policy,
      ),
    );
  });

const executeLoadNavigationViewAction = (
  execution: typeof RoomOrderNavigationClaimExecution.Type,
) =>
  Effect.gen(function* () {
    yield* reauthorize(execution, execution.claim.context);
    const input = yield* decodeWorkflowContractInputOrDie(RoomOrdersNavigate, execution.input);
    const operations = yield* RoomOrderNavigationOperations;
    return yield* preserveDeclaredFailure(
      operations.loadView(
        execution.claim,
        input.direction,
        RoomOrdersNavigate.authorizationPolicy.policy,
      ),
    );
  });

const executeCommitNavigationAction = (execution: typeof RoomOrderNavigationViewExecution.Type) =>
  Effect.gen(function* () {
    yield* reauthorize(execution, execution.view.context);
    const operations = yield* RoomOrderNavigationOperations;
    return yield* preserveDeclaredFailure(
      operations.commit(execution.view, RoomOrdersNavigate.authorizationPolicy.policy),
    );
  });

const executeRespondAction = (execution: typeof RoomOrderNavigationCommittedExecution.Type) =>
  Effect.gen(function* () {
    yield* reauthorize(
      execution,
      execution.committed.context,
      execution.committed.status === "updated" ? execution.committed.targetRank : undefined,
    );
    const input = yield* decodeWorkflowContractInputOrDie(RoomOrdersNavigate, execution.input);
    const operations = yield* RoomOrderNavigationOperations;
    return yield* preserveDeclaredFailure(
      operations.respond(
        execution.committed,
        input.responseReference,
        makeRoomOrderNavigationDeliveryKey(execution.invocationId, "respond"),
        RoomOrdersNavigate.authorizationPolicy.policy,
      ),
    );
  });

const executeEditRoomOrderMessageAction = (
  execution: typeof RoomOrderNavigationCommittedExecution.Type,
) =>
  Effect.gen(function* () {
    yield* reauthorize(
      execution,
      execution.committed.context,
      execution.committed.status === "updated" ? execution.committed.targetRank : undefined,
    );
    const operations = yield* RoomOrderNavigationOperations;
    return yield* preserveDeclaredFailure(
      operations.editRoomOrderMessage(
        execution.committed,
        makeRoomOrderNavigationDeliveryKey(execution.invocationId, "edit-room-order-message"),
        RoomOrdersNavigate.authorizationPolicy.policy,
      ),
    );
  });

const executeReleaseNavigationClaimAction = (
  execution: typeof RoomOrderNavigationReleaseExecution.Type,
) =>
  Effect.gen(function* () {
    if (!execution.canonicalProjectionConfirmed) {
      return yield* Effect.die(
        new Error("Cannot release a navigation claim before canonical projection confirmation"),
      );
    }
    yield* reauthorize(
      execution,
      execution.committed.context,
      execution.committed.status === "updated" ? execution.committed.targetRank : undefined,
    );
    const operations = yield* RoomOrderNavigationOperations;
    return yield* preserveDeclaredFailure(operations.release(execution.committed));
  });

const ClaimNavigationAction = makeAction({
  name: `${actionName}.claim-navigation`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderNavigateExecution,
  success: RoomOrderNavigationClaim,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeClaimNavigationAction,
});

const LoadNavigationViewAction = makeAction({
  name: `${actionName}.load-navigation-view`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderNavigationClaimExecution,
  success: RoomOrderNavigationView,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeLoadNavigationViewAction,
});

const CommitNavigationAction = makeAction({
  name: `${actionName}.commit-navigation`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderNavigationViewExecution,
  success: RoomOrderNavigationCommitted,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeCommitNavigationAction,
});

const RespondAction = makeAction({
  name: `${actionName}.respond`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderNavigationCommittedExecution,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeRespondAction,
});

const EditRoomOrderMessageAction = makeAction({
  name: `${actionName}.edit-room-order-message`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderNavigationCommittedExecution,
  success: EditMessageReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeEditRoomOrderMessageAction,
});

const ReleaseNavigationClaimAction = makeAction({
  name: `${actionName}.release-navigation-claim`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderNavigationReleaseExecution,
  success: Schema.Void,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeReleaseNavigationClaimAction,
});

const RoomOrdersNavigateWorkflow = Workflow.make({
  name,
  payload: RoomOrderNavigateExecution,
  success: RoomOrdersNavigate.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

type DeclaredFailure = typeof InteractiveDeclaredFailure.Type;

const failureFrom = (exit: Exit.Exit<unknown, DeclaredFailure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const completeDeliveries = (
  committedReference: string,
  committed: boolean,
  collected: ReadonlyArray<{
    readonly operation: string;
    readonly exit: Exit.Exit<typeof DeliveryReceipt.Type, DeclaredFailure>;
  }>,
) =>
  Effect.gen(function* () {
    const failed = collected.filter(({ exit }) => Exit.isFailure(exit));
    const failures = failed.map(({ exit }) => failureFrom(exit)).filter(Predicate.isNotUndefined);
    if (failed.length > 0) {
      yield* Effect.logWarning("Room-order navigation delivery failed").pipe(
        // The disposition log intentionally mirrors the established CollectAll audit shape.
        // fallow-ignore-next-line code-duplication
        Effect.annotateLogs({
          committed,
          committedReference,
          // fallow-ignore-next-line code-duplication
          dispositions: collected.map(({ operation, exit }) => ({
            operation,
            status: Exit.isSuccess(exit) ? "delivered" : "failed",
            ...(Exit.isFailure(exit) ? { failureTag: failureFrom(exit)?._tag ?? "Defect" } : {}),
          })),
        }),
      );
      const authorization = failures.find(Predicate.isTagged("AuthorizationRevoked"));
      if (Predicate.isNotUndefined(authorization)) return yield* Effect.fail(authorization);
      const delivery = failures.find(Predicate.isTagged("DeliveryRejected"));
      if (Predicate.isNotUndefined(delivery)) return yield* Effect.fail(delivery);
      if (failures.length > 0) return yield* Effect.fail(failures[0]!);
      const first = failed[0]!.exit;
      if (Exit.isFailure(first)) return yield* Effect.failCause(first.cause);
    }
    return collected.flatMap(({ exit }) => (Exit.isSuccess(exit) ? [exit.value] : []));
  });

export const makeRoomOrdersNavigateWorkflowBody = <
  RClaim,
  RLoad,
  RCommit,
  RRespond,
  REdit,
  RRelease,
>(actions: {
  readonly claim: (
    execution: typeof RoomOrderNavigateExecution.Type,
  ) => Effect.Effect<typeof RoomOrderNavigationClaim.Type, DeclaredFailure, RClaim>;
  readonly load: (
    execution: typeof RoomOrderNavigationClaimExecution.Type,
  ) => Effect.Effect<typeof RoomOrderNavigationView.Type, DeclaredFailure, RLoad>;
  readonly commit: (
    execution: typeof RoomOrderNavigationViewExecution.Type,
  ) => Effect.Effect<typeof RoomOrderNavigationCommitted.Type, DeclaredFailure, RCommit>;
  readonly respond: (
    execution: typeof RoomOrderNavigationCommittedExecution.Type,
  ) => Effect.Effect<typeof RespondReceipt.Type, DeclaredFailure, RRespond>;
  readonly edit: (
    execution: typeof RoomOrderNavigationCommittedExecution.Type,
  ) => Effect.Effect<typeof EditMessageReceipt.Type, DeclaredFailure, REdit>;
  readonly release: (
    execution: typeof RoomOrderNavigationReleaseExecution.Type,
  ) => Effect.Effect<void, DeclaredFailure, RRelease>;
}) =>
  // fallow-ignore-next-line complexity
  Effect.fnUntraced(function* (execution: typeof RoomOrderNavigateExecution.Type) {
    yield* decodeWorkflowContractInputOrDie(RoomOrdersNavigate, execution.input);
    const claim = yield* actions.claim(execution);
    if (claim.status === "denied") {
      const committed = {
        context: claim.context,
        claimId: claim.claimId,
        targetRank: claim.context.rank,
        status: "denied" as const,
        detail: claim.detail,
        message: {
          content: claim.detail ?? "room order is temporarily unavailable.",
          visibility: "ephemeral" as const,
        },
      };
      const receipt = yield* actions.respond({ ...execution, committed });
      return {
        messageId: claim.context.messageId,
        messageConversationId: claim.context.conversationId,
        status: "denied" as const,
        detail: claim.detail,
        deliveryReceipts: [receipt],
      };
    }
    const view = yield* actions.load({ ...execution, claim });
    const committed = yield* actions.commit({ ...execution, view });
    const committedExecution = { ...execution, committed };
    const responseExit = yield* Effect.exit(actions.respond(committedExecution));
    const editExit =
      committed.context.tentative && committed.status === "updated"
        ? yield* Effect.exit(actions.edit(committedExecution))
        : undefined;
    const canonicalProjectionConfirmed =
      committed.status === "denied"
        ? true
        : committed.context.tentative
          ? Predicate.isNotUndefined(editExit) && Exit.isSuccess(editExit)
          : Exit.isSuccess(responseExit);
    if (canonicalProjectionConfirmed) {
      yield* actions.release({
        ...committedExecution,
        canonicalProjectionConfirmed,
      });
    }
    const deliveryReceipts = yield* completeDeliveries(
      committed.context.messageId,
      committed.status === "updated",
      [
        { operation: "respond", exit: responseExit },
        ...(Predicate.isUndefined(editExit)
          ? []
          : [{ operation: "edit-room-order-message", exit: editExit }]),
      ],
    );
    return {
      messageId: committed.context.messageId,
      messageConversationId: committed.context.conversationId,
      status: committed.status,
      detail: committed.detail,
      deliveryReceipts,
    };
  });

export const makeRoomOrdersNavigateDefinition = () => ({
  contract: RoomOrdersNavigate,
  workflow: RoomOrdersNavigateWorkflow,
  actions: [
    ClaimNavigationAction,
    LoadNavigationViewAction,
    CommitNavigationAction,
    RespondAction,
    EditRoomOrderMessageAction,
    ReleaseNavigationClaimAction,
  ],
  workflowLayer: RoomOrdersNavigateWorkflow.toLayer(
    makeRoomOrdersNavigateWorkflowBody({
      claim: (execution) => ClaimNavigationAction.await(execution),
      load: (execution) => LoadNavigationViewAction.await(execution),
      commit: (execution) => CommitNavigationAction.await(execution),
      respond: (execution) => RespondAction.await(execution),
      edit: (execution) => EditRoomOrderMessageAction.await(execution),
      release: (execution) => ReleaseNavigationClaimAction.await(execution),
    }),
  ),
});
