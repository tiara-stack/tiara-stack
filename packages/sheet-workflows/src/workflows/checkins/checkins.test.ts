import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect";
import { Entity, ShardingConfig } from "effect/unstable/cluster";
import { InvocationId, workflowContractKey } from "effect-zero-workflow/contract";
import { EffectivePrincipal } from "sheet-auth/identity";
import {
  BotResourceNotFound,
  DeliveryKey,
  ResponseReference,
  type SheetBotHttpClient,
} from "sheet-bot-api";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { CheckinsRespond, WorkspaceId } from "sheet-workflow-contracts";
import {
  CheckinProjectionEntity,
  makeCheckinProjectionEntityLayer,
} from "@/entities/checkinProjection";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { makeSheetApisClient, makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import {
  ReadOnlyWorkflowAuthorization,
  readOnlyWorkflowAuthorizationLayer,
} from "../readOnly/authorization";
import {
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import { checkinProjectionKey, makeCheckinClaimId, makeCheckinDeliveryKey } from "./keys";
import { CheckinSheetWorkflowDefinitions, isCheckinSheetWorkflowName } from "./definitions";
import { makeCheckinsRespondWorkflowBody, makeCurrentCheckinMessage } from "./definition";
import { checkinWorkflowOperationsLayer } from "./operations";
import { CheckinRespondExecution, type CheckinCommit } from "./schema";
import { CheckinWorkflowOperations } from "./service";
import { CheckinSheetWorkflowContracts } from "./catalog";
import { CheckinSheetWorkflowRegistrations } from "./registry";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
const input = Schema.decodeUnknownSync(CheckinsRespond.input)({
  messageId: "message-1",
  responseReference,
});
const execution = Schema.decodeUnknownSync(CheckinRespondExecution)({
  invocationId,
  principal,
  input,
});
const context = {
  clientPlatform: "discord" as const,
  clientId: "discord-main",
  messageId: "message-1",
  workspaceId,
  conversationId: "checkin-1",
  memberId: principal.discordAccount.accountId,
  runningConversationId: "running-1",
  roleId: "role-1",
  initialMessage: [{ type: "text" as const, text: "Check in" }],
};
const committed: CheckinCommit = {
  context,
  checkinAt: 100,
  checkinClaimId: makeCheckinClaimId(invocationId),
  isFirst: true,
};

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
  entityMessagePollInterval: 5000,
  sendRetryInterval: 100,
});

type CheckinRow = Option.Option.Value<
  Effect.Success<ReturnType<TrustedSheetPersistenceShape["checkinState"]["getMessageCheckinData"]>>
>;
type CheckinMemberRow = Effect.Success<
  ReturnType<TrustedSheetPersistenceShape["checkinState"]["getMessageCheckinMembers"]>
>[number];

const checkinRow: CheckinRow = {
  clientPlatform: context.clientPlatform,
  clientId: context.clientId,
  messageId: context.messageId,
  hour: 1,
  roleId: context.roleId,
  initialMessage: context.initialMessage,
  runningConversationId: context.runningConversationId,
  workspaceId: context.workspaceId,
  conversationId: context.conversationId,
  createdByUserId: "creator-1",
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

const memberRow = (overrides: Partial<CheckinMemberRow> = {}): CheckinMemberRow => ({
  clientPlatform: context.clientPlatform,
  clientId: context.clientId,
  messageId: context.messageId,
  memberId: context.memberId,
  checkinAt: null,
  checkinClaimId: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  ...overrides,
});

const makeAuthorizationBot = (
  getMember: (request: unknown) => Effect.Effect<unknown, unknown> = () =>
    Effect.succeed({ userId: context.memberId, roleIds: [] }),
): SheetBotHttpClient =>
  ({
    cache: {
      getApplication: () => Effect.succeed({ ownerId: "application-owner" }),
      getMember,
      getWorkspace: () =>
        Effect.succeed({
          id: context.workspaceId,
          name: "Workspace One",
          icon: null,
          ownerId: "workspace-owner",
        }),
      listRoles: () => Effect.succeed([]),
    },
  }) as unknown as SheetBotHttpClient;

const makeAuthorization = (options: {
  readonly row?: Option.Option<CheckinRow>;
  readonly members?: ReadonlyArray<CheckinMemberRow>;
  readonly getMember?: (request: unknown) => Effect.Effect<unknown, unknown>;
}) => {
  const persistence = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
  return Effect.gen(function* () {
    return yield* ReadOnlyWorkflowAuthorization;
  }).pipe(
    Effect.provide(readOnlyWorkflowAuthorizationLayer),
    Effect.provide(
      Layer.succeed(SheetBotCacheClient, {
        get: () => makeAuthorizationBot(options.getMember),
      }),
    ),
    Effect.provide(
      Layer.succeed(TrustedSheetPersistence, {
        ...persistence,
        workspaces: {
          ...persistence.workspaces,
          getWorkspaceMonitorRoles: () => Effect.succeed([]),
        },
        checkinState: {
          ...persistence.checkinState,
          getMessageCheckinData: () => Effect.succeed(options.row ?? Option.some(checkinRow)),
          getMessageCheckinMembers: () => Effect.succeed(options.members ?? [memberRow()]),
        },
      }),
    ),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          sheetBotClientId: context.clientId,
          SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "sheet-bot-client",
        }),
      ),
    ),
  );
};

const makeDeliveryBot = (delivery: Record<string, unknown> = {}): SheetBotHttpClient =>
  ({
    delivery: new Proxy(delivery, {
      get: (target, method: string) =>
        method in target ? target[method] : () => Effect.die(`Unexpected delivery call: ${method}`),
    }),
  }) as unknown as SheetBotHttpClient;

const makeOperations = (
  persistence: TrustedSheetPersistenceShape,
  delivery: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    return yield* CheckinWorkflowOperations;
  }).pipe(
    Effect.provide(checkinWorkflowOperationsLayer),
    Effect.provide(Layer.succeed(TrustedSheetPersistence, persistence)),
    Effect.provide(
      Layer.succeed(SheetBotDeliveryClient, {
        get: () => makeDeliveryBot(delivery),
      }),
    ),
  );

const responseReceipt = {
  deliveryKey: makeCheckinDeliveryKey(invocationId, "respond"),
  operation: "respond" as const,
  target: { _tag: "Response" as const, responseReference },
};
const roleReceipt = {
  deliveryKey: makeCheckinDeliveryKey(invocationId, "set-member-role"),
  operation: "setMemberRole" as const,
  target: {
    _tag: "MemberRole" as const,
    workspace: {
      client: { platform: "discord", clientId: "discord-main" },
      workspaceId,
    },
    userId: context.memberId,
    roleId: "role-1",
  },
};
const editReceipt = {
  deliveryKey: makeCheckinDeliveryKey(invocationId, "edit-check-in-message"),
  operation: "editMessage" as const,
  target: {
    _tag: "Message" as const,
    message: {
      conversation: {
        workspace: {
          client: { platform: "discord", clientId: "discord-main" },
          workspaceId,
        },
        conversationId: "checkin-1",
      },
      messageId: "message-1",
    },
  },
};
const announcementReceipt = {
  deliveryKey: makeCheckinDeliveryKey(invocationId, "announce-first-check-in"),
  operation: "sendMessage" as const,
  target: {
    _tag: "Message" as const,
    message: {
      conversation: {
        workspace: {
          client: { platform: "discord", clientId: "discord-main" },
          workspaceId,
        },
        conversationId: "running-1",
      },
      messageId: "announcement-1",
    },
  },
};

describe("check-in response Workflow Definition slice", () => {
  it("registers only CheckinsRespond with the six pinned version-1 Durable Actions", () => {
    expect(CheckinSheetWorkflowContracts).toEqual([CheckinsRespond]);
    expect(CheckinSheetWorkflowDefinitions).toHaveLength(1);
    const [definition] = CheckinSheetWorkflowDefinitions;
    expect(definition?.workflow.name).toBe(workflowContractKey(CheckinsRespond));
    expect(definition?.actions.map(({ workflow }) => workflow.name)).toEqual([
      "checkins.respond.commit-check-in",
      "checkins.respond.respond",
      "checkins.respond.set-member-role",
      "checkins.respond.load-current-check-in-view",
      "checkins.respond.edit-check-in-message",
      "checkins.respond.announce-first-check-in",
    ]);
    expect(definition?.actions.every(({ version }) => version === "1")).toBe(true);
    expect(CheckinSheetWorkflowRegistrations).toEqual([
      expect.objectContaining({ contract: CheckinsRespond, definitionVersion: "1" }),
    ]);
    expect(isCheckinSheetWorkflowName(workflowContractKey(CheckinsRespond))).toBe(true);
    expect(isCheckinSheetWorkflowName(CheckinsRespond.identity)).toBe(false);
  });

  it.effect(
    "uses stable invocation-derived Action, claim, and operation-specific Delivery Keys",
    () =>
      Effect.gen(function* () {
        const definition = CheckinSheetWorkflowDefinitions[0]!;
        const actionInput = { ...execution, committed, view: { context, members: [] } };
        const first = yield* Effect.forEach(definition.actions, ({ workflow }) =>
          workflow.executionId(actionInput),
        );
        const replay = yield* Effect.forEach(definition.actions, ({ workflow }) =>
          workflow.executionId(actionInput),
        );
        expect(replay).toEqual(first);
        expect(new Set(first).size).toBe(6);
        expect(makeCheckinClaimId(invocationId)).toBe(
          `checkins.respond:1:${invocationId}:commit-check-in`,
        );
        expect(
          new Set([
            makeCheckinDeliveryKey(invocationId, "respond"),
            makeCheckinDeliveryKey(invocationId, "set-member-role"),
            makeCheckinDeliveryKey(invocationId, "edit-check-in-message"),
            makeCheckinDeliveryKey(invocationId, "announce-first-check-in"),
          ]).size,
        ).toBe(4);
        const otherInvocationId = Schema.decodeUnknownSync(InvocationId)(
          "123e4567-e89b-42d3-a456-426614174099",
        );
        expect(makeCheckinClaimId(otherInvocationId)).not.toBe(makeCheckinClaimId(invocationId));
      }),
  );

  it.effect("authorizes only the canonical participant with current workspace membership", () =>
    Effect.gen(function* () {
      const authorization = yield* makeAuthorization({});
      const authorizeCheckinRespond = Option.getOrThrow(
        Option.fromNullishOr(authorization.authorizeCheckinRespond),
      );
      expect(yield* authorizeCheckinRespond(principal, input)).toEqual(context);
      yield* authorization.authorize(CheckinsRespond, principal, input);
    }),
  );

  it.effect(
    "fails closed for service, unlinked, non-member, missing, deleted, incomplete, and cross-client state",
    () =>
      Effect.gen(function* () {
        const servicePrincipal = Schema.decodeUnknownSync(EffectivePrincipal)({
          kind: "service",
          serviceId: "sheet-bot.gateway",
          oauthClientId: "sheet-bot-client",
        });
        const cases = [
          {
            principal: servicePrincipal,
            authorization: yield* makeAuthorization({}),
          },
          {
            principal: { ...principal, discordAccount: undefined },
            authorization: yield* makeAuthorization({}),
          },
          {
            principal,
            authorization: yield* makeAuthorization({
              getMember: () =>
                Effect.fail(
                  new BotResourceNotFound({ resource: "member", message: "not a member" }),
                ),
            }),
          },
          {
            principal,
            authorization: yield* makeAuthorization({ row: Option.none() }),
          },
          {
            principal,
            authorization: yield* makeAuthorization({ members: [] }),
          },
          {
            principal,
            authorization: yield* makeAuthorization({
              members: [memberRow({ deletedAt: 2 })],
            }),
          },
          {
            principal,
            authorization: yield* makeAuthorization({
              row: Option.some({ ...checkinRow, conversationId: null }),
            }),
          },
          {
            principal,
            authorization: yield* makeAuthorization({
              row: Option.some({ ...checkinRow, clientId: "discord-other" }),
            }),
          },
        ] as const;

        for (const candidate of cases) {
          const exit = yield* Effect.exit(
            candidate.authorization.authorize(CheckinsRespond, candidate.principal, input),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
              _tag: "WorkflowInvocationUnauthorized",
            });
          }
        }
      }),
  );

  it.effect("commits with CAS and distinguishes first execution from repeat invocations", () =>
    Effect.gen(function* () {
      let current = memberRow();
      let mutations = 0;
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        checkinState: {
          ...base.checkinState,
          setMessageCheckinMemberCheckinAtIfUnset: (request) =>
            Effect.sync(() => {
              mutations += 1;
              if (Predicate.isNull(current.checkinAt)) {
                current = {
                  ...current,
                  checkinAt: request.checkinAt,
                  checkinClaimId: request.checkinClaimId,
                };
              }
            }),
          getMessageCheckinMembers: () => Effect.succeed([current]),
        },
      };
      const operations = yield* makeOperations(persistence);
      const firstClaim = makeCheckinClaimId(invocationId);
      const secondClaim = `${firstClaim}:repeat`;
      const first = yield* operations.commitCheckin(
        context,
        firstClaim,
        CheckinsRespond.authorizationPolicy.policy,
      );
      const repeat = yield* operations.commitCheckin(
        context,
        secondClaim,
        CheckinsRespond.authorizationPolicy.policy,
      );

      expect(mutations).toBe(2);
      expect(first).toMatchObject({ checkinClaimId: firstClaim, isFirst: true });
      expect(repeat).toMatchObject({ checkinClaimId: firstClaim, isFirst: false });
      expect(repeat.checkinAt).toBe(first.checkinAt);
    }),
  );

  it.effect("reconciles an ambiguous CAS failure from canonical persisted state", () =>
    Effect.gen(function* () {
      let current = memberRow();
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        checkinState: {
          ...base.checkinState,
          setMessageCheckinMemberCheckinAtIfUnset: (request) =>
            Effect.sync(() => {
              current = {
                ...current,
                checkinAt: request.checkinAt,
                checkinClaimId: request.checkinClaimId,
              };
            }).pipe(Effect.andThen(Effect.die("connection lost after commit"))),
          getMessageCheckinMembers: () => Effect.succeed([current]),
        },
      };
      const operations = yield* makeOperations(persistence);
      const result = yield* operations.commitCheckin(
        context,
        makeCheckinClaimId(invocationId),
        CheckinsRespond.authorizationPolicy.policy,
      );
      expect(result).toMatchObject({
        checkinClaimId: makeCheckinClaimId(invocationId),
        isFirst: true,
      });
    }),
  );

  it.effect("delivers every bot effect and maps missing post-commit resources to recovery", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const operations = yield* makeOperations(base, {
        respond: () => Effect.sync(() => (calls.push("respond"), responseReceipt)),
        setMemberRole: () => Effect.sync(() => (calls.push("setMemberRole"), roleReceipt)),
        editMessage: () => Effect.sync(() => (calls.push("editMessage"), editReceipt)),
        sendMessage: () => Effect.sync(() => (calls.push("sendMessage"), announcementReceipt)),
      });
      const policy = CheckinsRespond.authorizationPolicy.policy;
      const view = { context, members: [] };

      expect(
        yield* operations.respond(
          context,
          responseReference,
          true,
          responseReceipt.deliveryKey,
          policy,
        ),
      ).toEqual(responseReceipt);
      expect(
        yield* operations.setMemberRole(context, "role-1", roleReceipt.deliveryKey, policy),
      ).toEqual(roleReceipt);
      expect(
        yield* operations.editCheckinMessage(
          view,
          makeCurrentCheckinMessage(view),
          editReceipt.deliveryKey,
          policy,
        ),
      ).toEqual(editReceipt);
      expect(
        yield* operations.announceFirstCheckin(context, announcementReceipt.deliveryKey, policy),
      ).toEqual(announcementReceipt);
      expect(calls).toEqual(["respond", "setMemberRole", "editMessage", "sendMessage"]);

      const missing = yield* makeOperations(base, {
        editMessage: () =>
          Effect.fail(
            new BotResourceNotFound({
              resource: "check-in message",
              message: "message is unavailable",
            }),
          ),
      });
      expect(
        yield* Effect.flip(
          missing.editCheckinMessage(
            view,
            makeCurrentCheckinMessage(view),
            editReceipt.deliveryKey,
            policy,
          ),
        ),
      ).toEqual({
        _tag: "DeliveryRejected",
        operation: "checkins.respond.editCheckinMessage",
        message: "The check-in message update was rejected",
        committedReference: context.messageId,
        recoveryRequired: true,
      });
    }),
  );

  it.effect(
    "attempts the expiring response first and returns CollectAll receipts in pinned order",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const result = yield* makeCheckinsRespondWorkflowBody({
          commit: () => Effect.sync(() => (calls.push("commit"), committed)),
          respond: () => Effect.sync(() => (calls.push("respond"), responseReceipt)),
          setRole: () =>
            Effect.sync(() => {
              expect(calls).toContain("respond");
              calls.push("role");
              return roleReceipt;
            }),
          project: () =>
            Effect.sync(() => {
              expect(calls).toContain("respond");
              calls.push("project");
              return editReceipt;
            }),
          announce: () =>
            Effect.sync(() => {
              expect(calls).toContain("respond");
              calls.push("announce");
              return announcementReceipt;
            }),
        })(execution);

        expect(result).toEqual({
          messageId: "message-1",
          messageConversationId: "checkin-1",
          checkedInMemberId: context.memberId,
          deliveryReceipts: [responseReceipt, roleReceipt, editReceipt, announcementReceipt],
        });
        expect(calls.slice(0, 2)).toEqual(["commit", "respond"]);
        expect(new Set(calls.slice(2))).toEqual(new Set(["role", "project", "announce"]));
      }),
  );

  it.effect("skips optional role and announcement branches for a role-free repeat click", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const repeat = {
        ...committed,
        context: { ...context, roleId: null },
        isFirst: false,
      };
      const result = yield* makeCheckinsRespondWorkflowBody({
        commit: () => Effect.succeed(repeat),
        respond: () => Effect.succeed(responseReceipt),
        setRole: () => Effect.sync(() => (calls.push("role"), roleReceipt)),
        project: () => Effect.sync(() => (calls.push("project"), editReceipt)),
        announce: () => Effect.sync(() => (calls.push("announce"), announcementReceipt)),
      })(execution);
      expect(result.deliveryReceipts).toEqual([responseReceipt, editReceipt]);
      expect(calls).toEqual(["project"]);
    }),
  );

  it.effect("collects every applicable post-commit branch and gives revocation precedence", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const responseFailure = {
        _tag: "DeliveryRejected" as const,
        operation: "checkins.respond.respond",
        message: "expired",
        committedReference: "message-1",
        recoveryRequired: true,
      };
      const revoked = {
        _tag: "AuthorizationRevoked" as const,
        policy: CheckinsRespond.authorizationPolicy.policy,
      };
      const exit = yield* Effect.exit(
        makeCheckinsRespondWorkflowBody({
          commit: () => Effect.succeed(committed),
          respond: () => Effect.fail(responseFailure),
          setRole: () =>
            Effect.sync(() => calls.push("role")).pipe(Effect.andThen(Effect.fail(revoked))),
          project: () => Effect.sync(() => (calls.push("project"), editReceipt)),
          announce: () =>
            Effect.sync(() => calls.push("announce")).pipe(
              Effect.andThen(Effect.fail(responseFailure)),
            ),
        })(execution),
      );
      expect(calls).toEqual(expect.arrayContaining(["role", "project", "announce"]));
      expect(calls).toHaveLength(3);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toEqual(revoked);
      }
    }),
  );

  it("renders exact legacy member order and the enabled check-in component", () => {
    expect(
      makeCurrentCheckinMessage({
        context,
        members: [
          { memberId: "member-2", checkinAt: 200 },
          { memberId: "member-1", checkinAt: null },
          { memberId: context.memberId, checkinAt: 100 },
        ],
      }),
    ).toEqual({
      content: [
        { type: "text", text: "Check in" },
        { type: "text", text: "\n\nChecked in: " },
        { type: "userMention", userId: "member-2" },
        { type: "text", text: " " },
        { type: "userMention", userId: context.memberId },
      ],
      components: [
        {
          type: "actionRow",
          components: [
            expect.objectContaining({
              actionId: "interaction:checkin",
              label: "Check in",
              disabled: false,
            }),
          ],
        },
      ],
    });
  });

  it.effect("serializes the load-and-edit projection by canonical message identity", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<Array<string>>([]);
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      let call = 0;
      const layer = makeCheckinProjectionEntityLayer({
        project: () =>
          Effect.gen(function* () {
            call += 1;
            const current = call;
            yield* Ref.update(events, (items) => [...items, `${current}:start`]);
            if (current === 1) {
              yield* Deferred.succeed(firstStarted, void 0);
              yield* Deferred.await(releaseFirst);
            } else {
              yield* Deferred.succeed(secondStarted, void 0);
              yield* Deferred.await(releaseSecond);
            }
            yield* Ref.update(events, (items) => [...items, `${current}:end`]);
            return editReceipt;
          }),
      });
      const clientFor = yield* Entity.makeTestClient(CheckinProjectionEntity, layer);
      const client = yield* clientFor(checkinProjectionKey(context));
      const payload = { ...execution, committed };
      const first = yield* client.project(payload).pipe(Effect.forkScoped);
      yield* Deferred.await(firstStarted);
      const second = yield* client.project(payload).pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseFirst, void 0);
      yield* Deferred.await(secondStarted);
      expect(yield* Ref.get(events)).toEqual(["1:start", "1:end", "2:start"]);
      yield* Deferred.succeed(releaseSecond, void 0);
      yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      expect(yield* Ref.get(events)).toEqual(["1:start", "1:end", "2:start", "2:end"]);
    }).pipe(Effect.provide(TestShardingConfig)),
  );

  it("pins the public response and delivery reference schemas used by the slice", () => {
    expect(Schema.is(ResponseReference)(responseReference)).toBe(true);
    expect(Schema.is(DeliveryKey)(makeCheckinDeliveryKey(invocationId, "respond"))).toBe(true);
  });
});
