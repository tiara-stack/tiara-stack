import { Cause, Effect, Exit, Match, Option } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  DeliveryReceipt,
  RespondReceipt,
  SetMemberRoleReceipt,
  type BotOutboundMessage,
} from "sheet-bot-api";
import { InteractiveDeclaredFailure, MembersKick } from "sheet-workflow-contracts";
import { config } from "@/config";
import { MemberKickEntity } from "@/entities/memberKick";
import {
  interactiveDeliveryRejected,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { memberSheetWorkflowDefinitionVersion } from "./catalog";
import {
  makeMemberKickActionKey,
  makeMemberKickRemovalDeliveryKey,
  makeMemberKickResponseDeliveryKey,
  makeMemberKickSerializationKey,
} from "./keys";
import { makeMemberKickResultMessage, makeMissingScheduleMemberKickMessage } from "./operations";
import {
  MemberKickContext,
  MemberKickExecution,
  MemberKickRemovalExecution,
  MemberKickResolvedExecution,
  MemberKickResponseExecution,
  MemberKickSchedule,
  MemberKickScheduleExecution,
  MemberKickTargets,
} from "./schema";
import { MemberKickWorkflowOperations } from "./service";

const name = workflowContractKey(MembersKick);
const actionName = MembersKick.identity;

const executeResolveAction = (execution: typeof MemberKickExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* MemberKickWorkflowOperations;
    return yield* preserveDeclaredFailure(operations.resolve(execution));
  });

const executeLoadScheduleAction = (execution: typeof MemberKickResolvedExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* MemberKickWorkflowOperations;
    return yield* preserveDeclaredFailure(operations.loadSchedule(execution));
  });

const executeDiscoverTargetsAction = (execution: typeof MemberKickScheduleExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* MemberKickWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.discoverTargets(execution, execution.schedule),
    );
  });

const executeRemoveRoleAction = (execution: typeof MemberKickRemovalExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* MemberKickWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.removeRole(
        execution,
        execution.memberId,
        makeMemberKickRemovalDeliveryKey(execution.invocationId, execution.memberId),
      ),
    );
  });

const executeRespondAction = (execution: typeof MemberKickResponseExecution.Type) =>
  Effect.gen(function* () {
    const operations = yield* MemberKickWorkflowOperations;
    return yield* preserveDeclaredFailure(
      operations.respond(
        execution,
        execution.message,
        makeMemberKickResponseDeliveryKey(execution.invocationId),
        execution.recoveryRequired,
      ),
    );
  });

const ResolveMemberKickContextAction = makeAction({
  name: `${actionName}.resolve-member-kick-context`,
  version: memberSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: MemberKickExecution,
  success: MemberKickContext,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeMemberKickActionKey(invocationId, "resolve-member-kick-context"),
  execute: executeResolveAction,
});

const LoadMemberKickScheduleAction = makeAction({
  name: `${actionName}.load-member-kick-schedule`,
  version: memberSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: MemberKickResolvedExecution,
  success: MemberKickSchedule,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeMemberKickActionKey(invocationId, "load-member-kick-schedule"),
  execute: executeLoadScheduleAction,
});

const DiscoverMemberKickTargetsAction = makeAction({
  name: `${actionName}.discover-member-kick-targets`,
  version: memberSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: MemberKickScheduleExecution,
  success: MemberKickTargets,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeMemberKickActionKey(invocationId, "discover-member-kick-targets"),
  execute: executeDiscoverTargetsAction,
});

const RemoveMemberRoleAction = makeAction({
  name: `${actionName}.remove-member-role`,
  version: memberSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: MemberKickRemovalExecution,
  success: SetMemberRoleReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId, memberId }) =>
    makeMemberKickActionKey(invocationId, "remove-member-role", memberId),
  execute: executeRemoveRoleAction,
});

const DeliverMemberKickResultAction = makeAction({
  name: `${actionName}.deliver-member-kick-result`,
  version: memberSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: MemberKickResponseExecution,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) =>
    makeMemberKickActionKey(invocationId, "deliver-member-kick-result"),
  execute: executeRespondAction,
});

export const MembersKickWorkflow = Workflow.make({
  name,
  payload: MemberKickExecution,
  success: MembersKick.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

type DeclaredFailure = typeof InteractiveDeclaredFailure.Type;

// Failure extraction and public receipt assembly follow the established post-commit audit shape.
// fallow-ignore-next-line code-duplication
const failureFrom = (exit: Exit.Exit<unknown, DeclaredFailure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const publicResult = (
  context: typeof MemberKickContext.Type,
  status: "removed" | "empty" | "tooEarly" | "missingRole",
  removedMemberIds: ReadonlyArray<string>,
  deliveryReceipts: ReadonlyArray<typeof DeliveryReceipt.Type>,
) => ({
  workspaceId: context.workspaceId,
  runningConversationId: context.runningConversationId,
  hour: context.hour,
  roleId: context.roleId,
  removedMemberIds,
  status,
  deliveryReceipts,
});

const responseMessageFor = (
  context: typeof MemberKickContext.Type,
  scheduleFound: boolean,
  removedMemberIds: ReadonlyArray<string>,
  failedCount: number,
): typeof BotOutboundMessage.Type =>
  context.status === "ready" && !scheduleFound
    ? makeMissingScheduleMemberKickMessage()
    : makeMemberKickResultMessage(context, removedMemberIds, failedCount);

const roleRemovalFailure = (
  context: typeof MemberKickContext.Type,
  removedMemberIds: ReadonlyArray<string>,
): DeclaredFailure =>
  interactiveDeliveryRejected(
    "members.kick.remove-member-role",
    "Failed to remove the cleanup role from some members",
    removedMemberIds.length > 0,
    removedMemberIds.length > 0
      ? makeMemberKickSerializationKey(
          context.clientId,
          context.workspaceId,
          context.runningConversationId,
          context.hour,
          context.roleId,
        )
      : undefined,
  );

const respondIfUser = <RRespond>(
  execution: typeof MemberKickResolvedExecution.Type,
  message: typeof BotOutboundMessage.Type,
  recoveryRequired: boolean,
  respond: (
    execution: typeof MemberKickResponseExecution.Type,
  ) => Effect.Effect<typeof RespondReceipt.Type, DeclaredFailure, RRespond>,
) =>
  execution.context.principalKind === "user"
    ? Effect.map(Effect.exit(respond({ ...execution, message, recoveryRequired })), (exit) => ({
        attempted: true as const,
        exit,
      }))
    : Effect.succeed({ attempted: false as const });

export const makeMembersKickSerializedWorkflowBody = <
  RLoad,
  RDiscover,
  RRemove,
  RRespond,
>(actions: {
  readonly loadSchedule: (
    execution: typeof MemberKickResolvedExecution.Type,
  ) => Effect.Effect<typeof MemberKickSchedule.Type, DeclaredFailure, RLoad>;
  readonly discoverTargets: (
    execution: typeof MemberKickScheduleExecution.Type,
  ) => Effect.Effect<typeof MemberKickTargets.Type, DeclaredFailure, RDiscover>;
  readonly removeRole: (
    execution: typeof MemberKickRemovalExecution.Type,
  ) => Effect.Effect<typeof SetMemberRoleReceipt.Type, DeclaredFailure, RRemove>;
  readonly respond: (
    execution: typeof MemberKickResponseExecution.Type,
  ) => Effect.Effect<typeof RespondReceipt.Type, DeclaredFailure, RRespond>;
  readonly removalConcurrency: number;
}) =>
  // CollectAll failure precedence is easier to audit as one serialized workflow transaction.
  // fallow-ignore-next-line complexity
  Effect.fnUntraced(function* (execution: typeof MemberKickResolvedExecution.Type) {
    const { context } = execution;
    if (context.status !== "ready") {
      const message = responseMessageFor(context, false, [], 0);
      const response = yield* respondIfUser(execution, message, false, actions.respond);
      if (response.attempted && Exit.isFailure(response.exit)) {
        return yield* Effect.failCause(response.exit.cause);
      }
      const receipts =
        response.attempted && Exit.isSuccess(response.exit) ? [response.exit.value] : [];
      return publicResult(context, context.status, [], receipts);
    }

    const schedule = yield* actions.loadSchedule(execution);
    const targets = schedule.scheduleFound
      ? yield* actions.discoverTargets({ ...execution, schedule })
      : { memberIds: [] };
    const removalExits = yield* Effect.forEach(
      targets.memberIds,
      (memberId) => Effect.exit(actions.removeRole({ ...execution, memberId })),
      { concurrency: actions.removalConcurrency },
    );
    const removedMemberIds = targets.memberIds.filter((_, index) =>
      Exit.isSuccess(removalExits[index]!),
    );
    const failedCount = removalExits.length - removedMemberIds.length;
    const removalReceipts = removalExits.flatMap((exit) =>
      Exit.isSuccess(exit) ? [exit.value] : [],
    );
    const message = responseMessageFor(
      context,
      schedule.scheduleFound,
      removedMemberIds,
      failedCount,
    );
    const response = yield* respondIfUser(
      execution,
      message,
      removedMemberIds.length > 0,
      actions.respond,
    );

    if (failedCount > 0) {
      yield* Effect.logWarning("Member cleanup completed with failed role removals").pipe(
        Effect.annotateLogs({
          workspaceId: context.workspaceId,
          runningConversationId: context.runningConversationId,
          removedMemberIds,
          dispositions: removalExits.map((exit, index) => ({
            memberId: targets.memberIds[index],
            status: Exit.isSuccess(exit) ? "confirmed" : "failed",
            ...(Exit.isFailure(exit) ? { failureTag: failureFrom(exit)?._tag ?? "Defect" } : {}),
          })),
          responseStatus: !response.attempted
            ? "not-applicable"
            : Exit.isSuccess(response.exit)
              ? "confirmed"
              : (failureFrom(response.exit)?._tag ?? "Defect"),
        }),
      );
      return yield* Effect.fail(roleRemovalFailure(context, removedMemberIds));
    }

    if (response.attempted && Exit.isFailure(response.exit)) {
      return yield* Effect.failCause(response.exit.cause);
    }
    const responseReceipts =
      response.attempted && Exit.isSuccess(response.exit) ? [response.exit.value] : [];
    return publicResult(
      context,
      removedMemberIds.length > 0 ? "removed" : "empty",
      removedMemberIds,
      [...removalReceipts, ...responseReceipts],
    );
  });

export const runMembersKickSerialized = (execution: typeof MemberKickResolvedExecution.Type) =>
  Effect.gen(function* () {
    const removalConcurrency = yield* preserveDeclaredFailure(config.autoKickConcurrency);
    return yield* makeMembersKickSerializedWorkflowBody({
      loadSchedule: (input) => LoadMemberKickScheduleAction.await(input),
      discoverTargets: (input) => DiscoverMemberKickTargetsAction.await(input),
      removeRole: (input) => RemoveMemberRoleAction.await(input),
      respond: (input) => DeliverMemberKickResultAction.await(input),
      removalConcurrency,
    })(execution);
  });

const runThroughEntity = (execution: typeof MemberKickResolvedExecution.Type) =>
  Effect.gen(function* () {
    const clientFor = yield* MemberKickEntity.client;
    return yield* clientFor(
      makeMemberKickSerializationKey(
        execution.context.clientId,
        execution.context.workspaceId,
        execution.context.runningConversationId,
        execution.context.hour,
        execution.context.roleId,
      ),
    ).run(execution);
  }).pipe(preserveDeclaredFailure);

export const makeMembersKickWorkflowBody = <RResolve, RReady, RTerminal>(actions: {
  readonly resolve: (
    execution: typeof MemberKickExecution.Type,
  ) => Effect.Effect<typeof MemberKickContext.Type, DeclaredFailure, RResolve>;
  readonly runReady: (
    execution: typeof MemberKickResolvedExecution.Type,
  ) => Effect.Effect<typeof MembersKick.success.Type, DeclaredFailure, RReady>;
  readonly runTerminal: (
    execution: typeof MemberKickResolvedExecution.Type,
  ) => Effect.Effect<typeof MembersKick.success.Type, DeclaredFailure, RTerminal>;
}) =>
  Effect.fnUntraced(function* (execution: typeof MemberKickExecution.Type) {
    const context = yield* actions.resolve(execution);
    const resolvedExecution = { ...execution, context };
    return yield* Match.value(context.status).pipe(
      Match.when("ready", () => actions.runReady(resolvedExecution)),
      Match.when("tooEarly", () => actions.runTerminal(resolvedExecution)),
      Match.when("missingRole", () => actions.runTerminal(resolvedExecution)),
      Match.exhaustive,
    );
  });

export const makeMembersKickDefinition = () => ({
  contract: MembersKick,
  workflow: MembersKickWorkflow,
  actions: [
    ResolveMemberKickContextAction,
    LoadMemberKickScheduleAction,
    DiscoverMemberKickTargetsAction,
    RemoveMemberRoleAction,
    DeliverMemberKickResultAction,
  ] as const,
  workflowLayer: MembersKickWorkflow.toLayer(
    makeMembersKickWorkflowBody({
      resolve: (execution) => ResolveMemberKickContextAction.await(execution),
      runReady: runThroughEntity,
      runTerminal: runMembersKickSerialized,
    }),
  ),
});
