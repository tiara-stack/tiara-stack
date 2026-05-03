import { Context, DateTime, Duration, Effect, Layer, Option, Schema, pipe } from "effect";
import { DiscordMessageRequestSchema } from "dfx-discord-utils/discord/schema";
import {
  formatTentativeRoomOrderContent,
  hasTentativeRoomOrderPrefix,
  shouldSendTentativeRoomOrder,
} from "sheet-ingress-api/discordComponents";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import type { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import type {
  CheckinDispatchPayload,
  CheckinDispatchResult,
  CheckinHandleButtonPayload,
  CheckinHandleButtonResult,
  RoomOrderDispatchPayload,
  RoomOrderDispatchResult,
  RoomOrderHandleButtonPayload,
  RoomOrderHandleButtonResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import { makeArgumentError } from "typhoon-core/error";
import { CheckinService } from "./checkin";
import {
  checkinActionRow,
  roomOrderActionRow,
  tentativeRoomOrderActionRow,
  tentativeRoomOrderPinActionRow,
} from "./discordComponents";
import { GuildConfigService } from "./guildConfig";
import { IngressBotClient } from "./ingressBotClient";
import { MessageCheckinService } from "./messageCheckin";
import { MessageRoomOrderService } from "./messageRoomOrder";
import { buildRoomOrderContent, RoomOrderService } from "./roomOrder";
import { SheetService } from "./sheet";

const MessageFlags = {
  Ephemeral: 64,
} as const;

type DiscordMessage = {
  readonly id: string;
  readonly channel_id: string;
};

type MessagePayload = Schema.Schema.Type<typeof DiscordMessageRequestSchema>;
type GuildConfigServiceApi = Context.Service.Shape<typeof GuildConfigService>;
type SheetServiceApi = Context.Service.Shape<typeof SheetService>;

type DispatchMessageSink = {
  readonly sendPrimary: (
    payload: MessagePayload,
  ) => Effect.Effect<DiscordMessage, unknown, unknown>;
  readonly updatePrimary: (
    message: DiscordMessage,
    payload: MessagePayload,
  ) => Effect.Effect<DiscordMessage, unknown, unknown>;
};

const logEnableFailure = (message: string) => (error: unknown) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ cause: String(error) }));

const makeInteractionMessageSink = (
  botClient: typeof IngressBotClient.Service,
  interactionToken: string,
): DispatchMessageSink => ({
  sendPrimary: (payload) => botClient.updateOriginalInteractionResponse(interactionToken, payload),
  updatePrimary: (_message, payload) =>
    botClient.updateOriginalInteractionResponse(interactionToken, payload),
});

const makeChannelMessageSink = (
  botClient: typeof IngressBotClient.Service,
  channelId: string,
): DispatchMessageSink => ({
  sendPrimary: (payload) => botClient.sendMessage(channelId, payload),
  updatePrimary: (message, payload) =>
    botClient.updateMessage(message.channel_id, message.id, payload),
});

const makeMessageSink = (
  botClient: typeof IngressBotClient.Service,
  channelId: string,
  interactionToken: string | undefined,
): DispatchMessageSink =>
  typeof interactionToken === "string"
    ? makeInteractionMessageSink(botClient, interactionToken)
    : makeChannelMessageSink(botClient, channelId);

const mentionUser = (userId: string): string => `<@${userId}>`;

const renderCheckedInContent = (
  initialMessage: string,
  members: ReadonlyArray<{ readonly memberId: string; readonly checkinAt: Option.Option<unknown> }>,
) => {
  const checkedInMentions = members
    .filter((member) => Option.isSome(member.checkinAt))
    .map((member) => mentionUser(member.memberId));

  return checkedInMentions.length > 0
    ? `${initialMessage}\n\nChecked in: ${checkedInMentions.join(" ")}`
    : initialMessage;
};

const getSheetIdFromGuildId = (guildId: string, guildConfigService: GuildConfigServiceApi) =>
  guildConfigService.getGuildConfig(guildId).pipe(
    Effect.flatMap(
      Option.match({
        onSome: (guildConfig) =>
          pipe(
            guildConfig.sheetId,
            Option.match({
              onSome: Effect.succeed,
              onNone: () =>
                Effect.fail(
                  makeArgumentError("Cannot handle room-order button, the guild has no sheet id"),
                ),
            }),
          ),
        onNone: () =>
          Effect.fail(
            makeArgumentError("Cannot handle room-order button, the guild might not be registered"),
          ),
      }),
    ),
  );

const requireOptionValue = <A>(option: Option.Option<A>, message: string) =>
  Option.match(option, {
    onSome: Effect.succeed,
    onNone: () => Effect.fail(makeArgumentError(message)),
  });

const fillParticipantFromName = (name: string) => ({
  key: `name:${name}`,
  label: name,
  name,
});

const renderRoomOrderReply = Effect.fn("DispatchService.renderRoomOrderReply")(function* ({
  guildId,
  messageId,
  mode,
  roomOrder,
  guildConfigService,
  sheetService,
  messageRoomOrderService,
}: {
  readonly guildId: string;
  readonly messageId: string;
  readonly mode: "normal" | "tentative";
  readonly roomOrder: MessageRoomOrder;
  readonly guildConfigService: GuildConfigServiceApi;
  readonly sheetService: SheetServiceApi;
  readonly messageRoomOrderService: typeof MessageRoomOrderService.Service;
}) {
  const maybeRange = yield* messageRoomOrderService.getMessageRoomOrderRange(messageId);
  const entries = yield* messageRoomOrderService.getMessageRoomOrderEntry(
    messageId,
    roomOrder.rank,
  );
  const sheetId = yield* getSheetIdFromGuildId(guildId, guildConfigService);
  const range = yield* Option.match(maybeRange, {
    onSome: Effect.succeed,
    onNone: () => Effect.fail(makeArgumentError("Cannot render room order, no entries found")),
  });
  const eventConfig = yield* sheetService.getEventConfig(sheetId);
  const start = pipe(
    eventConfig.startTime,
    DateTime.addDuration(Duration.hours(roomOrder.hour - 1)),
  );
  const end = pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(roomOrder.hour)));

  const content = buildRoomOrderContent(
    roomOrder.hour,
    start,
    end,
    Option.getOrNull(roomOrder.monitor),
    roomOrder.previousFills.map(fillParticipantFromName),
    roomOrder.fills.map(fillParticipantFromName),
    entries,
  );

  return mode === "tentative"
    ? {
        content: formatTentativeRoomOrderContent(content),
        components: [tentativeRoomOrderActionRow(range, roomOrder.rank)],
      }
    : {
        content,
        components: [roomOrderActionRow(range, roomOrder.rank)],
      };
});

const sendTentativeRoomOrder = Effect.fn("DispatchService.sendTentativeRoomOrder")(function* ({
  guildId,
  runningChannelId,
  hour,
  fillCount,
  createdByUserId,
  botClient,
  roomOrderService,
  messageRoomOrderService,
}: {
  readonly guildId: string;
  readonly runningChannelId: string;
  readonly hour: number;
  readonly fillCount: number;
  readonly createdByUserId: string | null;
  readonly botClient: typeof IngressBotClient.Service;
  readonly roomOrderService: typeof RoomOrderService.Service;
  readonly messageRoomOrderService: typeof MessageRoomOrderService.Service;
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

    const sentMessage = yield* botClient.sendMessage(runningChannelId, {
      content: formatTentativeRoomOrderContent(generated.content),
      components: [tentativeRoomOrderActionRow(generated.range, generated.rank)],
    });

    yield* Effect.gen(function* () {
      yield* messageRoomOrderService.persistMessageRoomOrder(sentMessage.id, {
        data: {
          previousFills: generated.previousFills,
          fills: generated.fills,
          hour: generated.hour,
          rank: generated.rank,
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
            botClient
              .updateMessage(sentMessage.channel_id, sentMessage.id, {
                components: [tentativeRoomOrderPinActionRow()],
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

export class DispatchService extends Context.Service<DispatchService>()("DispatchService", {
  make: Effect.gen(function* () {
    const botClient = yield* IngressBotClient;
    const checkinService = yield* CheckinService;
    const guildConfigService = yield* GuildConfigService;
    const messageCheckinService = yield* MessageCheckinService;
    const messageRoomOrderService = yield* MessageRoomOrderService;
    const roomOrderService = yield* RoomOrderService;
    const sheetService = yield* SheetService;

    return {
      checkin: Effect.fn("DispatchService.checkin")(function* (payload: CheckinDispatchPayload) {
        const user = yield* SheetAuthUser;
        const createdByUserId = user.userId;
        const generated = yield* checkinService.generate(payload);
        const messageSink = makeMessageSink(
          botClient,
          generated.runningChannelId,
          payload.interactionToken,
        );
        const primaryMessage = yield* messageSink.sendPrimary(
          typeof payload.interactionToken === "string"
            ? {
                content: "Dispatching check-in...",
                flags: MessageFlags.Ephemeral,
              }
            : {
                content: generated.monitorCheckinMessage,
              },
        );

        let checkinMessage: DiscordMessage | null = null;
        let tentativeRoomOrderMessage: {
          readonly messageId: string;
          readonly messageChannelId: string;
        } | null = null;

        if (generated.initialMessage !== null) {
          checkinMessage = yield* botClient.sendMessage(generated.checkinChannelId, {
            content: generated.initialMessage,
          });

          yield* messageCheckinService.persistMessageCheckin(checkinMessage.id, {
            data: {
              initialMessage: generated.initialMessage,
              hour: generated.hour,
              channelId: generated.runningChannelId,
              roleId: generated.roleId,
              guildId: payload.guildId,
              messageChannelId: generated.checkinChannelId,
              createdByUserId,
            },
            memberIds: generated.fillIds,
          });

          yield* botClient
            .updateMessage(checkinMessage.channel_id, checkinMessage.id, {
              components: [checkinActionRow()],
            })
            .pipe(
              Effect.catch(
                logEnableFailure(
                  "Failed to enable check-in message after persistence; leaving message without components",
                ),
              ),
            );

          tentativeRoomOrderMessage = yield* sendTentativeRoomOrder({
            guildId: payload.guildId,
            runningChannelId: generated.runningChannelId,
            hour: generated.hour,
            fillCount: generated.fillCount,
            createdByUserId,
            botClient,
            roomOrderService,
            messageRoomOrderService,
          });
        }

        const finalPrimaryMessage =
          typeof payload.interactionToken === "string"
            ? checkinMessage === null
              ? yield* messageSink.updatePrimary(primaryMessage, {
                  content: generated.monitorCheckinMessage,
                  flags: MessageFlags.Ephemeral,
                })
              : yield* messageSink
                  .updatePrimary(primaryMessage, {
                    content: generated.monitorCheckinMessage,
                    flags: MessageFlags.Ephemeral,
                  })
                  .pipe(
                    Effect.catch((error) =>
                      logEnableFailure(
                        "Failed to update check-in primary response after persistence; leaving progress message",
                      )(error).pipe(Effect.as(primaryMessage)),
                    ),
                  )
            : primaryMessage;

        return {
          hour: generated.hour,
          runningChannelId: generated.runningChannelId,
          checkinChannelId: generated.checkinChannelId,
          checkinMessageId: checkinMessage?.id ?? null,
          checkinMessageChannelId: checkinMessage?.channel_id ?? null,
          primaryMessageId: finalPrimaryMessage.id,
          primaryMessageChannelId: finalPrimaryMessage.channel_id,
          tentativeRoomOrderMessageId: tentativeRoomOrderMessage?.messageId ?? null,
          tentativeRoomOrderMessageChannelId: tentativeRoomOrderMessage?.messageChannelId ?? null,
        } satisfies CheckinDispatchResult;
      }),
      roomOrder: Effect.fn("DispatchService.roomOrder")(function* (
        payload: RoomOrderDispatchPayload,
      ) {
        const user = yield* SheetAuthUser;
        const createdByUserId = user.userId;
        const generated = yield* roomOrderService.generate(payload);
        const messageSink = makeMessageSink(
          botClient,
          generated.runningChannelId,
          payload.interactionToken,
        );
        const message = yield* messageSink.sendPrimary({
          content: generated.content,
          components: [roomOrderActionRow(generated.range, generated.rank, true)],
        });

        yield* messageRoomOrderService.persistMessageRoomOrder(message.id, {
          data: {
            previousFills: generated.previousFills,
            fills: generated.fills,
            hour: generated.hour,
            rank: generated.rank,
            monitor: generated.monitor,
            guildId: payload.guildId,
            messageChannelId: message.channel_id,
            createdByUserId,
          },
          entries: generated.entries,
        });

        const enabledMessage = yield* messageSink
          .updatePrimary(message, {
            components: [roomOrderActionRow(generated.range, generated.rank)],
          })
          .pipe(
            Effect.catch((error) =>
              logEnableFailure(
                "Failed to enable room-order message after persistence; leaving disabled components",
              )(error).pipe(Effect.as(message)),
            ),
          );

        return {
          messageId: enabledMessage.id,
          messageChannelId: enabledMessage.channel_id,
          hour: generated.hour,
          runningChannelId: generated.runningChannelId,
          rank: generated.rank,
        } satisfies RoomOrderDispatchResult;
      }),
      checkinButton: Effect.fn("DispatchService.checkinButton")(function* (
        payload: CheckinHandleButtonPayload,
      ) {
        const user = yield* SheetAuthUser;
        const accountId = user.accountId;
        const checkinAt = Date.now();

        const maybeMessageCheckinData = yield* messageCheckinService.getMessageCheckinData(
          payload.messageId,
        );
        const messageCheckinData = yield* Option.match(maybeMessageCheckinData, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              makeArgumentError("Cannot handle check-in button, message is not registered"),
            ),
        });
        const messageChannelId = yield* requireOptionValue(
          messageCheckinData.messageChannelId,
          "Cannot handle check-in button, message channel is not registered",
        );
        const guildId = yield* requireOptionValue(
          messageCheckinData.guildId,
          "Cannot handle check-in button, message guild is not registered",
        );

        const checkedInMember =
          yield* messageCheckinService.setMessageCheckinMemberCheckinAtIfUnset(
            payload.messageId,
            accountId,
            checkinAt,
          );
        const isFirstCheckin =
          Option.isSome(checkedInMember.checkinAt) &&
          DateTime.toEpochMillis(checkedInMember.checkinAt.value) === checkinAt;

        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          content: isFirstCheckin
            ? "You have been checked in!"
            : "You have already been checked in!",
        });

        const checkedInMembers = yield* messageCheckinService.getMessageCheckinMembers(
          payload.messageId,
        );
        const content = renderCheckedInContent(messageCheckinData.initialMessage, checkedInMembers);

        yield* botClient.updateMessage(messageChannelId, payload.messageId, {
          content,
          components: [checkinActionRow()],
        });

        if (isFirstCheckin) {
          yield* botClient.sendMessage(messageCheckinData.channelId, {
            content: `${mentionUser(accountId)} has checked in!`,
          });
        }

        if (Option.isSome(messageCheckinData.roleId)) {
          yield* botClient.addGuildMemberRole(guildId, accountId, messageCheckinData.roleId.value);
        }

        return {
          messageId: payload.messageId,
          messageChannelId,
          checkedInMemberId: accountId,
        } satisfies CheckinHandleButtonResult;
      }),
      roomOrderButton: Effect.fn("DispatchService.roomOrderButton")(function* (
        payload: RoomOrderHandleButtonPayload,
      ) {
        const maybeInitialRoomOrder = yield* messageRoomOrderService.getMessageRoomOrder(
          payload.messageId,
        );
        if (Option.isNone(maybeInitialRoomOrder) && payload.action === "pinTentative") {
          const fallbackChannel = yield* guildConfigService.getGuildChannelById({
            guildId: payload.guildId,
            channelId: payload.messageChannelId,
            running: true,
          });
          if (Option.isNone(fallbackChannel)) {
            return yield* Effect.fail(
              makeArgumentError(
                "Cannot handle room-order button, message channel is not a registered running channel",
              ),
            );
          }

          const pinned = yield* botClient
            .createPin(payload.messageChannelId, payload.messageId)
            .pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logError("Failed to pin fallback tentative room order").pipe(
                  Effect.annotateLogs({
                    guildId: payload.guildId,
                    channelId: payload.messageChannelId,
                    messageId: payload.messageId,
                  }),
                  Effect.andThen(Effect.logError(cause)),
                  Effect.as(false),
                ),
              ),
            );

          const cleanedUp = pinned
            ? yield* botClient
                .updateMessage(payload.messageChannelId, payload.messageId, {
                  components: [],
                })
                .pipe(
                  Effect.as(true),
                  Effect.catchCause((cause) =>
                    Effect.logError("Failed to clean up fallback tentative room order").pipe(
                      Effect.annotateLogs({
                        guildId: payload.guildId,
                        channelId: payload.messageChannelId,
                        messageId: payload.messageId,
                      }),
                      Effect.andThen(Effect.logError(cause)),
                      Effect.as(false),
                    ),
                  ),
                )
            : false;

          const detail = pinned
            ? cleanedUp
              ? "pinned tentative room order!"
              : "pinned tentative room order, but failed to clean up the message."
            : "tentative room order could not be pinned.";
          yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
            content: detail,
            components: [],
          });

          return {
            messageId: payload.messageId,
            messageChannelId: payload.messageChannelId,
            action: payload.action,
            status: pinned ? (cleanedUp ? "pinned" : "partial") : "partial",
            detail,
          } satisfies RoomOrderHandleButtonResult;
        }
        const initialRoomOrder = yield* Option.match(maybeInitialRoomOrder, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              makeArgumentError("Cannot handle room-order button, message is not registered"),
            ),
        });
        const trustedGuildId = yield* requireOptionValue(
          initialRoomOrder.guildId,
          "Cannot handle room-order button, message guild is not registered",
        );
        const trustedMessageChannelId = yield* requireOptionValue(
          initialRoomOrder.messageChannelId,
          "Cannot handle room-order button, message channel is not registered",
        );
        const mode = hasTentativeRoomOrderPrefix(payload.messageContent ?? "")
          ? "tentative"
          : "normal";
        const renderReply = (
          roomOrder: MessageRoomOrder,
          replyMode: "normal" | "tentative" = mode,
        ) =>
          renderRoomOrderReply({
            guildId: trustedGuildId,
            messageId: payload.messageId,
            mode: replyMode,
            roomOrder,
            guildConfigService,
            sheetService,
            messageRoomOrderService,
          });

        const updateInteraction = (
          content: string,
          components: ReadonlyArray<Record<string, unknown>> = [],
        ) =>
          botClient.updateOriginalInteractionResponse(payload.interactionToken, {
            content,
            components,
          });

        if (payload.action === "previous" || payload.action === "next") {
          const isPrevious = payload.action === "previous";
          if (
            mode === "tentative" &&
            (Option.isSome(initialRoomOrder.tentativePinnedAt) ||
              Option.isSome(initialRoomOrder.tentativePinClaimId))
          ) {
            const detail = "tentative room order is already pinned.";
            yield* updateInteraction(detail);
            return {
              messageId: payload.messageId,
              messageChannelId: trustedMessageChannelId,
              action: payload.action,
              status: "denied",
              detail,
            } satisfies RoomOrderHandleButtonResult;
          }

          const updatedRank = yield* isPrevious
            ? messageRoomOrderService.decrementMessageRoomOrderRank(payload.messageId)
            : messageRoomOrderService.incrementMessageRoomOrderRank(payload.messageId);

          if (mode === "tentative") {
            const latestRoomOrder = yield* messageRoomOrderService.getMessageRoomOrder(
              payload.messageId,
            );
            const pinnedRoomOrder = Option.match(latestRoomOrder, {
              onSome: (roomOrder) =>
                Option.isSome(roomOrder.tentativePinnedAt) ||
                Option.isSome(roomOrder.tentativePinClaimId)
                  ? Option.some(roomOrder)
                  : Option.none(),
              onNone: () => Option.none(),
            });
            if (Option.isSome(pinnedRoomOrder)) {
              yield* (
                isPrevious
                  ? messageRoomOrderService.incrementMessageRoomOrderRank(payload.messageId)
                  : messageRoomOrderService.decrementMessageRoomOrderRank(payload.messageId)
              ).pipe(Effect.catchCause(() => Effect.void));
              const detail = "tentative room order is already pinned.";
              yield* updateInteraction(detail);
              return {
                messageId: payload.messageId,
                messageChannelId: trustedMessageChannelId,
                action: payload.action,
                status: "denied",
                detail,
              } satisfies RoomOrderHandleButtonResult;
            }

            const reply = yield* renderReply(updatedRank);
            yield* botClient.updateMessage(trustedMessageChannelId, payload.messageId, reply).pipe(
              Effect.catchCause((cause) =>
                (isPrevious
                  ? messageRoomOrderService.incrementMessageRoomOrderRank(payload.messageId)
                  : messageRoomOrderService.decrementMessageRoomOrderRank(payload.messageId)
                ).pipe(
                  Effect.catchCause(() => Effect.void),
                  Effect.andThen(Effect.failCause(cause)),
                ),
              ),
            );
            yield* updateInteraction("updated tentative room order.");
          } else {
            const reply = yield* renderReply(updatedRank);
            yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, reply);
          }

          return {
            messageId: payload.messageId,
            messageChannelId: trustedMessageChannelId,
            action: payload.action,
            status: "updated",
            detail: null,
          } satisfies RoomOrderHandleButtonResult;
        }

        if (payload.action === "send") {
          if (
            Option.isSome(initialRoomOrder.sentMessageId) &&
            Option.isSome(initialRoomOrder.sentMessageChannelId)
          ) {
            const detail = "room order was already sent.";
            yield* updateInteraction(detail);
            return {
              messageId: initialRoomOrder.sentMessageId.value,
              messageChannelId: initialRoomOrder.sentMessageChannelId.value,
              action: payload.action,
              status: "sent",
              detail,
            } satisfies RoomOrderHandleButtonResult;
          }

          const reply = yield* renderReply(initialRoomOrder, "normal");
          const claimId = globalThis.crypto.randomUUID();
          const claimedRoomOrder = yield* messageRoomOrderService.claimMessageRoomOrderSend(
            payload.messageId,
            claimId,
          );
          if (
            Option.isSome(claimedRoomOrder.sentMessageId) &&
            Option.isSome(claimedRoomOrder.sentMessageChannelId)
          ) {
            const detail = "room order was already sent.";
            yield* updateInteraction(detail);
            return {
              messageId: claimedRoomOrder.sentMessageId.value,
              messageChannelId: claimedRoomOrder.sentMessageChannelId.value,
              action: payload.action,
              status: "sent",
              detail,
            } satisfies RoomOrderHandleButtonResult;
          }
          if (!Option.contains(claimedRoomOrder.sendClaimId, claimId)) {
            const detail = "room order is already being sent.";
            yield* updateInteraction(detail);
            return {
              messageId: payload.messageId,
              messageChannelId: trustedMessageChannelId,
              action: payload.action,
              status: "denied",
              detail,
            } satisfies RoomOrderHandleButtonResult;
          }

          const sentMessage = yield* botClient
            .sendMessage(trustedMessageChannelId, {
              content: reply.content,
              nonce: payload.messageId,
              enforce_nonce: true,
            })
            .pipe(
              Effect.catchCause((cause) =>
                messageRoomOrderService
                  .releaseMessageRoomOrderSendClaim(payload.messageId, claimId)
                  .pipe(
                    Effect.catchCause(() => Effect.void),
                    Effect.andThen(Effect.failCause(cause)),
                  ),
              ),
            );
          const completedRoomOrder = yield* messageRoomOrderService.completeMessageRoomOrderSend(
            payload.messageId,
            claimId,
            {
              id: sentMessage.id,
              channelId: sentMessage.channel_id,
            },
          );
          if (
            !(
              Option.isNone(completedRoomOrder.sendClaimId) &&
              Option.contains(completedRoomOrder.sentMessageId, sentMessage.id) &&
              Option.contains(completedRoomOrder.sentMessageChannelId, sentMessage.channel_id)
            )
          ) {
            return yield* Effect.fail(makeArgumentError("Failed to persist sent room order state"));
          }
          const pinned = yield* botClient.createPin(sentMessage.channel_id, sentMessage.id).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logError("Failed to pin sent room order").pipe(
                Effect.annotateLogs({
                  guildId: trustedGuildId,
                  channelId: sentMessage.channel_id,
                  messageId: sentMessage.id,
                }),
                Effect.andThen(Effect.logError(cause)),
                Effect.as(false),
              ),
            ),
          );

          const detail = pinned
            ? "sent room order and pinned it!"
            : "sent room order, but failed to pin it.";
          yield* updateInteraction(detail);

          return {
            messageId: sentMessage.id,
            messageChannelId: sentMessage.channel_id,
            action: payload.action,
            status: pinned ? "pinned" : "partial",
            detail,
          } satisfies RoomOrderHandleButtonResult;
        }

        if (payload.action !== "pinTentative") {
          const exhaustive: never = payload.action;
          return exhaustive;
        }

        const pinClaimId = globalThis.crypto.randomUUID();
        const pinClaimedRoomOrder =
          yield* messageRoomOrderService.claimMessageRoomOrderTentativePin(
            payload.messageId,
            pinClaimId,
          );
        if (Option.isSome(pinClaimedRoomOrder.tentativePinnedAt)) {
          const detail = "tentative room order is already pinned.";
          yield* updateInteraction(detail);
          return {
            messageId: payload.messageId,
            messageChannelId: trustedMessageChannelId,
            action: payload.action,
            status: "denied",
            detail,
          } satisfies RoomOrderHandleButtonResult;
        }
        if (!Option.contains(pinClaimedRoomOrder.tentativePinClaimId, pinClaimId)) {
          const detail = "tentative room order is already being pinned.";
          yield* updateInteraction(detail);
          return {
            messageId: payload.messageId,
            messageChannelId: trustedMessageChannelId,
            action: payload.action,
            status: "denied",
            detail,
          } satisfies RoomOrderHandleButtonResult;
        }

        const pinned = yield* botClient.createPin(trustedMessageChannelId, payload.messageId).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logError("Failed to pin tentative room order").pipe(
              Effect.annotateLogs({
                guildId: trustedGuildId,
                channelId: trustedMessageChannelId,
                messageId: payload.messageId,
              }),
              Effect.andThen(Effect.logError(cause)),
              Effect.as(false),
            ),
          ),
        );

        if (!pinned) {
          yield* messageRoomOrderService
            .releaseMessageRoomOrderTentativePinClaim(payload.messageId, pinClaimId)
            .pipe(Effect.catchCause(() => Effect.void));
        }

        const pinnedRoomOrder = pinned
          ? yield* messageRoomOrderService.completeMessageRoomOrderTentativePin(
              payload.messageId,
              pinClaimId,
            )
          : null;

        const cleanedUp = pinned
          ? yield* Effect.gen(function* () {
              const latestReply = yield* renderReply(pinnedRoomOrder ?? initialRoomOrder, "normal");

              return yield* botClient
                .updateMessage(trustedMessageChannelId, payload.messageId, {
                  content: latestReply.content,
                  components: [],
                })
                .pipe(
                  Effect.as(true),
                  Effect.catchCause((cause) =>
                    Effect.logError("Failed to clean up pinned tentative room order").pipe(
                      Effect.annotateLogs({
                        guildId: trustedGuildId,
                        channelId: trustedMessageChannelId,
                        messageId: payload.messageId,
                      }),
                      Effect.andThen(Effect.logError(cause)),
                      Effect.as(false),
                    ),
                  ),
                );
            })
          : false;

        const detail = pinned
          ? cleanedUp
            ? "pinned tentative room order!"
            : "pinned tentative room order, but failed to clean up the message."
          : "tentative room order could not be pinned.";
        yield* updateInteraction(detail);

        return {
          messageId: payload.messageId,
          messageChannelId: trustedMessageChannelId,
          action: payload.action,
          status: pinned ? (cleanedUp ? "pinned" : "partial") : "partial",
          detail,
        } satisfies RoomOrderHandleButtonResult;
      }),
    };
  }),
}) {
  static layer = Layer.effect(DispatchService, this.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        IngressBotClient.layer,
        CheckinService.layer,
        GuildConfigService.layer,
        MessageCheckinService.layer,
        MessageRoomOrderService.layer,
        RoomOrderService.layer,
        SheetService.layer,
      ),
    ),
  );
}
