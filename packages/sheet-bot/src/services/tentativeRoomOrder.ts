import { Effect } from "effect";
import type { DiscordRestService } from "dfx/DiscordREST";
import {
  shouldSendTentativeRoomOrder,
  formatTentativeRoomOrderContent,
} from "sheet-ingress-api/clientActions";
import {
  tentativeRoomOrderActionRow,
  tentativeRoomOrderPinActionRow,
} from "../messageComponents/buttons/roomOrderComponents";
import type { GeneratedSheetText } from "sheet-ingress-api/schemas/client";
import { renderGeneratedSheetText } from "../discord/renderSheetMessage";

type TentativeRoomOrderSender = Pick<DiscordRestService, "createMessage" | "updateMessage">;

type TentativeRoomOrderGenerator = {
  generate: (payload: {
    workspaceId: string;
    conversationId?: string | undefined;
    conversationName?: string | undefined;
    hour?: number | undefined;
    healNeeded?: number | undefined;
  }) => Effect.Effect<
    {
      content: GeneratedSheetText;
      range: { minRank: number; maxRank: number };
      rank: number;
      hour: number;
      monitor: string | null;
      previousFills: ReadonlyArray<string>;
      fills: ReadonlyArray<string>;
      entries: ReadonlyArray<{
        rank: number;
        position: number;
        hour: number;
        team: string;
        tags: ReadonlyArray<string>;
        effectValue: number;
      }>;
    },
    unknown,
    never
  >;
};

type TentativeMessageRoomOrderService = {
  persistMessageRoomOrder: (
    messageId: string,
    payload: {
      data: {
        previousFills: ReadonlyArray<string>;
        fills: ReadonlyArray<string>;
        hour: number;
        rank: number;
        tentative: boolean;
        monitor: string | null | undefined;
        workspaceId: string | null;
        messageConversationId: string | null;
        createdByUserId: string | null;
      };
      entries: ReadonlyArray<{
        rank: number;
        position: number;
        hour: number;
        team: string;
        tags: ReadonlyArray<string>;
        effectValue: number;
      }>;
    },
  ) => Effect.Effect<unknown, unknown, never>;
};

const logTentativeRoomOrderSendFailure =
  (context: {
    readonly workspaceId: string;
    readonly runningConversationId: string;
    readonly hour: number;
  }) =>
  (cause: unknown) =>
    Effect.logError("Failed to send tentative room order").pipe(
      Effect.annotateLogs(context),
      Effect.andThen(Effect.logError(cause)),
      Effect.as(null),
    );

export const sendTentativeRoomOrder = Effect.fn("sendTentativeRoomOrder")(function* ({
  workspaceId,
  runningConversationId,
  hour,
  fillCount,
  roomOrderService,
  messageRoomOrderService,
  sender,
  createdByUserId,
}: {
  workspaceId: string;
  runningConversationId: string;
  hour: number;
  fillCount: number;
  roomOrderService: TentativeRoomOrderGenerator;
  messageRoomOrderService: TentativeMessageRoomOrderService;
  sender: TentativeRoomOrderSender;
  createdByUserId: string | null;
}) {
  if (!shouldSendTentativeRoomOrder(fillCount)) {
    return null;
  }

  return yield* Effect.gen(function* () {
    const generated = yield* roomOrderService.generate({
      workspaceId,
      conversationId: runningConversationId,
      hour,
    });
    const content = renderGeneratedSheetText(generated.content);

    const sentMessage = yield* sender.createMessage(runningConversationId, {
      content: formatTentativeRoomOrderContent(content),
      components: [tentativeRoomOrderActionRow(generated.range, generated.rank).toJSON()],
    });

    yield* messageRoomOrderService
      .persistMessageRoomOrder(sentMessage.id, {
        data: {
          previousFills: generated.previousFills,
          fills: generated.fills,
          hour: generated.hour,
          rank: generated.rank,
          tentative: true,
          monitor: generated.monitor,
          workspaceId,
          messageConversationId: sentMessage.channel_id,
          createdByUserId,
        },
        entries: generated.entries,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to persist tentative room order").pipe(
            Effect.annotateLogs({
              workspaceId,
              runningConversationId,
              hour,
              messageId: sentMessage.id,
            }),
            Effect.andThen(Effect.logError(cause)),
            Effect.andThen(
              sender
                .updateMessage(sentMessage.channel_id, sentMessage.id, {
                  components: [tentativeRoomOrderPinActionRow().toJSON()],
                })
                .pipe(
                  Effect.catchCause((updateCause) =>
                    Effect.logError(
                      "Failed to persist tentative room order and downgrade buttons",
                    ).pipe(
                      Effect.annotateLogs({
                        workspaceId,
                        runningConversationId,
                        hour,
                        messageId: sentMessage.id,
                      }),
                      Effect.andThen(Effect.logError(cause)),
                      Effect.andThen(Effect.logError(updateCause)),
                    ),
                  ),
                ),
            ),
          ),
        ),
      );

    return {
      messageId: sentMessage.id,
      messageConversationId: sentMessage.channel_id,
    };
  }).pipe(
    Effect.catchCause(
      logTentativeRoomOrderSendFailure({
        workspaceId,
        runningConversationId,
        hour,
      }),
    ),
  );
});
