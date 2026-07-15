import { Effect, Option } from "effect";
import type { SheetOutboundMessage, SheetTextPart } from "sheet-ingress-api/schemas/client";
import { makeArgumentError } from "typhoon-core/error";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import * as MessageText from "../../messageText";
import type { DeliveredMessage } from "./messageDelivery";
import { logNonInterruptFailure } from "./messageDelivery";
import { escapeMarkdown, workspaceWelcomeConversationCandidates } from "../pure/rendering";

type MessagePayload = SheetOutboundMessage;
type MessageTextValue = ReadonlyArray<SheetTextPart>;

export const resolveWorkspaceDisplayName = (
  botClient: typeof ClientDeliveryClient.Service,
  workspaceId: string,
): Effect.Effect<MessageTextValue, unknown> =>
  botClient.getWorkspace(workspaceId).pipe(
    Effect.map((workspace) => {
      const name = workspace.name.trim();
      return name.length > 0
        ? [MessageText.text(escapeMarkdown(name))]
        : [MessageText.text("this "), MessageText.clientTerm("workspace")];
    }),
    logNonInterruptFailure(
      "Failed to resolve workspace display name",
      { workspaceId },
      Effect.succeed([MessageText.text("this "), MessageText.clientTerm("workspace")]),
      "warning",
    ),
  );

export const sendWorkspaceAnnouncementWithWelcomeHeuristic = (params: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly workspaceId: string;
  readonly systemConversationId: string | undefined;
  readonly messagePayload: MessagePayload;
  readonly logLabel: string;
}) =>
  Effect.gen(function* () {
    const conversations = yield* params.botClient.getConversationsForParent(params.workspaceId);
    const [conversation] = workspaceWelcomeConversationCandidates(
      conversations,
      params.systemConversationId,
    );

    // Delivery failures may be ambiguous, so only attempt the highest-ranked
    // conversation rather than risking a duplicate announcement elsewhere.
    if (conversation !== undefined) {
      const sentMessage = yield* params.botClient
        .sendMessage(conversation.resourceId, params.messagePayload)
        .pipe(
          Effect.map(Option.some),
          logNonInterruptFailure(
            `Failed to send ${params.logLabel}`,
            {
              workspaceId: params.workspaceId,
              conversationId: conversation.resourceId,
              conversationName: conversation.value.name,
            },
            Effect.succeed(Option.none<DeliveredMessage>()),
            "warning",
          ),
        );

      if (Option.isSome(sentMessage)) {
        return sentMessage.value;
      }
    }

    return yield* Effect.fail(makeArgumentError(`Cannot send ${params.logLabel}`));
  });
