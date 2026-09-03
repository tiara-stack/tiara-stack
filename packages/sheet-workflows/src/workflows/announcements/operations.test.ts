import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import {
  WorkflowInvocationUnauthorized,
  WorkflowTransportUnavailable,
} from "effect-zero-workflow/contract/transport";
import {
  BotDependencyUnavailable,
  BotRequestRejected,
  type SendMessageReceipt,
  type SheetBotHttpClient,
  conversationRefFrom,
  messageRefFrom,
} from "sheet-bot-api";
import { EffectivePrincipal, ServicePrincipal } from "sheet-auth/identity";
import { AnnouncementsDeliverUpdate } from "sheet-workflow-contracts";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import {
  ReadOnlyWorkflowAuthorization,
  readOnlyWorkflowAuthorizationLayer,
} from "../readOnly/authorization";
import { makeUpdateAnnouncementMessage } from "./definition";
import { makeUpdateAnnouncementClaimId, makeUpdateAnnouncementDeliveryKey } from "./keys";
import { updateAnnouncementWorkflowOperationsLayer } from "./operations";
import { AnnouncementSheetWorkflowRegistrations } from "./registry";
import { UpdateAnnouncementWorkflowOperations } from "./service";

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
const execution = { invocationId, principal, input };
const client = { platform: "discord" as const, clientId: "discord-main" };
const conversation = conversationRefFrom(client, input.workspaceId, "system");
const claimId = makeUpdateAnnouncementClaimId(invocationId);
const deliveryKey = makeUpdateAnnouncementDeliveryKey(invocationId);
const policy = AnnouncementsDeliverUpdate.authorizationPolicy.policy;
const pendingConversationId = "__pending_update_announcement_delivery__";
const registration = AnnouncementSheetWorkflowRegistrations[0]!;
const actorProvenance = {
  actorServiceId: principal.serviceId,
  jobKind: "update-announcement",
};
const registrationAuthorization: ReadOnlyWorkflowAuthorization["Service"] = {
  authorize: (_contract, effectivePrincipal) =>
    effectivePrincipal === principal
      ? Effect.void
      : Effect.fail(new WorkflowInvocationUnauthorized({ message: "denied" })),
  authorizeSlotOpen: () => Effect.die("unused"),
  authorizeCheckinRespond: () => Effect.die("unused"),
  authorizeRoomOrdersNavigate: () => Effect.die("unused"),
  authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
  authorizeRoomOrdersSend: () => Effect.die("unused"),
  workspaceCapabilities: () => Effect.die("unused"),
};
const gatewayContext = {
  ownerKey: "service:sheet-bot.gateway",
  principal,
  actorProvenance,
};

type DeliveryRow = Option.Option.Value<
  Effect.Success<
    ReturnType<TrustedSheetPersistenceShape["workspaces"]["getWorkspaceUpdateAnnouncementDelivery"]>
  >
>;

type HarnessOptions = {
  readonly gated?: boolean;
  readonly initialRow?: DeliveryRow;
  readonly ambiguousClaim?: boolean;
  readonly ambiguousRecord?: boolean;
  readonly send?: (
    request: Parameters<SheetBotHttpClient["delivery"]["sendMessage"]>[0],
  ) => Effect.Effect<SendMessageReceipt, unknown>;
  readonly authorize?: ReadOnlyWorkflowAuthorization["Service"]["authorize"];
};

const makeHarness = (options: HarnessOptions = {}) => {
  let row = options.initialRow;
  const effects: Array<string> = [];
  const requests: Array<unknown> = [];
  const authorizationCalls: Array<unknown> = [];
  const authorize =
    options.authorize ??
    ((contract, effectivePrincipal, authorizedInput) =>
      Effect.sync(() => {
        authorizationCalls.push({
          contract,
          principal: effectivePrincipal,
          input: authorizedInput,
        });
      }));
  const authorization: ReadOnlyWorkflowAuthorization["Service"] = {
    authorize,
    authorizeSlotOpen: () => Effect.die("unused"),
    authorizeCheckinRespond: () => Effect.die("unused"),
    authorizeRoomOrdersNavigate: () => Effect.die("unused"),
    authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
    authorizeRoomOrdersSend: () => Effect.die("unused"),
    workspaceCapabilities: () => Effect.die("unused"),
  };
  const basePersistence = makeTrustedSheetPersistenceMock();
  const persistence: TrustedSheetPersistenceShape = {
    ...basePersistence,
    workspaces: {
      ...basePersistence.workspaces,
      getWorkspaceFeatureFlag: () =>
        Effect.sync(() => {
          effects.push("read-gate");
          return options.gated === false
            ? Option.none()
            : Option.some({
                workspaceId: input.workspaceId,
                flagName: "update-announcements",
                createdAt: 1,
                updatedAt: 1,
                deletedAt: null,
              });
        }),
      getWorkspaceUpdateAnnouncementDelivery: () =>
        Effect.sync(() => {
          effects.push("read-delivery");
          return Option.fromNullishOr(row);
        }),
      claimWorkspaceUpdateAnnouncementDelivery: ({ claimToken, publishedAt }) =>
        Effect.sync(() => {
          effects.push("claim");
          if (row !== undefined) return;
          row = {
            workspaceId: input.workspaceId,
            announcementId: input.announcement.id,
            publishedAt,
            deliveredAt: 1,
            conversationId: pendingConversationId,
            messageId: claimToken,
            createdAt: 1,
            updatedAt: 1,
            deletedAt: null,
          };
        }).pipe(
          options.ambiguousClaim === true
            ? Effect.andThen(Effect.die("ambiguous claim"))
            : Effect.asVoid,
        ),
      recordWorkspaceUpdateAnnouncementDelivery: (args) =>
        Effect.sync(() => {
          effects.push("record");
          row = {
            workspaceId: args.workspaceId,
            announcementId: args.announcementId,
            publishedAt: args.publishedAt,
            deliveredAt: args.deliveredAt,
            conversationId: args.conversationId,
            messageId: args.messageId,
            createdAt: 1,
            updatedAt: 2,
            deletedAt: null,
          };
        }).pipe(
          options.ambiguousRecord === true
            ? Effect.andThen(Effect.die("ambiguous record"))
            : Effect.asVoid,
        ),
      releaseWorkspaceUpdateAnnouncementDeliveryClaim: () =>
        Effect.sync(() => {
          effects.push("release");
          row = undefined;
        }),
    },
  };
  const bot = {
    cache: {
      listConversations: (request: unknown) =>
        Effect.sync(() => {
          effects.push("read-conversations");
          requests.push(request);
          return {
            items: [{ id: "system", type: 0, name: "welcome", position: 2, canSendMessages: true }],
          };
        }),
    },
    delivery: {
      sendMessage:
        options.send ??
        ((request: Parameters<SheetBotHttpClient["delivery"]["sendMessage"]>[0]) =>
          Effect.sync(() => {
            effects.push("send");
            requests.push(request);
            return {
              deliveryKey,
              operation: "sendMessage" as const,
              target: {
                _tag: "Message" as const,
                message: messageRefFrom(
                  client,
                  input.workspaceId,
                  conversation.conversationId,
                  "message-1",
                ),
              },
            };
          })),
    },
  } as unknown as SheetBotHttpClient;
  const operations = UpdateAnnouncementWorkflowOperations.pipe(
    Effect.provide(updateAnnouncementWorkflowOperationsLayer),
    Effect.provideService(TrustedSheetPersistence, persistence),
    Effect.provideService(SheetBotCacheClient, { get: () => bot }),
    Effect.provideService(SheetBotDeliveryClient, { get: () => bot }),
    Effect.provideService(ReadOnlyWorkflowAuthorization, authorization),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: client.clientId })),
    ),
  );
  return {
    operations,
    effects,
    requests,
    authorizationCalls,
    row: () => row,
    setRow: (value: DeliveryRow | undefined) => {
      row = value;
    },
  };
};

const gatewayEnvironment = {
  SHEET_BOT_GATEWAY_SERVICE_ID: principal.serviceId,
  SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: principal.oauthClientId,
  SHEET_AUTH_OAUTH_CLIENT_ID: "sheet-auto-role-cleanup",
};

const authorizeWithPolicy = (
  candidate: typeof EffectivePrincipal.Type,
  candidateInput: unknown,
) => {
  const bot = {} as SheetBotHttpClient;
  const persistence = makeTrustedSheetPersistenceMock();
  return ReadOnlyWorkflowAuthorization.pipe(
    Effect.flatMap((authorization) =>
      authorization.authorize(AnnouncementsDeliverUpdate, candidate, candidateInput),
    ),
    Effect.provide(readOnlyWorkflowAuthorizationLayer),
    Effect.provide(Layer.succeed(SheetBotCacheClient, { get: () => bot })),
    Effect.provide(Layer.succeed(TrustedSheetPersistence, persistence)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(gatewayEnvironment))),
  );
};

describe("update-announcement workflow operations", () => {
  it.effect("admits only the configured gateway principal and workspace-shaped input", () =>
    Effect.gen(function* () {
      yield* authorizeWithPolicy(principal, input);
      const rejected = [
        Schema.decodeUnknownSync(EffectivePrincipal)({ kind: "user", userId: "user-1" }),
        Schema.decodeUnknownSync(EffectivePrincipal)({
          kind: "service",
          serviceId: "other-service",
          oauthClientId: principal.oauthClientId,
        }),
        Schema.decodeUnknownSync(EffectivePrincipal)({
          kind: "service",
          serviceId: principal.serviceId,
          oauthClientId: "other-client",
        }),
      ];
      for (const candidate of rejected) {
        expect(yield* Effect.flip(authorizeWithPolicy(candidate, input))).toMatchObject({
          _tag: "WorkflowInvocationUnauthorized",
        });
      }
      expect(
        yield* Effect.flip(authorizeWithPolicy(principal, { ...input, workspaceId: undefined })),
      ).toMatchObject({ _tag: "WorkflowInvocationUnauthorized" });
    }),
  );

  it.effect("applies policy v1 at enqueue and owner isolation at replay", () =>
    Effect.gen(function* () {
      yield* registration.authorize(gatewayContext, input);

      const user = Schema.decodeUnknownSync(EffectivePrincipal)({
        kind: "user",
        userId: "user-1",
      });
      expect(
        yield* Effect.flip(
          registration.authorize(
            { ownerKey: "user:user-1", principal: user, actorProvenance },
            input,
          ),
        ),
      ).toMatchObject({ _tag: "WorkflowInvocationUnauthorized" });

      expect(
        yield* Effect.flip(
          registration.authorize(gatewayContext, input).pipe(
            Effect.provideService(ReadOnlyWorkflowAuthorization, {
              ...registrationAuthorization,
              authorize: () =>
                Effect.fail(new BotDependencyUnavailable({ message: "authorization unavailable" })),
            }),
          ),
        ),
      ).toEqual(
        new WorkflowTransportUnavailable({
          operation: "Enqueue",
          retryable: true,
          message: "Workflow enqueue transport is unavailable",
        }),
      );

      expect(
        yield* Effect.flip(
          registration.authorizeObservation({
            ...gatewayContext,
            ownerKey: "service:forged",
          }),
        ),
      ).toMatchObject({ _tag: "WorkflowInvocationUnauthorized" });
    }).pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, registrationAuthorization)),
  );

  it.effect("reauthorizes at every successful persistence, cache, and delivery boundary", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ ambiguousClaim: true, ambiguousRecord: true });
      const operations = yield* harness.operations;
      const owned = yield* operations.claim(execution, claimId, policy);
      const selected = yield* operations.select(execution, owned, policy);
      const commit = yield* operations.deliver(
        execution,
        owned,
        selected,
        makeUpdateAnnouncementMessage(input),
        deliveryKey,
        policy,
      );
      expect((yield* operations.record(execution, commit, policy)).status).toBe("tracked");
      expect(harness.effects).toEqual([
        "read-gate",
        "claim",
        "read-delivery",
        "read-delivery",
        "read-delivery",
        "read-conversations",
        "read-delivery",
        "send",
        "read-delivery",
        "record",
        "read-delivery",
        "read-delivery",
      ]);
      expect(harness.authorizationCalls).toHaveLength(harness.effects.length);
      expect(harness.authorizationCalls).toEqual(
        harness.effects.map(() => ({
          contract: AnnouncementsDeliverUpdate,
          principal,
          input,
        })),
      );
      expect(harness.requests[0]).toMatchObject({
        params: { platform: "discord", clientId: client.clientId, workspaceId: input.workspaceId },
        query: { limit: 100 },
      });
      expect(harness.requests[1]).toEqual({
        payload: {
          conversation,
          deliveryKey,
          message: makeUpdateAnnouncementMessage(input),
        },
      });
      expect(harness.row()).toMatchObject({
        workspaceId: input.workspaceId,
        announcementId: input.announcement.id,
        conversationId: conversation.conversationId,
        messageId: "message-1",
      });
    }),
  );

  it.effect("honors the exact gate, timestamp invariant, and durable claim dispositions", () =>
    Effect.gen(function* () {
      const ungated = makeHarness({ gated: false });
      expect((yield* (yield* ungated.operations).claim(execution, claimId, policy)).status).toBe(
        "skipped_not_gated",
      );
      expect(ungated.effects).toEqual(["read-gate"]);

      const invalid = makeHarness();
      expect(
        yield* Effect.flip(
          (yield* invalid.operations).claim(
            {
              ...execution,
              input: {
                ...input,
                announcement: { ...input.announcement, publishedAt: input.joinedAt },
              },
            },
            claimId,
            policy,
          ),
        ),
      ).toMatchObject({ _tag: "InvalidRequest", code: "InvalidUpdateAnnouncement" });
      expect(invalid.effects).toEqual([]);

      const competing = makeHarness({
        initialRow: {
          workspaceId: input.workspaceId,
          announcementId: input.announcement.id,
          publishedAt: input.announcement.publishedAt.getTime(),
          deliveredAt: 1,
          conversationId: pendingConversationId,
          messageId: "other-claim",
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      });
      const competingOperations = yield* competing.operations;
      const competingClaim = yield* competingOperations.claim(execution, claimId, policy);
      expect(competingClaim.status).toBe("skipped_already_claimed");

      const delivered = makeHarness({
        initialRow: {
          workspaceId: input.workspaceId,
          announcementId: input.announcement.id,
          publishedAt: input.announcement.publishedAt.getTime(),
          deliveredAt: 2,
          conversationId: "existing-conversation",
          messageId: "existing-message",
          createdAt: 1,
          updatedAt: 2,
          deletedAt: null,
        },
      });
      const deliveredOperations = yield* delivered.operations;
      const existing = yield* deliveredOperations.claim(execution, claimId, policy);
      expect(existing.status).toBe("skipped_already_delivered");
      expect(existing.delivery).toEqual(
        messageRefFrom(client, input.workspaceId, "existing-conversation", "existing-message"),
      );
    }),
  );

  it.effect(
    "fails closed on revocation and classifies definitive delivery rejection pre-commit",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const revoked = makeHarness({
          authorize: () =>
            ++calls === 2
              ? Effect.fail(new WorkflowInvocationUnauthorized({ message: "revoked" }))
              : Effect.void,
        });
        expect(
          yield* Effect.flip((yield* revoked.operations).claim(execution, claimId, policy)),
        ).toEqual({ _tag: "AuthorizationRevoked", policy });
        expect(revoked.effects).toEqual(["read-gate"]);

        const rejected = makeHarness({
          send: () => Effect.fail(new BotRequestRejected({ message: "definitive" })),
        });
        const operations = yield* rejected.operations;
        const owned = yield* operations.claim(execution, claimId, policy);
        expect(
          yield* Effect.flip(
            operations.deliver(
              execution,
              owned,
              conversation,
              makeUpdateAnnouncementMessage(input),
              deliveryKey,
              policy,
            ),
          ),
        ).toMatchObject({ _tag: "DeliveryRejected", recoveryRequired: false });
      }),
  );

  it.effect("rejects non-canonical owned-looking rows at every post-claim boundary", () =>
    Effect.gen(function* () {
      const beforeDelivery = makeHarness();
      const deliveryOperations = yield* beforeDelivery.operations;
      const deliveryClaim = yield* deliveryOperations.claim(execution, claimId, policy);
      beforeDelivery.setRow({ ...beforeDelivery.row()!, workspaceId: "other-workspace" });
      expect(
        yield* Effect.flip(
          deliveryOperations.deliver(
            execution,
            deliveryClaim,
            conversation,
            makeUpdateAnnouncementMessage(input),
            deliveryKey,
            policy,
          ),
        ),
      ).toEqual({ _tag: "AuthorizationRevoked", policy });
      expect(beforeDelivery.effects).not.toContain("send");

      const beforeRecord = makeHarness();
      const recordOperations = yield* beforeRecord.operations;
      const recordClaim = yield* recordOperations.claim(execution, claimId, policy);
      const commit = yield* recordOperations.deliver(
        execution,
        recordClaim,
        conversation,
        makeUpdateAnnouncementMessage(input),
        deliveryKey,
        policy,
      );
      beforeRecord.setRow({ ...beforeRecord.row()!, announcementId: "other-announcement" });
      expect(yield* Effect.flip(recordOperations.record(execution, commit, policy))).toMatchObject({
        _tag: "DeliveryRejected",
        recoveryRequired: true,
      });
      expect(beforeRecord.effects).not.toContain("record");

      const beforeRelease = makeHarness();
      const releaseOperations = yield* beforeRelease.operations;
      const releaseClaim = yield* releaseOperations.claim(execution, claimId, policy);
      beforeRelease.setRow({ ...beforeRelease.row()!, publishedAt: 1 });
      expect(
        yield* Effect.flip(releaseOperations.release(execution, releaseClaim, policy)),
      ).toEqual({ _tag: "AuthorizationRevoked", policy });
      expect(beforeRelease.effects).not.toContain("release");
    }),
  );

  it.effect("releases only an owned pre-commit claim and rejects release after commit", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const operations = yield* harness.operations;
      const owned = yield* operations.claim(execution, claimId, policy);
      yield* operations.release(execution, owned, policy);
      expect(harness.effects.slice(-3)).toEqual(["read-delivery", "release", "read-delivery"]);
      expect(harness.row()).toBeUndefined();

      const committed = makeHarness({
        initialRow: {
          workspaceId: input.workspaceId,
          announcementId: input.announcement.id,
          publishedAt: input.announcement.publishedAt.getTime(),
          deliveredAt: 2,
          conversationId: conversation.conversationId,
          messageId: "message-1",
          createdAt: 1,
          updatedAt: 2,
          deletedAt: null,
        },
      });
      expect(
        yield* Effect.flip((yield* committed.operations).release(execution, owned, policy)),
      ).toMatchObject({ _tag: "DeliveryRejected", recoveryRequired: true });
      expect(committed.effects).not.toContain("release");
    }),
  );

  it.effect("rejects a receipt for any other configured-client target", () =>
    Effect.gen(function* () {
      const forgedConversation = conversationRefFrom(
        { platform: "discord", clientId: "other-client" },
        input.workspaceId,
        conversation.conversationId,
      );
      const harness = makeHarness({
        send: () =>
          Effect.succeed({
            deliveryKey,
            operation: "sendMessage",
            target: {
              _tag: "Message",
              message: messageRefFrom(
                forgedConversation.workspace.client,
                input.workspaceId,
                forgedConversation.conversationId,
                "message-1",
              ),
            },
          }),
      });
      const operations = yield* harness.operations;
      const owned = yield* operations.claim(execution, claimId, policy);
      const exit = yield* Effect.exit(
        operations.deliver(
          execution,
          owned,
          conversation,
          makeUpdateAnnouncementMessage(input),
          deliveryKey,
          policy,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "UpdateAnnouncementWorkflowOperationsError",
          operation: "announcements.deliverUpdate.deliver-update-announcement",
        });
      }
    }),
  );
});
