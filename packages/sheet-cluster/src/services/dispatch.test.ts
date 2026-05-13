import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { TestClock } from "effect/testing";
import type {
  KickoutDispatchPayload,
  SlotButtonDispatchPayload,
} from "sheet-ingress-api/handlers/dispatch/schema";
import {
  Player,
  PopulatedSchedule,
  PopulatedSchedulePlayer,
} from "sheet-ingress-api/schemas/sheet";
import { DispatchService, IngressBotClient, SheetApisClient } from "@/services";

const slotButtonPayload: SlotButtonDispatchPayload = {
  dispatchRequestId: "dispatch-slot-button",
  guildId: "guild-1",
  channelId: "channel-1",
  day: 2,
  interactionToken: "interaction-token",
  interactionDeadlineEpochMs: 1_700_000_000_000,
};

const requester = {
  accountId: "account-1",
  userId: "discord-user-1",
};

const makeSchedule = (hour: number, fillIds: ReadonlyArray<string>) =>
  new PopulatedSchedule({
    channel: "main",
    day: 1,
    visible: true,
    hour: Option.some(hour),
    hourWindow: Option.none(),
    fills: Array.from({ length: 5 }, (_value, index) =>
      Option.fromNullishOr(
        fillIds[index] === undefined
          ? undefined
          : new PopulatedSchedulePlayer({
              player: new Player({
                index,
                id: fillIds[index],
                name: fillIds[index],
              }),
              enc: false,
            }),
      ),
    ),
    overfills: [],
    standbys: [],
    runners: [],
    monitor: Option.none(),
  });

const unexpected = (name: string) => () => Effect.die(`Unexpected Sheet API call: ${name}`);

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

const makeMessageSlotSheetApisClient = (
  upsertMessageSlotData: (args: unknown) => Effect.Effect<unknown, unknown>,
) =>
  makeSheetApisClient({
    messageSlot: {
      upsertMessageSlotData,
    },
  });

const runSlotButton = (
  botClient: typeof IngressBotClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
) =>
  Effect.gen(function* () {
    const service = yield* DispatchService.make;
    return yield* service.slotButton(slotButtonPayload, requester);
  }).pipe(
    Effect.provideService(IngressBotClient, botClient),
    Effect.provideService(SheetApisClient, sheetApisClient),
  );

describe("DispatchService", () => {
  it("persists slot button metadata with the requester Discord user id", async () => {
    const upsertCalls: Array<unknown> = [];
    const botClient = {
      sendMessage: () => Effect.succeed({ id: "message-1", channel_id: "channel-1" }),
      updateOriginalInteractionResponse: () =>
        Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" }),
    } as never;
    const sheetApisClient = makeMessageSlotSheetApisClient((args) => {
      upsertCalls.push(args);
      return Effect.succeed({});
    });

    const result = await Effect.runPromise(runSlotButton(botClient, sheetApisClient));

    expect(result).toEqual({
      messageId: "message-1",
      messageChannelId: "channel-1",
      day: 2,
    });
    expect(upsertCalls).toEqual([
      {
        payload: {
          messageId: "message-1",
          data: {
            day: 2,
            guildId: "guild-1",
            messageChannelId: "channel-1",
            createdByUserId: "discord-user-1",
          },
        },
      },
    ]);
  });

  it("deletes the slot button message when metadata persistence fails", async () => {
    const deleteCalls: Array<ReadonlyArray<string>> = [];
    const botClient = {
      sendMessage: () => Effect.succeed({ id: "message-1", channel_id: "channel-1" }),
      deleteMessage: (channelId: string, messageId: string) => {
        deleteCalls.push([channelId, messageId]);
        return Effect.succeed({});
      },
    } as never;
    const upsertError = new Error("upsert failed");
    const sheetApisClient = makeMessageSlotSheetApisClient(() => Effect.fail(upsertError));

    const exit = await Effect.runPromiseExit(runSlotButton(botClient, sheetApisClient));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons
          .filter(Cause.isFailReason)
          .some((reason) => reason.error === upsertError),
    ).toBe(true);
    expect(deleteCalls).toEqual([["channel-1", "message-1"]]);
  });

  it("returns slot button success when the final interaction update fails", async () => {
    const upsertCalls: Array<unknown> = [];
    const botClient = {
      sendMessage: () => Effect.succeed({ id: "message-1", channel_id: "channel-1" }),
      updateOriginalInteractionResponse: () => Effect.fail(new Error("interaction update failed")),
    } as never;
    const sheetApisClient = makeMessageSlotSheetApisClient((args) => {
      upsertCalls.push(args);
      return Effect.succeed({});
    });

    const result = await Effect.runPromise(runSlotButton(botClient, sheetApisClient));

    expect(result).toEqual({
      messageId: "message-1",
      messageChannelId: "channel-1",
      day: 2,
    });
    expect(upsertCalls).toHaveLength(1);
  });

  it("updates the interaction before failing when kickout cannot find a running channel", async () => {
    const updateCalls: Array<unknown> = [];
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannelById: () => Effect.fail({ _tag: "ArgumentError", message: "missing" }),
      },
    });

    const exit = await Effect.runPromiseExit(
      runKickout(
        {
          dispatchRequestId: "dispatch-kickout",
          guildId: "guild-1",
          channelId: "channel-1",
          hour: 1,
          interactionToken: "interaction-token",
        },
        botClient,
        sheetApisClient,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(updateCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          content: "Cannot kick out, running channel not found",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });

  it("returns tooEarly and skips sheet lookups when kickout runs too late in the hour", async () => {
    const updateCalls: Array<unknown> = [];
    const sheetApiCalls: Array<string> = [];
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
    } as never;
    const sheetApisClient = makeSheetApisClient(
      new Proxy(
        {},
        {
          get: (_target, group: string) =>
            new Proxy(
              {},
              {
                get: (_service, method: string) => {
                  sheetApiCalls.push(`${group}.${method}`);
                  return unexpected(`${group}.${method}`);
                },
              },
            ),
        },
      ),
    );

    const result = await Effect.runPromise(
      runKickout(
        {
          dispatchRequestId: "dispatch-kickout",
          guildId: "guild-1",
          channelId: "channel-1",
          hour: 1,
          interactionToken: "interaction-token",
        },
        botClient,
        sheetApisClient,
        Date.parse("2026-05-13T00:40:00.000Z"),
      ),
    );

    expect(result).toEqual({
      guildId: "guild-1",
      runningChannelId: "channel-1",
      hour: 1,
      roleId: null,
      removedMemberIds: [],
      status: "tooEarly",
    });
    expect(updateCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          content: "Cannot kick out until next hour starts",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
    expect(sheetApiCalls).toEqual([]);
  });

  it("updates the interaction before failing when kickout channel has no name", async () => {
    const updateCalls: Array<unknown> = [];
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannelById: () =>
          Effect.succeed({
            guildId: "guild-1",
            channelId: "channel-1",
            name: Option.none(),
            roleId: Option.some("role-1"),
            running: Option.some(true),
          }),
      },
    });

    const exit = await Effect.runPromiseExit(
      runKickout(
        {
          dispatchRequestId: "dispatch-kickout",
          guildId: "guild-1",
          channelId: "channel-1",
          hour: 1,
          interactionToken: "interaction-token",
        },
        botClient,
        sheetApisClient,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(updateCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          content: "Cannot kick out, channel has no name",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });

  it("does not remove roles when kickout has no schedule for the channel hour", async () => {
    const updateCalls: Array<unknown> = [];
    const removeCalls: Array<ReadonlyArray<string>> = [];
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
      getMembersForParent: () => Effect.die("members should not be loaded without a schedule"),
      removeGuildMemberRole: (guildId: string, memberId: string, roleId: string) => {
        removeCalls.push([guildId, memberId, roleId]);
        return Effect.succeed({});
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannelById: () =>
          Effect.succeed({
            guildId: "guild-1",
            channelId: "channel-1",
            name: Option.some("main"),
            roleId: Option.some("role-1"),
            running: Option.some(true),
          }),
      },
      schedule: {
        getChannelPopulatedSchedules: () => Effect.succeed({ schedules: [] }),
      },
    });

    const result = await Effect.runPromise(
      runKickout(
        {
          dispatchRequestId: "dispatch-kickout",
          guildId: "guild-1",
          channelId: "channel-1",
          hour: 1,
          interactionToken: "interaction-token",
        },
        botClient,
        sheetApisClient,
      ),
    );

    expect(result).toEqual({
      guildId: "guild-1",
      runningChannelId: "channel-1",
      hour: 1,
      roleId: "role-1",
      removedMemberIds: [],
      status: "empty",
    });
    expect(updateCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          content: "No schedule found for this channel and hour; no players kicked out",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
    expect(removeCalls).toEqual([]);
  });

  it("continues kickout removals and updates the interaction when one role removal fails", async () => {
    const updateCalls: Array<unknown> = [];
    const removeCalls: Array<ReadonlyArray<string>> = [];
    const botClient = {
      updateOriginalInteractionResponse: (interactionToken: string, payload: unknown) => {
        updateCalls.push({ interactionToken, payload });
        return Effect.succeed({ id: "interaction-message-1", channel_id: "channel-1" });
      },
      getMembersForParent: () =>
        Effect.succeed([
          {
            parentId: "guild-1",
            resourceId: "member-1",
            value: { user: { id: "member-1" }, roles: ["role-1"] },
          },
          {
            parentId: "guild-1",
            resourceId: "member-2",
            value: { user: { id: "member-2" }, roles: ["role-1"] },
          },
          {
            parentId: "guild-1",
            resourceId: "member-3",
            value: { user: { id: "member-3" }, roles: ["role-1"] },
          },
        ]),
      removeGuildMemberRole: (guildId: string, memberId: string, roleId: string) => {
        removeCalls.push([guildId, memberId, roleId]);
        return memberId === "member-2"
          ? Effect.fail(new Error("Discord role removal failed"))
          : Effect.succeed({});
      },
    } as never;
    const sheetApisClient = makeSheetApisClient({
      guildConfig: {
        getGuildChannelById: () =>
          Effect.succeed({
            guildId: "guild-1",
            channelId: "channel-1",
            name: Option.some("main"),
            roleId: Option.some("role-1"),
            running: Option.some(true),
          }),
      },
      schedule: {
        getChannelPopulatedSchedules: () =>
          Effect.succeed({ schedules: [makeSchedule(1, ["member-1"])] }),
      },
    });

    const result = await Effect.runPromise(
      runKickout(
        {
          dispatchRequestId: "dispatch-kickout",
          guildId: "guild-1",
          channelId: "channel-1",
          hour: 1,
          interactionToken: "interaction-token",
        },
        botClient,
        sheetApisClient,
      ),
    );

    expect(result).toEqual({
      guildId: "guild-1",
      runningChannelId: "channel-1",
      hour: 1,
      roleId: "role-1",
      removedMemberIds: ["member-3"],
      status: "removed",
    });
    expect(removeCalls).toEqual([
      ["guild-1", "member-2", "role-1"],
      ["guild-1", "member-3", "role-1"],
    ]);
    expect(updateCalls).toEqual([
      {
        interactionToken: "interaction-token",
        payload: {
          content: "Kicked out <@member-3>",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });
});

const runKickout = (
  payload: KickoutDispatchPayload,
  botClient: typeof IngressBotClient.Service,
  sheetApisClient: typeof SheetApisClient.Service,
  clockTime = Date.parse("2026-05-13T00:00:00.000Z"),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(clockTime);
      const service = yield* DispatchService.make;
      return yield* service.kickout(payload, requester);
    }).pipe(
      Effect.provideService(IngressBotClient, botClient),
      Effect.provideService(SheetApisClient, sheetApisClient),
      Effect.provide(TestClock.layer()),
    ),
  );
