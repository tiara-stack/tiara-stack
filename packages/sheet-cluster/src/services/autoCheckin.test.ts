import { describe, expect, it } from "vitest";
import { DateTime, Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { CheckinGenerateResult } from "sheet-ingress-api/schemas/checkin";
import { GuildChannelConfig, GuildConfig } from "sheet-ingress-api/schemas/guildConfig";
import { MessageRoomOrderRange } from "sheet-ingress-api/schemas/messageRoomOrder";
import { RoomOrderGenerateResult } from "sheet-ingress-api/schemas/roomOrder";
import { EventConfig } from "sheet-ingress-api/schemas/sheetConfig";
import {
  AutoCheckinService,
  AutoCheckinWorkflowClient,
  IngressBotClient,
  SheetApisClient,
} from "@/services";
import type { AutoCheckinChannelPayload } from "@/workflows/autoCheckinContract";

const payload: AutoCheckinChannelPayload = {
  guildId: "guild-1",
  channelName: "main",
  hour: 3,
  eventStartEpochMs: Date.parse("2026-03-26T12:00:00.000Z"),
};

const makeGuildConfig = (guildId: string) =>
  new GuildConfig({
    guildId,
    sheetId: Option.some("sheet-1"),
    autoCheckin: Option.some(true),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  });

const makeGuildChannel = (name: Option.Option<string>) =>
  new GuildChannelConfig({
    guildId: "guild-1",
    channelId: `channel-${Option.getOrElse(name, () => "unnamed")}`,
    name,
    running: Option.some(true),
    roleId: Option.none(),
    checkinChannelId: Option.none(),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  });

const makeGeneratedCheckin = (overrides?: {
  readonly initialMessage?: string | null;
  readonly fillCount?: number;
  readonly monitorUserId?: string | null;
  readonly monitorFailureMessage?: string | null;
}) =>
  new CheckinGenerateResult({
    hour: payload.hour,
    runningChannelId: "running-channel",
    checkinChannelId: "checkin-channel",
    fillCount: overrides?.fillCount ?? 5,
    roleId: "role-1",
    initialMessage:
      overrides && "initialMessage" in overrides ? overrides.initialMessage! : "check in now",
    monitorCheckinMessage: "monitor summary",
    monitorUserId:
      overrides && "monitorUserId" in overrides ? overrides.monitorUserId! : "monitor-1",
    monitorFailureMessage:
      overrides && "monitorFailureMessage" in overrides
        ? overrides.monitorFailureMessage!
        : "monitor missing",
    fillIds: ["member-1", "member-2"],
  });

const makeRoomOrder = () =>
  new RoomOrderGenerateResult({
    content: "room order",
    runningChannelId: "running-channel",
    range: new MessageRoomOrderRange({ minRank: 1, maxRank: 1 }),
    rank: 1,
    hour: payload.hour,
    monitor: null,
    previousFills: [],
    fills: ["member-1"],
    entries: [],
  });

const unexpected = (name: string) => () => Effect.die(`Unexpected call: ${name}`);

const makeSheetApisClient = (services: Record<string, unknown>) =>
  ({
    get: () =>
      new Proxy(services, {
        get(target, group: string) {
          if (group in target) {
            return target[group];
          }

          return new Proxy(
            {},
            {
              get: (_service, method: string) => unexpected(`${group}.${method}`),
            },
          );
        },
      }),
  }) as never;

const makeBotClient = (calls: Array<unknown>) =>
  ({
    sendMessage: (channelId: string, message: unknown) => {
      calls.push({ method: "sendMessage", channelId, message });
      return Effect.succeed({ id: `${channelId}-message-${calls.length}`, channel_id: channelId });
    },
    updateMessage: (channelId: string, messageId: string, message: unknown) => {
      calls.push({ method: "updateMessage", channelId, messageId, message });
      return Effect.succeed({ id: messageId, channel_id: channelId });
    },
  }) as never;

const runService = <A, E>(
  effect: (service: typeof AutoCheckinService.Service) => Effect.Effect<A, E>,
  options: {
    readonly sheetApisClient: typeof SheetApisClient.Service;
    readonly botClient?: typeof IngressBotClient.Service;
    readonly workflowClient?: typeof AutoCheckinWorkflowClient.Service;
    readonly clockTime?: string;
  },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        if (options.clockTime) {
          yield* TestClock.setTime(Date.parse(options.clockTime));
        }
        const service = yield* AutoCheckinService.make;
        return yield* effect(service);
      }).pipe(
        Effect.provideService(SheetApisClient, options.sheetApisClient),
        Effect.provideService(IngressBotClient, options.botClient ?? ({} as never)),
        Effect.provideService(
          AutoCheckinWorkflowClient,
          options.workflowClient ??
            ({
              enqueueChannel: () => Effect.die("Unexpected workflow enqueue"),
            } as never),
        ),
        Effect.provide(TestClock.layer()),
      ),
    ),
  );

describe("AutoCheckinService", () => {
  it("derives the target hour and enqueues unique named running channels", async () => {
    const enqueued: AutoCheckinChannelPayload[] = [];
    const sheetApisClient = makeSheetApisClient({
      sheet: {
        getEventConfig: () =>
          Effect.succeed(
            new EventConfig({
              startTime: DateTime.makeUnsafe("2026-03-26T12:00:00.000Z"),
            }),
          ),
      },
      guildConfig: {
        getGuildChannels: () =>
          Effect.succeed([
            makeGuildChannel(Option.some("main")),
            makeGuildChannel(Option.some("main")),
            makeGuildChannel(Option.some("side")),
            makeGuildChannel(Option.some("")),
            makeGuildChannel(Option.none()),
          ]),
      },
    });

    const count = await runService((service) => service.enqueueGuild("guild-1"), {
      sheetApisClient,
      workflowClient: {
        enqueueChannel: (payload: AutoCheckinChannelPayload) => {
          enqueued.push(payload);
          return Effect.succeed(`execution-${enqueued.length}`);
        },
      } as never,
      clockTime: "2026-03-26T13:40:00.000Z",
    });

    expect(count).toBe(2);
    expect(enqueued).toEqual([
      {
        guildId: "guild-1",
        channelName: "main",
        hour: 3,
        eventStartEpochMs: Date.parse("2026-03-26T12:00:00.000Z"),
      },
      {
        guildId: "guild-1",
        channelName: "side",
        hour: 3,
        eventStartEpochMs: Date.parse("2026-03-26T12:00:00.000Z"),
      },
    ]);
  });

  it("continues enqueueing when one channel enqueue fails", async () => {
    const sheetApisClient = makeSheetApisClient({
      sheet: {
        getEventConfig: () =>
          Effect.succeed(
            new EventConfig({
              startTime: DateTime.makeUnsafe("2026-03-26T12:00:00.000Z"),
            }),
          ),
      },
      guildConfig: {
        getGuildChannels: () =>
          Effect.succeed([
            makeGuildChannel(Option.some("main")),
            makeGuildChannel(Option.some("side")),
          ]),
      },
    });

    const count = await runService((service) => service.enqueueGuild("guild-1"), {
      sheetApisClient,
      workflowClient: {
        enqueueChannel: (payload: AutoCheckinChannelPayload) =>
          payload.channelName === "main"
            ? Effect.fail(new Error("enqueue failed"))
            : Effect.succeed("execution-side"),
      } as never,
      clockTime: "2026-03-26T13:40:00.000Z",
    });

    expect(count).toBe(1);
  });

  it("continues enqueueing guilds when one guild fails", async () => {
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getAutoCheckinGuilds: () =>
          Effect.succeed([makeGuildConfig("guild-1"), makeGuildConfig("guild-2")]),
        getGuildChannels: ({ query }: { readonly query: { readonly guildId: string } }) =>
          query.guildId === "guild-1"
            ? Effect.fail(new Error("guild failed"))
            : Effect.succeed([makeGuildChannel(Option.some("side"))]),
      },
      sheet: {
        getEventConfig: ({ query }: { readonly query: { readonly guildId: string } }) =>
          query.guildId === "guild-1"
            ? Effect.fail(new Error("event config failed"))
            : Effect.succeed(
                new EventConfig({
                  startTime: DateTime.makeUnsafe("2026-03-26T12:00:00.000Z"),
                }),
              ),
      },
    });

    const count = await runService((service) => service.enqueueDueChannels(), {
      sheetApisClient,
      workflowClient: {
        enqueueChannel: () => Effect.succeed("execution-side"),
      } as never,
      clockTime: "2026-03-26T13:40:00.000Z",
    });

    expect(count).toBe(1);
  });

  it("processes a sent auto check-in channel", async () => {
    const botCalls: Array<unknown> = [];
    const persistCheckinCalls: Array<unknown> = [];
    const persistRoomOrderCalls: Array<unknown> = [];
    const sheetApisClient = makeSheetApisClient({
      checkin: {
        generate: () => Effect.succeed(makeGeneratedCheckin()),
      },
      messageCheckin: {
        persistMessageCheckin: (args: unknown) => {
          persistCheckinCalls.push(args);
          return Effect.succeed({});
        },
      },
      roomOrder: {
        generate: () => Effect.succeed(makeRoomOrder()),
      },
      messageRoomOrder: {
        persistMessageRoomOrder: (args: unknown) => {
          persistRoomOrderCalls.push(args);
          return Effect.succeed({});
        },
      },
    });

    const result = await runService((service) => service.processChannel(payload), {
      sheetApisClient,
      botClient: makeBotClient(botCalls),
    });

    expect(result).toEqual({
      guildId: "guild-1",
      channelName: "main",
      hour: 3,
      status: "sent",
      checkinMessageId: "checkin-channel-message-1",
      monitorMessageId: "running-channel-message-3",
      tentativeRoomOrderMessageId: "running-channel-message-4",
    });
    expect(botCalls).toMatchObject([
      {
        method: "sendMessage",
        channelId: "checkin-channel",
        message: {
          content: "check in now\n-# Sent automatically via auto check-in.",
        },
      },
      {
        method: "updateMessage",
        channelId: "checkin-channel",
        messageId: "checkin-channel-message-1",
      },
      {
        method: "sendMessage",
        channelId: "running-channel",
        message: {
          content: "<@monitor-1>",
          allowed_mentions: { users: ["monitor-1"] },
        },
      },
      {
        method: "sendMessage",
        channelId: "running-channel",
        message: {
          content: "(tentative)\nroom order",
        },
      },
    ]);
    expect(persistCheckinCalls).toEqual([
      {
        payload: {
          messageId: "checkin-channel-message-1",
          data: {
            initialMessage: "check in now\n-# Sent automatically via auto check-in.",
            hour: 3,
            channelId: "running-channel",
            roleId: "role-1",
            guildId: "guild-1",
            messageChannelId: "checkin-channel",
            createdByUserId: null,
          },
          memberIds: ["member-1", "member-2"],
        },
      },
    ]);
    expect(persistRoomOrderCalls).toHaveLength(1);
    expect(persistRoomOrderCalls[0]).toMatchObject({
      payload: {
        messageId: "running-channel-message-4",
        data: {
          tentative: true,
          guildId: "guild-1",
          createdByUserId: null,
        },
      },
    });
  });

  it("sends only the monitor summary when generated check-in has no initial message", async () => {
    const botCalls: Array<unknown> = [];
    const sheetApisClient = makeSheetApisClient({
      checkin: {
        generate: () =>
          Effect.succeed(
            makeGeneratedCheckin({
              initialMessage: null,
              fillCount: 0,
              monitorUserId: null,
              monitorFailureMessage: null,
            }),
          ),
      },
    });

    const result = await runService((service) => service.processChannel(payload), {
      sheetApisClient,
      botClient: makeBotClient(botCalls),
    });

    expect(result).toEqual({
      guildId: "guild-1",
      channelName: "main",
      hour: 3,
      status: "skipped",
      checkinMessageId: null,
      monitorMessageId: "running-channel-message-1",
      tentativeRoomOrderMessageId: null,
    });
    expect(botCalls).toEqual([
      {
        method: "sendMessage",
        channelId: "running-channel",
        message: {
          content: undefined,
          embeds: [
            {
              title: "Auto check-in summary for monitors",
              description: "monitor summary\n-# Sent automatically via auto check-in.",
            },
          ],
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });
});
