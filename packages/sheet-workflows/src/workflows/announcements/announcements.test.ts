import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { InvocationId } from "effect-zero-workflow/contract";
import { conversationRefFrom, messageRefFrom } from "sheet-bot-api";
import { ServicePrincipal } from "sheet-auth/identity";
import { AnnouncementsDeliverUpdate, AutonomousDeclaredFailure } from "sheet-workflow-contracts";
import {
  makeAnnouncementsDeliverUpdateDefinition,
  makeAnnouncementsDeliverUpdateWorkflowBody,
  makeUpdateAnnouncementMessage,
} from "./definition";
import {
  makeUpdateAnnouncementClaimId,
  makeUpdateAnnouncementDeliveryKey,
  makeUpdateAnnouncementInvocationId,
  makeUpdateAnnouncementSerializationKey,
} from "./keys";
import { AnnouncementSheetWorkflowRegistrations } from "./registry";

const invocationId = Schema.decodeUnknownSync(InvocationId)("018f47f5-c16a-7c42-89f3-26a9088f0d31");

const input = Schema.decodeUnknownSync(AnnouncementsDeliverUpdate.input)({
  workspaceId: "workspace-1",
  workspaceName: "Tiara",
  joinedAt: "2026-06-01T00:00:00.000Z",
  systemConversationId: "system",
  announcement: {
    id: "update-announcements-2026-06-05",
    publishedAt: "2026-06-05T00:00:00.000Z",
    title: "Update",
    description: "Details",
    color: 0x5865f2,
  },
});

const principal = Schema.decodeUnknownSync(ServicePrincipal)({
  kind: "service",
  serviceId: "sheet-bot.gateway",
  oauthClientId: "sheet-bot-client",
});

const client = { platform: "discord" as const, clientId: "discord-main" };
const conversation = conversationRefFrom(client, input.workspaceId, "conversation-1");
const claimId = makeUpdateAnnouncementClaimId(invocationId);
const claim = {
  status: "owned" as const,
  workspaceId: input.workspaceId,
  announcementId: input.announcement.id,
  publishedAt: input.announcement.publishedAt.getTime(),
  claimId,
  delivery: null,
};
const receipt = {
  deliveryKey: makeUpdateAnnouncementDeliveryKey(invocationId),
  operation: "sendMessage" as const,
  target: {
    _tag: "Message" as const,
    message: messageRefFrom(client, input.workspaceId, conversation.conversationId, "message-1"),
  },
};

describe("update-announcement delivery Workflow Definition slice", () => {
  it("registers the pinned autonomous v1 five-action graph", () => {
    const definition = makeAnnouncementsDeliverUpdateDefinition();
    expect(definition.contract).toBe(AnnouncementsDeliverUpdate);
    expect(definition.workflow.name).toBe(workflowContractKey(AnnouncementsDeliverUpdate));
    expect(definition.actions.map(({ workflow, version }) => [workflow.name, version])).toEqual([
      ["announcements.deliverUpdate.claim-update-announcement-delivery", "1"],
      ["announcements.deliverUpdate.select-update-announcement-conversation", "1"],
      ["announcements.deliverUpdate.deliver-update-announcement", "1"],
      ["announcements.deliverUpdate.record-update-announcement-delivery", "1"],
      ["announcements.deliverUpdate.release-update-announcement-claim", "1"],
    ]);
    expect(AnnouncementsDeliverUpdate.declaredFailure).toBe(AutonomousDeclaredFailure);
    expect(AnnouncementSheetWorkflowRegistrations).toHaveLength(1);
    expect(AnnouncementSheetWorkflowRegistrations[0]?.definitionVersion).toBe("1");
  });

  it.effect("runs claim, fixed selection, one send, and required tracking in order", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const body = makeAnnouncementsDeliverUpdateWorkflowBody({
        claim: () => Effect.sync(() => (calls.push("claim"), claim)),
        select: () => Effect.sync(() => (calls.push("select"), conversation)),
        deliver: () =>
          Effect.sync(
            () => (
              calls.push("deliver"),
              {
                claim,
                conversation,
                receipt,
                deliveredAt: 1_750_000_000_000,
              }
            ),
          ),
        record: (execution) =>
          Effect.sync(
            () => (calls.push("record"), { commit: execution.commit, status: "tracked" as const }),
          ),
        release: () => Effect.die("committed claim release"),
      });
      expect(yield* body({ invocationId, principal, input })).toEqual({
        workspaceId: input.workspaceId,
        announcementId: input.announcement.id,
        status: "sent",
        announcementConversationId: conversation.conversationId,
        announcementMessageId: receipt.target.message.messageId,
        deliveryReceipts: [receipt],
      });
      expect(calls).toEqual(["claim", "select", "deliver", "record"]);
    }),
  );

  it.effect("returns every durable skip disposition without selecting or delivering", () =>
    Effect.gen(function* () {
      const delivered = messageRefFrom(
        client,
        input.workspaceId,
        "existing-conversation",
        "existing-message",
      );
      const cases = [
        { status: "skipped_not_gated" as const, delivery: null },
        { status: "skipped_already_claimed" as const, delivery: null },
        { status: "skipped_already_delivered" as const, delivery: delivered },
      ];
      for (const current of cases) {
        const body = makeAnnouncementsDeliverUpdateWorkflowBody({
          claim: () => Effect.succeed({ ...claim, ...current }),
          select: () => Effect.die("skip selected a conversation"),
          deliver: () => Effect.die("skip delivered a message"),
          record: () => Effect.die("skip recorded a delivery"),
          release: () => Effect.die("skip released a claim"),
        });
        expect(yield* body({ invocationId, principal, input })).toEqual({
          workspaceId: input.workspaceId,
          announcementId: input.announcement.id,
          status: current.status,
          announcementConversationId:
            current.status === "skipped_already_delivered" ? "existing-conversation" : null,
          announcementMessageId:
            current.status === "skipped_already_delivered" ? "existing-message" : null,
          deliveryReceipts: [],
        });
      }
    }),
  );

  it.effect("compensates an owned claim when no sendable conversation exists", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const body = makeAnnouncementsDeliverUpdateWorkflowBody({
        claim: () => Effect.succeed(claim),
        select: () =>
          Effect.sync(() => calls.push("select")).pipe(
            Effect.andThen(
              Effect.fail({
                _tag: "ResourceNotFound" as const,
                resource: "sendable workspace conversation",
              }),
            ),
          ),
        deliver: () => Effect.die("missing conversation delivered"),
        record: () => Effect.die("missing conversation recorded"),
        release: () => Effect.sync(() => calls.push("release")),
      });
      const exit = yield* Effect.exit(body({ invocationId, principal, input }));
      expect(calls).toEqual(["select", "release"]);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toEqual({
          _tag: "ResourceNotFound",
          resource: "sendable workspace conversation",
        });
      }
    }),
  );

  it.effect("compensates only a definitive pre-commit delivery rejection", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const rejected = {
        _tag: "DeliveryRejected" as const,
        operation: "announcements.deliverUpdate.deliver-update-announcement",
        message: "The update announcement was rejected",
        recoveryRequired: false,
      };
      const body = makeAnnouncementsDeliverUpdateWorkflowBody({
        claim: () => Effect.succeed(claim),
        select: () => Effect.succeed(conversation),
        deliver: () => Effect.fail(rejected),
        record: () => Effect.die("rejected delivery recorded"),
        release: () => Effect.sync(() => calls.push("release")),
      });
      expect(yield* Effect.flip(body({ invocationId, principal, input }))).toEqual(rejected);
      expect(calls).toEqual(["release"]);
    }),
  );

  it.effect("preserves the claim and committed receipt when post-commit tracking fails", () =>
    Effect.gen(function* () {
      let deliveryCount = 0;
      const recovery = {
        _tag: "DeliveryRejected" as const,
        operation: "announcements.deliverUpdate.record-update-announcement-delivery",
        message: "Delivery tracking could not be confirmed",
        recoveryRequired: true,
        committedReference: JSON.stringify([
          "discord",
          client.clientId,
          input.workspaceId,
          input.announcement.id,
        ]),
      };
      const body = makeAnnouncementsDeliverUpdateWorkflowBody({
        claim: () => Effect.succeed(claim),
        select: () => Effect.succeed(conversation),
        deliver: () =>
          Effect.sync(() => {
            deliveryCount += 1;
            return { claim, conversation, receipt, deliveredAt: 1_750_000_000_000 };
          }),
        record: () => Effect.fail(recovery),
        release: () => Effect.die("post-commit claim release"),
      });
      expect(yield* Effect.flip(body({ invocationId, principal, input }))).toEqual(recovery);
      expect(deliveryCount).toBe(1);
    }),
  );

  it("renders the exact legacy announcement with mentions disabled", () => {
    expect(makeUpdateAnnouncementMessage(input)).toEqual({
      embeds: [
        {
          title: [{ type: "text", text: input.announcement.title }],
          description: [{ type: "text", text: input.announcement.description }],
          color: input.announcement.color,
        },
      ],
      allowedMentions: "none",
    });
    expect(
      makeUpdateAnnouncementMessage({
        ...input,
        announcement: { ...input.announcement, color: undefined },
      }),
    ).toEqual({
      embeds: [
        {
          title: [{ type: "text", text: input.announcement.title }],
          description: [{ type: "text", text: input.announcement.description }],
        },
      ],
      allowedMentions: "none",
    });
  });

  it("derives stable resource, claim, and delivery identities", () => {
    expect(
      makeUpdateAnnouncementSerializationKey(
        client.clientId,
        input.workspaceId,
        input.announcement.id,
      ),
    ).toBe(JSON.stringify(["discord", client.clientId, input.workspaceId, input.announcement.id]));
    expect(makeUpdateAnnouncementClaimId(invocationId)).toContain(
      `announcements.deliverUpdate:1:${invocationId}:claim-update-announcement-delivery`,
    );
    expect(makeUpdateAnnouncementDeliveryKey(invocationId)).toContain(
      `announcements.deliverUpdate:1:${invocationId}:deliver-update-announcement`,
    );
    expect(
      makeUpdateAnnouncementInvocationId(client.clientId, input.workspaceId, input.announcement.id),
    ).toBe(
      makeUpdateAnnouncementInvocationId(client.clientId, input.workspaceId, input.announcement.id),
    );
    expect(
      makeUpdateAnnouncementInvocationId(
        client.clientId,
        input.workspaceId,
        `${input.announcement.id}-different`,
      ),
    ).not.toBe(
      makeUpdateAnnouncementInvocationId(client.clientId, input.workspaceId, input.announcement.id),
    );
  });
});
