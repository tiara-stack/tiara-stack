import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Option, Schema } from "effect";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { InvocationId } from "effect-zero-workflow/contract";
import { BotOutboundMessage, DeliveryKey, messageRefFrom, ResponseReference } from "sheet-bot-api";
import { EffectivePrincipal } from "sheet-auth/identity";
import { CheckinsOpen } from "sheet-workflow-contracts";
import { CheckinGeneration } from "@/services/sheetDataProvider";
import {
  makeCheckinsOpenAutonomousInvocationId,
  makeCheckinsOpenActionKey,
  makeCheckinsOpenDeliveryKey,
  makeCheckinsOpenSerializationKey,
  makeCheckinsOpenUserInvocationId,
  checkinsOpenActionIdentities,
} from "./keys";
import { makeCheckinsOpenDefinition, makeCheckinsOpenWorkflowBody } from "./openDefinition";
import { CheckinsOpenResolvedExecution } from "./openSchema";

const invocationId = Schema.decodeUnknownSync(InvocationId)("123e4567-e89b-42d3-a456-426614174000");
const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-open-1");
const client = { platform: "discord" as const, clientId: "discord-main" };
const workspaceId = "workspace-1";
const userPrincipal = Schema.decodeUnknownSync(EffectivePrincipal)({
  kind: "user",
  userId: "user-1",
  discordAccount: { accountId: "discord-user-1" },
});
const servicePrincipal = Schema.decodeUnknownSync(EffectivePrincipal)({
  kind: "service",
  serviceId: "auto-checkin",
  oauthClientId: "auto-checkin-client",
});

const message = (text: string): typeof BotOutboundMessage.Type => ({
  content: [{ type: "text", text }],
});

const makeMessageRef = (conversationId: string, messageId: string) =>
  messageRefFrom(client, workspaceId, conversationId, messageId);

const sendReceipt = (
  invocation: typeof InvocationId.Type,
  action: "deliver-checkin" | "deliver-primary" | "deliver-tentative-room-order",
  conversationId: string,
  messageId: string,
) => ({
  deliveryKey: makeCheckinsOpenDeliveryKey(invocation, action),
  operation: "sendMessage" as const,
  target: {
    _tag: "Message" as const,
    message: makeMessageRef(conversationId, messageId),
  },
});

const editReceipt = (invocation: typeof InvocationId.Type, messageId: string) => ({
  deliveryKey: makeCheckinsOpenDeliveryKey(invocation, "finalize-checkin"),
  operation: "editMessage" as const,
  target: {
    _tag: "Message" as const,
    message: makeMessageRef("checkin-1", messageId),
  },
});

const directReceipt = (invocation: typeof InvocationId.Type, userId: string) => ({
  deliveryKey: makeCheckinsOpenDeliveryKey(invocation, "deliver-participant-dm", userId),
  operation: "sendDirectMessage" as const,
  target: {
    _tag: "DirectMessage" as const,
    recipient: { client, userId },
    message: makeMessageRef("", `dm-${userId}`),
  },
});

const responseReceipt = {
  deliveryKey: makeCheckinsOpenDeliveryKey(invocationId, "deliver-primary"),
  operation: "respond" as const,
  target: {
    _tag: "Response" as const,
    responseReference,
    message: makeMessageRef("running-1", "summary-1"),
  },
};

// The fixture intentionally exposes the complete principal/input matrix used by the workflow tests.
// fallow-ignore-next-line complexity
const makeExecution = (
  options: {
    readonly principalKind?: "user" | "service";
    readonly initialMessage?: ReadonlyArray<{
      readonly type: "text";
      readonly text: string;
    }> | null;
    readonly fillIds?: ReadonlyArray<string>;
    readonly fillCount?: number;
    readonly monitorConversationId?: string | null;
    readonly monitorCheckinRequired?: boolean;
  } = {},
) => {
  const principalKind = options.principalKind ?? "service";
  const initialMessage =
    options.initialMessage === undefined
      ? [{ type: "text" as const, text: "opening check-in" }]
      : options.initialMessage;
  const generated = Schema.decodeUnknownSync(CheckinGeneration)({
    hour: 3,
    runningConversationId: "running-1",
    checkinConversationId: "checkin-1",
    monitorConversationId: options.monitorConversationId ?? null,
    fillCount: options.fillCount ?? 5,
    roleId: "role-1",
    initialMessage,
    monitorCheckinMessage: [{ type: "text", text: "monitor summary" }],
    monitorUserId: "monitor-1",
    monitorCheckinRequired: options.monitorCheckinRequired ?? true,
    monitorFailureMessage: null,
    fillIds: options.fillIds ?? ["player-1", "player-2"],
  });
  const principal = principalKind === "user" ? userPrincipal : servicePrincipal;
  const input = Schema.decodeUnknownSync(CheckinsOpen.input)(
    principalKind === "user"
      ? { workspaceId, conversationName: "main", responseReference }
      : { workspaceId, conversationName: "main", hour: 3 },
  );
  return Schema.decodeUnknownSync(CheckinsOpenResolvedExecution)({
    invocationId: invocationId,
    input,
    principal,
    context: {
      clientPlatform: client.platform,
      clientId: client.clientId,
      workspaceId,
      principalKind,
      createdByUserId: principalKind === "user" ? "discord-user-1" : null,
      responseReference: principalKind === "user" ? responseReference : null,
      generated,
      initialMessage,
      monitorCheckinMessage: [{ type: "text", text: "monitor summary" }],
      monitorFailureMessage: null,
      primaryConversationId: principalKind === "user" ? "response" : "running-1",
      primaryMessage: message("summary"),
    },
  });
};

const withConfig = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ AUTO_CHECKIN_CONCURRENCY: 2 })),
    ),
  );

describe("CheckinsOpen Workflow Definition slice", () => {
  it("registers the pinned v1 action graph and contract", () => {
    const definition = makeCheckinsOpenDefinition();
    expect(definition.contract).toBe(CheckinsOpen);
    expect(definition.workflow.name).toBe(workflowContractKey(CheckinsOpen));
    expect(definition.actions.map(({ workflow, version }) => [workflow.name, version])).toEqual([
      ["checkins.open.resolve-context", "1"],
      ["checkins.open.deliver-checkin", "1"],
      ["checkins.open.finalize-checkin", "1"],
      ["checkins.open.deliver-primary", "1"],
      ["checkins.open.deliver-participant-dm", "1"],
      ["checkins.open.deliver-monitor-dm", "1"],
      ["checkins.open.deliver-tentative-room-order", "1"],
    ]);
  });

  it("accepts explicit user fields and autonomous derived-input fields", () => {
    const explicit = Schema.decodeUnknownSync(CheckinsOpen.input)({
      workspaceId,
      conversationName: "main",
      hour: 4,
      template: "{{mentionsString}} custom",
      responseReference,
    });
    const autonomous = Schema.decodeUnknownSync(CheckinsOpen.input)({
      workspaceId,
      conversationName: "main",
    });

    expect(explicit).toMatchObject({
      workspaceId,
      conversationName: "main",
      hour: 4,
      template: "{{mentionsString}} custom",
      responseReference,
    });
    expect(autonomous).toMatchObject({ workspaceId, conversationName: "main" });
    expect(autonomous).not.toHaveProperty("responseReference");
  });

  it("keeps invocation, action, delivery, and serialization identities stable", () => {
    const otherInvocationId = Schema.decodeUnknownSync(InvocationId)(
      "123e4567-e89b-42d3-a456-426614174099",
    );
    const actionKey = makeCheckinsOpenActionKey(
      invocationId,
      checkinsOpenActionIdentities.deliverCheckin,
    );
    expect(actionKey).toBe(
      makeCheckinsOpenActionKey(invocationId, checkinsOpenActionIdentities.deliverCheckin),
    );
    expect(actionKey).not.toBe(
      makeCheckinsOpenActionKey(otherInvocationId, checkinsOpenActionIdentities.deliverCheckin),
    );
    expect(
      makeCheckinsOpenDeliveryKey(invocationId, checkinsOpenActionIdentities.deliverCheckin),
    ).not.toBe(
      makeCheckinsOpenDeliveryKey(invocationId, checkinsOpenActionIdentities.deliverPrimary),
    );
    expect(
      Schema.is(DeliveryKey)(
        makeCheckinsOpenDeliveryKey(invocationId, checkinsOpenActionIdentities.deliverCheckin),
      ),
    ).toBe(true);

    expect(makeCheckinsOpenSerializationKey("discord-main", workspaceId, "running-1", 3)).toBe(
      makeCheckinsOpenSerializationKey("discord-main", workspaceId, "running-1", 3),
    );
    expect(makeCheckinsOpenSerializationKey("discord-main", workspaceId, "running-1", 3)).not.toBe(
      makeCheckinsOpenSerializationKey("discord-main", workspaceId, "running-1", 4),
    );
    expect(makeCheckinsOpenUserInvocationId("discord-main", "interaction-1")).toBe(
      makeCheckinsOpenUserInvocationId("discord-main", "interaction-1"),
    );
    expect(makeCheckinsOpenUserInvocationId("discord-main", "interaction-1")).not.toBe(
      makeCheckinsOpenUserInvocationId("discord-main", "interaction-2"),
    );
    expect(
      makeCheckinsOpenAutonomousInvocationId({
        workspaceId,
        eventStartEpochMs: 1_750_000_000_000,
        hour: 3,
        conversationName: "main",
      }),
    ).toBe(
      makeCheckinsOpenAutonomousInvocationId({
        workspaceId,
        eventStartEpochMs: 1_750_000_000_000,
        hour: 3,
        conversationName: "main",
      }),
    );
    expect(
      makeCheckinsOpenAutonomousInvocationId({
        workspaceId,
        eventStartEpochMs: 1_750_000_000_000,
        hour: 3,
        conversationName: "main",
      }),
    ).not.toBe(
      makeCheckinsOpenAutonomousInvocationId({
        workspaceId,
        eventStartEpochMs: 1_750_000_000_000,
        hour: 3,
        conversationName: "other",
      }),
    );
  });

  it.effect("commits before bounded best-effort delivery and preserves receipt order", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const execution = makeExecution();
      const commitReceipt = sendReceipt(invocationId, "deliver-checkin", "checkin-1", "checkin-1");
      const commit = { message: commitReceipt.target.message, receipt: commitReceipt };
      const primary = sendReceipt(invocationId, "deliver-primary", "running-1", "summary-1");
      const roomOrder = sendReceipt(
        invocationId,
        "deliver-tentative-room-order",
        "running-1",
        "room-order-1",
      );
      const failure = {
        _tag: "DeliveryRejected" as const,
        operation: "checkins.open.deliver-participant-dm",
        message: "participant DM failed",
        recoveryRequired: true,
      };
      const result = yield* withConfig(
        makeCheckinsOpenWorkflowBody({
          deliverCheckin: () => Effect.sync(() => (calls.push("commit"), commit)),
          finalizeCheckin: () =>
            Effect.sync(() => (calls.push("finalize"), editReceipt(invocationId, "checkin-1"))),
          deliverPrimary: () =>
            Effect.sync(
              () => (calls.push("primary"), { receipt: primary, additionalReceipts: [] }),
            ),
          deliverParticipantDm: ({ userId }) =>
            userId === "player-2"
              ? Effect.sync(() => calls.push("dm:player-2")).pipe(
                  Effect.andThen(Effect.fail(failure)),
                )
              : Effect.sync(() => (calls.push("dm:player-1"), directReceipt(invocationId, userId))),
          deliverMonitorDm: () =>
            Effect.sync(() => (calls.push("dm:monitor"), directReceipt(invocationId, "monitor-1"))),
          deliverTentativeRoomOrder: () => Effect.sync(() => (calls.push("room-order"), roomOrder)),
        })(execution),
      );

      expect(calls.slice(0, 3)).toEqual(["commit", "finalize", "primary"]);
      expect(calls).toEqual(
        expect.arrayContaining(["dm:player-1", "dm:player-2", "dm:monitor", "room-order"]),
      );
      expect(result).toEqual({
        hour: 3,
        runningConversationId: "running-1",
        checkinConversationId: "checkin-1",
        checkinMessageId: "checkin-1",
        primaryMessageId: "summary-1",
        tentativeRoomOrderMessageId: "room-order-1",
        deliveryReceipts: [
          commitReceipt,
          editReceipt(invocationId, "checkin-1"),
          primary,
          directReceipt(invocationId, "player-1"),
          directReceipt(invocationId, "monitor-1"),
          roomOrder,
        ],
      });
    }),
  );

  it.effect("propagates interruption from best-effort delivery", () =>
    Effect.gen(function* () {
      const execution = makeExecution();
      const commitReceipt = sendReceipt(invocationId, "deliver-checkin", "checkin-1", "checkin-1");
      const primary = sendReceipt(invocationId, "deliver-primary", "running-1", "summary-1");
      const exit = yield* withConfig(
        Effect.exit(
          makeCheckinsOpenWorkflowBody({
            deliverCheckin: () =>
              Effect.succeed({ message: commitReceipt.target.message, receipt: commitReceipt }),
            finalizeCheckin: () => Effect.succeed(editReceipt(invocationId, "checkin-1")),
            deliverPrimary: () => Effect.succeed({ receipt: primary, additionalReceipts: [] }),
            deliverParticipantDm: () => Effect.interrupt,
            deliverMonitorDm: () => Effect.succeed(directReceipt(invocationId, "monitor-1")),
            deliverTentativeRoomOrder: () =>
              Effect.succeed(
                sendReceipt(
                  invocationId,
                  "deliver-tentative-room-order",
                  "running-1",
                  "room-order-1",
                ),
              ),
          })(execution),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      }
    }),
  );

  it.effect("skips the business commit and optional tail when no initial message exists", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const execution = makeExecution({
        principalKind: "user",
        initialMessage: null,
        fillCount: 0,
      });
      const result = yield* withConfig(
        makeCheckinsOpenWorkflowBody({
          deliverCheckin: () => Effect.die("no check-in commit expected"),
          finalizeCheckin: () => Effect.die("no finalization expected"),
          deliverPrimary: () =>
            Effect.sync(
              () => (calls.push("primary"), { receipt: responseReceipt, additionalReceipts: [] }),
            ),
          deliverParticipantDm: () => Effect.die("no participant DM expected"),
          deliverMonitorDm: () => Effect.die("no monitor DM expected"),
          deliverTentativeRoomOrder: () => Effect.die("no room order expected"),
        })(execution),
      );

      expect(calls).toEqual(["primary"]);
      expect(result).toMatchObject({
        checkinMessageId: null,
        primaryMessageId: "summary-1",
        tentativeRoomOrderMessageId: null,
        deliveryReceipts: [responseReceipt],
      });
    }),
  );

  it.effect("returns a recovery barrier when required primary delivery fails after commit", () =>
    Effect.gen(function* () {
      const execution = makeExecution();
      const commitReceipt = sendReceipt(invocationId, "deliver-checkin", "checkin-1", "checkin-1");
      const commit = { message: commitReceipt.target.message, receipt: commitReceipt };
      const failure = {
        _tag: "DeliveryRejected" as const,
        operation: "checkins.open.deliver-primary",
        message: "summary failed",
        committedReference: "checkin-1",
        recoveryRequired: true,
      };
      const exit = yield* withConfig(
        Effect.exit(
          makeCheckinsOpenWorkflowBody({
            deliverCheckin: () => Effect.succeed(commit),
            finalizeCheckin: () => Effect.succeed(editReceipt(invocationId, "checkin-1")),
            deliverPrimary: () => Effect.fail(failure),
            deliverParticipantDm: () => Effect.die("post-commit tail must not start"),
            deliverMonitorDm: () => Effect.die("post-commit tail must not start"),
            deliverTentativeRoomOrder: () => Effect.die("post-commit tail must not start"),
          })(execution),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toEqual(failure);
      }
    }),
  );
});
