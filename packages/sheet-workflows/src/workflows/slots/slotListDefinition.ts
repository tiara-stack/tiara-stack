import { DateTime, Effect, Match, Number as Number_, Option, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { BotOutboundMessage, RespondReceipt } from "sheet-bot-api";
import {
  PartialNamePlayer,
  PopulatedBreakSchedule,
  PopulatedSchedule,
  PopulatedSchedulePlayer,
  type PopulatedScheduleResult,
} from "sheet-ingress-api/schemas/sheet";
import { makeWebScheduleEmbed } from "sheet-message-content/rendering";
import { renderSlotEmbeds } from "sheet-message-content/slotRendering";
import { InteractiveDeclaredFailure, SlotsDeliverList } from "sheet-workflow-contracts";
import {
  decodeWorkflowContractInputOrDie,
  workflowContractExecutionSchema,
} from "../shared/execution";
import {
  authorizeInteractiveWorkflow as authorize,
  interactiveExternalOperationRejected,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { slotCapacity } from "../shared/slotCapacity";
import { slotSheetWorkflowDefinitionVersion } from "./catalog";
import { makeSlotDeliveryKey } from "./keys";
import { SlotView } from "./slotListSchema";
import { SlotListWorkflowOperations } from "./slotListService";

type SlotViewSchedule = SlotView["schedules"][number];

const name = workflowContractKey(SlotsDeliverList);
const actionName = SlotsDeliverList.identity;
const executionSchema = workflowContractExecutionSchema(SlotsDeliverList);
const responseExecutionSchema = Schema.Struct({
  ...executionSchema.fields,
  message: BotOutboundMessage,
});

const placeholderPlayer = new PopulatedSchedulePlayer({
  player: new PartialNamePlayer({ name: "Filled" }),
  enc: false,
});
const clampSlotCount = Number_.clamp({ minimum: 0, maximum: slotCapacity });
// Overfills are variable-length legacy data, but the synthetic player allocation must be bounded.
const maximumOverfillSlots = 100;
const clampOverfillCount = Number_.clamp({ minimum: 0, maximum: maximumOverfillSlots });

const toLegacySchedule = (
  day: number,
  schedule: SlotViewSchedule,
): Effect.Effect<PopulatedScheduleResult> =>
  Match.valueTags(schedule, {
    Break: ({ hour, visible }) =>
      Effect.succeed(
        new PopulatedBreakSchedule({
          channel: "",
          day,
          visible,
          hour: Option.fromNullishOr(hour),
          hourWindow: Option.none(),
        }),
      ),
    Schedule: ({ filledSlots, hour, overfillSlots, visible }) => {
      const boundedFilledSlots = clampSlotCount(filledSlots);
      const boundedOverfillSlots = clampOverfillCount(overfillSlots);
      const legacySchedule = new PopulatedSchedule({
        channel: "",
        day,
        visible,
        hour: Option.fromNullishOr(hour),
        hourWindow: Option.none(),
        fills: Array.from({ length: slotCapacity }, (_, index) =>
          index < boundedFilledSlots ? Option.some(placeholderPlayer) : Option.none(),
        ),
        overfills: Array.from({ length: boundedOverfillSlots }, () => placeholderPlayer),
        standbys: [],
        runners: [],
        monitor: Option.none(),
      });
      return overfillSlots > maximumOverfillSlots
        ? Effect.logWarning("Truncating slot overfills at the defensive allocation limit").pipe(
            Effect.annotateLogs({
              day,
              hour: hour ?? "missing",
              maximumOverfillSlots,
              overfillSlots,
            }),
            Effect.as(legacySchedule),
          )
        : Effect.succeed(legacySchedule);
    },
  });

const sortedSchedulesWithHours = (view: SlotView) => {
  const schedulesWithHours = view.schedules.flatMap((schedule) =>
    Predicate.isNotNull(schedule.hour) ? ([{ hour: schedule.hour, schedule }] as const) : [],
  );
  return {
    droppedCount: view.schedules.length - schedulesWithHours.length,
    schedules: schedulesWithHours
      .sort((left, right) => left.hour - right.hour)
      .map(({ schedule }) => schedule),
  };
};

export const makeSlotViewEmbeds = (
  day: number,
  view: SlotView,
  operation: string,
): Effect.Effect<
  NonNullable<(typeof BotOutboundMessage.Type)["embeds"]>,
  InteractiveDeclaredFailure
> =>
  Effect.gen(function* () {
    const startTime = yield* Option.match(DateTime.make(view.eventStartEpochMs), {
      onNone: () =>
        Effect.fail(
          interactiveExternalOperationRejected(
            operation,
            "InvalidProviderResponse",
            "The schedule provider returned an invalid event start time",
          ),
        ),
      onSome: Effect.succeed,
    });
    const sorted = sortedSchedulesWithHours(view);
    if (sorted.droppedCount > 0) {
      yield* Effect.logWarning("Ignoring slot schedules without an hour").pipe(
        Effect.annotateLogs({ day, droppedScheduleCount: sorted.droppedCount }),
      );
    }
    const schedules = yield* Effect.forEach(sorted.schedules, (schedule) =>
      toLegacySchedule(day, schedule),
    );
    return renderSlotEmbeds(day, schedules, { startTime });
  });

export const makeSlotsDeliverListMessage = (
  day: number,
  view: SlotView,
): Effect.Effect<typeof BotOutboundMessage.Type, InteractiveDeclaredFailure> =>
  makeSlotViewEmbeds(day, view, "slots.deliverList.loadSlotView").pipe(
    Effect.map((embeds) => ({ embeds: [...embeds, makeWebScheduleEmbed()] })),
  );

export const executeSlotsDeliverListLoadAction = (execution: typeof executionSchema.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(SlotsDeliverList, execution));
    const operations = yield* SlotListWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(SlotsDeliverList, execution.input);
    return yield* preserveDeclaredFailure(operations.loadSlotView(input));
  });

export const executeSlotsDeliverListRespondAction = (
  execution: typeof responseExecutionSchema.Type,
) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(SlotsDeliverList, execution));
    const operations = yield* SlotListWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(SlotsDeliverList, execution.input);
    return yield* preserveDeclaredFailure(
      operations.respond(
        input,
        execution.message,
        makeSlotDeliveryKey(SlotsDeliverList, execution.invocationId, "respond"),
        SlotsDeliverList.authorizationPolicy.policy,
      ),
    );
  });

const SlotsDeliverListLoadAction = makeAction({
  name: `${actionName}.load-slot-view`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: executionSchema,
  success: SlotView,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeSlotsDeliverListLoadAction,
});

const SlotsDeliverListRespondAction = makeAction({
  name: `${actionName}.respond`,
  version: slotSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: responseExecutionSchema,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeSlotsDeliverListRespondAction,
});

const SlotsDeliverListWorkflow = Workflow.make({
  name,
  payload: executionSchema,
  success: SlotsDeliverList.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export const makeSlotsDeliverListWorkflowBody = <E, R>(actions: {
  readonly load: (execution: typeof executionSchema.Type) => Effect.Effect<SlotView, E, R>;
  readonly respond: (
    execution: typeof responseExecutionSchema.Type,
  ) => Effect.Effect<typeof RespondReceipt.Type, E, R>;
}) =>
  Effect.fnUntraced(function* (execution: typeof executionSchema.Type) {
    const input = yield* decodeWorkflowContractInputOrDie(SlotsDeliverList, execution.input);
    const view = yield* actions.load(execution);
    const message = yield* makeSlotsDeliverListMessage(input.day, view);
    const receipt = yield* actions.respond({
      ...execution,
      message,
    });
    return {
      workspaceId: input.workspaceId,
      day: input.day,
      messageType: input.messageType,
      deliveryReceipts: [receipt],
    };
  });

export const makeSlotsDeliverListDefinition = () => ({
  contract: SlotsDeliverList,
  workflow: SlotsDeliverListWorkflow,
  actions: [SlotsDeliverListLoadAction, SlotsDeliverListRespondAction],
  workflowLayer: SlotsDeliverListWorkflow.toLayer(
    makeSlotsDeliverListWorkflowBody({
      load: (execution) => SlotsDeliverListLoadAction.await(execution),
      respond: (execution) => SlotsDeliverListRespondAction.await(execution),
    }),
  ),
});
