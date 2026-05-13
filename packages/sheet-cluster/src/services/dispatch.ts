import {
  Chunk,
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Schema,
  String as EffectString,
  pipe,
} from "effect";
import { DiscordMessageRequestSchema } from "dfx-discord-utils/discord/schema";
import {
  formatTentativeRoomOrderContent,
  hasTentativeRoomOrderPrefix,
  shouldSendTentativeRoomOrder,
} from "sheet-ingress-api/discordComponents";
import type { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import type {
  CheckinDispatchPayload,
  CheckinDispatchResult,
  CheckinHandleButtonPayload,
  CheckinHandleButtonResult,
  KickoutDispatchPayload,
  KickoutDispatchResult,
  RoomOrderButtonBasePayload,
  RoomOrderButtonResult,
  RoomOrderDispatchPayload,
  RoomOrderDispatchResult,
  SlotButtonDispatchPayload,
  SlotButtonDispatchResult,
  SlotListDispatchPayload,
  SlotListDispatchResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import * as Sheet from "sheet-ingress-api/schemas/sheet";
import { makeArgumentError } from "typhoon-core/error";
import {
  checkinActionRow,
  roomOrderActionRow,
  slotActionRow,
  tentativeRoomOrderActionRow,
  tentativeRoomOrderPinActionRow,
} from "./discordComponents";
import { IngressBotClient } from "./ingressBotClient";
import { buildRoomOrderContent } from "./roomOrderContent";
import { SheetApisClient } from "./sheetApisClient";

const MessageFlags = {
  Ephemeral: 64,
} as const;

type DiscordMessage = {
  readonly id: string;
  readonly channel_id: string;
};

type MessagePayload = Schema.Schema.Type<typeof DiscordMessageRequestSchema>;
type SheetServiceApi = {
  readonly getEventConfig: ReturnType<
    typeof makeSheetApisServices
  >["sheetService"]["getEventConfig"];
};
type RoomOrderButtonAction = "previous" | "next" | "send" | "pinTentative";
type RoomOrderButtonPayload = RoomOrderButtonBasePayload & {
  readonly action: RoomOrderButtonAction;
};

export type DispatchRequester = {
  readonly accountId: string;
  readonly userId: string;
};

type DispatchMessageSink = {
  readonly sendPrimary: (payload: MessagePayload) => Effect.Effect<DiscordMessage, unknown, never>;
  readonly updatePrimary: (
    message: DiscordMessage,
    payload: MessagePayload,
  ) => Effect.Effect<DiscordMessage, unknown, never>;
};

const optionalArgumentError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        error._tag === "ArgumentError",
      () => Effect.succeed(Option.none<A>()),
    ),
  );

const makeSheetApisServices = (sheetApisClient: typeof SheetApisClient.Service) => {
  const sheetApis = sheetApisClient.get();

  const messageRoomOrderService = {
    getMessageRoomOrder: (messageId: string) =>
      optionalArgumentError(
        sheetApis.messageRoomOrder.getMessageRoomOrder({ query: { messageId } }),
      ),
    upsertMessageRoomOrder: (
      messageId: string,
      data: Parameters<
        typeof sheetApis.messageRoomOrder.upsertMessageRoomOrder
      >[0]["payload"]["data"],
    ) => sheetApis.messageRoomOrder.upsertMessageRoomOrder({ payload: { messageId, data } }),
    persistMessageRoomOrder: (
      messageId: string,
      payload: Omit<
        Parameters<typeof sheetApis.messageRoomOrder.persistMessageRoomOrder>[0]["payload"],
        "messageId"
      >,
    ) =>
      sheetApis.messageRoomOrder.persistMessageRoomOrder({
        payload: { messageId, ...payload },
      }),
    decrementMessageRoomOrderRank: (
      messageId: string,
      payload: Omit<
        Parameters<typeof sheetApis.messageRoomOrder.decrementMessageRoomOrderRank>[0]["payload"],
        "messageId"
      >,
    ) =>
      sheetApis.messageRoomOrder.decrementMessageRoomOrderRank({
        payload: { messageId, ...payload },
      }),
    incrementMessageRoomOrderRank: (
      messageId: string,
      payload: Omit<
        Parameters<typeof sheetApis.messageRoomOrder.incrementMessageRoomOrderRank>[0]["payload"],
        "messageId"
      >,
    ) =>
      sheetApis.messageRoomOrder.incrementMessageRoomOrderRank({
        payload: { messageId, ...payload },
      }),
    getMessageRoomOrderEntry: (messageId: string, rank: number) =>
      sheetApis.messageRoomOrder.getMessageRoomOrderEntry({ query: { messageId, rank } }),
    getMessageRoomOrderRange: (messageId: string) =>
      optionalArgumentError(
        sheetApis.messageRoomOrder.getMessageRoomOrderRange({ query: { messageId } }),
      ),
    removeMessageRoomOrderEntry: (messageId: string) =>
      sheetApis.messageRoomOrder.removeMessageRoomOrderEntry({ payload: { messageId } }),
    claimMessageRoomOrderSend: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.claimMessageRoomOrderSend({ payload: { messageId, claimId } }),
    completeMessageRoomOrderSend: (
      messageId: string,
      claimId: string,
      sentMessage: { readonly id: string; readonly channelId: string },
    ) =>
      sheetApis.messageRoomOrder.completeMessageRoomOrderSend({
        payload: { messageId, claimId, sentMessage },
      }),
    releaseMessageRoomOrderSendClaim: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.releaseMessageRoomOrderSendClaim({
        payload: { messageId, claimId },
      }),
    claimMessageRoomOrderTentativeUpdate: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.claimMessageRoomOrderTentativeUpdate({
        payload: { messageId, claimId },
      }),
    releaseMessageRoomOrderTentativeUpdateClaim: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.releaseMessageRoomOrderTentativeUpdateClaim({
        payload: { messageId, claimId },
      }),
    claimMessageRoomOrderTentativePin: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.claimMessageRoomOrderTentativePin({
        payload: { messageId, claimId },
      }),
    completeMessageRoomOrderTentativePin: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.completeMessageRoomOrderTentativePin({
        payload: { messageId, claimId },
      }),
    releaseMessageRoomOrderTentativePinClaim: (messageId: string, claimId: string) =>
      sheetApis.messageRoomOrder.releaseMessageRoomOrderTentativePinClaim({
        payload: { messageId, claimId },
      }),
    markMessageRoomOrderTentative: (messageId: string) =>
      sheetApis.messageRoomOrder.markMessageRoomOrderTentative({
        payload: { messageId },
      }),
  };

  return {
    checkinService: {
      generate: (payload: CheckinDispatchPayload) => sheetApis.checkin.generate({ payload }),
    },
    guildConfigService: {
      getGuildConfig: (guildId: string) =>
        optionalArgumentError(sheetApis.guildConfig.getGuildConfig({ query: { guildId } })),
      getGuildChannelById: (query: {
        readonly guildId: string;
        readonly channelId: string;
        readonly running?: boolean | undefined;
      }) => optionalArgumentError(sheetApis.guildConfig.getGuildChannelById({ query })),
      getGuildChannelByName: (query: {
        readonly guildId: string;
        readonly channelName: string;
        readonly running?: boolean | undefined;
      }) => optionalArgumentError(sheetApis.guildConfig.getGuildChannelByName({ query })),
    },
    messageCheckinService: {
      getMessageCheckinData: (messageId: string) =>
        optionalArgumentError(
          sheetApis.messageCheckin.getMessageCheckinData({ query: { messageId } }),
        ),
      getMessageCheckinMembers: (messageId: string) =>
        sheetApis.messageCheckin.getMessageCheckinMembers({ query: { messageId } }),
      persistMessageCheckin: (
        messageId: string,
        payload: Omit<
          Parameters<typeof sheetApis.messageCheckin.persistMessageCheckin>[0]["payload"],
          "messageId"
        >,
      ) => sheetApis.messageCheckin.persistMessageCheckin({ payload: { messageId, ...payload } }),
      setMessageCheckinMemberCheckinAtIfUnset: (
        messageId: string,
        memberId: string,
        checkinAt: number,
        checkinClaimId: string,
      ) =>
        sheetApis.messageCheckin.setMessageCheckinMemberCheckinAtIfUnset({
          payload: { messageId, memberId, checkinAt, checkinClaimId },
        }),
    },
    messageRoomOrderService,
    messageSlotService: {
      upsertMessageSlotData: (
        messageId: string,
        data: Parameters<typeof sheetApis.messageSlot.upsertMessageSlotData>[0]["payload"]["data"],
      ) => sheetApis.messageSlot.upsertMessageSlotData({ payload: { messageId, data } }),
    },
    roomOrderService: {
      generate: (
        payload: RoomOrderDispatchPayload | { guildId: string; channelId: string; hour: number },
      ) => sheetApis.roomOrder.generate({ payload }),
    },
    scheduleService: {
      dayPopulatedFillerSchedules: (guildId: string, day: number) =>
        sheetApis.schedule
          .getDayPopulatedSchedules({ query: { guildId, day, view: "filler" } })
          .pipe(Effect.map(({ schedules }) => schedules)),
      channelPopulatedMonitorSchedules: (guildId: string, channel: string) =>
        sheetApis.schedule
          .getChannelPopulatedSchedules({ query: { guildId, channel, view: "monitor" } })
          .pipe(Effect.map(({ schedules }) => schedules)),
    },
    sheetService: {
      getEventConfig: (guildId: string) => sheetApis.sheet.getEventConfig({ query: { guildId } }),
    },
  };
};

const logEnableFailure = (message: string) => (error: unknown) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ cause: globalThis.String(error) }));

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

const bold = (value: string): string => `**${value}**`;

const time = (epochSeconds: number): string => `<t:${Math.floor(epochSeconds)}:t>`;

const makeEmbed = (embed: {
  readonly title?: string;
  readonly description?: string | null;
  readonly fields?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly color?: number;
}) => embed;

const makeWebScheduleEmbed = () =>
  makeEmbed({
    description: "📅 **Preview**: View your schedule online at <https://schedule.theerapakg.moe/>",
    color: 0x5865f2,
  });

const formatDateTime = (dateTime: DateTime.DateTime) => DateTime.toEpochMillis(dateTime) / 1000;

const hourWindowFor = (eventConfig: { readonly startTime: DateTime.DateTime }, hour: number) => ({
  start: pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(hour - 1))),
  end: pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(hour))),
});

const formatHourWindow = (hourWindow: {
  readonly start: DateTime.DateTime;
  readonly end: DateTime.DateTime;
}) => `${time(formatDateTime(hourWindow.start))}-${time(formatDateTime(hourWindow.end))}`;

const formatScheduleRange = (
  schedule: Sheet.PopulatedBreakSchedule | Sheet.PopulatedSchedule,
  eventConfig: { readonly startTime: DateTime.DateTime },
) =>
  pipe(
    schedule.hourWindow,
    Option.match({
      onSome: (hourWindow) => formatHourWindow(hourWindow),
      onNone: () =>
        pipe(
          schedule.hour,
          Option.match({
            onSome: (hour) => formatHourWindow(hourWindowFor(eventConfig, hour)),
            onNone: () => "??-??",
          }),
        ),
    }),
  );

const formatOpenSlot = (
  schedule: Sheet.PopulatedBreakSchedule | Sheet.PopulatedSchedule,
  eventConfig: { readonly startTime: DateTime.DateTime },
) =>
  Match.value(schedule).pipe(
    Match.tagsExhaustive({
      PopulatedBreakSchedule: () => "",
      PopulatedSchedule: (schedule) => {
        const empty = Sheet.PopulatedSchedule.empty(schedule);
        const slotCountString = schedule.visible ? bold(`+${empty} |`) : "";
        const hourString = pipe(
          schedule.hour,
          Option.map((hour) => bold(`hour ${hour}`)),
          Option.getOrElse(() => bold("hour ??")),
        );
        const rangeString = formatScheduleRange(schedule, eventConfig);

        return !schedule.visible || empty > 0
          ? [slotCountString, hourString, rangeString].filter(EffectString.isNonEmpty).join(" ")
          : "";
      },
    }),
  );

const formatFilledSlot = (
  schedule: Sheet.PopulatedBreakSchedule | Sheet.PopulatedSchedule,
  eventConfig: { readonly startTime: DateTime.DateTime },
) =>
  Match.value(schedule).pipe(
    Match.tagsExhaustive({
      PopulatedBreakSchedule: () => "",
      PopulatedSchedule: (schedule) => {
        const empty = Sheet.PopulatedSchedule.empty(schedule);
        const hourString = pipe(
          schedule.hour,
          Option.map((hour) => bold(`hour ${hour}`)),
          Option.getOrElse(() => bold("hour ??")),
        );
        const rangeString = formatScheduleRange(schedule, eventConfig);

        return schedule.visible && empty === 0
          ? [hourString, rangeString].filter(EffectString.isNonEmpty).join(" ")
          : "";
      },
    }),
  );

const joinDedupeAdjacent = (items: ReadonlyArray<string>) =>
  pipe(Chunk.fromIterable(items), Chunk.dedupeAdjacent, Chunk.join("\n"));

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
  sheetService,
  messageRoomOrderService,
}: {
  readonly guildId: string;
  readonly messageId: string;
  readonly mode: "normal" | "tentative";
  readonly roomOrder: MessageRoomOrder;
  readonly sheetService: SheetServiceApi;
  readonly messageRoomOrderService: ReturnType<
    typeof makeSheetApisServices
  >["messageRoomOrderService"];
}) {
  const maybeRange = yield* messageRoomOrderService.getMessageRoomOrderRange(messageId);
  const entries = yield* messageRoomOrderService.getMessageRoomOrderEntry(
    messageId,
    roomOrder.rank,
  );
  const range = yield* Option.match(maybeRange, {
    onSome: Effect.succeed,
    onNone: () => Effect.fail(makeArgumentError("Cannot render room order, no entries found")),
  });
  const eventConfig = yield* sheetService.getEventConfig(guildId);
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
  readonly roomOrderService: ReturnType<typeof makeSheetApisServices>["roomOrderService"];
  readonly messageRoomOrderService: ReturnType<
    typeof makeSheetApisServices
  >["messageRoomOrderService"];
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
    const sheetApisClient = yield* SheetApisClient;
    const {
      checkinService,
      guildConfigService,
      messageCheckinService,
      messageRoomOrderService,
      messageSlotService,
      roomOrderService,
      scheduleService,
      sheetService,
    } = makeSheetApisServices(sheetApisClient);

    const roomOrderButton = Effect.fn("DispatchService.roomOrderButton")(function* (
      payload: RoomOrderButtonPayload,
      authorizedRoomOrder?: MessageRoomOrder | null,
    ) {
      const failRoomOrderInteraction = (content: string, errorMessage: string) =>
        botClient
          .updateOriginalInteractionResponse(payload.interactionToken, {
            content,
            components: [],
          })
          .pipe(Effect.andThen(Effect.fail(makeArgumentError(errorMessage))));
      const requireRoomOrderMatch = (roomOrder: MessageRoomOrder) =>
        Effect.gen(function* () {
          if (
            !Option.contains(roomOrder.guildId, payload.guildId) ||
            !Option.contains(roomOrder.messageChannelId, payload.messageChannelId)
          ) {
            return yield* failRoomOrderInteraction(
              "This room-order message authorization changed.",
              "Cannot handle room-order button, authorization changed",
            );
          }
        });
      const requireClaimedRoomOrderMatch = (
        roomOrder: MessageRoomOrder,
        releaseClaim: Effect.Effect<unknown, unknown, never>,
      ) =>
        requireRoomOrderMatch(roomOrder).pipe(
          Effect.catchCause((cause) =>
            releaseClaim.pipe(
              Effect.catchCause(() => Effect.void),
              Effect.andThen(Effect.failCause(cause)),
            ),
          ),
        );
      const requireCurrentRoomOrderMatch = () =>
        Effect.gen(function* () {
          const maybeCurrentRoomOrder = yield* messageRoomOrderService.getMessageRoomOrder(
            payload.messageId,
          );
          const currentRoomOrder = yield* Option.match(maybeCurrentRoomOrder, {
            onSome: Effect.succeed,
            onNone: () =>
              failRoomOrderInteraction(
                "This room-order message is not registered.",
                "Cannot handle room-order button, message is not registered",
              ),
          });
          yield* requireRoomOrderMatch(currentRoomOrder);
          return currentRoomOrder;
        });
      const maybeInitialRoomOrder =
        authorizedRoomOrder === null
          ? Option.none<MessageRoomOrder>()
          : authorizedRoomOrder === undefined
            ? yield* messageRoomOrderService.getMessageRoomOrder(payload.messageId)
            : Option.some(authorizedRoomOrder);
      if (Option.isNone(maybeInitialRoomOrder) && payload.action === "pinTentative") {
        const fallbackChannel = yield* guildConfigService.getGuildChannelById({
          guildId: payload.guildId,
          channelId: payload.messageChannelId,
          running: true,
        });
        if (Option.isNone(fallbackChannel)) {
          yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
            content: "This channel is not a registered running channel.",
            components: [],
          });
          return yield* Effect.fail(
            makeArgumentError(
              "Cannot handle room-order button, message channel is not a registered running channel",
            ),
          );
        }

        const pinned = yield* botClient.createPin(payload.messageChannelId, payload.messageId).pipe(
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
          status: pinned ? (cleanedUp ? "pinned" : "partial") : "failed",
          detail,
        } satisfies RoomOrderButtonResult;
      }
      const initialRoomOrder = yield* Option.match(maybeInitialRoomOrder, {
        onSome: Effect.succeed,
        onNone: () =>
          botClient
            .updateOriginalInteractionResponse(payload.interactionToken, {
              content: "This room-order message is not registered.",
              components: [],
            })
            .pipe(
              Effect.andThen(
                Effect.fail(
                  makeArgumentError("Cannot handle room-order button, message is not registered"),
                ),
              ),
            ),
      });
      yield* requireRoomOrderMatch(initialRoomOrder);
      const trustedGuildId = yield* Option.match(initialRoomOrder.guildId, {
        onSome: Effect.succeed,
        onNone: () =>
          failRoomOrderInteraction(
            "This room-order message guild is not registered.",
            "Cannot handle room-order button, message guild is not registered",
          ),
      });
      const trustedMessageChannelId = yield* Option.match(initialRoomOrder.messageChannelId, {
        onSome: Effect.succeed,
        onNone: () =>
          failRoomOrderInteraction(
            "This room-order message channel is not registered.",
            "Cannot handle room-order button, message channel is not registered",
          ),
      });
      const messageHasTentativePrefix = hasTentativeRoomOrderPrefix(payload.messageContent ?? "");
      const effectiveInitialRoomOrder =
        !initialRoomOrder.tentative && messageHasTentativePrefix
          ? yield* messageRoomOrderService.markMessageRoomOrderTentative(payload.messageId).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Failed to repair legacy tentative room-order flag").pipe(
                  Effect.annotateLogs({
                    guildId: trustedGuildId,
                    messageId: payload.messageId,
                    channelId: trustedMessageChannelId,
                  }),
                  Effect.andThen(Effect.logError(cause)),
                  Effect.as(initialRoomOrder),
                ),
              ),
            )
          : initialRoomOrder;
      const mode = effectiveInitialRoomOrder.tentative ? "tentative" : "normal";
      const interactionResponseType =
        payload.interactionResponseType ?? (mode === "tentative" ? "reply" : "update");
      const renderReply = (roomOrder: MessageRoomOrder, replyMode: "normal" | "tentative" = mode) =>
        renderRoomOrderReply({
          guildId: trustedGuildId,
          messageId: payload.messageId,
          mode: replyMode,
          roomOrder,
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

      const getRoomOrderBusyDetail = (roomOrder: MessageRoomOrder) => {
        if (Option.isSome(roomOrder.sendClaimId)) {
          return "room order is already being sent.";
        }
        if (Option.isSome(roomOrder.tentativeUpdateClaimId)) {
          return "tentative room order is already being updated.";
        }
        if (Option.isSome(roomOrder.tentativePinnedAt)) {
          return "tentative room order is already pinned.";
        }
        return "tentative room order is already being pinned.";
      };

      if (payload.action === "previous" || payload.action === "next") {
        const isPrevious = payload.action === "previous";
        if (mode === "tentative" && Option.isSome(initialRoomOrder.tentativePinnedAt)) {
          const detail = "tentative room order is already pinned.";
          yield* updateInteraction(detail);
          return {
            messageId: payload.messageId,
            messageChannelId: trustedMessageChannelId,
            status: "denied",
            detail,
          } satisfies RoomOrderButtonResult;
        }

        yield* requireCurrentRoomOrderMatch();
        const updateClaimId = globalThis.crypto.randomUUID();
        const claimedRoomOrder =
          yield* messageRoomOrderService.claimMessageRoomOrderTentativeUpdate(
            payload.messageId,
            updateClaimId,
          );
        yield* requireClaimedRoomOrderMatch(
          claimedRoomOrder,
          messageRoomOrderService.releaseMessageRoomOrderTentativeUpdateClaim(
            payload.messageId,
            updateClaimId,
          ),
        );
        if (
          Option.isSome(claimedRoomOrder.tentativePinnedAt) ||
          Option.isSome(claimedRoomOrder.tentativePinClaimId) ||
          !Option.contains(claimedRoomOrder.tentativeUpdateClaimId, updateClaimId)
        ) {
          const detail = getRoomOrderBusyDetail(claimedRoomOrder);
          yield* updateInteraction(detail);
          return {
            messageId: payload.messageId,
            messageChannelId: trustedMessageChannelId,
            status: "denied",
            detail,
          } satisfies RoomOrderButtonResult;
        }

        const updatedRank = yield* (
          isPrevious
            ? messageRoomOrderService.decrementMessageRoomOrderRank(payload.messageId, {
                expectedRank: initialRoomOrder.rank,
                tentativeUpdateClaimId: updateClaimId,
              })
            : messageRoomOrderService.incrementMessageRoomOrderRank(payload.messageId, {
                expectedRank: initialRoomOrder.rank,
                tentativeUpdateClaimId: updateClaimId,
              })
        ).pipe(
          Effect.catchCause((cause) =>
            messageRoomOrderService
              .releaseMessageRoomOrderTentativeUpdateClaim(payload.messageId, updateClaimId)
              .pipe(
                Effect.catchCause(() => Effect.void),
                Effect.andThen(Effect.failCause(cause)),
              ),
          ),
        );
        const expectedRank = initialRoomOrder.rank + (isPrevious ? -1 : 1);
        if (updatedRank.rank !== expectedRank) {
          const detail =
            Option.isSome(updatedRank.sendClaimId) ||
            Option.isSome(updatedRank.tentativeUpdateClaimId) ||
            Option.isSome(updatedRank.tentativePinnedAt) ||
            Option.isSome(updatedRank.tentativePinClaimId)
              ? getRoomOrderBusyDetail(updatedRank)
              : "room order could not be updated.";
          yield* messageRoomOrderService
            .releaseMessageRoomOrderTentativeUpdateClaim(payload.messageId, updateClaimId)
            .pipe(Effect.catchCause(() => Effect.void));
          yield* updateInteraction(detail);
          return {
            messageId: payload.messageId,
            messageChannelId: trustedMessageChannelId,
            status: "denied",
            detail,
          } satisfies RoomOrderButtonResult;
        }

        const rollbackRankUpdate = (cause: Cause.Cause<unknown>) =>
          (isPrevious
            ? messageRoomOrderService.incrementMessageRoomOrderRank(payload.messageId, {
                expectedRank: updatedRank.rank,
                tentativeUpdateClaimId: updateClaimId,
              })
            : messageRoomOrderService.decrementMessageRoomOrderRank(payload.messageId, {
                expectedRank: updatedRank.rank,
                tentativeUpdateClaimId: updateClaimId,
              })
          ).pipe(
            Effect.catchCause(() => Effect.void),
            Effect.andThen(
              messageRoomOrderService
                .releaseMessageRoomOrderTentativeUpdateClaim(payload.messageId, updateClaimId)
                .pipe(Effect.catchCause(() => Effect.void)),
            ),
            Effect.andThen(
              updateInteraction("room order could not be updated.").pipe(
                Effect.catchCause(() => Effect.void),
              ),
            ),
            Effect.andThen(Effect.failCause(cause)),
          );

        if (mode === "tentative") {
          const reply = yield* renderReply(updatedRank).pipe(Effect.catchCause(rollbackRankUpdate));
          yield* botClient
            .updateMessage(trustedMessageChannelId, payload.messageId, reply)
            .pipe(Effect.catchCause(rollbackRankUpdate));
          yield* messageRoomOrderService
            .releaseMessageRoomOrderTentativeUpdateClaim(payload.messageId, updateClaimId)
            .pipe(Effect.catchCause(() => Effect.void));
          if (interactionResponseType === "reply") {
            yield* updateInteraction("updated tentative room order.");
          }
        } else {
          const reply = yield* renderReply(updatedRank).pipe(Effect.catchCause(rollbackRankUpdate));
          if (interactionResponseType === "reply") {
            yield* botClient
              .updateMessage(trustedMessageChannelId, payload.messageId, reply)
              .pipe(Effect.catchCause(rollbackRankUpdate));
          } else {
            yield* botClient
              .updateOriginalInteractionResponse(payload.interactionToken, reply)
              .pipe(Effect.catchCause(rollbackRankUpdate));
          }
          yield* messageRoomOrderService
            .releaseMessageRoomOrderTentativeUpdateClaim(payload.messageId, updateClaimId)
            .pipe(Effect.catchCause(() => Effect.void));
          if (interactionResponseType === "reply") {
            yield* updateInteraction("updated room order.");
          }
        }

        return {
          messageId: payload.messageId,
          messageChannelId: trustedMessageChannelId,
          status: "updated",
          detail: null,
        } satisfies RoomOrderButtonResult;
      }

      if (payload.action === "send") {
        if (mode === "tentative") {
          const detail = "cannot send a tentative room order.";
          yield* updateInteraction(detail);
          return {
            messageId: payload.messageId,
            messageChannelId: trustedMessageChannelId,
            status: "denied",
            detail,
          } satisfies RoomOrderButtonResult;
        }
        if (
          Option.isSome(initialRoomOrder.sentMessageId) &&
          Option.isSome(initialRoomOrder.sentMessageChannelId)
        ) {
          const detail = "room order was already sent.";
          yield* updateInteraction(detail);
          return {
            messageId: initialRoomOrder.sentMessageId.value,
            messageChannelId: initialRoomOrder.sentMessageChannelId.value,
            status: "sent",
            detail,
          } satisfies RoomOrderButtonResult;
        }
        if (Option.isSome(initialRoomOrder.tentativePinnedAt)) {
          const detail = "tentative room order is already pinned.";
          yield* updateInteraction(detail);
          return {
            messageId: payload.messageId,
            messageChannelId: trustedMessageChannelId,
            status: "denied",
            detail,
          } satisfies RoomOrderButtonResult;
        }

        yield* requireCurrentRoomOrderMatch();
        const claimId = globalThis.crypto.randomUUID();
        const claimedRoomOrder = yield* messageRoomOrderService.claimMessageRoomOrderSend(
          payload.messageId,
          claimId,
        );
        yield* requireClaimedRoomOrderMatch(
          claimedRoomOrder,
          messageRoomOrderService.releaseMessageRoomOrderSendClaim(payload.messageId, claimId),
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
            status: "sent",
            detail,
          } satisfies RoomOrderButtonResult;
        }
        if (!Option.contains(claimedRoomOrder.sendClaimId, claimId)) {
          const detail = getRoomOrderBusyDetail(claimedRoomOrder);
          yield* updateInteraction(detail);
          return {
            messageId: payload.messageId,
            messageChannelId: trustedMessageChannelId,
            status: "denied",
            detail,
          } satisfies RoomOrderButtonResult;
        }

        const reply = yield* renderReply(claimedRoomOrder, "normal").pipe(
          Effect.catchCause((cause) =>
            messageRoomOrderService
              .releaseMessageRoomOrderSendClaim(payload.messageId, claimId)
              .pipe(
                Effect.catchCause(() => Effect.void),
                Effect.andThen(
                  updateInteraction("room order could not be sent.").pipe(
                    Effect.catchCause(() => Effect.void),
                  ),
                ),
                Effect.andThen(Effect.failCause(cause)),
              ),
          ),
        );
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
                  Effect.andThen(
                    updateInteraction("room order could not be sent.").pipe(
                      Effect.catchCause(() => Effect.void),
                    ),
                  ),
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
          const detail = "sent room order, but failed to track it.";
          yield* updateInteraction(detail);
          return {
            messageId: sentMessage.id,
            messageChannelId: sentMessage.channel_id,
            status: "partial",
            detail,
          } satisfies RoomOrderButtonResult;
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
          status: pinned ? "pinned" : "partial",
          detail,
        } satisfies RoomOrderButtonResult;
      }

      if (payload.action !== "pinTentative") {
        const exhaustive: never = payload.action;
        return exhaustive;
      }

      const pinClaimId = globalThis.crypto.randomUUID();
      yield* requireCurrentRoomOrderMatch();
      const pinClaimedRoomOrder = yield* messageRoomOrderService.claimMessageRoomOrderTentativePin(
        payload.messageId,
        pinClaimId,
      );
      yield* requireClaimedRoomOrderMatch(
        pinClaimedRoomOrder,
        messageRoomOrderService.releaseMessageRoomOrderTentativePinClaim(
          payload.messageId,
          pinClaimId,
        ),
      );
      if (Option.isSome(pinClaimedRoomOrder.tentativePinnedAt)) {
        const detail = "tentative room order is already pinned.";
        yield* updateInteraction(detail);
        return {
          messageId: payload.messageId,
          messageChannelId: trustedMessageChannelId,
          status: "denied",
          detail,
        } satisfies RoomOrderButtonResult;
      }
      if (!Option.contains(pinClaimedRoomOrder.tentativePinClaimId, pinClaimId)) {
        const detail = getRoomOrderBusyDetail(pinClaimedRoomOrder);
        yield* updateInteraction(detail);
        return {
          messageId: payload.messageId,
          messageChannelId: trustedMessageChannelId,
          status: "denied",
          detail,
        } satisfies RoomOrderButtonResult;
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

      const maybePinnedRoomOrder = pinned
        ? yield* messageRoomOrderService
            .completeMessageRoomOrderTentativePin(payload.messageId, pinClaimId)
            .pipe(
              Effect.map(Option.some),
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  const detail = "pinned tentative room order, but failed to track it.";
                  yield* Effect.logError("Failed to track pinned tentative room order").pipe(
                    Effect.annotateLogs({
                      guildId: trustedGuildId,
                      channelId: trustedMessageChannelId,
                      messageId: payload.messageId,
                    }),
                    Effect.andThen(Effect.logError(cause)),
                  );
                  yield* updateInteraction(detail).pipe(Effect.catchCause(() => Effect.void));
                  yield* messageRoomOrderService
                    .releaseMessageRoomOrderTentativePinClaim(payload.messageId, pinClaimId)
                    .pipe(Effect.catchCause(() => Effect.void));
                  return Option.none();
                }),
              ),
            )
        : Option.none();
      if (pinned && Option.isNone(maybePinnedRoomOrder)) {
        return {
          messageId: payload.messageId,
          messageChannelId: trustedMessageChannelId,
          status: "partial",
          detail: "pinned tentative room order, but failed to track it.",
        } satisfies RoomOrderButtonResult;
      }
      const pinnedRoomOrder = Option.getOrNull(maybePinnedRoomOrder);
      if (pinnedRoomOrder !== null && Option.isNone(pinnedRoomOrder.tentativePinnedAt)) {
        const detail = "pinned tentative room order, but failed to track it.";
        yield* updateInteraction(detail);
        return {
          messageId: payload.messageId,
          messageChannelId: trustedMessageChannelId,
          status: "partial",
          detail,
        } satisfies RoomOrderButtonResult;
      }

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
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Failed to render pinned tentative room order cleanup").pipe(
                Effect.annotateLogs({
                  guildId: trustedGuildId,
                  channelId: trustedMessageChannelId,
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
      yield* updateInteraction(detail);

      return {
        messageId: payload.messageId,
        messageChannelId: trustedMessageChannelId,
        status: pinned ? (cleanedUp ? "pinned" : "partial") : "failed",
        detail,
      } satisfies RoomOrderButtonResult;
    });

    return {
      checkin: Effect.fn("DispatchService.checkin")(function* (
        payload: CheckinDispatchPayload,
        requester: DispatchRequester,
      ) {
        const createdByUserId = requester.userId;
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
        requester: DispatchRequester,
      ) {
        const createdByUserId = requester.userId;
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
            tentative: false,
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
      kickout: Effect.fn("DispatchService.kickout")(function* (
        payload: KickoutDispatchPayload,
        _requester: DispatchRequester,
      ) {
        const updateInteraction = (content: string) =>
          typeof payload.interactionToken === "string"
            ? botClient.updateOriginalInteractionResponse(payload.interactionToken, {
                content,
                allowed_mentions: { parse: [] },
              })
            : Effect.void;
        const date = yield* DateTime.now;
        const minute = DateTime.getPart(date, "minute");

        if (minute >= 40) {
          yield* updateInteraction("Cannot kick out until next hour starts");
          return {
            guildId: payload.guildId,
            runningChannelId: payload.channelId ?? "",
            hour: payload.hour ?? 0,
            roleId: null,
            removedMemberIds: [],
            status: "tooEarly",
          } satisfies KickoutDispatchResult;
        }

        const hour =
          payload.hour ??
          pipe(
            DateTime.distance(
              (yield* sheetService.getEventConfig(payload.guildId)).startTime,
              pipe(DateTime.addDuration(date, "20 minutes"), DateTime.startOf("hour")),
            ),
            Duration.toHours,
            Math.floor,
            (value) => value + 1,
          );
        const maybeRunningChannel =
          typeof payload.channelName === "string"
            ? yield* guildConfigService.getGuildChannelByName({
                guildId: payload.guildId,
                channelName: payload.channelName,
                running: true,
              })
            : yield* guildConfigService.getGuildChannelById({
                guildId: payload.guildId,
                channelId: payload.channelId ?? "",
                running: true,
              });
        const runningChannel = yield* Option.match(maybeRunningChannel, {
          onSome: Effect.succeed,
          onNone: () =>
            updateInteraction("Cannot kick out, running channel not found").pipe(
              Effect.andThen(
                Effect.fail(makeArgumentError("Cannot kick out, running channel not found")),
              ),
            ),
        });
        const channelName = yield* Option.match(runningChannel.name, {
          onSome: Effect.succeed,
          onNone: () =>
            updateInteraction("Cannot kick out, channel has no name").pipe(
              Effect.andThen(
                Effect.fail(makeArgumentError("Cannot kick out, channel has no name")),
              ),
            ),
        });
        const runningChannelId = runningChannel.channelId;
        const roleId = Option.getOrNull(runningChannel.roleId);

        if (roleId === null) {
          yield* updateInteraction("No role configured for this channel");
          return {
            guildId: payload.guildId,
            runningChannelId,
            hour,
            roleId: null,
            removedMemberIds: [],
            status: "missingRole",
          } satisfies KickoutDispatchResult;
        }

        const scheduleItem = (yield* scheduleService.channelPopulatedMonitorSchedules(
          payload.guildId,
          channelName,
        )).find((schedule) => Option.contains(schedule.hour, hour));
        if (scheduleItem === undefined) {
          yield* Effect.logWarning("Skipping kickout because no schedule was found").pipe(
            Effect.annotateLogs({
              guildId: payload.guildId,
              runningChannelId,
              channelName,
              hour,
            }),
          );
          yield* updateInteraction(
            "No schedule found for this channel and hour; no players kicked out",
          );
          return {
            guildId: payload.guildId,
            runningChannelId,
            hour,
            roleId,
            removedMemberIds: [],
            status: "empty",
          } satisfies KickoutDispatchResult;
        }

        const fillIds: ReadonlyArray<string> = Match.value(scheduleItem).pipe(
          Match.tagsExhaustive({
            PopulatedBreakSchedule: () => [],
            PopulatedSchedule: (schedule) =>
              schedule.fills.filter(Option.isSome).flatMap((player) =>
                Match.value(player.value.player).pipe(
                  Match.tagsExhaustive({
                    Player: (player) => [player.id],
                    PartialNamePlayer: () => [],
                  }),
                ),
              ),
          }),
        );
        const members = yield* botClient.getMembersForParent(payload.guildId);
        const removedMemberIds = members
          .filter((member) => member.value.roles.includes(roleId))
          .map((member) => member.value.user.id)
          .filter((memberId) => !fillIds.includes(memberId));

        const removalResults = yield* Effect.forEach(removedMemberIds, (memberId) =>
          botClient.removeGuildMemberRole(payload.guildId, memberId, roleId).pipe(
            Effect.as({ memberId, removed: true as const }),
            Effect.catchCause((cause) =>
              Effect.logError("Failed to remove kickout role from member").pipe(
                Effect.annotateLogs({
                  guildId: payload.guildId,
                  runningChannelId,
                  memberId,
                  roleId,
                }),
                Effect.andThen(Effect.logError(cause)),
                Effect.as({ memberId, removed: false as const }),
              ),
            ),
          ),
        );
        const actualRemovedIds = removalResults
          .filter((result) => result.removed)
          .map((result) => result.memberId);

        yield* updateInteraction(
          actualRemovedIds.length > 0
            ? `Kicked out ${actualRemovedIds.map(mentionUser).join(" ")}`
            : "No players to kick out",
        );

        return {
          guildId: payload.guildId,
          runningChannelId,
          hour,
          roleId,
          removedMemberIds: actualRemovedIds,
          status: actualRemovedIds.length > 0 ? "removed" : "empty",
        } satisfies KickoutDispatchResult;
      }),
      slotButton: Effect.fn("DispatchService.slotButton")(function* (
        payload: SlotButtonDispatchPayload,
        requester: DispatchRequester,
      ) {
        const message = yield* botClient.sendMessage(payload.channelId, {
          content: `Press the button below to get the current open slots for day ${payload.day}`,
          components: [slotActionRow()],
        });

        yield* messageSlotService
          .upsertMessageSlotData(message.id, {
            day: payload.day,
            guildId: payload.guildId,
            messageChannelId: payload.channelId,
            createdByUserId: requester.userId,
          })
          .pipe(
            Effect.catchCause((cause) =>
              botClient.deleteMessage(payload.channelId, message.id).pipe(
                Effect.catchCause(() => Effect.void),
                Effect.andThen(Effect.failCause(cause)),
              ),
            ),
          );

        yield* botClient
          .updateOriginalInteractionResponse(payload.interactionToken, {
            content: "Slot button sent!",
            flags: MessageFlags.Ephemeral,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Failed to update slot button interaction response").pipe(
                Effect.annotateLogs({
                  interactionToken: payload.interactionToken,
                  messageId: message.id,
                }),
                Effect.andThen(Effect.logError(cause)),
              ),
            ),
          );

        return {
          messageId: message.id,
          messageChannelId: message.channel_id,
          day: payload.day,
        } satisfies SlotButtonDispatchResult;
      }),
      slotList: Effect.fn("DispatchService.slotList")(function* (payload: SlotListDispatchPayload) {
        const eventConfig = yield* sheetService.getEventConfig(payload.guildId);
        const daySchedule = yield* scheduleService.dayPopulatedFillerSchedules(
          payload.guildId,
          payload.day,
        );
        const sortedSchedules = daySchedule
          .flatMap((schedule) =>
            Option.match(schedule.hour, {
              onSome: (hour) => [{ schedule, hour }],
              onNone: () => [],
            }),
          )
          .sort((left, right) => left.hour - right.hour)
          .map(({ schedule }) => schedule);
        const openSlots = pipe(
          sortedSchedules.map((schedule) => formatOpenSlot(schedule, eventConfig)),
          joinDedupeAdjacent,
          (description) =>
            EffectString.Equivalence(description, EffectString.empty)
              ? "All Filled :3"
              : description,
        );
        const filledSlots = pipe(
          sortedSchedules.map((schedule) => formatFilledSlot(schedule, eventConfig)),
          joinDedupeAdjacent,
          (description) =>
            EffectString.Equivalence(description, EffectString.empty) ? "All Open :3" : description,
        );

        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          embeds: [
            makeEmbed({
              title: `Day ${payload.day} Open Slots~`,
              description: openSlots,
            }),
            makeEmbed({
              title: `Day ${payload.day} Filled Slots~`,
              description: filledSlots,
            }),
            makeWebScheduleEmbed(),
          ],
        });

        return {
          guildId: payload.guildId,
          day: payload.day,
          messageType: payload.messageType,
        } satisfies SlotListDispatchResult;
      }),
      checkinButton: Effect.fn("DispatchService.checkinButton")(function* (
        payload: CheckinHandleButtonPayload,
        requester: DispatchRequester,
      ) {
        const accountId = requester.accountId;
        const checkinAt = Date.now();
        const checkinClaimId = globalThis.crypto.randomUUID();

        const maybeMessageCheckinData = yield* messageCheckinService.getMessageCheckinData(
          payload.messageId,
        );
        const failCheckinInteraction = (content: string, errorMessage: string) =>
          botClient
            .updateOriginalInteractionResponse(payload.interactionToken, {
              content,
            })
            .pipe(Effect.andThen(Effect.fail(makeArgumentError(errorMessage))));
        const messageCheckinData = yield* Option.match(maybeMessageCheckinData, {
          onSome: Effect.succeed,
          onNone: () =>
            failCheckinInteraction(
              "This check-in message is not registered.",
              "Cannot handle check-in button, message is not registered",
            ),
        });
        const messageChannelId = yield* Option.match(messageCheckinData.messageChannelId, {
          onSome: Effect.succeed,
          onNone: () =>
            failCheckinInteraction(
              "This check-in message channel is not registered.",
              "Cannot handle check-in button, message channel is not registered",
            ),
        });
        const guildId = yield* Option.match(messageCheckinData.guildId, {
          onSome: Effect.succeed,
          onNone: () =>
            failCheckinInteraction(
              "This check-in message guild is not registered.",
              "Cannot handle check-in button, message guild is not registered",
            ),
        });

        const checkedInMember = yield* messageCheckinService
          .setMessageCheckinMemberCheckinAtIfUnset(
            payload.messageId,
            accountId,
            checkinAt,
            checkinClaimId,
          )
          .pipe(
            Effect.catch((error) =>
              botClient
                .updateOriginalInteractionResponse(payload.interactionToken, {
                  content: "We could not check you in. Please try again.",
                })
                .pipe(Effect.andThen(Effect.fail(error))),
            ),
          );
        const isFirstCheckin = Option.contains(
          Option.map(checkedInMember.checkinAt, (value) => Number(DateTime.toEpochMillis(value))),
          checkinAt,
        );

        yield* botClient.updateOriginalInteractionResponse(payload.interactionToken, {
          content: isFirstCheckin
            ? "You have been checked in!"
            : "You have already been checked in!",
        });

        const checkedInMembers = yield* messageCheckinService.getMessageCheckinMembers(
          payload.messageId,
        );
        const content = renderCheckedInContent(messageCheckinData.initialMessage, checkedInMembers);

        yield* botClient
          .updateMessage(messageChannelId, payload.messageId, {
            content,
            components: [checkinActionRow()],
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Failed to update check-in message after button check-in").pipe(
                Effect.annotateLogs({
                  guildId,
                  messageId: payload.messageId,
                  messageChannelId,
                  accountId,
                }),
                Effect.andThen(Effect.logError(cause)),
              ),
            ),
          );

        if (isFirstCheckin) {
          yield* botClient
            .sendMessage(messageCheckinData.channelId, {
              content: `${mentionUser(accountId)} has checked in!`,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Failed to announce button check-in").pipe(
                  Effect.annotateLogs({
                    guildId,
                    accountId,
                    channelId: messageCheckinData.channelId,
                    messageId: payload.messageId,
                  }),
                  Effect.andThen(Effect.logError(cause)),
                ),
              ),
            );
        }

        if (Option.isSome(messageCheckinData.roleId)) {
          const roleId = messageCheckinData.roleId.value;
          // Re-apply the role on repeat clicks to repair missed Discord side effects.
          yield* botClient.addGuildMemberRole(guildId, accountId, roleId).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Failed to add check-in role after button check-in").pipe(
                Effect.annotateLogs({
                  guildId,
                  accountId,
                  roleId,
                  messageId: payload.messageId,
                }),
                Effect.andThen(Effect.logError(cause)),
              ),
            ),
          );
        }

        return {
          messageId: payload.messageId,
          messageChannelId,
          checkedInMemberId: accountId,
        } satisfies CheckinHandleButtonResult;
      }),
      roomOrderPreviousButton(
        payload: RoomOrderButtonBasePayload,
        authorizedRoomOrder?: MessageRoomOrder,
      ) {
        return roomOrderButton({ ...payload, action: "previous" }, authorizedRoomOrder);
      },
      roomOrderNextButton(
        payload: RoomOrderButtonBasePayload,
        authorizedRoomOrder?: MessageRoomOrder,
      ) {
        return roomOrderButton({ ...payload, action: "next" }, authorizedRoomOrder);
      },
      roomOrderSendButton(
        payload: RoomOrderButtonBasePayload,
        authorizedRoomOrder?: MessageRoomOrder,
      ) {
        return roomOrderButton({ ...payload, action: "send" }, authorizedRoomOrder);
      },
      roomOrderPinTentativeButton(
        payload: RoomOrderButtonBasePayload,
        authorizedRoomOrder?: MessageRoomOrder | null,
      ) {
        return roomOrderButton({ ...payload, action: "pinTentative" }, authorizedRoomOrder);
      },
    };
  }),
}) {
  static layer = Layer.effect(DispatchService, this.make).pipe(
    Layer.provide(Layer.mergeAll(IngressBotClient.layer, SheetApisClient.layer)),
  );
}
