import { Effect } from "effect";
import type { DiscordRestService } from "dfx/DiscordREST";
import {
  shouldSendTentativeRoomOrder,
  formatTentativeRoomOrderContent,
} from "sheet-ingress-api/discordComponents";
import {
  tentativeRoomOrderActionRow,
  tentativeRoomOrderPinActionRow,
} from "../messageComponents/buttons/roomOrderComponents";

type TentativeRoomOrderSender = Pick<DiscordRestService, "createMessage" | "updateMessage">;

type TentativeRoomOrderGenerator = {
  generate: (payload: {
    guildId: string;
    channelId?: string | undefined;
    channelName?: string | undefined;
    hour?: number | undefined;
    healNeeded?: number | undefined;
  }) => Effect.Effect<
    {
      content: string;
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
        guildId: string | null;
        messageChannelId: string | null;
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

export const sendTentativeRoomOrder = Effect.fn("sendTentativeRoomOrder")(function* ({
  guildId,
  runningChannelId,
  hour,
  fillCount,
  roomOrderService,
  messageRoomOrderService,
  sender,
  createdByUserId,
}: {
  guildId: string;
  runningChannelId: string;
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
      guildId,
      channelId: runningChannelId,
      hour,
    });

    const sentMessage = yield* sender.createMessage(runningChannelId, {
      content: formatTentativeRoomOrderContent(generated.content),
      components: [tentativeRoomOrderActionRow(generated.range, generated.rank).toJSON()],
    });

    yield* Effect.gen(function* () {
      yield* messageRoomOrderService.persistMessageRoomOrder(sentMessage.id, {
        data: {
          previousFills: generated.previousFills,
          fills: generated.fills,
          hour: generated.hour,
          rank: generated.rank,
          tentative: true,
          monitor: generated.monitor,
          guildId,
          messageChannelId: sentMessage.channel_id,
          createdByUserId,
        },
        entries: generated.entries,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Failed to persist tentative room order").pipe(
          Effect.annotateLogs({
            guildId,
            runningChannelId,
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
                      guildId,
                      runningChannelId,
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
      messageChannelId: sentMessage.channel_id,
    };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Failed to send tentative room order").pipe(
        Effect.annotateLogs({
          guildId,
          runningChannelId,
          hour,
        }),
        Effect.andThen(Effect.logError(cause)),
        Effect.as(null),
      ),
    ),
  );
});
