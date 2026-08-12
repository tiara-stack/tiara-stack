import { Effect, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { BotOutboundMessage, RespondReceipt } from "sheet-bot-api";
import {
  escapeMarkdown,
  formatHourRanges,
  makeEmbed,
  makeWebScheduleEmbed,
} from "sheet-message-content/rendering";
import { InteractiveDeclaredFailure, SchedulesDeliverUserSchedule } from "sheet-workflow-contracts";
import {
  decodeWorkflowContractInputOrDie,
  workflowContractExecutionSchema,
} from "../shared/execution";
import {
  authorizeInteractiveWorkflow as authorize,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { scheduleSheetWorkflowDefinitionVersion } from "./catalog";
import { makeScheduleDeliveryKey } from "./keys";
import { UserScheduleView } from "./schema";
import { ScheduleWorkflowOperations } from "./service";

const UserScheduleSummary = Schema.Struct({
  fillHours: Schema.Array(Schema.Number),
  overfillHours: Schema.Array(Schema.Number),
  standbyHours: Schema.Array(Schema.Number),
  invisible: Schema.Boolean,
});
type UserScheduleSummary = typeof UserScheduleSummary.Type;

const name = workflowContractKey(SchedulesDeliverUserSchedule);
const actionName = SchedulesDeliverUserSchedule.identity;
const executionSchema = workflowContractExecutionSchema(SchedulesDeliverUserSchedule);
const responseExecutionSchema = Schema.Struct({
  ...executionSchema.fields,
  message: BotOutboundMessage,
});

const sortedUnique = (hours: ReadonlyArray<number>): ReadonlyArray<number> =>
  [...hours]
    .sort((left, right) => left - right)
    .filter((hour, index, sorted) => index === 0 || hour !== sorted[index - 1]);

// The single traversal intentionally mirrors the legacy visibility and membership precedence.
// fallow-ignore-next-line complexity
export const summarizeUserSchedule = (
  view: UserScheduleView,
  targetUserId: string,
): UserScheduleSummary => {
  const playerAccountIdsByName = new Map<string, Set<string>>();
  for (const player of view.players) {
    const accountIds = playerAccountIdsByName.get(player.name) ?? new Set<string>();
    accountIds.add(player.accountId);
    playerAccountIdsByName.set(player.name, accountIds);
  }
  let invisible = false;
  const fillHours: Array<number> = [];
  const overfillHours: Array<number> = [];
  const standbyHours: Array<number> = [];
  const matchesTarget = (playerName: string) => {
    const accountIds = playerAccountIdsByName.get(playerName);
    return (
      Predicate.isNotUndefined(accountIds) && accountIds.size === 1 && accountIds.has(targetUserId)
    );
  };
  for (const schedule of view.schedules) {
    if (schedule.break) continue;
    if (!schedule.visible) invisible = true;
    if (schedule.hour === null) continue;
    if (schedule.fills.some(matchesTarget)) fillHours.push(schedule.hour);
    if (schedule.overfills.some(matchesTarget)) overfillHours.push(schedule.hour);
    if (schedule.standbys.some(matchesTarget)) standbyHours.push(schedule.hour);
  }
  return {
    fillHours: sortedUnique(fillHours),
    overfillHours: sortedUnique(overfillHours),
    standbyHours: sortedUnique(standbyHours),
    invisible,
  };
};

export const makeUserScheduleMessage = (
  day: number,
  targetUsername: string,
  summary: UserScheduleSummary,
): typeof BotOutboundMessage.Type => ({
  embeds: [
    makeEmbed({
      title: `${escapeMarkdown(targetUsername)}'s Schedule for Day ${day}`,
      description: summary.invisible
        ? "It is kinda foggy around here... This schedule is not visible to you yet."
        : null,
      fields: summary.invisible
        ? []
        : [
            { name: "Fill", value: formatHourRanges(summary.fillHours) },
            { name: "Overfill", value: formatHourRanges(summary.overfillHours) },
            { name: "Standby", value: formatHourRanges(summary.standbyHours) },
          ],
    }),
    makeWebScheduleEmbed(),
  ],
});

export const executeUserScheduleLoadAction = (execution: typeof executionSchema.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(SchedulesDeliverUserSchedule, execution));
    const operations = yield* ScheduleWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(
      SchedulesDeliverUserSchedule,
      execution.input,
    );
    return yield* preserveDeclaredFailure(operations.loadUserSchedule(input));
  });

export const executeUserScheduleRespondAction = (execution: typeof responseExecutionSchema.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(SchedulesDeliverUserSchedule, execution));
    const operations = yield* ScheduleWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(
      SchedulesDeliverUserSchedule,
      execution.input,
    );
    return yield* preserveDeclaredFailure(
      operations.respond(
        input,
        execution.message,
        makeScheduleDeliveryKey(SchedulesDeliverUserSchedule, execution.invocationId, "respond"),
        SchedulesDeliverUserSchedule.authorizationPolicy.policy,
      ),
    );
  });

const SchedulesDeliverUserScheduleLoadAction = makeAction({
  name: `${actionName}.load-user-schedule`,
  version: scheduleSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: executionSchema,
  success: UserScheduleView,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeUserScheduleLoadAction,
});

const SchedulesDeliverUserScheduleRespondAction = makeAction({
  name: `${actionName}.respond`,
  version: scheduleSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: responseExecutionSchema,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeUserScheduleRespondAction,
});

const SchedulesDeliverUserScheduleWorkflow = Workflow.make({
  name,
  payload: executionSchema,
  success: SchedulesDeliverUserSchedule.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export const makeUserScheduleWorkflowBody = <E, R>(actions: {
  readonly load: (execution: typeof executionSchema.Type) => Effect.Effect<UserScheduleView, E, R>;
  readonly respond: (
    execution: typeof responseExecutionSchema.Type,
  ) => Effect.Effect<typeof RespondReceipt.Type, E, R>;
}) =>
  Effect.fnUntraced(function* (execution: typeof executionSchema.Type) {
    const input = yield* decodeWorkflowContractInputOrDie(
      SchedulesDeliverUserSchedule,
      execution.input,
    );
    const view = yield* actions.load(execution);
    const summary = summarizeUserSchedule(view, input.targetUserId);
    const message = makeUserScheduleMessage(input.day, input.targetUsername, summary);
    const receipt = yield* actions.respond({ ...execution, message });
    return {
      workspaceId: input.workspaceId,
      day: input.day,
      targetUserId: input.targetUserId,
      invisible: summary.invisible,
      deliveryReceipts: [receipt],
    };
  });

export const makeUserScheduleDefinition = () => ({
  contract: SchedulesDeliverUserSchedule,
  workflow: SchedulesDeliverUserScheduleWorkflow,
  actions: [SchedulesDeliverUserScheduleLoadAction, SchedulesDeliverUserScheduleRespondAction],
  workflowLayer: SchedulesDeliverUserScheduleWorkflow.toLayer(
    makeUserScheduleWorkflowBody({
      load: (execution) => SchedulesDeliverUserScheduleLoadAction.await(execution),
      respond: (execution) => SchedulesDeliverUserScheduleRespondAction.await(execution),
    }),
  ),
});
