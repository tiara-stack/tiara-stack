import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, HashSet, Option, Redacted } from "effect";
import { CHECKIN_BUTTON_CUSTOM_ID } from "sheet-ingress-api/discordComponents";
import { CheckinGenerateResult } from "sheet-ingress-api/schemas/checkin";
import {
  MessageRoomOrder,
  MessageRoomOrderRange,
} from "sheet-ingress-api/schemas/messageRoomOrder";
import {
  GeneratedRoomOrderEntry,
  RoomOrderGenerateResult,
} from "sheet-ingress-api/schemas/roomOrder";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { CheckinService } from "./checkin";
import { DispatchService } from "./dispatch";
import { GuildConfigService } from "./guildConfig";
import { IngressBotClient } from "./ingressBotClient";
import { MessageCheckinService } from "./messageCheckin";
import { MessageRoomOrderService } from "./messageRoomOrder";
import { RoomOrderService } from "./roomOrder";
import { SheetService } from "./sheet";

type BotClientApi = typeof IngressBotClient.Service;
type CheckinServiceApi = typeof CheckinService.Service;
type DispatchServiceApi = typeof DispatchService.Service;
type GuildConfigServiceApi = typeof GuildConfigService.Service;
type MessageCheckinServiceApi = typeof MessageCheckinService.Service;
type MessageRoomOrderServiceApi = typeof MessageRoomOrderService.Service;
type RoomOrderServiceApi = typeof RoomOrderService.Service;
type SheetServiceApi = typeof SheetService.Service;
type UpdateMessage = (
  channelId: string,
  messageId: string,
  payload: unknown,
) => Effect.Effect<{ readonly id: string; readonly channel_id: string }, unknown>;

type Call = {
  readonly name: string;
  readonly args: ReadonlyArray<unknown>;
};

const testUser = {
  accountId: "discord-user-1",
  userId: "auth-user-1",
  permissions: HashSet.empty(),
  token: Redacted.make("token"),
};

const makeRoomOrderEntry = () =>
  new GeneratedRoomOrderEntry({
    rank: 0,
    position: 0,
    hour: 20,
    team: "Team A",
    tags: ["fill"],
    effectValue: 100,
  });

const makeRoomOrderResult = (content = "Room order content") =>
  new RoomOrderGenerateResult({
    content,
    runningChannelId: "running-channel-1",
    range: new MessageRoomOrderRange({ minRank: 0, maxRank: 1 }),
    rank: 0,
    hour: 20,
    monitor: "monitor-1",
    previousFills: ["old-fill"],
    fills: ["fill-1", "fill-2"],
    entries: [makeRoomOrderEntry()],
  });

const makeCheckinResult = (
  overrides: Partial<ConstructorParameters<typeof CheckinGenerateResult>[0]> = {},
) =>
  new CheckinGenerateResult({
    hour: 20,
    runningChannelId: "running-channel-1",
    checkinChannelId: "checkin-channel-1",
    fillCount: 5,
    roleId: "role-1",
    initialMessage: "Check in now",
    monitorCheckinMessage: "Check-in message sent!",
    monitorUserId: "monitor-1",
    monitorFailureMessage: null,
    fillIds: ["fill-1", "fill-2"],
    ...overrides,
  });

const makeBotClient = (calls: Call[]): BotClientApi => ({
  sendMessage: (channelId, payload) =>
    Effect.sync(() => {
      calls.push({ name: "sendMessage", args: [channelId, payload] });
      return {
        id: `${channelId}-message-${calls.length}`,
        channel_id: channelId,
      };
    }),
  updateMessage: (channelId, messageId, payload) =>
    Effect.sync(() => {
      calls.push({ name: "updateMessage", args: [channelId, messageId, payload] });
      return {
        id: messageId,
        channel_id: channelId,
      };
    }),
  updateOriginalInteractionResponse: (interactionToken, payload) =>
    Effect.sync(() => {
      calls.push({ name: "updateOriginalInteractionResponse", args: [interactionToken, payload] });
      return {
        id: "interaction-message-1",
        channel_id: "interaction-channel-1",
      };
    }),
  createPin: (channelId, messageId) =>
    Effect.sync(() => {
      calls.push({ name: "createPin", args: [channelId, messageId] });
      return {};
    }),
  addGuildMemberRole: (guildId, userId, roleId) =>
    Effect.sync(() => {
      calls.push({ name: "addGuildMemberRole", args: [guildId, userId, roleId] });
      return {};
    }),
});

const makeMessageRoomOrder = (
  rank = 0,
  overrides: Partial<ConstructorParameters<typeof MessageRoomOrder>[0]> = {},
) =>
  new MessageRoomOrder({
    messageId: "room-order-message-1",
    previousFills: ["old-fill"],
    fills: ["fill-1", "fill-2"],
    hour: 20,
    rank,
    monitor: Option.some("monitor-1"),
    guildId: Option.some("guild-1"),
    messageChannelId: Option.some("running-channel-1"),
    createdByUserId: Option.some("auth-user-1"),
    sendClaimId: Option.none(),
    sendClaimedAt: Option.none(),
    sentMessageId: Option.none(),
    sentMessageChannelId: Option.none(),
    sentAt: Option.none(),
    tentativePinClaimId: Option.none(),
    tentativePinClaimedAt: Option.none(),
    tentativePinnedAt: Option.none(),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
    ...overrides,
  });

const makeDispatchService = ({
  calls,
  checkinResult = makeCheckinResult(),
  roomOrderResult = makeRoomOrderResult(),
  botClient = makeBotClient(calls),
  updateMessage = botClient.updateMessage as UpdateMessage,
  setCheckinAtIfUnset,
  messageRoomOrder = Option.some(makeMessageRoomOrder()),
  claimMessageRoomOrderSend,
  completeMessageRoomOrderSend,
}: {
  readonly calls: Call[];
  readonly checkinResult?: CheckinGenerateResult;
  readonly roomOrderResult?: RoomOrderGenerateResult;
  readonly botClient?: BotClientApi;
  readonly updateMessage?: UpdateMessage;
  readonly setCheckinAtIfUnset?: (
    messageId: string,
    memberId: string,
    checkinAt: number,
  ) => Effect.Effect<unknown, never>;
  readonly messageRoomOrder?: Option.Option<MessageRoomOrder>;
  readonly claimMessageRoomOrderSend?: (
    messageId: string,
    claimId: string,
  ) => Effect.Effect<MessageRoomOrder, never>;
  readonly completeMessageRoomOrderSend?: (
    messageId: string,
    claimId: string,
    sentMessage: { readonly id: string; readonly channelId: string },
  ) => Effect.Effect<MessageRoomOrder, never>;
}) =>
  DispatchService.make.pipe(
    Effect.provideService(IngressBotClient, {
      ...botClient,
      updateMessage: updateMessage as BotClientApi["updateMessage"],
    }),
    Effect.provideService(CheckinService, {
      generate: (payload) =>
        Effect.sync(() => {
          calls.push({ name: "checkin.generate", args: [payload] });
          return checkinResult;
        }),
    } as CheckinServiceApi),
    Effect.provideService(RoomOrderService, {
      generate: (payload) =>
        Effect.sync(() => {
          calls.push({ name: "roomOrder.generate", args: [payload] });
          return roomOrderResult;
        }),
    } as RoomOrderServiceApi),
    Effect.provideService(GuildConfigService, {
      getGuildConfig: () =>
        Effect.succeed(
          Option.some({
            sheetId: Option.some("sheet-1"),
          }),
        ),
      getGuildChannelById: () => Effect.succeed(Option.some({})),
    } as unknown as GuildConfigServiceApi),
    Effect.provideService(SheetService, {
      getEventConfig: () =>
        Effect.succeed({
          startTime: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
        }),
    } as unknown as SheetServiceApi),
    Effect.provideService(MessageCheckinService, {
      persistMessageCheckin: (messageId: string, payload: unknown) =>
        Effect.sync(() => {
          calls.push({ name: "messageCheckin.persist", args: [messageId, payload] });
          return {} as never;
        }),
      setMessageCheckinMemberCheckinAt: (messageId: string, memberId: string, checkinAt: number) =>
        Effect.sync(() => {
          calls.push({
            name: "messageCheckin.setCheckinAt",
            args: [messageId, memberId, checkinAt],
          });
          return {} as never;
        }),
      setMessageCheckinMemberCheckinAtIfUnset: (
        messageId: string,
        memberId: string,
        checkinAt: number,
      ) =>
        setCheckinAtIfUnset?.(messageId, memberId, checkinAt) ??
        Effect.sync(() => {
          calls.push({
            name: "messageCheckin.setCheckinAtIfUnset",
            args: [messageId, memberId, checkinAt],
          });
          return {
            memberId,
            checkinAt: Option.some(DateTime.makeUnsafe(new Date(checkinAt).toISOString())),
          } as never;
        }),
      getMessageCheckinData: (messageId: string) =>
        Effect.sync(() => {
          calls.push({ name: "messageCheckin.getData", args: [messageId] });
          return Option.some({
            initialMessage: "Check in now",
            channelId: "running-channel-1",
            roleId: Option.some("role-1"),
            guildId: Option.some("guild-1"),
            messageChannelId: Option.some("checkin-channel-1"),
          });
        }),
      getMessageCheckinMembers: (messageId: string) =>
        Effect.sync(() => {
          calls.push({ name: "messageCheckin.getMembers", args: [messageId] });
          const hasCheckedIn = calls.some(
            (call) => call.name === "messageCheckin.setCheckinAtIfUnset",
          );
          return [
            {
              memberId: "discord-user-1",
              checkinAt: hasCheckedIn
                ? Option.some(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"))
                : Option.none(),
            },
          ];
        }),
    } as unknown as MessageCheckinServiceApi),
    Effect.provideService(MessageRoomOrderService, {
      persistMessageRoomOrder: (messageId: string, payload: unknown) =>
        Effect.sync(() => {
          calls.push({ name: "messageRoomOrder.persist", args: [messageId, payload] });
          return {} as never;
        }),
      getMessageRoomOrder: (messageId: string) =>
        Effect.sync(() => {
          calls.push({ name: "messageRoomOrder.get", args: [messageId] });
          return messageRoomOrder;
        }),
      decrementMessageRoomOrderRank: (messageId: string) =>
        Effect.sync(() => {
          calls.push({ name: "messageRoomOrder.decrement", args: [messageId] });
          return makeMessageRoomOrder(0);
        }),
      incrementMessageRoomOrderRank: (messageId: string) =>
        Effect.sync(() => {
          calls.push({ name: "messageRoomOrder.increment", args: [messageId] });
          return makeMessageRoomOrder(1);
        }),
      claimMessageRoomOrderSend: (messageId: string, claimId: string) =>
        claimMessageRoomOrderSend?.(messageId, claimId) ??
        Effect.sync(() => {
          calls.push({ name: "messageRoomOrder.claimSend", args: [messageId, claimId] });
          return makeMessageRoomOrder(0, {
            sendClaimId: Option.some(claimId),
            sendClaimedAt: Option.some(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
          });
        }),
      completeMessageRoomOrderSend: (
        messageId: string,
        claimId: string,
        sentMessage: { readonly id: string; readonly channelId: string },
      ) =>
        completeMessageRoomOrderSend?.(messageId, claimId, sentMessage) ??
        Effect.sync(() => {
          calls.push({
            name: "messageRoomOrder.completeSend",
            args: [messageId, claimId, sentMessage],
          });
          return makeMessageRoomOrder(0, {
            sendClaimId: Option.none(),
            sentMessageId: Option.some(sentMessage.id),
            sentMessageChannelId: Option.some(sentMessage.channelId),
            sentAt: Option.some(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
          });
        }),
      releaseMessageRoomOrderSendClaim: (messageId: string, claimId: string) =>
        Effect.sync(() => {
          calls.push({ name: "messageRoomOrder.releaseSend", args: [messageId, claimId] });
        }),
      claimMessageRoomOrderTentativePin: (messageId: string, claimId: string) =>
        Effect.sync(() => {
          calls.push({ name: "messageRoomOrder.claimTentativePin", args: [messageId, claimId] });
          return makeMessageRoomOrder(0, {
            tentativePinClaimId: Option.some(claimId),
            tentativePinClaimedAt: Option.some(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
          });
        }),
      completeMessageRoomOrderTentativePin: (messageId: string, claimId: string) =>
        Effect.sync(() => {
          calls.push({ name: "messageRoomOrder.completeTentativePin", args: [messageId, claimId] });
          return makeMessageRoomOrder(0, {
            tentativePinnedAt: Option.some(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
          });
        }),
      releaseMessageRoomOrderTentativePinClaim: (messageId: string, claimId: string) =>
        Effect.sync(() => {
          calls.push({ name: "messageRoomOrder.releaseTentativePin", args: [messageId, claimId] });
        }),
      getMessageRoomOrderRange: (messageId: string) =>
        Effect.sync(() => {
          calls.push({ name: "messageRoomOrder.getRange", args: [messageId] });
          return Option.some(new MessageRoomOrderRange({ minRank: 0, maxRank: 1 }));
        }),
      getMessageRoomOrderEntry: (messageId: string, rank: number) =>
        Effect.sync(() => {
          calls.push({ name: "messageRoomOrder.getEntry", args: [messageId, rank] });
          return [makeRoomOrderEntry()];
        }),
    } as unknown as MessageRoomOrderServiceApi),
  ) as Effect.Effect<DispatchServiceApi, never>;

const runWithUser = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(SheetAuthUser, testUser)) as Effect.Effect<A, E>;

describe("DispatchService", () => {
  it.effect(
    "checkin sends the primary monitor message, persists the check-in, enables it, and sends tentative room order",
    () =>
      Effect.gen(function* () {
        const calls: Call[] = [];
        const dispatchService = yield* makeDispatchService({ calls });
        const result = yield* runWithUser(
          dispatchService.checkin({
            guildId: "guild-1",
            channelId: "running-channel-1",
            hour: 20,
          }),
        );

        expect(result).toMatchObject({
          hour: 20,
          runningChannelId: "running-channel-1",
          checkinChannelId: "checkin-channel-1",
          checkinMessageId: "checkin-channel-1-message-3",
          checkinMessageChannelId: "checkin-channel-1",
          primaryMessageId: "running-channel-1-message-2",
          primaryMessageChannelId: "running-channel-1",
          tentativeRoomOrderMessageId: "running-channel-1-message-7",
          tentativeRoomOrderMessageChannelId: "running-channel-1",
        });

        expect(calls.map((call) => call.name)).toEqual([
          "checkin.generate",
          "sendMessage",
          "sendMessage",
          "messageCheckin.persist",
          "updateMessage",
          "roomOrder.generate",
          "sendMessage",
          "messageRoomOrder.persist",
        ]);
        expect(calls[4]?.args[2]).toMatchObject({
          components: [
            {
              components: [expect.objectContaining({ custom_id: CHECKIN_BUTTON_CUSTOM_ID })],
            },
          ],
        });
        expect(calls[6]?.args[1]).toMatchObject({
          content: "(tentative)\nRoom order content",
        });
        expect(calls[3]?.args[1]).toMatchObject({
          data: { createdByUserId: "auth-user-1" },
        });
        expect(calls[7]?.args[1]).toMatchObject({
          data: { createdByUserId: "auth-user-1" },
        });
      }),
  );

  it.effect(
    "checkin interaction dispatch edits the original response and skips check-in persistence when no initial message exists",
    () =>
      Effect.gen(function* () {
        const calls: Call[] = [];
        const dispatchService = yield* makeDispatchService({
          calls,
          checkinResult: makeCheckinResult({
            fillCount: 4,
            initialMessage: null,
            monitorCheckinMessage: "No check-in message sent",
            fillIds: [],
          }),
        });

        const result = yield* runWithUser(
          dispatchService.checkin({
            guildId: "guild-1",
            channelName: "room-1",
            interactionToken: "token-1",
          }),
        );

        expect(result).toMatchObject({
          checkinMessageId: null,
          checkinMessageChannelId: null,
          primaryMessageId: "interaction-message-1",
          primaryMessageChannelId: "interaction-channel-1",
          tentativeRoomOrderMessageId: null,
        });
        expect(calls.map((call) => call.name)).toEqual([
          "checkin.generate",
          "updateOriginalInteractionResponse",
          "updateOriginalInteractionResponse",
        ]);
        expect(calls[1]?.args).toMatchObject([
          "token-1",
          { content: "Dispatching check-in...", flags: 64 },
        ]);
        expect(calls[2]?.args).toMatchObject([
          "token-1",
          { content: "No check-in message sent", flags: 64 },
        ]);
      }),
  );

  it.effect("room order sends disabled buttons, persists data, then enables buttons", () =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const dispatchService = yield* makeDispatchService({ calls });
      const result = yield* runWithUser(
        dispatchService.roomOrder({
          guildId: "guild-1",
          channelId: "running-channel-1",
          hour: 20,
        }),
      );

      expect(result).toEqual({
        messageId: "running-channel-1-message-2",
        messageChannelId: "running-channel-1",
        hour: 20,
        runningChannelId: "running-channel-1",
        rank: 0,
      });
      expect(calls.map((call) => call.name)).toEqual([
        "roomOrder.generate",
        "sendMessage",
        "messageRoomOrder.persist",
        "updateMessage",
      ]);
      expect(calls[1]?.args[1]).toMatchObject({
        components: [
          { components: expect.arrayContaining([expect.objectContaining({ disabled: true })]) },
        ],
      });
      expect(calls[3]?.args[2]).toMatchObject({
        components: [
          { components: expect.arrayContaining([expect.objectContaining({ disabled: false })]) },
        ],
      });
      expect(calls[2]?.args[1]).toMatchObject({
        data: { createdByUserId: "auth-user-1" },
      });
    }),
  );

  it.effect(
    "room order interaction dispatch edits the original response instead of sending a channel message",
    () =>
      Effect.gen(function* () {
        const calls: Call[] = [];
        const dispatchService = yield* makeDispatchService({ calls });
        const result = yield* runWithUser(
          dispatchService.roomOrder({
            guildId: "guild-1",
            channelName: "room-1",
            interactionToken: "token-1",
          }),
        );

        expect(result).toEqual({
          messageId: "interaction-message-1",
          messageChannelId: "interaction-channel-1",
          hour: 20,
          runningChannelId: "running-channel-1",
          rank: 0,
        });
        expect(calls.map((call) => call.name)).toEqual([
          "roomOrder.generate",
          "updateOriginalInteractionResponse",
          "messageRoomOrder.persist",
          "updateOriginalInteractionResponse",
        ]);
        expect(calls[1]?.args[1]).not.toHaveProperty("flags");
        expect(calls[3]?.args[1]).not.toHaveProperty("flags");
      }),
  );

  it.effect(
    "room order leaves disabled components when enabling buttons fails after persistence",
    () =>
      Effect.gen(function* () {
        const calls: Call[] = [];
        const dispatchService = yield* makeDispatchService({
          calls,
          updateMessage: (channelId, messageId, payload) =>
            Effect.sync(() => {
              calls.push({ name: "updateMessage", args: [channelId, messageId, payload] });
            }).pipe(Effect.andThen(Effect.fail(new Error("discord update failed")))),
        });

        const result = yield* runWithUser(
          dispatchService.roomOrder({
            guildId: "guild-1",
            channelId: "running-channel-1",
            hour: 20,
          }),
        );

        expect(result).toEqual({
          messageId: "running-channel-1-message-2",
          messageChannelId: "running-channel-1",
          hour: 20,
          runningChannelId: "running-channel-1",
          rank: 0,
        });
        expect(calls.map((call) => call.name)).toEqual([
          "roomOrder.generate",
          "sendMessage",
          "messageRoomOrder.persist",
          "updateMessage",
        ]);
      }),
  );

  it.effect("checkin button checks in the current user and updates Discord side effects", () =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const dispatchService = yield* makeDispatchService({ calls });
      const result = yield* runWithUser(
        dispatchService.checkinButton({
          guildId: "guild-1",
          messageId: "checkin-message-1",
          messageChannelId: "checkin-channel-1",
          interactionToken: "token-1",
        }),
      );

      expect(result).toEqual({
        messageId: "checkin-message-1",
        messageChannelId: "checkin-channel-1",
        checkedInMemberId: "discord-user-1",
      });
      expect(calls.map((call) => call.name)).toEqual([
        "messageCheckin.getData",
        "messageCheckin.setCheckinAtIfUnset",
        "updateOriginalInteractionResponse",
        "messageCheckin.getMembers",
        "updateMessage",
        "sendMessage",
        "addGuildMemberRole",
      ]);
      expect(calls[2]?.args).toEqual(["token-1", { content: "You have been checked in!" }]);
      expect(calls[4]?.args[2]).toMatchObject({
        content: "Check in now\n\nChecked in: <@discord-user-1>",
        components: [
          {
            components: [expect.objectContaining({ custom_id: CHECKIN_BUTTON_CUSTOM_ID })],
          },
        ],
      });
      expect(calls[5]?.args).toEqual([
        "running-channel-1",
        { content: "<@discord-user-1> has checked in!" },
      ]);
      expect(calls[6]?.args).toEqual(["guild-1", "discord-user-1", "role-1"]);
    }),
  );

  it.effect(
    "checkin button retry repairs message and role side effects without re-announcing",
    () =>
      Effect.gen(function* () {
        const calls: Call[] = [];
        const dispatchService = yield* makeDispatchService({
          calls,
          setCheckinAtIfUnset: (messageId, memberId, checkinAt) =>
            Effect.sync(() => {
              calls.push({
                name: "messageCheckin.setCheckinAtIfUnset",
                args: [messageId, memberId, checkinAt],
              });
              return {
                memberId,
                checkinAt: Option.some(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
              };
            }),
        });
        const result = yield* runWithUser(
          dispatchService.checkinButton({
            guildId: "guild-1",
            messageId: "checkin-message-1",
            messageChannelId: "checkin-channel-1",
            interactionToken: "token-1",
          }),
        );

        expect(result).toEqual({
          messageId: "checkin-message-1",
          messageChannelId: "checkin-channel-1",
          checkedInMemberId: "discord-user-1",
        });
        expect(calls.map((call) => call.name)).toEqual([
          "messageCheckin.getData",
          "messageCheckin.setCheckinAtIfUnset",
          "updateOriginalInteractionResponse",
          "messageCheckin.getMembers",
          "updateMessage",
          "addGuildMemberRole",
        ]);
        expect(calls[2]?.args).toEqual([
          "token-1",
          { content: "You have already been checked in!" },
        ]);
        expect(calls[5]?.args).toEqual(["guild-1", "discord-user-1", "role-1"]);
      }),
  );

  it.effect("room order previous button updates normal interaction response", () =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const dispatchService = yield* makeDispatchService({ calls });
      const result = yield* runWithUser(
        dispatchService.roomOrderButton({
          guildId: "guild-1",
          messageId: "room-order-message-1",
          messageChannelId: "running-channel-1",
          messageContent: "Room order content",
          interactionToken: "token-1",
          action: "previous",
        }),
      );

      expect(result).toMatchObject({
        messageId: "room-order-message-1",
        messageChannelId: "running-channel-1",
        action: "previous",
        status: "updated",
      });
      expect(calls.map((call) => call.name)).toEqual([
        "messageRoomOrder.get",
        "messageRoomOrder.decrement",
        "messageRoomOrder.getRange",
        "messageRoomOrder.getEntry",
        "updateOriginalInteractionResponse",
      ]);
      expect(calls[4]?.args[1]).toMatchObject({
        content: expect.stringContaining("**Hour 20**"),
        components: [expect.objectContaining({ components: expect.any(Array) })],
      });
    }),
  );

  it.effect("room order send button sends and pins a rendered room order", () =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const dispatchService = yield* makeDispatchService({ calls });
      const result = yield* runWithUser(
        dispatchService.roomOrderButton({
          guildId: "guild-1",
          messageId: "room-order-message-1",
          messageChannelId: "running-channel-1",
          messageContent: "(tentative)\nRoom order content",
          interactionToken: "token-1",
          action: "send",
        }),
      );

      expect(result).toMatchObject({
        messageChannelId: "running-channel-1",
        action: "send",
        status: "pinned",
        detail: "sent room order and pinned it!",
      });
      expect(calls.map((call) => call.name)).toEqual([
        "messageRoomOrder.get",
        "messageRoomOrder.getRange",
        "messageRoomOrder.getEntry",
        "messageRoomOrder.claimSend",
        "sendMessage",
        "messageRoomOrder.completeSend",
        "createPin",
        "updateOriginalInteractionResponse",
      ]);
      expect(calls[4]?.args[1]).toMatchObject({
        content: expect.stringContaining("**Hour 20**"),
        nonce: "room-order-message-1",
        enforce_nonce: true,
      });
      expect(calls[7]?.args).toEqual([
        "token-1",
        { content: "sent room order and pinned it!", components: [] },
      ]);
    }),
  );

  it.effect("room order send button short-circuits when already sent", () =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const dispatchService = yield* makeDispatchService({
        calls,
        messageRoomOrder: Option.some(
          makeMessageRoomOrder(0, {
            sentMessageId: Option.some("sent-message-1"),
            sentMessageChannelId: Option.some("running-channel-1"),
            sentAt: Option.some(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
          }),
        ),
      });
      const result = yield* runWithUser(
        dispatchService.roomOrderButton({
          guildId: "guild-1",
          messageId: "room-order-message-1",
          messageChannelId: "running-channel-1",
          messageContent: "(tentative)\nRoom order content",
          interactionToken: "token-1",
          action: "send",
        }),
      );

      expect(result).toMatchObject({
        messageId: "sent-message-1",
        messageChannelId: "running-channel-1",
        action: "send",
        status: "sent",
        detail: "room order was already sent.",
      });
      expect(calls.map((call) => call.name)).toEqual([
        "messageRoomOrder.get",
        "updateOriginalInteractionResponse",
      ]);
    }),
  );

  it.effect("room order tentative previous button denies after tentative order is pinned", () =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const dispatchService = yield* makeDispatchService({
        calls,
        messageRoomOrder: Option.some(
          makeMessageRoomOrder(0, {
            tentativePinnedAt: Option.some(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
          }),
        ),
      });
      const result = yield* runWithUser(
        dispatchService.roomOrderButton({
          guildId: "guild-1",
          messageId: "room-order-message-1",
          messageChannelId: "running-channel-1",
          messageContent: "(tentative)\nRoom order content",
          interactionToken: "token-1",
          action: "previous",
        }),
      );

      expect(result).toMatchObject({
        messageId: "room-order-message-1",
        messageChannelId: "running-channel-1",
        action: "previous",
        status: "denied",
        detail: "tentative room order is already pinned.",
      });
      expect(calls.map((call) => call.name)).toEqual([
        "messageRoomOrder.get",
        "updateOriginalInteractionResponse",
      ]);
    }),
  );

  it.effect("room order send button denies competing send claims", () =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const dispatchService = yield* makeDispatchService({
        calls,
        claimMessageRoomOrderSend: (messageId, claimId) =>
          Effect.sync(() => {
            calls.push({ name: "messageRoomOrder.claimSend", args: [messageId, claimId] });
            return makeMessageRoomOrder(0, {
              sendClaimId: Option.some("other-claim"),
            });
          }),
      });
      const result = yield* runWithUser(
        dispatchService.roomOrderButton({
          guildId: "guild-1",
          messageId: "room-order-message-1",
          messageChannelId: "running-channel-1",
          messageContent: "(tentative)\nRoom order content",
          interactionToken: "token-1",
          action: "send",
        }),
      );

      expect(result).toMatchObject({
        action: "send",
        status: "denied",
        detail: "room order is already being sent.",
      });
      expect(calls.map((call) => call.name)).toEqual([
        "messageRoomOrder.get",
        "messageRoomOrder.getRange",
        "messageRoomOrder.getEntry",
        "messageRoomOrder.claimSend",
        "updateOriginalInteractionResponse",
      ]);
    }),
  );

  it.effect("room order send button releases claim when Discord send fails", () =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const dispatchService = yield* makeDispatchService({
        calls,
        botClient: {
          ...makeBotClient(calls),
          sendMessage: (channelId, payload) =>
            Effect.sync(() => {
              calls.push({ name: "sendMessage", args: [channelId, payload] });
            }).pipe(
              Effect.andThen(
                Effect.fail(new Error("discord send failed")) as unknown as ReturnType<
                  BotClientApi["sendMessage"]
                >,
              ),
            ),
        },
      });

      const exit = yield* runWithUser(
        dispatchService.roomOrderButton({
          guildId: "guild-1",
          messageId: "room-order-message-1",
          messageChannelId: "running-channel-1",
          messageContent: "(tentative)\nRoom order content",
          interactionToken: "token-1",
          action: "send",
        }),
      ).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(calls.map((call) => call.name)).toEqual([
        "messageRoomOrder.get",
        "messageRoomOrder.getRange",
        "messageRoomOrder.getEntry",
        "messageRoomOrder.claimSend",
        "sendMessage",
        "messageRoomOrder.releaseSend",
      ]);
    }),
  );

  it.effect("room order send button fails when completion does not persist sent state", () =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const dispatchService = yield* makeDispatchService({
        calls,
        completeMessageRoomOrderSend: (messageId, claimId, sentMessage) =>
          Effect.sync(() => {
            calls.push({
              name: "messageRoomOrder.completeSend",
              args: [messageId, claimId, sentMessage],
            });
            return makeMessageRoomOrder(0, {
              sendClaimId: Option.some(claimId),
            });
          }),
      });

      const exit = yield* runWithUser(
        dispatchService.roomOrderButton({
          guildId: "guild-1",
          messageId: "room-order-message-1",
          messageChannelId: "running-channel-1",
          messageContent: "(tentative)\nRoom order content",
          interactionToken: "token-1",
          action: "send",
        }),
      ).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(calls.map((call) => call.name)).toEqual([
        "messageRoomOrder.get",
        "messageRoomOrder.getRange",
        "messageRoomOrder.getEntry",
        "messageRoomOrder.claimSend",
        "sendMessage",
        "messageRoomOrder.completeSend",
      ]);
    }),
  );

  it.effect("room order tentative pin marks the record before cleanup", () =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const dispatchService = yield* makeDispatchService({ calls });
      const result = yield* runWithUser(
        dispatchService.roomOrderButton({
          guildId: "guild-1",
          messageId: "room-order-message-1",
          messageChannelId: "running-channel-1",
          messageContent: "(tentative)\nRoom order content",
          interactionToken: "token-1",
          action: "pinTentative",
        }),
      );

      expect(result).toMatchObject({
        messageId: "room-order-message-1",
        messageChannelId: "running-channel-1",
        action: "pinTentative",
        status: "pinned",
        detail: "pinned tentative room order!",
      });
      expect(calls.map((call) => call.name)).toEqual([
        "messageRoomOrder.get",
        "messageRoomOrder.claimTentativePin",
        "createPin",
        "messageRoomOrder.completeTentativePin",
        "messageRoomOrder.getRange",
        "messageRoomOrder.getEntry",
        "updateMessage",
        "updateOriginalInteractionResponse",
      ]);
      expect(calls[6]?.args[2]).toMatchObject({
        content: expect.stringContaining("**Hour 20**"),
        components: [],
      });
    }),
  );

  it.effect(
    "room order tentative pin falls back to payload context when persistence is absent",
    () =>
      Effect.gen(function* () {
        const calls: Call[] = [];
        const dispatchService = yield* makeDispatchService({
          calls,
          messageRoomOrder: Option.none(),
        });
        const result = yield* runWithUser(
          dispatchService.roomOrderButton({
            guildId: "guild-1",
            messageId: "fallback-room-order-message-1",
            messageChannelId: "running-channel-1",
            messageContent: "(tentative)\nRoom order content",
            interactionToken: "token-1",
            action: "pinTentative",
          }),
        );

        expect(result).toMatchObject({
          messageId: "fallback-room-order-message-1",
          messageChannelId: "running-channel-1",
          action: "pinTentative",
          status: "pinned",
          detail: "pinned tentative room order!",
        });
        expect(calls.map((call) => call.name)).toEqual([
          "messageRoomOrder.get",
          "createPin",
          "updateMessage",
          "updateOriginalInteractionResponse",
        ]);
        expect(calls[2]?.args).toEqual([
          "running-channel-1",
          "fallback-room-order-message-1",
          { components: [] },
        ]);
      }),
  );
});
