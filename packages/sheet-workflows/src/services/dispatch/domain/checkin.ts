import { Cause, Effect, Option, Predicate } from "effect";
import { shouldSendTentativeRoomOrder } from "sheet-ingress-api/clientActions";
import type { SheetOutboundMessage, SheetTextPart } from "sheet-ingress-api/schemas/client";
import type {
  AutoCheckinTestConversationResult,
  AutoCheckinTestDispatchPayload,
  AutoCheckinTestDispatchResult,
  CheckinDispatchPayload,
} from "sheet-ingress-api/sheet-apis-rpc";
import type { DispatchRequester } from "sheet-ingress-api/sheet-workflows-workflows";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { uniqueConversationNames } from "../../autoCheckinConversations";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import * as MessageText from "sheet-message-content/text";
import { tentativeRoomOrderContent } from "sheet-message-content/roomOrderMessage";
import { logNonInterruptFailure, makeMessageSink } from "../clients/messageDelivery";
import { makeSheetApisServices } from "../clients/sheetApis";
import { makeDeliveryNonce } from "../pure/deliveryNonce";
import { recoverNonInterruptCause } from "../pure/failure";
import {
  autoCheckinTestHour,
  autoCheckinTestNotice,
  boundEmbedDescription,
  conversationMentionValue,
  makeAutoCheckinTestEmbed,
  truncateAutoCheckinTestFailureDetail,
} from "sheet-message-content/rendering";
import {
  deliverCheckin,
  finalizeCheckinPrimaryMessage,
  makeCheckinDispatchResult,
} from "./checkinDelivery";

type MessagePayload = SheetOutboundMessage;
type MessageEmbed = NonNullable<NonNullable<MessagePayload["embeds"]>[number]>;
type MessageTextInput = string | ReadonlyArray<SheetTextPart>;
type SheetApisServices = ReturnType<typeof makeSheetApisServices>;

export const makeCheckinOperations = ({
  autoCheckinConcurrency,
  botClient,
  checkinService,
  messageCheckinService,
  messageRoomOrderService,
  roomOrderService,
  userConfigService,
  workspaceConfigService,
}: {
  readonly autoCheckinConcurrency: number;
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly checkinService: SheetApisServices["checkinService"];
  readonly messageCheckinService: SheetApisServices["messageCheckinService"];
  readonly messageRoomOrderService: SheetApisServices["messageRoomOrderService"];
  readonly roomOrderService: SheetApisServices["roomOrderService"];
  readonly userConfigService: SheetApisServices["userConfigService"];
  readonly workspaceConfigService: SheetApisServices["workspaceConfigService"];
}) => ({
  autoCheckinTest: Effect.fn("DispatchService.autoCheckinTest")(function* (
    payload: AutoCheckinTestDispatchPayload,
    requester: DispatchRequester,
  ) {
    yield* Effect.annotateCurrentSpan({
      workspaceId: payload.workspaceId,
      anchorConversationId: payload.anchorConversationId,
      hour: autoCheckinTestHour,
      "requester.accountId": requester.accountId,
      "requester.userId": requester.userId,
      autoCheckinConcurrency,
    });
    const makeAnchorPayload = (
      description: MessageTextInput,
      fields: ReadonlyArray<{
        readonly name: MessageTextInput;
        readonly value: MessageTextInput;
        readonly inline?: boolean;
      }> = [],
    ) =>
      ({
        content: null,
        embeds: [
          makeAutoCheckinTestEmbed({
            title: "TEST RUN: Auto check-in configuration",
            description,
            fields,
          }),
        ],
        allowedMentions: "none",
      }) satisfies MessagePayload;

    const anchorSink = makeMessageSink(
      botClient,
      payload.anchorConversationId,
      payload.interactionResponseToken,
    );
    const withTestDeliveryNonce = (
      conversationId: string,
      messageKind: string,
      messagePayload: MessagePayload,
    ): MessagePayload => ({
      ...messagePayload,
      nonce: makeDeliveryNonce(`${payload.dispatchRequestId}:${conversationId}:${messageKind}`),
      enforceNonce: true,
    });

    const anchorMessage = yield* anchorSink.sendPrimary(
      withTestDeliveryNonce(
        payload.anchorConversationId,
        "anchor",
        makeAnchorPayload(
          MessageText.lines(
            [
              MessageText.text("Testing first-hour auto check-in for "),
              MessageText.clientTerm("workspace"),
              MessageText.text(` ${payload.workspaceId}.`),
            ],
            [
              MessageText.text("Requested by "),
              MessageText.userMention(requester.accountId),
              MessageText.text("."),
            ],
            [MessageText.text(autoCheckinTestNotice)],
          ),
        ),
      ),
    );
    const updateAnchor = (messagePayload: MessagePayload) =>
      anchorSink.updatePrimary(anchorMessage, messagePayload);
    const anchorMessageLink = [
      MessageText.messageLink(
        {
          conversation: {
            workspace: {
              client: payload.client,
              workspaceId: payload.workspaceId,
            },
            conversationId: anchorMessage.conversation_id,
          },
          messageId: anchorMessage.id,
        },
        "message",
      ),
    ];
    const withAnchorField = (embed: MessageEmbed): MessageEmbed => {
      const fields = embed.fields ?? [];

      return {
        ...embed,
        fields: [
          ...fields,
          {
            name: [MessageText.clientTerm("testRun", { casing: "sentence" })],
            value: anchorMessageLink,
          },
        ],
      };
    };
    const referencedMessagePayload = (embed: MessageEmbed) =>
      ({
        content: null,
        embeds: [withAnchorField(embed)],
        allowedMentions: "none",
      }) satisfies MessagePayload;
    const sendTestPreview = (
      conversationId: string,
      messageKind: string,
      embed: Parameters<typeof makeAutoCheckinTestEmbed>[0],
    ) =>
      botClient.sendMessage(
        conversationId,
        withTestDeliveryNonce(
          conversationId,
          messageKind,
          referencedMessagePayload(makeAutoCheckinTestEmbed(embed)),
        ),
      );
    const autoCheckinTestFields = ({
      conversationName,
      runningConversationId,
      checkinConversationId,
      hour,
    }: {
      readonly conversationName: string;
      readonly runningConversationId: string;
      readonly checkinConversationId?: string;
      readonly hour: number;
    }) => [
      {
        name: [MessageText.clientTerm("conversation", { casing: "sentence" })],
        value: conversationName,
        inline: true,
      },
      {
        name: [MessageText.clientTerm("runDestination", { casing: "sentence" })],
        value: conversationMentionValue(payload.client, payload.workspaceId, runningConversationId),
        inline: true,
      },
      ...(Predicate.isString(checkinConversationId)
        ? [
            {
              name: [MessageText.clientTerm("checkinDestination", { casing: "sentence" })],
              value: conversationMentionValue(
                payload.client,
                payload.workspaceId,
                checkinConversationId,
              ),
              inline: true,
            },
          ]
        : []),
      { name: "Hour", value: globalThis.String(hour), inline: true },
    ];

    const runTestConversation = (
      conversationName: string,
    ): Effect.Effect<AutoCheckinTestConversationResult, unknown, never> => {
      let runningConversationId: string | null = null;
      let checkinConversationId: string | null = null;
      let checkinPreviewMessageId: string | null = null;
      let monitorPreviewMessageId: string | null = null;
      let tentativeRoomOrderPreviewMessageId: string | null = null;

      return Effect.gen(function* () {
        const generated = yield* checkinService.generate({
          client: payload.client,
          dispatchRequestId: `${payload.dispatchRequestId}:${conversationName}`,
          workspaceId: payload.workspaceId,
          conversationName,
          hour: autoCheckinTestHour,
        });
        const generatedMonitorCheckinMessage = MessageText.materializeGeneratedText(
          payload.client,
          payload.workspaceId,
          generated.monitorCheckinMessage,
        );
        const generatedMonitorFailureMessage =
          generated.monitorFailureMessage === null
            ? null
            : MessageText.materializeGeneratedText(
                payload.client,
                payload.workspaceId,
                generated.monitorFailureMessage,
              );
        const monitorSummaryLines = (failureMessage: typeof generatedMonitorFailureMessage) =>
          MessageText.lines(
            generatedMonitorCheckinMessage,
            ...Option.match(Option.fromNullishOr(failureMessage), {
              onSome: (failure) => [[MessageText.subtle(failure)]],
              onNone: () => [],
            }),
          );
        const generatedInitialMessage =
          generated.initialMessage === null
            ? null
            : MessageText.materializeGeneratedText(
                payload.client,
                payload.workspaceId,
                generated.initialMessage,
              );
        runningConversationId = generated.runningConversationId;
        checkinConversationId = generated.checkinConversationId;

        if (generatedInitialMessage === null) {
          const monitorPreviewMessage = yield* sendTestPreview(
            generated.runningConversationId,
            "monitor-skipped",
            {
              title: "TEST RUN: Check-in skipped",
              description: monitorSummaryLines(generatedMonitorFailureMessage),
              fields: autoCheckinTestFields({
                conversationName,
                runningConversationId: generated.runningConversationId,
                hour: generated.hour,
              }),
            },
          );
          monitorPreviewMessageId = monitorPreviewMessage.id;

          return {
            conversationName,
            runningConversationId: generated.runningConversationId,
            checkinConversationId: generated.checkinConversationId,
            hour: generated.hour,
            status: "skipped",
            checkinPreviewMessageId: null,
            monitorPreviewMessageId: monitorPreviewMessage.id,
            tentativeRoomOrderPreviewMessageId: null,
            error:
              generatedMonitorFailureMessage === null
                ? null
                : MessageText.renderPlainText(generatedMonitorFailureMessage),
          } satisfies AutoCheckinTestConversationResult;
        }

        const checkinPreviewMessage = yield* sendTestPreview(
          generated.checkinConversationId,
          "checkin",
          {
            title: "TEST RUN: Check-in message",
            description: generatedInitialMessage,
            fields: autoCheckinTestFields({
              conversationName,
              runningConversationId: generated.runningConversationId,
              checkinConversationId: generated.checkinConversationId,
              hour: generated.hour,
            }),
          },
        );
        checkinPreviewMessageId = checkinPreviewMessage.id;

        const monitorPreviewMessage = yield* sendTestPreview(
          generated.runningConversationId,
          "monitor",
          {
            title: "TEST RUN: Monitor auto check-in summary",
            description: monitorSummaryLines(generatedMonitorFailureMessage),
            fields: autoCheckinTestFields({
              conversationName,
              runningConversationId: generated.runningConversationId,
              hour: generated.hour,
            }),
          },
        );
        monitorPreviewMessageId = monitorPreviewMessage.id;

        const tentativeRoomOrderPreviewMessage = shouldSendTentativeRoomOrder(generated.fillCount)
          ? yield* Effect.gen(function* () {
              const roomOrder = yield* roomOrderService.generate({
                workspaceId: payload.workspaceId,
                conversationId: generated.runningConversationId,
                hour: generated.hour,
              });
              const roomOrderContent = MessageText.materializeGeneratedText(
                payload.client,
                payload.workspaceId,
                roomOrder.content,
              );

              return yield* sendTestPreview(
                generated.runningConversationId,
                "tentative-room-order",
                {
                  title: "TEST RUN: Tentative room order",
                  description: tentativeRoomOrderContent(roomOrderContent),
                  fields: autoCheckinTestFields({
                    conversationName,
                    runningConversationId: generated.runningConversationId,
                    hour: generated.hour,
                  }),
                },
              );
            })
          : null;
        tentativeRoomOrderPreviewMessageId = tentativeRoomOrderPreviewMessage?.id ?? null;

        return {
          conversationName,
          runningConversationId: generated.runningConversationId,
          checkinConversationId: generated.checkinConversationId,
          hour: generated.hour,
          status: "sent",
          checkinPreviewMessageId,
          monitorPreviewMessageId,
          tentativeRoomOrderPreviewMessageId,
          error: null,
        } satisfies AutoCheckinTestConversationResult;
      }).pipe(
        Effect.catchCause((cause) =>
          recoverNonInterruptCause(cause, () =>
            Effect.logError("Auto-checkin test conversation failed").pipe(
              Effect.andThen(Effect.logError(Cause.pretty(cause))),
              Effect.annotateLogs({ conversationName }),
              Effect.as({
                conversationName,
                runningConversationId,
                checkinConversationId,
                hour: autoCheckinTestHour,
                status: "failed",
                checkinPreviewMessageId,
                monitorPreviewMessageId,
                tentativeRoomOrderPreviewMessageId,
                error: "Test run failed; see server logs.",
              } satisfies AutoCheckinTestConversationResult),
            ),
          ),
        ),
      );
    };

    const conversations = yield* workspaceConfigService.getWorkspaceConversations(
      payload.workspaceId,
      true,
    );
    const conversationNames = uniqueConversationNames(conversations);

    const conversationResults: ReadonlyArray<AutoCheckinTestConversationResult> =
      yield* Effect.forEach(conversationNames, runTestConversation, {
        concurrency: autoCheckinConcurrency,
      });

    const sentCount = conversationResults.filter((result) => result.status === "sent").length;
    const skippedCount = conversationResults.filter((result) => result.status === "skipped").length;
    const failedResults = conversationResults.filter((result) => result.status === "failed");
    const failedCount = failedResults.length;
    const firstFailure = failedResults[0];
    const summaryParts = [
      `Tested hour ${autoCheckinTestHour} across ${conversationResults.length} configured running conversation(s).`,
      `Sent: ${sentCount}. Skipped: ${skippedCount}. Failed: ${failedCount}.`,
      failedResults.length > 0
        ? `Failed conversations: ${failedResults.map((result) => result.conversationName).join(", ")}`
        : "No conversation failures.",
      ...(firstFailure === undefined
        ? []
        : [
            [
              `First failure detail for ${firstFailure.conversationName}:`,
              truncateAutoCheckinTestFailureDetail(firstFailure.error ?? "Unknown error"),
            ].join("\n"),
          ]),
    ];
    const summary = boundEmbedDescription(
      summaryParts.join("\n"),
      "\n… Summary truncated to fit Discord limits.",
    );

    yield* updateAnchor(
      makeAnchorPayload(summary, [
        { name: "Hour", value: globalThis.String(autoCheckinTestHour), inline: true },
        {
          name: "Conversations",
          value: globalThis.String(conversationResults.length),
          inline: true,
        },
        { name: "Failed", value: globalThis.String(failedCount), inline: true },
      ]),
    ).pipe(
      logNonInterruptFailure(
        "Failed to update the auto-checkin test summary after conversations completed",
        {
          workspaceId: payload.workspaceId,
          anchorConversationId: anchorMessage.conversation_id,
          anchorMessageId: anchorMessage.id,
        },
        Effect.void,
      ),
    );

    return {
      workspaceId: payload.workspaceId,
      hour: autoCheckinTestHour,
      anchorMessageId: anchorMessage.id,
      anchorMessageConversationId: anchorMessage.conversation_id,
      conversationCount: conversationResults.length,
      sentCount,
      skippedCount,
      failedCount,
      conversations: conversationResults,
    } satisfies AutoCheckinTestDispatchResult;
  }),
  checkin: Effect.fn("DispatchService.checkin")(function* (
    payload: CheckinDispatchPayload,
    requester: DispatchRequester,
  ) {
    yield* Effect.annotateCurrentSpan({
      workspaceId: payload.workspaceId,
      conversationName: payload.conversationName,
      hour: payload.hour,
      "requester.accountId": requester.accountId,
      "requester.userId": requester.userId,
    });
    const createdByUserId = requester.accountId;
    const interactionResponseToken =
      Predicate.isString(payload.interactionResponseToken) &&
      payload.interactionResponseToken.length > 0
        ? payload.interactionResponseToken
        : undefined;
    const hasInteractionToken = Predicate.isString(interactionResponseToken);
    const generated = yield* checkinService.generate(payload);
    const monitorCheckinMessage = MessageText.materializeGeneratedText(
      payload.client,
      payload.workspaceId,
      generated.monitorCheckinMessage,
    );
    const initialMessage =
      generated.initialMessage === null
        ? null
        : MessageText.materializeGeneratedText(
            payload.client,
            payload.workspaceId,
            generated.initialMessage,
          );
    const messageSink = makeMessageSink(
      botClient,
      generated.runningConversationId,
      interactionResponseToken,
    );
    const primaryMessage = yield* messageSink.sendPrimary({
      ...(hasInteractionToken
        ? {
            content: [MessageText.text("Dispatching check-in...")],
            visibility: "ephemeral",
          }
        : {
            content: monitorCheckinMessage,
          }),
      nonce: makeDeliveryNonce(`${payload.dispatchRequestId}:primary-monitor`),
      enforceNonce: true,
    });

    const delivery =
      initialMessage === null
        ? { checkinMessage: null, tentativeRoomOrderMessage: null }
        : yield* deliverCheckin({
            autoCheckinConcurrency,
            botClient,
            createdByUserId,
            generated,
            initialMessage,
            messageCheckinService,
            messageRoomOrderService,
            payload,
            roomOrderService,
            userConfigService,
          }).pipe(
            Effect.catchCause((cause) =>
              recoverNonInterruptCause(cause, () =>
                (hasInteractionToken
                  ? finalizeCheckinPrimaryMessage({
                      hasInteractionToken,
                      messageContent: [
                        MessageText.text("Check-in delivery failed. Please try again."),
                      ],
                      messageSink,
                      primaryMessage,
                      recoverUpdateFailure: false,
                    })
                  : messageSink.updatePrimary(primaryMessage, {
                      content: [MessageText.text("Check-in delivery failed. Please try again.")],
                    })
                ).pipe(
                  Effect.catchCause((finalizationCause) =>
                    recoverNonInterruptCause(finalizationCause, () =>
                      Effect.logWarning(
                        "Failed to finalize check-in primary response after failure",
                      ).pipe(Effect.andThen(Effect.logDebug(finalizationCause))),
                    ),
                  ),
                  Effect.andThen(Effect.fail(markInteractionFailureHandled(cause))),
                ),
              ),
            ),
          );
    const { checkinMessage, tentativeRoomOrderMessage } = delivery;
    const finalPrimaryMessage = yield* finalizeCheckinPrimaryMessage({
      hasInteractionToken,
      messageContent: monitorCheckinMessage,
      messageSink,
      primaryMessage,
      recoverUpdateFailure: true,
    });

    return makeCheckinDispatchResult({
      checkinMessage,
      finalPrimaryMessage,
      generated,
      tentativeRoomOrderMessage,
    });
  }),
});
