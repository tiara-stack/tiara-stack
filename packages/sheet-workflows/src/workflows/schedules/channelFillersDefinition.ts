import { Effect, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { BotOutboundMessage, RespondReceipt } from "sheet-bot-api";
import { escapeMarkdown, makeEmbed } from "sheet-message-content/rendering";
import {
  InteractiveDeclaredFailure,
  SchedulesDeliverChannelFillers,
} from "sheet-workflow-contracts";
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
import { ScheduleWorkflowOperations, type ScheduleWorkflowActions } from "./service";
import { resolveSchedulePlayerAccountIds } from "@/services/sheetDataProvider";

export type ChannelFiller = {
  readonly accountId: string | null;
  readonly name: string;
};

const name = workflowContractKey(SchedulesDeliverChannelFillers);
const actionName = SchedulesDeliverChannelFillers.identity;
const executionSchema = workflowContractExecutionSchema(SchedulesDeliverChannelFillers);
const responseExecutionSchema = Schema.Struct({
  ...executionSchema.fields,
  message: BotOutboundMessage,
});

const fillerKey = (filler: ChannelFiller): string =>
  Predicate.isNull(filler.accountId) ? `name:${filler.name}` : `account:${filler.accountId}`;

/**
 * Selects scheduled Fill entries for one running channel and inclusive hour range.
 *
 * A player account ID is the stable identity when the sheet contains exactly one
 * account ID for that name. Ambiguous and missing names stay unlinked so the command
 * never mentions an account that cannot be identified safely.
 */
export const selectUniqueChannelFillers = (
  view: UserScheduleView,
  input: Pick<
    typeof SchedulesDeliverChannelFillers.input.Type,
    "conversationName" | "startHour" | "finishHour"
  >,
): ReadonlyArray<ChannelFiller> => {
  const selected = new Map<string, ChannelFiller>();

  for (const schedule of view.schedules) {
    if (
      schedule.channel !== input.conversationName ||
      !schedule.visible ||
      Predicate.isNull(schedule.hour) ||
      schedule.hour < input.startHour ||
      schedule.hour > input.finishHour ||
      schedule.break
    ) {
      continue;
    }

    const accountIds = resolveSchedulePlayerAccountIds(view.players, schedule.fills);
    for (const [index, scheduledName] of schedule.fills.entries()) {
      const accountId = accountIds[index];
      const filler = {
        accountId: Predicate.isString(accountId) && accountId.length > 0 ? accountId : null,
        name: scheduledName,
      } satisfies ChannelFiller;
      selected.set(fillerKey(filler), selected.get(fillerKey(filler)) ?? filler);
    }
  }

  return [...selected.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name, "en") ||
      (left.accountId ?? "").localeCompare(right.accountId ?? "", "en"),
  );
};

const maximumFillerFieldCharacters = 900;
const maximumFillerFields = 5;
const codeFence = "```";
const mentionNeutralizer = "\u200b";
const lineBreaks = /[\r\n\u2028\u2029]+/gu;

const fillerLine = (filler: ChannelFiller): string =>
  Predicate.isNull(filler.accountId)
    ? filler.name.replace(lineBreaks, " ").replaceAll("@", `@${mentionNeutralizer}`)
    : `<@${filler.accountId}>`;

const codeBlock = (lines: ReadonlyArray<string>): string =>
  `${codeFence}\n${lines.join("\n")}\n${codeFence}`;

const codeBlockLength = (lineLength: number, lineCount: number): number =>
  codeFence.length * 2 + lineCount + 1 + lineLength;

type FillerField = {
  readonly name: string;
  readonly value: string;
};

const fillerFieldValues = (fillers: ReadonlyArray<ChannelFiller>): ReadonlyArray<string> => {
  const chunks: Array<string> = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const filler of fillers) {
    const line = fillerLine(filler);
    if (
      current.length > 0 &&
      codeBlockLength(currentLength + line.length, current.length + 1) >
        maximumFillerFieldCharacters
    ) {
      chunks.push(codeBlock(current));
      current = [];
      currentLength = 0;
    }
    current.push(line);
    currentLength += line.length;
  }
  if (current.length > 0) chunks.push(codeBlock(current));
  return chunks;
};

const fillerText = (fillers: ReadonlyArray<ChannelFiller>): string =>
  fillers.map(fillerLine).join("\n");

const makeFillerAttachment = (fillers: ReadonlyArray<ChannelFiller>) => ({
  name: "fillers.txt",
  contentType: "text/plain",
  content: new TextEncoder().encode(fillerText(fillers)),
});

export const makeChannelFillersMessage = (
  input: Pick<
    typeof SchedulesDeliverChannelFillers.input.Type,
    "conversationName" | "startHour" | "finishHour"
  >,
  fillers: ReadonlyArray<ChannelFiller>,
): typeof BotOutboundMessage.Type => {
  const fillerValues = fillerFieldValues(fillers);
  const needsAttachment =
    fillerValues.length > maximumFillerFields ||
    fillerValues.some((value) => value.length > maximumFillerFieldCharacters) ||
    fillers.some((filler) => fillerLine(filler).includes(codeFence));
  const attachment = needsAttachment ? makeFillerAttachment(fillers) : undefined;
  const fillerFields: Array<FillerField> =
    fillers.length === 0
      ? [{ name: "Fillers", value: "None" }]
      : attachment === undefined
        ? fillerValues.slice(0, maximumFillerFields).map((value, index) => ({
            name: index === 0 ? "Fillers" : "Fillers (continued)",
            value,
          }))
        : [];
  const fields = [
    {
      name: "Hours",
      value: `${input.startHour}-${input.finishHour}`,
      inline: true,
    },
    ...fillerFields,
  ];
  return {
    ...(attachment === undefined
      ? {}
      : {
          content: `The complete list of ${fillers.length} unique fillers is attached as ${attachment.name}.`,
          files: [attachment],
        }),
    embeds: [
      makeEmbed({
        title: `Unique fillers for ${escapeMarkdown(input.conversationName)}`,
        fields,
      }),
    ],
    allowedMentions: "none",
  };
};

const executeChannelFillersLoadAction = (execution: typeof executionSchema.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(SchedulesDeliverChannelFillers, execution));
    const operations = yield* ScheduleWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(
      SchedulesDeliverChannelFillers,
      execution.input,
    );
    return yield* preserveDeclaredFailure(operations.loadChannelFillers(input));
  });

const executeChannelFillersRespondAction = (execution: typeof responseExecutionSchema.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(SchedulesDeliverChannelFillers, execution));
    const operations = yield* ScheduleWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(
      SchedulesDeliverChannelFillers,
      execution.input,
    );
    return yield* preserveDeclaredFailure(
      operations.respondChannelFillers(
        input,
        execution.message,
        makeScheduleDeliveryKey(SchedulesDeliverChannelFillers, execution.invocationId, "respond"),
        SchedulesDeliverChannelFillers.authorizationPolicy.policy,
      ),
    );
  });

const SchedulesDeliverChannelFillersLoadAction = makeAction({
  name: `${actionName}.load-channel-fillers`,
  version: scheduleSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: executionSchema,
  success: UserScheduleView,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeChannelFillersLoadAction,
});

const SchedulesDeliverChannelFillersRespondAction = makeAction({
  name: `${actionName}.respond`,
  version: scheduleSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: responseExecutionSchema,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeChannelFillersRespondAction,
});

const SchedulesDeliverChannelFillersWorkflow = Workflow.make({
  name,
  payload: executionSchema,
  success: SchedulesDeliverChannelFillers.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const makeChannelFillersWorkflowBody = <E, R>(
  actions: ScheduleWorkflowActions<
    typeof executionSchema.Type,
    typeof responseExecutionSchema.Type,
    E,
    R
  >,
) =>
  Effect.fnUntraced(function* (execution: typeof executionSchema.Type) {
    const input = yield* decodeWorkflowContractInputOrDie(
      SchedulesDeliverChannelFillers,
      execution.input,
    );
    const view = yield* actions.load(execution);
    const fillers = selectUniqueChannelFillers(view, input);
    const message = makeChannelFillersMessage(input, fillers);
    const receipt = yield* actions.respond({ ...execution, message });
    return {
      workspaceId: input.workspaceId,
      conversationName: input.conversationName,
      startHour: input.startHour,
      finishHour: input.finishHour,
      fillerCount: fillers.length,
      deliveryReceipts: [receipt],
    };
  });

export const makeChannelFillersDefinition = () => ({
  contract: SchedulesDeliverChannelFillers,
  workflow: SchedulesDeliverChannelFillersWorkflow,
  actions: [SchedulesDeliverChannelFillersLoadAction, SchedulesDeliverChannelFillersRespondAction],
  workflowLayer: SchedulesDeliverChannelFillersWorkflow.toLayer(
    makeChannelFillersWorkflowBody({
      load: (execution) => SchedulesDeliverChannelFillersLoadAction.await(execution),
      respond: (execution) => SchedulesDeliverChannelFillersRespondAction.await(execution),
    }),
  ),
});
