import { Effect, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { BotOutboundMessage, RespondReceipt, type BotTextPart } from "sheet-bot-api";
import { escapeMarkdown, makeEmbed } from "sheet-message-content/rendering";
import * as MessageText from "sheet-message-content/text";
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

const renderFiller = (filler: ChannelFiller): ReadonlyArray<BotTextPart> =>
  Predicate.isNull(filler.accountId)
    ? [MessageText.text(escapeMarkdown(filler.name))]
    : [MessageText.userMention(filler.accountId)];

const fillerLineLength = (filler: ChannelFiller): number => {
  const renderedLength = MessageText.renderPlainText(renderFiller(filler)).length;
  return renderedLength + (Predicate.isString(filler.accountId) ? 2 : 0);
};

const maximumFillerFieldCharacters = 900;
const maximumFillerFields = 5;
type FillerField = {
  readonly name: string;
  readonly value: string | ReadonlyArray<BotTextPart>;
};

const fillerFieldValues = (fillers: ReadonlyArray<ChannelFiller>): ReadonlyArray<BotTextPart[]> => {
  const chunks: Array<BotTextPart[]> = [];
  let current: BotTextPart[] = [];
  let currentLength = 0;
  for (const filler of fillers) {
    const line = renderFiller(filler);
    const lineLength = fillerLineLength(filler);
    const separatorLength = current.length === 0 ? 0 : 1;
    if (
      current.length > 0 &&
      currentLength + separatorLength + lineLength > maximumFillerFieldCharacters
    ) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    const hadCurrent = current.length > 0;
    current.push(...(hadCurrent ? [MessageText.text("\n")] : []), ...line);
    currentLength += (hadCurrent ? separatorLength : 0) + lineLength;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

const csvFormulaTrigger = /^[=+\-@\t\r]/u;
const csvFormulaAfterWhitespace = /^\s*[=+\-@]/u;

const csvCell = (value: string): string => {
  const safeValue =
    csvFormulaTrigger.test(value) || csvFormulaAfterWhitespace.test(value) ? `'${value}` : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
};

const fillerCsv = (fillers: ReadonlyArray<ChannelFiller>): string =>
  [["account_id", "name"], ...fillers.map(({ accountId, name }) => [accountId ?? "", name])]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");

const makeFillerAttachment = (fillers: ReadonlyArray<ChannelFiller>) => ({
  name: "fillers.csv",
  contentType: "text/csv",
  content: new TextEncoder().encode(fillerCsv(fillers)),
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
    fillers.some((filler) => fillerLineLength(filler) > maximumFillerFieldCharacters);
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
    allowedMentions:
      attachment === undefined && fillers.some(({ accountId }) => Predicate.isString(accountId))
        ? "default"
        : "none",
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
