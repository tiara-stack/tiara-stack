import { Cause, DateTime, Effect, Exit, Layer, Option, Predicate, Random } from "effect";
import {
  BotOutboundMessage,
  type BotText,
  type BotTextPart,
  type ConversationRef,
  type DeliveryKey,
  type MessageRef,
  type SendMessageReceipt,
  conversationRefFrom,
  workspaceRefFrom,
} from "sheet-bot-api";
import { shouldSendTentativeRoomOrder } from "sheet-bot-api/actions";
import { makeMonitorCheckinMessage } from "sheet-message-content/checkinSummary";
import { buildRoomOrderContent } from "sheet-message-content/roomOrderContent";
import { tentativeRoomOrderContent } from "sheet-message-content/roomOrderMessage";
import {
  autoCheckinTestHour,
  autoCheckinTestNotice,
  boundEmbedDescription,
  conversationMentionValue,
  fillParticipantFromName,
  hourWindowFor,
  makeAutoCheckinTestEmbed,
  truncateAutoCheckinTestFailureDetail,
} from "sheet-message-content/rendering";
import * as MessageText from "sheet-message-content/text";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import {
  CheckinsTestAuto,
  type CheckinsTestAutoConversationResult,
} from "sheet-workflow-contracts";
import { config } from "@/config";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { calculateRoomOrderEntries } from "../roomOrders/createCalculation";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";
import {
  interactiveAuthorizationRevoked,
  interactiveBusinessRuleRejected,
  interactiveConfigurationMissing,
  interactiveDeliveryRejected,
  interactiveExternalOperationRejected,
  interactiveInvalidRequest,
  interactiveResourceNotFound,
  isInteractiveDeclaredFailure,
  mapBotCacheFailure,
  mapDeliveryFailure,
  requireInteractiveDiscordAccountId,
} from "../shared/interactive";
import { providerCauseKind } from "../shared/providerFailure";
import { autoCheckinTestActionIdentities, makeAutoCheckinTestDeliveryKey } from "./autoTestKeys";
import {
  AutoCheckinTestProvider,
  AutoCheckinTestProviderError,
  type AutoCheckinTestProviderParticipant,
} from "./autoTestProvider";
import type {
  AutoCheckinTestPreparation,
  AutoCheckinTestPreview,
  AutoCheckinTestPreviewDeliveryOutcome,
} from "./autoTestSchema";
import {
  AutoCheckinTestWorkflowOperations,
  AutoCheckinTestWorkflowOperationsError,
} from "./autoTestService";

const maximumAutoCheckinTestTargets = 500;
const operationPrefix = CheckinsTestAuto.identity;

const operationError = (operation: string, cause: unknown) =>
  new AutoCheckinTestWorkflowOperationsError({ operation, cause });

// The bot boundary uses the same strict structural binding checks across operation modules.
// fallow-ignore-next-line code-duplication
const sameConversationRef = (left: ConversationRef, right: ConversationRef): boolean =>
  left.workspace.client.platform === right.workspace.client.platform &&
  left.workspace.client.clientId === right.workspace.client.clientId &&
  left.workspace.workspaceId === right.workspace.workspaceId &&
  left.conversationId === right.conversationId;

const sameMessageRef = (left: MessageRef, right: MessageRef): boolean =>
  left.messageId === right.messageId && sameConversationRef(left.conversation, right.conversation);

const providerRejected = (error: AutoCheckinTestProviderError) =>
  Effect.logWarning("The Sheets provider rejected an auto-checkin test read").pipe(
    Effect.annotateLogs({
      providerOperation: error.operation,
      providerCauseKind: providerCauseKind(error.cause),
    }),
    Effect.andThen(
      Effect.fail(
        error.operation === "read-configuration"
          ? interactiveConfigurationMissing("workspace.sheetConfiguration")
          : interactiveExternalOperationRejected(
              `${operationPrefix}.prepare-target`,
              "ProviderRejected",
              "The Sheets provider rejected the auto-checkin test read",
            ),
      ),
    ),
  );

type Participant = {
  readonly key: string;
  readonly name: string;
  readonly userId?: string;
};

const toParticipant = ({ accountId, name }: AutoCheckinTestProviderParticipant): Participant =>
  Predicate.isString(accountId)
    ? { key: `player:${accountId}`, name, userId: accountId }
    : { key: `name:${name}`, name };

const dedupeParticipants = (participants: ReadonlyArray<Participant>) => {
  const seen = new Set<string>();
  return participants.filter(({ key }) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Keep the legacy check-in movement semantics byte-for-byte aligned with the provider boundary.
// fallow-ignore-next-line code-duplication
const diffParticipants = (
  previousParticipants: ReadonlyArray<Participant>,
  currentParticipants: ReadonlyArray<Participant>,
) => {
  // fallow-ignore-next-line code-duplication
  const previous = dedupeParticipants(previousParticipants);
  const current = dedupeParticipants(currentParticipants);
  const previousKeys = new Set(previous.map(({ key }) => key));
  const currentKeys = new Set(current.map(({ key }) => key));
  return {
    out: previous.filter(({ key }) => !currentKeys.has(key)),
    stay: current.filter(({ key }) => previousKeys.has(key)),
    in: current.filter(({ key }) => !previousKeys.has(key)),
  };
};

type Weighted<A> = { readonly value: A; readonly weight: number };

const checkinMessageTemplates: readonly Weighted<string>[] = [
  {
    value:
      "{{mentionsString}} Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.5,
  },
  {
    value:
      "{{mentionsString}} The goddess Miku is calling for you to fill. Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.2,
  },
  {
    value:
      "{{mentionsString}} Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}. ... Beep Boop. Beep Boop. zzzt... zzzt... zzzt...",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}.\n~~or VBS Miku will recruit you for some taste testing of her cooking.~~",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} Ebi jail AAAAAAAAAAAAAAAAAAAAAAA. Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} Miku's voice echoes in the empty SEKAI. Press the button below to check in, then {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} The clock hits 25:00. Miku whispers from the empty SEKAI. Press the button below to check in, then {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} It is ebi jail time! Check in now and {{conversationString}} {{hourString}} {{timeStampString}}.\n-# Perhaps you would encounter Miku on a purple background next time you roll if you fast CI? wink wink~",
    weight: 0.05,
  },
];

const pickCheckinTemplate = Effect.gen(function* () {
  const totalWeight = checkinMessageTemplates.reduce((total, item) => total + item.weight, 0);
  const random = yield* Random.nextBetween(0, totalWeight);
  let accumulatedWeight = 0;
  for (const item of checkinMessageTemplates) {
    accumulatedWeight += item.weight;
    if (random < accumulatedWeight) return item.value;
  }
  return checkinMessageTemplates[checkinMessageTemplates.length - 1]!.value;
});

const renderStaticTemplateSegment = (value: string) =>
  value
    .split("~~")
    .flatMap((segment, index) =>
      segment.length === 0
        ? []
        : index % 2 === 0
          ? [MessageText.text(segment)]
          : [{ type: "strikethrough" as const, parts: [MessageText.text(segment)] }],
    );

const renderTemplate = (
  template: string,
  context: Readonly<Record<string, ReadonlyArray<BotTextPart>>>,
) => {
  const result: Array<BotTextPart> = [];
  const pattern = /\{\{\{?(\w+)\}?\}\}/gu;
  let lastIndex = 0;
  for (const match of template.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex)
      result.push(...renderStaticTemplateSegment(template.slice(lastIndex, index)));
    result.push(...(context[match[1] ?? ""] ?? renderStaticTemplateSegment(match[0])));
    lastIndex = index + match[0].length;
  }
  if (lastIndex < template.length)
    result.push(...renderStaticTemplateSegment(template.slice(lastIndex)));
  return result;
};

const renderParticipantMentions = (participants: ReadonlyArray<Participant>) =>
  participants.flatMap((participant, index) =>
    MessageText.parts(
      index === 0 ? undefined : MessageText.text(" "),
      Predicate.isString(participant.userId)
        ? MessageText.userMention(participant.userId)
        : MessageText.text(participant.name),
    ),
  );

const makeAnchorPayload = (
  description: BotText,
  fields: ReadonlyArray<{
    readonly name: BotText;
    readonly value: BotText;
    readonly inline?: boolean;
  }> = [],
): typeof BotOutboundMessage.Type => ({
  content: null,
  embeds: [
    makeAutoCheckinTestEmbed({
      title: "TEST RUN: Auto check-in configuration",
      description,
      fields,
    }),
  ],
  allowedMentions: "none",
});

const previewFields = (options: {
  readonly client: { readonly platform: "discord"; readonly clientId: string };
  readonly workspaceId: string;
  readonly conversationName: string;
  readonly runningConversationId: string;
  readonly checkinConversationId?: string;
  readonly monitorConversationId?: string;
  readonly hour: number;
}) => [
  {
    name: [MessageText.clientTerm("conversation", { casing: "sentence" })],
    value: options.conversationName,
    inline: true,
  },
  {
    name: [MessageText.clientTerm("runDestination", { casing: "sentence" })],
    value: conversationMentionValue(
      options.client,
      options.workspaceId,
      options.runningConversationId,
    ),
    inline: true,
  },
  ...(Predicate.isString(options.checkinConversationId)
    ? [
        {
          name: [MessageText.clientTerm("checkinDestination", { casing: "sentence" })],
          value: conversationMentionValue(
            options.client,
            options.workspaceId,
            options.checkinConversationId,
          ),
          inline: true,
        },
      ]
    : []),
  ...(Predicate.isString(options.monitorConversationId)
    ? [
        {
          name: "Monitor destination",
          value: conversationMentionValue(
            options.client,
            options.workspaceId,
            options.monitorConversationId,
          ),
          inline: true,
        },
      ]
    : []),
  { name: "Hour", value: globalThis.String(options.hour), inline: true },
];

const previewMessage = (
  anchor: MessageRef,
  embed: Parameters<typeof makeAutoCheckinTestEmbed>[0],
): typeof BotOutboundMessage.Type => ({
  content: null,
  embeds: [
    makeAutoCheckinTestEmbed({
      ...embed,
      fields: [
        ...(embed.fields ?? []),
        {
          name: [MessageText.clientTerm("testRun", { casing: "sentence" })],
          value: [MessageText.messageLink(anchor, "message")],
        },
      ],
    }),
  ],
  allowedMentions: "none",
});

export const makeAutoCheckinTestSummaryMessage = (
  conversations: ReadonlyArray<CheckinsTestAutoConversationResult>,
) => {
  const sentCount = conversations.filter(({ status }) => status === "sent").length;
  const skippedCount = conversations.filter(({ status }) => status === "skipped").length;
  const failures = conversations.filter(({ status }) => status === "failed");
  const firstFailure = failures[0];
  const summary = boundEmbedDescription(
    [
      `Tested hour ${autoCheckinTestHour} across ${conversations.length} configured running conversation(s).`,
      `Sent: ${sentCount}. Skipped: ${skippedCount}. Failed: ${failures.length}.`,
      failures.length > 0
        ? `Failed conversations: ${failures.map(({ conversationName }) => conversationName).join(", ")}`
        : "No conversation failures.",
      ...(Predicate.isUndefined(firstFailure)
        ? []
        : [
            [
              `First failure detail for ${firstFailure.conversationName}:`,
              truncateAutoCheckinTestFailureDetail(firstFailure.error ?? "Unknown error"),
            ].join("\n"),
          ]),
    ].join("\n"),
    "\n… Summary truncated to fit Discord limits.",
  );
  return {
    message: makeAnchorPayload(summary, [
      { name: "Hour", value: globalThis.String(autoCheckinTestHour), inline: true },
      { name: "Conversations", value: globalThis.String(conversations.length), inline: true },
      { name: "Failed", value: globalThis.String(failures.length), inline: true },
    ]),
    sentCount,
    skippedCount,
    failedCount: failures.length,
  };
};

const validateMessageReceipt = (
  receipt: SendMessageReceipt,
  deliveryKey: typeof DeliveryKey.Type,
  conversation: ConversationRef,
  operation: string,
) =>
  receipt.deliveryKey === deliveryKey &&
  receipt.operation === "sendMessage" &&
  sameConversationRef(receipt.target.message.conversation, conversation)
    ? Effect.succeed(receipt)
    : Effect.fail(
        interactiveDeliveryRejected(
          operation,
          "The preview receipt did not match the requested delivery",
          true,
          receipt.target.message.messageId,
        ),
      );

const unknownPreviewDelivery = (
  operation: string,
  cause: Cause.Cause<unknown>,
): Effect.Effect<AutoCheckinTestPreviewDeliveryOutcome> => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  const failure = isInteractiveDeclaredFailure(error)
    ? error
    : interactiveDeliveryRejected(
        operation,
        "The auto-checkin preview delivery outcome is unknown",
        true,
      );
  return Effect.logWarning("The auto-checkin preview delivery outcome is ambiguous", cause).pipe(
    Effect.annotateLogs({ operation }),
    Effect.as({ _tag: "Unknown" as const, failure }),
  );
};

// This layer deliberately assembles the complete authorization, preparation, and delivery boundary.
// fallow-ignore-next-line complexity
export const autoCheckinTestWorkflowOperationsLayer = Layer.effect(
  AutoCheckinTestWorkflowOperations,
  // fallow-ignore-next-line complexity
  Effect.gen(function* () {
    const authorization = yield* ReadOnlyWorkflowAuthorization;
    const cache = yield* SheetBotCacheClient;
    const delivery = yield* SheetBotDeliveryClient;
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* AutoCheckinTestProvider;
    const clientId = yield* config.sheetBotClientId;
    const concurrency = yield* config.autoCheckinConcurrency;
    const client = { platform: "discord" as const, clientId };
    const policy = CheckinsTestAuto.authorizationPolicy.policy;

    const reauthorize = (
      execution: {
        readonly principal: Parameters<typeof authorization.authorize>[1];
        readonly input: unknown;
      },
      operation: string,
    ) =>
      authorization
        .authorize(CheckinsTestAuto, execution.principal, execution.input)
        .pipe(
          Effect.mapError((error) =>
            Predicate.isTagged("WorkflowInvocationUnauthorized")(error)
              ? interactiveAuthorizationRevoked(policy)
              : operationError(`${operation}.authorize`, error),
          ),
        );

    const createAnchor: AutoCheckinTestWorkflowOperations["Service"]["createAnchor"] = (
      execution,
      deliveryKey,
    ) =>
      // Anchor creation keeps validation and best-effort invalid-receipt cleanup in one boundary.
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const input = yield* decodeWorkflowContractInputOrDie(CheckinsTestAuto, execution.input);
        const requesterAccountId = yield* requireInteractiveDiscordAccountId(
          execution.principal,
          policy,
        );
        const workspace = yield* cache
          .get()
          .cache.getWorkspace({ params: { ...client, workspaceId: input.workspaceId } })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(
              mapBotCacheFailure(
                policy,
                "workspace",
                `${operationPrefix}.create-provisional-anchor.load-workspace`,
                operationError,
              ),
            ),
          );
        if (workspace.id !== input.workspaceId) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "NonCanonicalAutoCheckinWorkspace",
              "The bot cache returned a non-canonical workspace",
            ),
          );
        }
        const message = makeAnchorPayload(
          MessageText.lines(
            [
              MessageText.text("Testing first-hour auto check-in for "),
              MessageText.text(workspace.name),
              MessageText.text("."),
            ],
            [
              MessageText.text("Requested by "),
              MessageText.userMention(requesterAccountId),
              MessageText.text("."),
            ],
            [MessageText.text(autoCheckinTestNotice)],
          ),
        );
        yield* reauthorize(execution, `${operationPrefix}.create-provisional-anchor`);
        const receipt = yield* delivery
          .get()
          .delivery.respond({
            payload: {
              responseReference: input.responseReference,
              workspace: workspaceRefFrom(client, input.workspaceId),
              deliveryKey,
              message,
            },
          })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(
              mapDeliveryFailure(
                policy,
                `${operationPrefix}.create-provisional-anchor`,
                "response",
                false,
                "The auto-checkin test response was rejected",
                operationError,
              ),
            ),
          );
        const anchor = receipt.target.message;
        const expectedConversation = conversationRefFrom(
          client,
          input.workspaceId,
          input.anchorConversationId,
        );
        const valid =
          receipt.deliveryKey === deliveryKey &&
          receipt.operation === "respond" &&
          receipt.target.responseReference === input.responseReference &&
          Predicate.isNotUndefined(anchor) &&
          sameConversationRef(anchor.conversation, expectedConversation);
        if (valid) return receipt;

        const cleanupKey = makeAutoCheckinTestDeliveryKey(
          execution.invocationId,
          autoCheckinTestActionIdentities.cleanupAnchor,
        );
        const cleanup = Predicate.isUndefined(anchor)
          ? Exit.succeed(undefined)
          : yield* reauthorize(execution, `${operationPrefix}.cleanup-invalid-anchor`).pipe(
              Effect.andThen(
                delivery.get().delivery.deleteMessage({
                  payload: { message: anchor, deliveryKey: cleanupKey },
                }),
              ),
              Effect.flatMap((receipt) =>
                receipt.deliveryKey === cleanupKey &&
                receipt.operation === "deleteMessage" &&
                sameMessageRef(receipt.target.message, anchor)
                  ? Effect.succeed(receipt)
                  : Effect.fail(
                      interactiveDeliveryRejected(
                        `${operationPrefix}.cleanup-invalid-anchor`,
                        "The cleanup receipt did not match the invalid provisional anchor",
                        true,
                        anchor.messageId,
                      ),
                    ),
              ),
              Effect.timeout("30 seconds"),
              Effect.exit,
            );
        return yield* Effect.fail(
          interactiveDeliveryRejected(
            `${operationPrefix}.create-provisional-anchor`,
            "The response receipt did not match the authorized anchor context",
            Exit.isFailure(cleanup),
            Exit.isFailure(cleanup) ? anchor?.messageId : undefined,
          ),
        );
      });

    const discoverTargets: AutoCheckinTestWorkflowOperations["Service"]["discoverTargets"] = (
      execution,
    ) =>
      Effect.gen(function* () {
        const input = yield* decodeWorkflowContractInputOrDie(CheckinsTestAuto, execution.input);
        yield* reauthorize(execution, `${operationPrefix}.discover-targets`);
        const conversations = yield* persistence.workspaces
          .getWorkspaceConversations({ workspaceId: input.workspaceId, running: true })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) =>
              operationError(`${operationPrefix}.discover-targets`, cause),
            ),
          );
        const seen = new Set<string>();
        const conversationNames: Array<string> = [];
        for (const conversation of conversations) {
          if (
            conversation.workspaceId !== input.workspaceId ||
            conversation.running !== true ||
            Predicate.isNotNull(conversation.deletedAt)
          ) {
            return yield* Effect.fail(
              interactiveInvalidRequest(
                "NonCanonicalRunningConversation",
                "Trusted persistence returned a non-canonical running conversation",
              ),
            );
          }
          if (
            Predicate.isString(conversation.name) &&
            conversation.name.length > 0 &&
            !seen.has(conversation.name)
          ) {
            seen.add(conversation.name);
            conversationNames.push(conversation.name);
          }
        }
        if (conversationNames.length > maximumAutoCheckinTestTargets) {
          return yield* Effect.fail(
            interactiveBusinessRuleRejected(
              "TooManyAutoCheckinTestTargets",
              `The auto-checkin test supports at most ${maximumAutoCheckinTestTargets} configured conversations`,
            ),
          );
        }
        return { conversationNames, concurrency };
      });

    const prepareTarget: AutoCheckinTestWorkflowOperations["Service"]["prepareTarget"] = (
      execution,
    ) =>
      // Preparation preserves the legacy hour-one check-in and room-order rendering algorithm.
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const input = yield* decodeWorkflowContractInputOrDie(CheckinsTestAuto, execution.input);
        yield* reauthorize(execution, `${operationPrefix}.prepare-target`);
        const { conversation, workspace } = yield* Effect.all(
          {
            workspace: persistence.workspaces.getWorkspaceConfigByWorkspaceId({
              workspaceId: input.workspaceId,
            }),
            conversation: persistence.workspaces.getWorkspaceConversationByName({
              workspaceId: input.workspaceId,
              conversationName: execution.conversationName,
              running: true,
            }),
          },
          { concurrency: "unbounded" },
        ).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) =>
            operationError(`${operationPrefix}.prepare-target.resolve`, cause),
          ),
          Effect.flatMap(({ conversation, workspace }) =>
            Option.all({ conversation, workspace }).pipe(
              Option.match({
                onNone: () =>
                  Effect.fail(interactiveResourceNotFound("auto-checkin configuration")),
                onSome: Effect.succeed,
              }),
            ),
          ),
        );
        if (
          workspace.workspaceId !== input.workspaceId ||
          Predicate.isNotNull(workspace.deletedAt) ||
          conversation.workspaceId !== input.workspaceId ||
          conversation.name !== execution.conversationName ||
          conversation.running !== true ||
          Predicate.isNotNull(conversation.deletedAt)
        ) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "NonCanonicalAutoCheckinConfiguration",
              "Trusted persistence returned non-canonical auto-checkin configuration",
            ),
          );
        }
        if (Predicate.isNull(workspace.sheetId)) {
          return yield* Effect.fail(interactiveConfigurationMissing("workspace.sheetId"));
        }
        const spreadsheetId = workspace.sheetId;
        const view = yield* provider
          .loadCheckin(spreadsheetId, execution.conversationName)
          .pipe(Effect.catchTag("AutoCheckinTestProviderError", providerRejected));
        if (view.schedules.length === 0) {
          return yield* Effect.fail(
            interactiveConfigurationMissing("workspace.sheetScheduleConfiguration"),
          );
        }
        const schedulesByHour = new Map(
          view.schedules.flatMap((schedule) =>
            Predicate.isNull(schedule.hour) ? [] : ([[schedule.hour, schedule]] as const),
          ),
        );
        const previous = schedulesByHour.get(autoCheckinTestHour - 1);
        const current = schedulesByHour.get(autoCheckinTestHour);
        const previousParticipants = (previous?.fills ?? []).map(toParticipant);
        const participants = (current?.fills ?? []).map(toParticipant);
        const movement = diffParticipants(previousParticipants, participants);
        const incoming = movement.in;
        const template = yield* pickCheckinTemplate;
        const conversationText = Predicate.isString(conversation.roleId)
          ? MessageText.parts(MessageText.text(`head to ${execution.conversationName}`))
          : MessageText.parts(
              MessageText.text("head to "),
              MessageText.conversationMention(
                conversationRefFrom(client, input.workspaceId, conversation.conversationId),
              ),
            );
        const hourWindow = hourWindowFor(
          { startTime: DateTime.makeUnsafe(view.eventStartEpochMs) },
          autoCheckinTestHour,
        );
        const initialMessage =
          incoming.length === 0
            ? null
            : renderTemplate(template, {
                mentionsString: renderParticipantMentions(incoming),
                conversationString: conversationText,
                hourString: MessageText.parts(
                  MessageText.text("for "),
                  MessageText.strong([MessageText.text(`hour ${autoCheckinTestHour}`)]),
                ),
                timeStampString: MessageText.parts(
                  MessageText.timestamp(DateTime.toEpochMillis(hourWindow.start), "relative"),
                ),
              });
        const lookupFailures = (current?.fills ?? []).flatMap(({ accountId, name }) =>
          Predicate.isNull(accountId) ? [name] : [],
        );
        const lookupFailureMessage =
          lookupFailures.length === 0
            ? Option.none<string>()
            : Option.some(
                `Cannot look up ID for ${lookupFailures.join(", ")}. They would need to check in manually.`,
              );
        const monitorCheckinMessage = makeMonitorCheckinMessage({
          initialMessage,
          empty: Math.max(5 - (current?.fills.length ?? 0) - (current?.overfillCount ?? 0), 0),
          out: movement.out,
          stay: movement.stay,
          in: movement.in,
          lookupFailedMessage: lookupFailureMessage,
        });
        const monitorUserId = current?.monitor?.accountId ?? null;
        const previousMonitorUserId = previous?.monitor?.accountId ?? null;
        const monitorFailureMessage = Predicate.isUndefined(current)
          ? null
          : Predicate.isNull(current.monitor)
            ? [MessageText.text("Cannot ping monitor: monitor not assigned for this hour.")]
            : Predicate.isNull(current.monitor.accountId)
              ? [
                  MessageText.text(
                    `Cannot ping monitor: monitor "${current.monitor.name}" is missing an ID in the sheet.`,
                  ),
                ]
              : null;
        const monitorSummary = MessageText.lines(
          monitorCheckinMessage,
          ...(Predicate.isString(monitorUserId)
            ? [
                MessageText.parts(
                  MessageText.userMention(monitorUserId),
                  MessageText.text(
                    monitorUserId !== previousMonitorUserId
                      ? " would be asked to check in."
                      : " would continue from the previous hour without a new check-in.",
                  ),
                ),
              ]
            : []),
          ...(Predicate.isNull(monitorFailureMessage)
            ? []
            : [MessageText.parts(MessageText.subtle(monitorFailureMessage))]),
        );
        const runningConversationId = conversation.conversationId;
        const checkinConversationId = conversation.checkinConversationId ?? runningConversationId;
        const monitorConversationId = workspace.monitorConversationId ?? runningConversationId;
        const fields = {
          client,
          workspaceId: input.workspaceId,
          conversationName: execution.conversationName,
          runningConversationId,
          hour: autoCheckinTestHour,
        };
        if (Predicate.isNull(initialMessage)) {
          return {
            conversationName: execution.conversationName,
            runningConversationId,
            checkinConversationId,
            hour: autoCheckinTestHour,
            status: "skipped" as const,
            checkinPreview: null,
            monitorPreview: {
              conversation: conversationRefFrom(client, input.workspaceId, monitorConversationId),
              message: previewMessage(execution.anchor, {
                title: "TEST RUN: Check-in skipped",
                description: monitorSummary,
                fields: previewFields({ ...fields, monitorConversationId }),
              }),
            },
            tentativeRoomOrderPreview: null,
            error: Predicate.isNull(monitorFailureMessage)
              ? null
              : MessageText.renderPlainText(monitorFailureMessage),
          } satisfies AutoCheckinTestPreparation;
        }
        const tentativeRoomOrderPreview = shouldSendTentativeRoomOrder(current?.fills.length ?? 0)
          ? yield* Effect.gen(function* () {
              const roomView = yield* provider
                .loadRoomOrder(spreadsheetId, execution.conversationName)
                .pipe(Effect.catchTag("AutoCheckinTestProviderError", providerRejected));
              const roomSchedulesByHour = new Map(
                roomView.schedules.flatMap((schedule) =>
                  Predicate.isNull(schedule.hour) ? [] : ([[schedule.hour, schedule]] as const),
                ),
              );
              const roomPrevious = roomSchedulesByHour.get(autoCheckinTestHour - 1);
              const roomCurrent = roomSchedulesByHour.get(autoCheckinTestHour);
              const fills = roomCurrent?.fills ?? [];
              const entries = yield* calculateRoomOrderEntries({
                teamsByPlayer: fills.map((fill) =>
                  Predicate.isNull(fill.accountId)
                    ? []
                    : (roomView.teamsByPlayerName.get(fill.name) ?? []).map((team) => ({
                        ...team,
                        encable: fill.enc,
                        tierer: team.tags.includes("tierer_hint"),
                      })),
                ),
                healNeeded: 0,
                hour: autoCheckinTestHour,
              });
              if (entries.length === 0) {
                return null;
              }
              const content = buildRoomOrderContent(
                autoCheckinTestHour,
                hourWindow.start,
                hourWindow.end,
                roomCurrent?.monitor ?? null,
                (roomPrevious?.fills ?? []).map(({ name }) => fillParticipantFromName(name)),
                fills.map(({ name }) => fillParticipantFromName(name)),
                entries.filter(({ rank }) => rank === 0),
              );
              return {
                conversation: conversationRefFrom(client, input.workspaceId, runningConversationId),
                message: previewMessage(execution.anchor, {
                  title: "TEST RUN: Tentative room order",
                  description: tentativeRoomOrderContent(content),
                  fields: previewFields(fields),
                }),
              } satisfies AutoCheckinTestPreview;
            })
          : null;
        return {
          conversationName: execution.conversationName,
          runningConversationId,
          checkinConversationId,
          hour: autoCheckinTestHour,
          status: "sent" as const,
          checkinPreview: {
            conversation: conversationRefFrom(client, input.workspaceId, checkinConversationId),
            message: previewMessage(execution.anchor, {
              title: "TEST RUN: Check-in message",
              description: initialMessage,
              fields: previewFields({ ...fields, checkinConversationId }),
            }),
          },
          monitorPreview: {
            conversation: conversationRefFrom(client, input.workspaceId, monitorConversationId),
            message: previewMessage(execution.anchor, {
              title: "TEST RUN: Monitor auto check-in summary",
              description: monitorSummary,
              fields: previewFields({ ...fields, monitorConversationId }),
            }),
          },
          tentativeRoomOrderPreview,
          error: null,
        } satisfies AutoCheckinTestPreparation;
      });

    const deliverPreview = (
      execution: Parameters<
        AutoCheckinTestWorkflowOperations["Service"]["deliverMonitorPreview"]
      >[0],
      preview: AutoCheckinTestPreview,
      deliveryKey: typeof DeliveryKey.Type,
      operation: string,
    ) =>
      Effect.gen(function* () {
        yield* reauthorize(execution, operation);
        const deliveryExit = yield* delivery
          .get()
          .delivery.sendMessage({
            payload: {
              conversation: preview.conversation,
              deliveryKey,
              message: preview.message,
            },
          })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(
              mapDeliveryFailure(
                policy,
                operation,
                "preview conversation",
                true,
                "The auto-checkin preview delivery was rejected",
                operationError,
              ),
            ),
            Effect.flatMap((receipt) =>
              validateMessageReceipt(receipt, deliveryKey, preview.conversation, operation),
            ),
            Effect.exit,
          );
        if (Exit.isSuccess(deliveryExit)) {
          return { _tag: "Committed", receipt: deliveryExit.value } as const;
        }
        if (Cause.hasInterruptsOnly(deliveryExit.cause)) {
          return yield* Effect.failCause(deliveryExit.cause);
        }
        return yield* unknownPreviewDelivery(operation, deliveryExit.cause);
      });

    const requirePreview = (
      preview: AutoCheckinTestPreview | null,
      operation: string,
    ): Effect.Effect<AutoCheckinTestPreview, ReturnType<typeof interactiveInvalidRequest>> =>
      Predicate.isNull(preview)
        ? Effect.fail(
            interactiveInvalidRequest(
              "AutoCheckinPreviewNotPrepared",
              `The ${operation} preview was not prepared`,
            ),
          )
        : Effect.succeed(preview);

    const deliverCheckinPreview: AutoCheckinTestWorkflowOperations["Service"]["deliverCheckinPreview"] =
      (execution, deliveryKey) =>
        requirePreview(execution.preparation.checkinPreview, "check-in").pipe(
          Effect.flatMap((preview) =>
            deliverPreview(
              execution,
              preview,
              deliveryKey,
              `${operationPrefix}.deliver-checkin-preview`,
            ),
          ),
        );

    const deliverMonitorPreview: AutoCheckinTestWorkflowOperations["Service"]["deliverMonitorPreview"] =
      (execution, deliveryKey) =>
        deliverPreview(
          execution,
          execution.preparation.monitorPreview,
          deliveryKey,
          `${operationPrefix}.deliver-monitor-preview`,
        );

    const deliverTentativeRoomOrderPreview: AutoCheckinTestWorkflowOperations["Service"]["deliverTentativeRoomOrderPreview"] =
      (execution, deliveryKey) =>
        requirePreview(
          execution.preparation.tentativeRoomOrderPreview,
          "tentative room-order",
        ).pipe(
          Effect.flatMap((preview) =>
            deliverPreview(
              execution,
              preview,
              deliveryKey,
              `${operationPrefix}.deliver-tentative-room-order-preview`,
            ),
          ),
        );

    const updateAnchorSummary: AutoCheckinTestWorkflowOperations["Service"]["updateAnchorSummary"] =
      (execution, deliveryKey) =>
        Effect.gen(function* () {
          const { message } = makeAutoCheckinTestSummaryMessage(execution.conversations);
          const previewMayHaveCommitted =
            Predicate.hasProperty("previewMayHaveCommitted")(execution) &&
            Predicate.isBoolean(execution.previewMayHaveCommitted)
              ? execution.previewMayHaveCommitted
              : (execution.previewCommitted ?? false);
          yield* reauthorize(execution, `${operationPrefix}.update-anchor-summary`);
          const receipt = yield* delivery
            .get()
            .delivery.editMessage({
              payload: { message: execution.anchor, deliveryKey, content: message },
            })
            .pipe(
              Effect.timeout("30 seconds"),
              Effect.mapError(
                mapDeliveryFailure(
                  policy,
                  `${operationPrefix}.update-anchor-summary`,
                  "anchor response",
                  previewMayHaveCommitted,
                  "The auto-checkin test summary update was rejected",
                  operationError,
                  previewMayHaveCommitted ? execution.anchor.messageId : undefined,
                ),
              ),
            );
          return receipt.deliveryKey === deliveryKey &&
            receipt.operation === "editMessage" &&
            sameMessageRef(receipt.target.message, execution.anchor)
            ? receipt
            : yield* Effect.fail(
                interactiveDeliveryRejected(
                  `${operationPrefix}.update-anchor-summary`,
                  "The summary receipt did not match the provisional anchor",
                  previewMayHaveCommitted,
                  previewMayHaveCommitted ? execution.anchor.messageId : undefined,
                ),
              );
        });

    const cleanupAnchor: AutoCheckinTestWorkflowOperations["Service"]["cleanupAnchor"] = (
      execution,
      deliveryKey,
    ) =>
      Effect.gen(function* () {
        yield* reauthorize(execution, `${operationPrefix}.cleanup-provisional-anchor`);
        const receipt = yield* delivery
          .get()
          .delivery.deleteMessage({ payload: { message: execution.anchor, deliveryKey } })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(
              mapDeliveryFailure(
                policy,
                `${operationPrefix}.cleanup-provisional-anchor`,
                "anchor response",
                true,
                "The provisional auto-checkin test anchor could not be cleaned up",
                operationError,
                execution.anchor.messageId,
              ),
            ),
          );
        return receipt.deliveryKey === deliveryKey &&
          receipt.operation === "deleteMessage" &&
          sameMessageRef(receipt.target.message, execution.anchor)
          ? receipt
          : yield* Effect.fail(
              interactiveDeliveryRejected(
                `${operationPrefix}.cleanup-provisional-anchor`,
                "The cleanup receipt did not match the provisional anchor",
                true,
                execution.anchor.messageId,
              ),
            );
      });

    return {
      createAnchor,
      discoverTargets,
      prepareTarget,
      deliverCheckinPreview,
      deliverMonitorPreview,
      deliverTentativeRoomOrderPreview,
      updateAnchorSummary,
      cleanupAnchor,
    };
  }),
);
