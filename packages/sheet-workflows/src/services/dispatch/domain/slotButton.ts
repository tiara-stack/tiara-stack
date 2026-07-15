import { Effect, Option } from "effect";
import type { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import type { SlotOpenButtonPayload, SlotOpenButtonResult } from "sheet-ingress-api/sheet-apis-rpc";
import { makeArgumentError } from "typhoon-core/error";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { requireSome } from "../pure/option";
import type { SlotEmbedRenderer } from "./slotRendering";

export const makeSlotButtonOperations = ({
  botClient,
  makeSlotEmbeds,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly makeSlotEmbeds: SlotEmbedRenderer;
}) => ({
  slotOpenButton: Effect.fn("DispatchService.slotOpenButton")(function* (
    payload: SlotOpenButtonPayload,
    messageSlot: MessageSlot,
  ) {
    yield* Effect.annotateCurrentSpan({
      messageId: payload.messageId,
      day: messageSlot.day,
    });
    const failSlotInteraction = (content: string, errorMessage: string) =>
      botClient
        .updateOriginalInteractionResponse(payload.interactionResponseToken, { content })
        .pipe(
          Effect.andThen(
            Effect.fail(markInteractionFailureHandled(makeArgumentError(errorMessage))),
          ),
        );
    const requireSlotField = <A>(field: Option.Option<A>, content: string, errorMessage: string) =>
      requireSome(field, () => failSlotInteraction(content, errorMessage));
    const workspaceId = yield* requireSlotField(
      messageSlot.workspaceId,
      "This slot message is not registered to a server.",
      "Cannot handle slot button, message workspace is not registered",
    );
    yield* requireSlotField(
      messageSlot.conversationId,
      "This slot message conversation is not registered.",
      "Cannot handle slot button, message conversation is not registered",
    );

    const slotEmbeds = yield* makeSlotEmbeds(workspaceId, messageSlot.day);

    yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
      embeds: slotEmbeds,
    });

    return {
      messageId: payload.messageId,
      workspaceId,
      day: messageSlot.day,
    } satisfies SlotOpenButtonResult;
  }),
});
