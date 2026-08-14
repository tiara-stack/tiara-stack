import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { DeleteMessageReceipt, EditMessageReceipt } from "sheet-bot-api";
import { InteractiveDeclaredFailure, RoomOrdersCreate } from "sheet-workflow-contracts";
import { AuthorizedRoomOrderCreateContext } from "../readOnly/authorization";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";
import {
  authorizeRoomOrdersCreateWorkflow as authorize,
  interactiveAuthorizationRevoked,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { roomOrderSheetWorkflowDefinitionVersion } from "./catalog";
import { makeRoomOrderCreateDeliveryKey } from "./keys";
import {
  RoomOrderCreateBindingOutcome,
  RoomOrderCreateCleanupExecution,
  RoomOrderCreateDraft,
  RoomOrderCreateDraftExecution,
  RoomOrderCreateExecution,
  RoomOrderCreatePublication,
  RoomOrderCreatePublicationExecution,
} from "./createSchema";
import { RoomOrderCreateOperations } from "./createService";

const name = workflowContractKey(RoomOrdersCreate);
const actionName = RoomOrdersCreate.identity;
const sameContext = Schema.toEquivalence(AuthorizedRoomOrderCreateContext);

const reauthorize = (
  execution: typeof RoomOrderCreateExecution.Type,
  expected: typeof AuthorizedRoomOrderCreateContext.Type,
) =>
  Effect.gen(function* () {
    const current = yield* preserveDeclaredFailure(authorize(execution));
    return sameContext(current, expected)
      ? current
      : yield* Effect.fail(
          interactiveAuthorizationRevoked(RoomOrdersCreate.authorizationPolicy.policy),
        );
  });

const LoadRoomOrderDraftAction = makeAction({
  name: `${actionName}.load-room-order-draft`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderCreateExecution,
  success: RoomOrderCreateDraft,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      const context = yield* preserveDeclaredFailure(authorize(execution));
      const input = yield* decodeWorkflowContractInputOrDie(RoomOrdersCreate, execution.input);
      const operations = yield* RoomOrderCreateOperations;
      return yield* preserveDeclaredFailure(operations.loadDraft(context, input));
    }),
});

const PublishRoomOrderDraftAction = makeAction({
  name: `${actionName}.publish-room-order-draft`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderCreateDraftExecution,
  success: RoomOrderCreatePublication,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* reauthorize(execution, execution.draft.context);
      const input = yield* decodeWorkflowContractInputOrDie(RoomOrdersCreate, execution.input);
      const operations = yield* RoomOrderCreateOperations;
      return yield* preserveDeclaredFailure(
        operations.publishDraft(
          execution.draft,
          input.responseReference,
          {
            publishKey: makeRoomOrderCreateDeliveryKey(
              execution.invocationId,
              "publish-room-order-draft",
            ),
            cleanupKey: makeRoomOrderCreateDeliveryKey(
              execution.invocationId,
              "delete-provisional-room-order",
            ),
          },
          RoomOrdersCreate.authorizationPolicy.policy,
        ),
      );
    }),
});

const BindRoomOrderStateAction = makeAction({
  name: `${actionName}.bind-room-order-state`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderCreatePublicationExecution,
  success: RoomOrderCreateBindingOutcome,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* reauthorize(execution, execution.publication.draft.context);
      const operations = yield* RoomOrderCreateOperations;
      return yield* preserveDeclaredFailure(operations.bindState(execution.publication));
    }),
});

const FinalizeRoomOrderMessageAction = makeAction({
  name: `${actionName}.finalize-room-order-message`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderCreatePublicationExecution,
  success: EditMessageReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* reauthorize(execution, execution.publication.draft.context);
      const operations = yield* RoomOrderCreateOperations;
      return yield* preserveDeclaredFailure(
        operations.finalizeMessage(
          execution.publication,
          makeRoomOrderCreateDeliveryKey(execution.invocationId, "finalize-room-order-message"),
          RoomOrdersCreate.authorizationPolicy.policy,
        ),
      );
    }),
});

const DeleteProvisionalRoomOrderAction = makeAction({
  name: `${actionName}.delete-provisional-room-order`,
  version: roomOrderSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: RoomOrderCreateCleanupExecution,
  success: DeleteMessageReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      const operations = yield* RoomOrderCreateOperations;
      return yield* preserveDeclaredFailure(
        operations.deleteProvisional(
          execution.publication,
          makeRoomOrderCreateDeliveryKey(execution.invocationId, "delete-provisional-room-order"),
          RoomOrdersCreate.authorizationPolicy.policy,
        ),
      );
    }),
});

const RoomOrdersCreateWorkflow = Workflow.make({
  name,
  payload: RoomOrderCreateExecution,
  // The Workflow registration shape is standardized across room-order definitions.
  // fallow-ignore-next-line code-duplication
  success: RoomOrdersCreate.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

type DeclaredFailure = typeof InteractiveDeclaredFailure.Type;

const failureFrom = (exit: Exit.Exit<unknown, DeclaredFailure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const compensateAndFail = <A, RCleanup>(
  cause: Cause.Cause<DeclaredFailure>,
  cleanup: Effect.Effect<unknown, DeclaredFailure, RCleanup>,
): Effect.Effect<A, DeclaredFailure, RCleanup> =>
  Effect.uninterruptible(cleanup).pipe(
    Effect.catchCause((cleanupCause) => Effect.failCause(Cause.combine(cause, cleanupCause))),
    Effect.andThen(Effect.failCause(cause)),
  );

export const makeRoomOrdersCreateWorkflowBody = <
  RLoad,
  RPublish,
  RBind,
  RFinalize,
  RCleanup,
>(actions: {
  readonly load: (
    execution: typeof RoomOrderCreateExecution.Type,
  ) => Effect.Effect<typeof RoomOrderCreateDraft.Type, DeclaredFailure, RLoad>;
  readonly publish: (
    execution: typeof RoomOrderCreateDraftExecution.Type,
  ) => Effect.Effect<typeof RoomOrderCreatePublication.Type, DeclaredFailure, RPublish>;
  readonly bind: (
    execution: typeof RoomOrderCreatePublicationExecution.Type,
  ) => Effect.Effect<typeof RoomOrderCreateBindingOutcome.Type, DeclaredFailure, RBind>;
  readonly finalize: (
    execution: typeof RoomOrderCreatePublicationExecution.Type,
  ) => Effect.Effect<typeof EditMessageReceipt.Type, DeclaredFailure, RFinalize>;
  readonly cleanup: (
    execution: typeof RoomOrderCreateCleanupExecution.Type,
  ) => Effect.Effect<typeof DeleteMessageReceipt.Type, DeclaredFailure, RCleanup>;
}) =>
  Effect.fnUntraced(function* (execution: typeof RoomOrderCreateExecution.Type) {
    yield* decodeWorkflowContractInputOrDie(RoomOrdersCreate, execution.input);
    const draft = yield* actions.load(execution);
    const publication = yield* actions.publish({ ...execution, draft });
    const bindExit = yield* Effect.exit(actions.bind({ ...execution, publication }));
    if (Exit.isFailure(bindExit)) {
      const failure = failureFrom(bindExit);
      return Predicate.isTagged("AuthorizationRevoked")(failure)
        ? yield* compensateAndFail<never, RCleanup>(
            bindExit.cause,
            actions.cleanup({ ...execution, publication }),
          )
        : yield* Effect.failCause(bindExit.cause);
    }
    if (Predicate.isTagged("CleanupRequired")(bindExit.value)) {
      const cause = Cause.fail(bindExit.value.failure);
      return yield* compensateAndFail<never, RCleanup>(
        cause,
        actions.cleanup({ ...execution, publication, binding: bindExit.value }),
      );
    }
    const finalizeExit = yield* Effect.exit(actions.finalize({ ...execution, publication }));
    if (Exit.isFailure(finalizeExit)) {
      const failure = failureFrom(finalizeExit);
      yield* Effect.logWarning("Room-order creation committed with Recovery Required").pipe(
        Effect.annotateLogs({
          committedReference: publication.message.messageId,
          dispositions: [
            { operation: "publish-room-order-draft", status: "confirmed-or-reconciled" },
            { operation: "bind-room-order-state", status: "committed" },
            {
              operation: "finalize-room-order-message",
              status: "failed",
              failureTag: failure?._tag ?? "Defect",
            },
          ],
        }),
      );
      return yield* Effect.failCause(finalizeExit.cause);
    }
    const success: typeof RoomOrdersCreate.success.Type = {
      messageId: publication.message.messageId,
      messageConversationId: publication.message.conversation.conversationId,
      hour: draft.hour,
      runningConversationId: draft.runningConversationId,
      rank: draft.rank,
      deliveryReceipts: [publication.receipt, finalizeExit.value],
    };
    return success;
  });

export const makeRoomOrdersCreateDefinition = () => ({
  contract: RoomOrdersCreate,
  workflow: RoomOrdersCreateWorkflow,
  actions: [
    LoadRoomOrderDraftAction,
    PublishRoomOrderDraftAction,
    BindRoomOrderStateAction,
    FinalizeRoomOrderMessageAction,
    DeleteProvisionalRoomOrderAction,
  ],
  workflowLayer: RoomOrdersCreateWorkflow.toLayer((execution) =>
    makeRoomOrdersCreateWorkflowBody({
      load: (execution) => LoadRoomOrderDraftAction.await(execution),
      publish: (execution) => PublishRoomOrderDraftAction.await(execution),
      bind: (execution) => BindRoomOrderStateAction.await(execution),
      finalize: (execution) => FinalizeRoomOrderMessageAction.await(execution),
      cleanup: (execution) => DeleteProvisionalRoomOrderAction.await(execution),
    })(execution),
  ),
});
