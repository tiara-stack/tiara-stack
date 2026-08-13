import { Cause, Effect, Exit, Option, Predicate, Schedule, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  DeliveryReceipt,
  EditMessageReceipt,
  RespondReceipt,
  SendMessageReceipt,
  SetMemberRoleReceipt,
} from "sheet-bot-api";
import { checkinActionRow } from "sheet-message-content/components";
import { renderCheckedInContent } from "sheet-message-content/rendering";
import { CheckinsRespond, InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { CheckinProjectionEntity } from "@/entities/checkinProjection";
import { AuthorizedCheckinRespondContext } from "../readOnly/authorization";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";
import {
  authorizeCheckinRespondWorkflow as authorize,
  interactiveAuthorizationRevoked,
  interactiveDeliveryRejected,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { checkinSheetWorkflowDefinitionVersion } from "./catalog";
import { checkinProjectionKey, makeCheckinClaimId, makeCheckinDeliveryKey } from "./keys";
import {
  CheckinCommit,
  CheckinCommittedExecution,
  CheckinRespondExecution,
  CheckinView,
  CheckinViewExecution,
} from "./schema";
import { CheckinWorkflowOperations } from "./service";

const name = workflowContractKey(CheckinsRespond);
const actionName = CheckinsRespond.identity;
const sameContext = Schema.toEquivalence(AuthorizedCheckinRespondContext);
const isProjectionSendFailure = Predicate.or(
  Predicate.isTagged("MailboxFull"),
  Predicate.or(
    Predicate.isTagged("AlreadyProcessingMessage"),
    Predicate.isTagged("PersistenceError"),
  ),
);

const reauthorize = (
  execution: typeof CheckinRespondExecution.Type,
  expected: typeof AuthorizedCheckinRespondContext.Type,
) =>
  Effect.gen(function* () {
    const current = yield* preserveDeclaredFailure(authorize(execution));
    return sameContext(current, expected)
      ? current
      : yield* Effect.fail(
          interactiveAuthorizationRevoked(CheckinsRespond.authorizationPolicy.policy),
        );
  });

const executeCommitCheckinAction = (execution: typeof CheckinRespondExecution.Type) =>
  Effect.gen(function* () {
    const context = yield* preserveDeclaredFailure(authorize(execution));
    const operations = yield* CheckinWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.commitCheckin(
        context,
        makeCheckinClaimId(execution.invocationId),
        CheckinsRespond.authorizationPolicy.policy,
      ),
    );
  });

const executeCheckinRespondAction = (execution: typeof CheckinCommittedExecution.Type) =>
  Effect.gen(function* () {
    const context = yield* reauthorize(execution, execution.committed.context);
    const input = yield* decodeWorkflowContractInputOrDie(CheckinsRespond, execution.input);
    const operations = yield* CheckinWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.respond(
        context,
        input.responseReference,
        execution.committed.isFirst,
        makeCheckinDeliveryKey(execution.invocationId, "respond"),
        CheckinsRespond.authorizationPolicy.policy,
      ),
    );
  });

const executeSetMemberRoleAction = (execution: typeof CheckinCommittedExecution.Type) =>
  Effect.gen(function* () {
    const context = yield* reauthorize(execution, execution.committed.context);
    if (Predicate.isNull(context.roleId)) {
      return yield* Effect.fail(
        interactiveAuthorizationRevoked(CheckinsRespond.authorizationPolicy.policy),
      );
    }
    const operations = yield* CheckinWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.setMemberRole(
        context,
        context.roleId,
        makeCheckinDeliveryKey(execution.invocationId, "set-member-role"),
        CheckinsRespond.authorizationPolicy.policy,
      ),
    );
  });

const executeLoadCurrentCheckinViewAction = (execution: typeof CheckinCommittedExecution.Type) =>
  Effect.gen(function* () {
    const context = yield* reauthorize(execution, execution.committed.context);
    const operations = yield* CheckinWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.loadCurrentView(context, CheckinsRespond.authorizationPolicy.policy),
    );
  });

export const makeCurrentCheckinMessage = (view: typeof CheckinView.Type) => ({
  content: renderCheckedInContent(
    view.context.initialMessage,
    view.members.map(({ memberId, checkinAt }) => ({
      memberId,
      checkinAt: Option.fromNullishOr(checkinAt),
    })),
  ),
  components: [checkinActionRow()],
});

const executeEditCheckinMessageAction = (execution: typeof CheckinViewExecution.Type) =>
  Effect.gen(function* () {
    yield* reauthorize(execution, execution.view.context);
    const operations = yield* CheckinWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.editCheckinMessage(
        execution.view,
        makeCurrentCheckinMessage(execution.view),
        makeCheckinDeliveryKey(execution.invocationId, "edit-check-in-message"),
        CheckinsRespond.authorizationPolicy.policy,
      ),
    );
  });

const executeAnnounceFirstCheckinAction = (execution: typeof CheckinCommittedExecution.Type) =>
  Effect.gen(function* () {
    const context = yield* reauthorize(execution, execution.committed.context);
    const operations = yield* CheckinWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.announceFirstCheckin(
        context,
        makeCheckinDeliveryKey(execution.invocationId, "announce-first-check-in"),
        CheckinsRespond.authorizationPolicy.policy,
      ),
    );
  });

const CommitCheckinAction = makeAction({
  name: `${actionName}.commit-check-in`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: CheckinRespondExecution,
  success: CheckinCommit,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeCommitCheckinAction,
});

const CheckinRespondAction = makeAction({
  name: `${actionName}.respond`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: CheckinCommittedExecution,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeCheckinRespondAction,
});

const SetMemberRoleAction = makeAction({
  name: `${actionName}.set-member-role`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: CheckinCommittedExecution,
  success: SetMemberRoleReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeSetMemberRoleAction,
});

export const LoadCurrentCheckinViewAction = makeAction({
  name: `${actionName}.load-current-check-in-view`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: CheckinCommittedExecution,
  success: CheckinView,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeLoadCurrentCheckinViewAction,
});

export const EditCheckinMessageAction = makeAction({
  name: `${actionName}.edit-check-in-message`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: CheckinViewExecution,
  success: EditMessageReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeEditCheckinMessageAction,
});

const AnnounceFirstCheckinAction = makeAction({
  name: `${actionName}.announce-first-check-in`,
  version: checkinSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: CheckinCommittedExecution,
  success: SendMessageReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeAnnounceFirstCheckinAction,
});

const CheckinsRespondWorkflow = Workflow.make({
  name,
  payload: CheckinRespondExecution,
  success: CheckinsRespond.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

type DeclaredFailure = typeof InteractiveDeclaredFailure.Type;
type PostCommitEffect<R> = Effect.Effect<typeof DeliveryReceipt.Type, DeclaredFailure, R>;

const failureFrom = (exit: Exit.Exit<unknown, DeclaredFailure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

type CollectedDelivery = {
  readonly operation: string;
  readonly exit: Exit.Exit<typeof DeliveryReceipt.Type, DeclaredFailure>;
};

const completeCollectedEffects = (
  collected: ReadonlyArray<CollectedDelivery>,
): Effect.Effect<ReadonlyArray<typeof DeliveryReceipt.Type>, DeclaredFailure> =>
  Effect.gen(function* () {
    const dispositions = collected.map(({ operation, exit }) => ({
      operation,
      status: Exit.isSuccess(exit) ? "delivered" : "failed",
      ...(Exit.isFailure(exit) ? { failureTag: failureFrom(exit)?._tag ?? "Defect" } : {}),
    }));
    const exits = collected.map(({ exit }) => exit);
    const failures = exits.map(failureFrom).filter(Predicate.isNotUndefined);
    const failedExits = exits.filter(Exit.isFailure);
    if (failedExits.length > 0) {
      yield* Effect.logWarning("Check-in committed with post-commit recovery required").pipe(
        Effect.annotateLogs({ committed: true, dispositions }),
      );
      const authorization = failures.find(Predicate.isTagged("AuthorizationRevoked"));
      if (Predicate.isNotUndefined(authorization)) return yield* Effect.fail(authorization);
      const delivery = failures.find(Predicate.isTagged("DeliveryRejected"));
      if (Predicate.isNotUndefined(delivery)) return yield* Effect.fail(delivery);
      if (failures.length > 0) return yield* Effect.fail(failures[0]!);
      const [firstCause, ...remainingCauses] = failedExits.map(({ cause }) => cause);
      if (Predicate.isUndefined(firstCause)) return yield* Effect.die("Missing failure cause");
      let combinedCause: Cause.Cause<DeclaredFailure> = firstCause;
      for (const cause of remainingCauses) {
        combinedCause = Cause.combine(combinedCause, cause);
      }
      return yield* Effect.failCause(combinedCause);
    }
    return exits.flatMap((exit) => (Exit.isSuccess(exit) ? [exit.value] : []));
  });

export const makeCheckinsRespondWorkflowBody = <
  RCommit,
  RRespond,
  RRole,
  RProject,
  RAnnounce,
>(actions: {
  readonly commit: (
    execution: typeof CheckinRespondExecution.Type,
  ) => Effect.Effect<typeof CheckinCommit.Type, DeclaredFailure, RCommit>;
  readonly respond: (
    execution: typeof CheckinCommittedExecution.Type,
  ) => Effect.Effect<typeof RespondReceipt.Type, DeclaredFailure, RRespond>;
  readonly setRole: (
    execution: typeof CheckinCommittedExecution.Type,
  ) => Effect.Effect<typeof SetMemberRoleReceipt.Type, DeclaredFailure, RRole>;
  readonly project: (
    execution: typeof CheckinCommittedExecution.Type,
  ) => Effect.Effect<typeof EditMessageReceipt.Type, DeclaredFailure, RProject>;
  readonly announce: (
    execution: typeof CheckinCommittedExecution.Type,
  ) => Effect.Effect<typeof SendMessageReceipt.Type, DeclaredFailure, RAnnounce>;
}) =>
  Effect.fnUntraced(function* (execution: typeof CheckinRespondExecution.Type) {
    yield* decodeWorkflowContractInputOrDie(CheckinsRespond, execution.input);
    const committed = yield* actions.commit(execution);
    const committedExecution = { ...execution, committed };

    const responseExit = yield* Effect.exit(actions.respond(committedExecution));
    const postCommitSteps: ReadonlyArray<{
      readonly operation: string;
      readonly effect: PostCommitEffect<RRole | RProject | RAnnounce>;
    }> = [
      ...(Predicate.isNull(committed.context.roleId)
        ? []
        : [
            {
              operation: "set-member-role",
              effect: actions.setRole(committedExecution),
            },
          ]),
      {
        operation: "edit-check-in-message",
        effect: actions.project(committedExecution),
      },
      ...(committed.isFirst
        ? [
            {
              operation: "announce-first-check-in",
              effect: actions.announce(committedExecution),
            },
          ]
        : []),
    ];
    const postCommitCollected = yield* Effect.forEach(
      postCommitSteps,
      ({ operation, effect }) =>
        Effect.exit(effect).pipe(Effect.map((exit) => ({ operation, exit }))),
      { concurrency: "unbounded" },
    );
    const deliveryReceipts = yield* completeCollectedEffects([
      { operation: "respond", exit: responseExit },
      ...postCommitCollected,
    ]);
    return {
      messageId: committed.context.messageId,
      messageConversationId: committed.context.conversationId,
      checkedInMemberId: committed.context.memberId,
      deliveryReceipts,
    };
  });

const projectThroughEntity = (execution: typeof CheckinCommittedExecution.Type) =>
  Effect.gen(function* () {
    const clientFor = yield* CheckinProjectionEntity.client;
    return yield* clientFor(checkinProjectionKey(execution.committed.context))
      .project(execution)
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered),
          times: 3,
          while: isProjectionSendFailure,
        }),
        Effect.mapError((error) =>
          isProjectionSendFailure(error)
            ? interactiveDeliveryRejected(
                "checkins.respond.editCheckinMessage",
                "The check-in projection could not be scheduled",
                true,
                execution.committed.context.messageId,
              )
            : error,
        ),
      );
  }).pipe(preserveDeclaredFailure);

export const makeCheckinsRespondDefinition = () => ({
  contract: CheckinsRespond,
  workflow: CheckinsRespondWorkflow,
  actions: [
    CommitCheckinAction,
    CheckinRespondAction,
    SetMemberRoleAction,
    LoadCurrentCheckinViewAction,
    EditCheckinMessageAction,
    AnnounceFirstCheckinAction,
  ],
  workflowLayer: CheckinsRespondWorkflow.toLayer(
    makeCheckinsRespondWorkflowBody({
      commit: (execution) => CommitCheckinAction.await(execution),
      respond: (execution) => CheckinRespondAction.await(execution),
      setRole: (execution) => SetMemberRoleAction.await(execution),
      project: projectThroughEntity,
      announce: (execution) => AnnounceFirstCheckinAction.await(execution),
    }),
  ),
});
