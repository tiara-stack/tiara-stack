import { Cause, Context, Data, Effect, Layer, Option, Schema } from "effect";
import type { EffectivePrincipal } from "sheet-auth/identity";
import {
  type DeleteMessageReceipt,
  DeliveryKey,
  type RespondReceipt,
  type SendMessageReceipt,
  conversationRefFrom,
} from "sheet-bot-api";
import { slotActionRow } from "sheet-message-content/components";
import * as MessageText from "sheet-message-content/text";
import { InteractiveDeclaredFailure, type SlotsPublishButtonInput } from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { config } from "@/config";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveInvalidRequest as invalidRequest,
  mapBotCacheFailure,
  mapDeliveryFailure,
  requireInteractiveDiscordAccountId,
} from "../shared/interactive";

export const SlotBindingOutcome = Schema.Union([
  Schema.TaggedStruct("Bound", {}),
  Schema.TaggedStruct("CleanupRequired", { failure: Schema.Literal("SlotStateBindFailed") }),
]);
type SlotBindingOutcome = typeof SlotBindingOutcome.Type;

class SlotWorkflowOperationsError extends Data.TaggedError("SlotWorkflowOperationsError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type SlotResult<A> = Effect.Effect<A, InteractiveDeclaredFailure | SlotWorkflowOperationsError>;

interface SlotWorkflowOperationsShape {
  readonly requireCreatorAccountId: (
    principal: EffectivePrincipal,
    policy: string,
  ) => SlotResult<string>;
  readonly publishButton: (
    input: SlotsPublishButtonInput,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => SlotResult<SendMessageReceipt>;
  readonly bindSlotState: (
    input: SlotsPublishButtonInput,
    receipt: SendMessageReceipt,
    creatorAccountId: string,
  ) => SlotResult<SlotBindingOutcome>;
  readonly deleteProvisionalButton: (
    receipt: SendMessageReceipt,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => SlotResult<DeleteMessageReceipt>;
  readonly respond: (
    input: SlotsPublishButtonInput,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => SlotResult<RespondReceipt>;
}

export class SlotWorkflowOperations extends Context.Service<
  SlotWorkflowOperations,
  SlotWorkflowOperationsShape
>()("sheet-workflows/SlotWorkflowOperations") {}

const operationError = (operation: string, cause: unknown) =>
  new SlotWorkflowOperationsError({ operation, cause });

const publishButtonMessage = (day: number) => ({
  content: [
    MessageText.text(`Press the button below to get the current open slots for day ${day}`),
  ],
  components: [slotActionRow()],
});

const slotButtonAcknowledgement = Object.freeze({
  content: [MessageText.text("Slot button sent!")],
  visibility: "ephemeral" as const,
});

const rowMatchesBinding = (
  row: {
    readonly clientPlatform: string;
    readonly clientId: string;
    readonly messageId: string;
    readonly day: number;
    readonly workspaceId: string | null;
    readonly conversationId: string | null;
    readonly createdByUserId: string | null;
    readonly deletedAt: number | null;
  },
  expected: {
    readonly clientPlatform: string;
    readonly clientId: string;
    readonly messageId: string;
    readonly day: number;
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly createdByUserId: string;
  },
) =>
  row.clientPlatform === expected.clientPlatform &&
  row.clientId === expected.clientId &&
  row.messageId === expected.messageId &&
  row.day === expected.day &&
  row.workspaceId === expected.workspaceId &&
  row.conversationId === expected.conversationId &&
  row.createdByUserId === expected.createdByUserId &&
  row.deletedAt === null;

export const slotWorkflowOperationsLayer = Layer.effect(
  SlotWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const cache = yield* SheetBotCacheClient;
    const delivery = yield* SheetBotDeliveryClient;
    const clientId = yield* config.sheetBotClientId;
    const client = { platform: "discord", clientId } as const;

    const requireCreatorAccountId: SlotWorkflowOperationsShape["requireCreatorAccountId"] =
      requireInteractiveDiscordAccountId;

    const publishButton: SlotWorkflowOperationsShape["publishButton"] = (
      input,
      deliveryKey,
      policy,
    ) =>
      Effect.gen(function* () {
        const conversation = yield* cache
          .get()
          .cache.getConversation({
            params: {
              ...client,
              workspaceId: input.workspaceId,
              conversationId: input.conversationId,
            },
          })
          .pipe(
            Effect.mapError(
              mapBotCacheFailure(
                policy,
                "conversation",
                "slots.validateConversation",
                operationError,
              ),
            ),
          );
        if (conversation.workspaceId !== input.workspaceId) {
          return yield* Effect.fail(
            invalidRequest(
              "ConversationWorkspaceMismatch",
              "The conversation must belong to the authorized workspace",
            ),
          );
        }
        return yield* delivery
          .get()
          .delivery.sendMessage({
            payload: {
              conversation: conversationRefFrom(client, input.workspaceId, input.conversationId),
              deliveryKey,
              message: publishButtonMessage(input.day),
            },
          })
          .pipe(
            Effect.mapError(
              mapDeliveryFailure(
                policy,
                "slots.publishButton",
                "conversation",
                false,
                "The slot button message was rejected",
                operationError,
              ),
            ),
          );
      });

    const bindSlotState: SlotWorkflowOperationsShape["bindSlotState"] = (
      input,
      receipt,
      creatorAccountId,
    ) => {
      const message = receipt.target.message;
      const expected = {
        clientPlatform: message.conversation.workspace.client.platform,
        clientId: message.conversation.workspace.client.clientId,
        messageId: message.messageId,
        day: input.day,
        workspaceId: input.workspaceId,
        conversationId: message.conversation.conversationId,
        createdByUserId: creatorAccountId,
      };
      return persistence.slotState.upsertMessageSlotData(expected).pipe(
        Effect.as({ _tag: "Bound" } as const),
        Effect.catchCause((cause) =>
          Effect.uninterruptible(
            persistence.slotState
              .getMessageSlotData({
                clientPlatform: expected.clientPlatform,
                clientId: expected.clientId,
                messageId: expected.messageId,
              })
              .pipe(
                Effect.catchCause((reconciliationCause) =>
                  Effect.fail(
                    operationError(
                      "slots.bindSlotState.reconcile",
                      Cause.combine(cause, reconciliationCause),
                    ),
                  ),
                ),
                Effect.flatMap(
                  (row): SlotResult<SlotBindingOutcome> =>
                    Option.match(row, {
                      onNone: (): SlotResult<SlotBindingOutcome> =>
                        Cause.hasInterrupts(cause)
                          ? Effect.fail(operationError("slots.bindSlotState.interrupted", cause))
                          : Effect.logError("Slot state bind failed before commit", cause).pipe(
                              Effect.as({
                                _tag: "CleanupRequired" as const,
                                failure: "SlotStateBindFailed" as const,
                              }),
                            ),
                      onSome: (persisted): SlotResult<SlotBindingOutcome> =>
                        rowMatchesBinding(persisted, expected)
                          ? Effect.succeed({ _tag: "Bound" as const })
                          : Effect.fail(
                              operationError(
                                "slots.bindSlotState.reconcile",
                                "The exact message slot record does not match the intended binding",
                              ),
                            ),
                    }),
                ),
              ),
          ),
        ),
      );
    };

    const deleteProvisionalButton: SlotWorkflowOperationsShape["deleteProvisionalButton"] = (
      receipt,
      deliveryKey,
      policy,
    ) =>
      delivery
        .get()
        .delivery.deleteMessage({
          payload: { message: receipt.target.message, deliveryKey },
        })
        .pipe(
          Effect.mapError(
            mapDeliveryFailure(
              policy,
              "slots.deleteProvisionalButton",
              "message",
              true,
              "The provisional slot button could not be deleted",
              operationError,
            ),
          ),
        );

    const respond: SlotWorkflowOperationsShape["respond"] = (input, deliveryKey, policy) =>
      delivery
        .get()
        .delivery.respond({
          payload: {
            responseReference: input.responseReference,
            deliveryKey,
            message: slotButtonAcknowledgement,
          },
        })
        .pipe(
          Effect.mapError(
            mapDeliveryFailure(
              policy,
              "slots.respond",
              "response",
              true,
              "The slot button acknowledgement was rejected",
              operationError,
            ),
          ),
        );

    return {
      requireCreatorAccountId,
      publishButton,
      bindSlotState,
      deleteProvisionalButton,
      respond,
    };
  }),
);
