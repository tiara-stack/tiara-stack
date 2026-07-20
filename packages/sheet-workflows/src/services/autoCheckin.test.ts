// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { CheckinGenerateResult } from "sheet-ingress-api/schemas/checkin";
import {
  WorkspaceConversationConfig,
  WorkspaceConfig,
} from "sheet-ingress-api/schemas/workspaceConfig";
import { MessageRoomOrderRange } from "sheet-ingress-api/schemas/messageRoomOrder";
import { RoomOrderGenerateResult } from "sheet-ingress-api/schemas/roomOrder";
import { EventConfig } from "sheet-ingress-api/schemas/sheetConfig";
import {
  Player,
  PopulatedSchedule,
  PopulatedSchedulePlayer,
} from "sheet-ingress-api/schemas/sheet";
import {
  AutoCheckinService,
  AutoCheckinWorkflowClient,
  ClientDeliveryClient,
  SheetApisClient,
} from "@/services";
import type {
  AutoCheckinConversationPayload,
  AutoCheckinConversationResult,
} from "@/workflows/autoCheckinContract";
import { makeSheetApisClient, normalizePayloadText, text } from "./testHelpers";
import * as Data from "effect/Data";

class SheetWorkflowsServicesAutoCheckinTestError extends Data.TaggedError(
  "SheetWorkflowsServicesAutoCheckinTestError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const payload: AutoCheckinConversationPayload = {
  workspaceId: "workspace-1",
  conversationName: "main",
  hour: 3,
  eventStartEpochMs: Date.parse("2026-03-26T12:00:00.000Z"),
};

const makeWorkspaceConfig = (workspaceId: string) =>
  new WorkspaceConfig({
    workspaceId,
    sheetId: Option.some("sheet-1"),
    autoCheckin: Option.some(true),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  });

const makeWorkspaceConversation = (
  name: Option.Option<string>,
  overrides: Partial<ConstructorParameters<typeof WorkspaceConversationConfig>[0]> = {},
) =>
  new WorkspaceConversationConfig({
    workspaceId: "workspace-1",
    conversationId: `conversation-${Option.getOrElse(name, () => "unnamed")}`,
    name,
    running: Option.some(true),
    roleId: Option.none(),
    checkinConversationId: Option.none(),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
    ...overrides,
  });

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
              player: new Player({ index, id: fillIds[index], name: fillIds[index] }),
              enc: false,
            }),
      ),
    ),
    overfills: [],
    standbys: [],
    runners: [],
    monitor: Option.none(),
  });

const makeGeneratedCheckin = (overrides?: {
  readonly initialMessage?: ReturnType<typeof text> | null;
  readonly fillCount?: number;
  readonly monitorUserId?: string | null;
  readonly monitorFailureMessage?: ReturnType<typeof text> | null;
}) =>
  new CheckinGenerateResult({
    hour: payload.hour,
    runningConversationId: "running-conversation",
    checkinConversationId: "checkin-conversation",
    fillCount: overrides?.fillCount ?? 5,
    roleId: "role-1",
    initialMessage:
      overrides && "initialMessage" in overrides ? overrides.initialMessage! : text("check in now"),
    monitorCheckinMessage: text("monitor summary"),
    monitorUserId:
      overrides && "monitorUserId" in overrides ? overrides.monitorUserId! : "monitor-1",
    monitorFailureMessage:
      overrides && "monitorFailureMessage" in overrides
        ? overrides.monitorFailureMessage!
        : text("monitor missing"),
    fillIds: ["member-1", "member-2"],
  });

const makeRoomOrder = () =>
  new RoomOrderGenerateResult({
    content: text("room order"),
    runningConversationId: "running-conversation",
    range: new MessageRoomOrderRange({ minRank: 1, maxRank: 1 }),
    rank: 1,
    hour: payload.hour,
    monitor: null,
    previousFills: [],
    fills: ["member-1"],
    entries: [],
  });

const makeBotClient = (calls: Array<unknown>) =>
  ({
    getWorkspace: () => Effect.succeed({ id: "workspace-1", name: "Workspace One" }),
    forClient: (client: unknown) => ({
      sendDirectMessage: (userId: string, message: unknown) => {
        calls.push({
          method: "sendDirectMessage",
          client,
          userId,
          message: normalizePayloadText(message),
        });
        return Effect.succeed({
          id: `direct-message-${calls.length}`,
          conversation_id: `dm-${userId}`,
        });
      },
    }),
    sendMessage: (conversationId: string, message: unknown) => {
      calls.push({ method: "sendMessage", conversationId, message: normalizePayloadText(message) });
      return Effect.succeed({
        id: `${conversationId}-message-${calls.length}`,
        conversation_id: conversationId,
      });
    },
    updateMessage: (conversationId: string, messageId: string, message: unknown) => {
      calls.push({
        method: "updateMessage",
        conversationId,
        messageId,
        message: normalizePayloadText(message),
      });
      return Effect.succeed({ id: messageId, conversation_id: conversationId });
    },
  }) as never;

const runService = <A, E>(
  effect: (service: typeof AutoCheckinService.Service) => Effect.Effect<A, E, never>,
  options: {
    readonly sheetApisClient: typeof SheetApisClient.Service;
    readonly botClient?: typeof ClientDeliveryClient.Service;
    readonly workflowClient?: typeof AutoCheckinWorkflowClient.Service;
    readonly clockTime?: string;
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (options.clockTime) {
        yield* TestClock.setTime(Date.parse(options.clockTime));
      }
      const service = yield* AutoCheckinService.make;
      return yield* effect(service);
    }).pipe(
      Effect.provideService(SheetApisClient, options.sheetApisClient),
      Effect.provideService(ClientDeliveryClient, options.botClient ?? ({} as never)),
      Effect.provideService(
        AutoCheckinWorkflowClient,
        options.workflowClient ??
          ({
            enqueueConversation: () => Effect.die("Unexpected workflow enqueue"),
          } as never),
      ),
      Effect.provide(TestClock.layer()),
    ),
  );

describe("AutoCheckinService", () => {
  it.effect("derives the target hour and enqueues unique named running conversations", () =>
    Effect.gen(function* () {
      const enqueued: AutoCheckinConversationPayload[] = [];
      const sheetApisClient = makeSheetApisClient({
        sheet: {
          getEventConfig: () =>
            Effect.succeed(
              new EventConfig({
                startTime: DateTime.makeUnsafe("2026-03-26T12:00:00.000Z"),
              }),
            ),
        },
        workspaceConfig: {
          getWorkspaceConversations: () =>
            Effect.succeed([
              makeWorkspaceConversation(Option.some("main")),
              makeWorkspaceConversation(Option.some("main")),
              makeWorkspaceConversation(Option.some("side")),
              makeWorkspaceConversation(Option.some("")),
              makeWorkspaceConversation(Option.none()),
            ]),
        },
      });

      const count = yield* runService((service) => service.enqueueWorkspace("workspace-1"), {
        sheetApisClient,
        workflowClient: {
          enqueueConversation: (payload: AutoCheckinConversationPayload) => {
            enqueued.push(payload);
            return Effect.succeed(`execution-${enqueued.length}`);
          },
        } as never,
        clockTime: "2026-03-26T13:40:00.000Z",
      });

      expect(count).toBe(2);
      expect(enqueued).toEqual([
        {
          workspaceId: "workspace-1",
          conversationName: "main",
          hour: 3,
          eventStartEpochMs: Date.parse("2026-03-26T12:00:00.000Z"),
        },
        {
          workspaceId: "workspace-1",
          conversationName: "side",
          hour: 3,
          eventStartEpochMs: Date.parse("2026-03-26T12:00:00.000Z"),
        },
      ]);
    }),
  );

  it.effect("continues enqueueing when one conversation enqueue fails", () =>
    Effect.gen(function* () {
      const sheetApisClient = makeSheetApisClient({
        sheet: {
          getEventConfig: () =>
            Effect.succeed(
              new EventConfig({
                startTime: DateTime.makeUnsafe("2026-03-26T12:00:00.000Z"),
              }),
            ),
        },
        workspaceConfig: {
          getWorkspaceConversations: () =>
            Effect.succeed([
              makeWorkspaceConversation(Option.some("main")),
              makeWorkspaceConversation(Option.some("side")),
            ]),
        },
      });

      const count = yield* runService((service) => service.enqueueWorkspace("workspace-1"), {
        sheetApisClient,
        workflowClient: {
          enqueueConversation: (payload: AutoCheckinConversationPayload) =>
            payload.conversationName === "main"
              ? Effect.fail(
                  new SheetWorkflowsServicesAutoCheckinTestError({ message: "enqueue failed" }),
                )
              : Effect.succeed("execution-side"),
        } as never,
        clockTime: "2026-03-26T13:40:00.000Z",
      });

      expect(count).toBe(1);
    }),
  );

  it.effect("continues enqueueing workspaces when one workspace fails", () =>
    Effect.gen(function* () {
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getAutoCheckinWorkspaces: () =>
            Effect.succeed([
              makeWorkspaceConfig("workspace-1"),
              makeWorkspaceConfig("workspace-2"),
            ]),
          getWorkspaceConversations: ({
            query,
          }: {
            readonly query: { readonly workspaceId: string };
          }) =>
            query.workspaceId === "workspace-1"
              ? Effect.fail(
                  new SheetWorkflowsServicesAutoCheckinTestError({ message: "workspace failed" }),
                )
              : Effect.succeed([makeWorkspaceConversation(Option.some("side"))]),
        },
        sheet: {
          getEventConfig: ({ query }: { readonly query: { readonly workspaceId: string } }) =>
            query.workspaceId === "workspace-1"
              ? Effect.fail(
                  new SheetWorkflowsServicesAutoCheckinTestError({
                    message: "event config failed",
                  }),
                )
              : Effect.succeed(
                  new EventConfig({
                    startTime: DateTime.makeUnsafe("2026-03-26T12:00:00.000Z"),
                  }),
                ),
        },
      });

      const count = yield* runService((service) => service.enqueueDueConversations(), {
        sheetApisClient,
        workflowClient: {
          enqueueConversation: () => Effect.succeed("execution-side"),
        } as never,
        clockTime: "2026-03-26T13:40:00.000Z",
      });

      expect(count).toBe(1);
    }),
  );

  it.effect("cleans lockdown roles for the current hour and skips unconfigured conversations", () =>
    Effect.gen(function* () {
      const scheduleCalls: Array<unknown> = [];
      const removeCalls: Array<ReadonlyArray<string>> = [];
      const sheetApisClient = makeSheetApisClient({
        sheet: {
          getEventConfig: () =>
            Effect.succeed(
              new EventConfig({
                startTime: DateTime.makeUnsafe("2026-03-26T12:00:00.000Z"),
              }),
            ),
        },
        workspaceConfig: {
          getWorkspaceConversations: () =>
            Effect.succeed([
              makeWorkspaceConversation(Option.some("main"), {
                conversationId: "conversation-main",
                roleId: Option.some("role-main"),
              }),
              makeWorkspaceConversation(Option.some("side"), {
                conversationId: "conversation-side",
                roleId: Option.none(),
              }),
            ]),
        },
        schedule: {
          getConversationPopulatedSchedules: (args: unknown) => {
            scheduleCalls.push(args);
            return Effect.succeed({ schedules: [makeSchedule(2, ["member-fill"])] });
          },
        },
      });
      const botClient = {
        getMembersForParent: () =>
          Effect.succeed([
            {
              parentId: "workspace-1",
              resourceId: "member-fill",
              value: { user: { id: "member-fill" }, roles: ["role-main"] },
            },
            {
              parentId: "workspace-1",
              resourceId: "member-remove",
              value: { user: { id: "member-remove" }, roles: ["role-main"] },
            },
            {
              parentId: "workspace-1",
              resourceId: "member-unrelated",
              value: { user: { id: "member-unrelated" }, roles: ["other-role"] },
            },
          ]),
        removeWorkspaceMemberRole: (workspaceId: string, memberId: string, roleId: string) => {
          removeCalls.push([workspaceId, memberId, roleId]);
          return Effect.void;
        },
      } as never;

      const count = yield* runService((service) => service.kickWorkspace("workspace-1"), {
        sheetApisClient,
        botClient,
        clockTime: "2026-03-26T13:15:00.000Z",
      });

      expect(count).toBe(1);
      expect(scheduleCalls).toEqual([
        {
          query: {
            workspaceId: "workspace-1",
            conversationName: "main",
            view: "monitor",
          },
        },
      ]);
      expect(removeCalls).toEqual([["workspace-1", "member-remove", "role-main"]]);
    }),
  );

  it.effect("isolates automatic kick failures between conversations and workspaces", () =>
    Effect.gen(function* () {
      const conversationCalls: Array<unknown> = [];
      let memberLookupCount = 0;
      const removeCalls: Array<ReadonlyArray<string>> = [];
      const sheetApisClient = makeSheetApisClient({
        workspaceConfig: {
          getAutoCheckinWorkspaces: () =>
            Effect.succeed([
              makeWorkspaceConfig("workspace-failed"),
              makeWorkspaceConfig("workspace-2"),
            ]),
          getWorkspaceConversations: (args: {
            readonly query: { readonly workspaceId: string; readonly running: boolean };
          }) => {
            conversationCalls.push(args);
            return args.query.workspaceId === "workspace-2"
              ? Effect.succeed([
                  makeWorkspaceConversation(Option.some("broken"), {
                    workspaceId: "workspace-2",
                    conversationId: "conversation-broken",
                    roleId: Option.some("role-broken"),
                  }),
                  makeWorkspaceConversation(Option.some("main"), {
                    workspaceId: "workspace-2",
                    conversationId: "conversation-main",
                    roleId: Option.some("role-main"),
                  }),
                  makeWorkspaceConversation(Option.some("secondary"), {
                    workspaceId: "workspace-2",
                    conversationId: "conversation-secondary",
                    roleId: Option.some("role-secondary"),
                  }),
                ])
              : Effect.die(`Unexpected conversation lookup for ${args.query.workspaceId}`);
          },
        },
        sheet: {
          getEventConfig: ({ query }: { readonly query: { readonly workspaceId: string } }) =>
            query.workspaceId === "workspace-failed"
              ? Effect.fail(
                  new SheetWorkflowsServicesAutoCheckinTestError({
                    message: "event config failed",
                  }),
                )
              : Effect.succeed(
                  new EventConfig({
                    startTime: DateTime.makeUnsafe("2026-03-26T12:00:00.000Z"),
                  }),
                ),
        },
        schedule: {
          getConversationPopulatedSchedules: ({
            query,
          }: {
            readonly query: { readonly conversationName: string };
          }) =>
            query.conversationName === "broken"
              ? Effect.fail(
                  new SheetWorkflowsServicesAutoCheckinTestError({ message: "schedule failed" }),
                )
              : Effect.succeed({ schedules: [makeSchedule(2, [])] }),
        },
      });
      const botClient = {
        getMembersForParent: () =>
          Effect.sync(() => {
            memberLookupCount += 1;
            return [
              {
                parentId: "workspace-2",
                resourceId: "member-remove",
                value: { user: { id: "member-remove" }, roles: ["role-main"] },
              },
            ];
          }),
        removeWorkspaceMemberRole: (workspaceId: string, memberId: string, roleId: string) => {
          removeCalls.push([workspaceId, memberId, roleId]);
          return Effect.void;
        },
      } as never;

      const count = yield* runService((service) => service.runDueKicks(), {
        sheetApisClient,
        botClient,
        clockTime: "2026-03-26T13:15:00.000Z",
      });

      expect(count).toBe(2);
      expect(conversationCalls).toEqual([{ query: { workspaceId: "workspace-2", running: true } }]);
      expect(memberLookupCount).toBe(1);
      expect(removeCalls).toEqual([["workspace-2", "member-remove", "role-main"]]);
    }),
  );

  it.effect("processes a sent auto check-in conversation", () =>
    Effect.gen(function* () {
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
        userConfig: {
          getCheckinDmRecipients: () => Effect.succeed([]),
          getMonitorDmRecipients: (args: unknown) => {
            expect(args).toEqual({
              payload: { platform: "discord", userIds: ["monitor-1"] },
            });
            return Effect.succeed([
              {
                platform: "discord",
                userId: "monitor-1",
                defaultClientId: "discord-main",
              },
            ]);
          },
        },
        messageRoomOrder: {
          persistMessageRoomOrder: (args: unknown) => {
            persistRoomOrderCalls.push(args);
            return Effect.succeed({});
          },
        },
      });

      const result = yield* runService(
        (service) =>
          service.processConversation(payload) as Effect.Effect<
            AutoCheckinConversationResult,
            unknown,
            never
          >,
        {
          sheetApisClient,
          botClient: makeBotClient(botCalls),
        },
      );

      expect(result).toEqual({
        workspaceId: "workspace-1",
        conversationName: "main",
        hour: 3,
        status: "sent",
        checkinMessageId: "checkin-conversation-message-1",
        monitorMessageId: "running-conversation-message-4",
        tentativeRoomOrderMessageId: "running-conversation-message-5",
      });
      expect(botCalls).toMatchObject([
        {
          method: "sendMessage",
          conversationId: "checkin-conversation",
          message: {
            content: "check in now\nSent automatically via auto check-in.",
          },
        },
        {
          method: "updateMessage",
          conversationId: "checkin-conversation",
          messageId: "checkin-conversation-message-1",
        },
        {
          method: "sendDirectMessage",
          client: { platform: "discord", clientId: "discord-main" },
          userId: "monitor-1",
          message: {
            content: null,
            embeds: [
              {
                title: "Check-in is open for hour 3",
                description:
                  "Server: Workspace One\nRunning channel: #running-conversation\nYou are assigned as monitor for this hour.\nOpen the running channel for the monitor summary and next steps.",
              },
            ],
            allowedMentions: "none",
          },
        },
        {
          method: "sendMessage",
          conversationId: "running-conversation",
          message: {
            content: "@monitor-1",
          },
        },
        {
          method: "sendMessage",
          conversationId: "running-conversation",
          message: {
            content: "(tentative)\nroom order",
          },
        },
      ]);
      expect(persistCheckinCalls).toEqual([
        {
          payload: {
            clientPlatform: "discord",
            clientId: "discord-main",
            messageId: "checkin-conversation-message-1",
            data: {
              initialMessage: [
                { type: "text", text: "check in now" },
                { type: "text", text: "\n" },
                {
                  type: "subtle",
                  parts: [{ type: "text", text: "Sent automatically via auto check-in." }],
                },
              ],
              hour: 3,
              runningConversationId: "running-conversation",
              roleId: "role-1",
              workspaceId: "workspace-1",
              conversationId: "checkin-conversation",
              createdByUserId: null,
            },
            memberIds: ["member-1", "member-2"],
          },
        },
      ]);
      expect(persistRoomOrderCalls).toHaveLength(1);
      expect(persistRoomOrderCalls[0]).toMatchObject({
        payload: {
          clientPlatform: "discord",
          clientId: "discord-main",
          messageId: "running-conversation-message-5",
          data: {
            tentative: true,
            workspaceId: "workspace-1",
            conversationId: "running-conversation",
            createdByUserId: null,
          },
        },
      });
    }),
  );

  it.effect("sends only the monitor summary when generated check-in has no initial message", () =>
    Effect.gen(function* () {
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

      const result = yield* runService(
        (service) =>
          service.processConversation(payload) as Effect.Effect<
            AutoCheckinConversationResult,
            unknown,
            never
          >,
        {
          sheetApisClient,
          botClient: makeBotClient(botCalls),
        },
      );

      expect(result).toEqual({
        workspaceId: "workspace-1",
        conversationName: "main",
        hour: 3,
        status: "skipped",
        checkinMessageId: null,
        monitorMessageId: "running-conversation-message-1",
        tentativeRoomOrderMessageId: null,
      });
      expect(botCalls).toEqual([
        {
          method: "sendMessage",
          conversationId: "running-conversation",
          message: {
            content: undefined,
            embeds: [
              {
                title: "Auto check-in summary for monitors",
                description: "monitor summary\nSent automatically via auto check-in.",
              },
            ],
            allowedMentions: "none",
          },
        },
      ]);
    }),
  );
});
