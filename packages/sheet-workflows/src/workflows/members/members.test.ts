import type { sheets_v4 } from "@googleapis/sheets";
import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Option, Ref, Schema } from "effect";
import {
  ResponseReference,
  type SheetBotHttpClient,
  type RespondReceipt,
  type SetMemberRoleReceipt,
  workspaceRefFrom,
} from "sheet-bot-api";
import { EffectivePrincipal } from "sheet-auth/identity";
import { MembersKick } from "sheet-workflow-contracts";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { workflowTestInvocationId as invocationId } from "../shared/testHelpers";
import { makeMembersKickSerializedWorkflowBody, makeMembersKickWorkflowBody } from "./definition";
import {
  makeMemberKickAutonomousInvocationId,
  makeMemberKickRemovalDeliveryKey,
  makeMemberKickResponseDeliveryKey,
  makeMemberKickSerializationKey,
  makeMemberKickUserInvocationId,
} from "./keys";
import {
  deriveMemberKickHour,
  memberKickWorkflowOperationsLayer,
  validateMemberKickInput,
} from "./operations";
import { makeMemberKickProvider, MemberKickProvider } from "./provider";
import { MemberKickExecution, MemberKickResolvedExecution } from "./schema";
import { MemberKickWorkflowOperations } from "./service";

const client = { platform: "discord" as const, clientId: "discord-main" };
const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
const userPrincipal = Schema.decodeUnknownSync(EffectivePrincipal)({
  kind: "user",
  userId: "user-1",
  discordAccount: { accountId: "discord-user-1" },
});
const input = Schema.decodeUnknownSync(MembersKick.input)({
  workspaceId: "workspace-1",
  responseReference,
  conversationId: "conversation-1",
});
const execution = Schema.decodeUnknownSync(MemberKickResolvedExecution)({
  invocationId,
  input,
  principal: userPrincipal,
  acceptedAt: Date.UTC(2026, 0, 1, 10, 20),
  context: {
    clientPlatform: client.platform,
    clientId: client.clientId,
    workspaceId: input.workspaceId,
    spreadsheetId: "sheet-1",
    runningConversationId: "conversation-1",
    conversationName: "alpha",
    roleId: "cleanup-role",
    acceptedAt: Date.UTC(2026, 0, 1, 10, 20),
    hour: 3,
    status: "ready",
    principalKind: "user",
  },
});
const unresolvedExecution = Schema.decodeUnknownSync(MemberKickExecution)({
  invocationId,
  input,
  principal: userPrincipal,
  acceptedAt: Date.UTC(2026, 0, 1, 10, 20),
});

const removalReceipt = (memberId: string): SetMemberRoleReceipt => ({
  deliveryKey: makeMemberKickRemovalDeliveryKey(invocationId, memberId),
  operation: "setMemberRole",
  target: {
    _tag: "MemberRole",
    workspace: workspaceRefFrom(client, input.workspaceId),
    userId: memberId,
    roleId: "cleanup-role",
  },
});

const responseReceipt: RespondReceipt = {
  deliveryKey: makeMemberKickResponseDeliveryKey(invocationId),
  operation: "respond",
  target: { _tag: "Response", responseReference },
};

const makeResolutionOperations = () => {
  const basePersistence = makeTrustedSheetPersistenceMock();
  const persistence: TrustedSheetPersistenceShape = {
    ...basePersistence,
    workspaces: {
      ...basePersistence.workspaces,
      getWorkspaceConversationByName: () =>
        Effect.succeed(
          Option.some({
            workspaceId: input.workspaceId,
            conversationId: "conversation-1",
            name: "alpha",
            running: true,
            roleId: null,
            checkinConversationId: null,
            createdAt: 1,
            updatedAt: 1,
            deletedAt: null,
          }),
        ),
      getWorkspaceConfigByWorkspaceId: () =>
        Effect.succeed(
          Option.some({
            workspaceId: input.workspaceId,
            sheetId: "sheet-1",
            autoCheckin: null,
            monitorConversationId: null,
            createdAt: 1,
            updatedAt: 1,
            deletedAt: null,
          }),
        ),
    },
  };
  const authorization: ReadOnlyWorkflowAuthorization["Service"] = {
    authorize: () => Effect.void,
    authorizeSlotOpen: () => Effect.die("unused"),
    authorizeCheckinRespond: () => Effect.die("unused"),
    authorizeRoomOrdersNavigate: () => Effect.die("unused"),
    authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
    authorizeRoomOrdersSend: () => Effect.die("unused"),
    workspaceCapabilities: () => Effect.die("unused"),
  };
  const bot = {} as SheetBotHttpClient;
  return MemberKickWorkflowOperations.pipe(
    Effect.provide(memberKickWorkflowOperationsLayer),
    Effect.provideService(TrustedSheetPersistence, persistence),
    Effect.provideService(MemberKickProvider, {
      loadEventStart: () => Effect.succeed(Date.UTC(2026, 0, 1, 8, 30)),
      loadSchedule: () => Effect.die("unused"),
    }),
    Effect.provideService(SheetBotCacheClient, { get: () => bot }),
    Effect.provideService(SheetBotDeliveryClient, { get: () => bot }),
    Effect.provideService(ReadOnlyWorkflowAuthorization, authorization),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: client.clientId })),
    ),
  );
};

describe("member cleanup policy", () => {
  it.effect("accepts only the principal-specific wire-v1 input shapes", () =>
    Effect.gen(function* () {
      yield* validateMemberKickInput("user", input);
      yield* validateMemberKickInput(
        "service",
        Schema.decodeUnknownSync(MembersKick.input)({
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          hour: 3,
        }),
      );

      const invalidUser = yield* Effect.exit(
        validateMemberKickInput(
          "user",
          Schema.decodeUnknownSync(MembersKick.input)({
            workspaceId: "workspace-1",
            responseReference,
            conversationId: "conversation-1",
            conversationName: "alpha",
          }),
        ),
      );
      const invalidService = yield* Effect.exit(
        validateMemberKickInput(
          "service",
          Schema.decodeUnknownSync(MembersKick.input)({
            workspaceId: "workspace-1",
            responseReference,
            conversationId: "conversation-1",
            hour: 3,
          }),
        ),
      );

      expect(Exit.isFailure(invalidUser)).toBe(true);
      expect(Exit.isFailure(invalidService)).toBe(true);
      if (Exit.isFailure(invalidUser)) {
        expect(Option.getOrThrow(Cause.findErrorOption(invalidUser.cause))).toMatchObject({
          _tag: "InvalidRequest",
          code: "InvalidMemberKickPrincipalInput",
        });
      }
    }),
  );

  it.effect("derives the event hour from the durable acceptance time", () =>
    Effect.gen(function* () {
      const eventStart = Date.UTC(2026, 0, 1, 8, 30);
      expect(yield* deriveMemberKickHour(eventStart, Date.UTC(2026, 0, 1, 10, 39))).toBe(2);
      expect(yield* deriveMemberKickHour(eventStart, Date.UTC(2026, 0, 1, 10, 59))).toBe(2);
    }),
  );

  it.effect("preserves the terminal cutoff before conversation resolution", () =>
    Effect.gen(function* () {
      const operations = yield* makeResolutionOperations();
      const terminalExecution = Schema.decodeUnknownSync(MemberKickExecution)({
        ...unresolvedExecution,
        acceptedAt: Date.UTC(2026, 0, 1, 10, 40),
        input: {
          workspaceId: input.workspaceId,
          responseReference,
          conversationName: "alpha",
        },
      });

      expect(yield* operations.resolve(terminalExecution)).toMatchObject({
        runningConversationId: "",
        conversationName: "alpha",
        hour: 0,
        status: "tooEarly",
      });
    }),
  );

  it.effect("derives the canonical hour before returning missing-role", () =>
    Effect.gen(function* () {
      const operations = yield* makeResolutionOperations();
      const nameExecution = Schema.decodeUnknownSync(MemberKickExecution)({
        ...unresolvedExecution,
        input: {
          workspaceId: input.workspaceId,
          responseReference,
          conversationName: "alpha",
        },
      });

      expect(yield* operations.resolve(nameExecution)).toMatchObject({
        spreadsheetId: "sheet-1",
        runningConversationId: "conversation-1",
        conversationName: "alpha",
        roleId: null,
        hour: 2,
        status: "missingRole",
      });
    }),
  );

  it("keeps invocation, action-delivery, and serialization identities stable", () => {
    expect(makeMemberKickUserInvocationId(client.clientId, "interaction-1")).toBe(
      makeMemberKickUserInvocationId(client.clientId, "interaction-1"),
    );
    expect(
      makeMemberKickAutonomousInvocationId(
        Date.UTC(2026, 0, 1, 10, 45),
        client.clientId,
        input.workspaceId,
        "conversation-1",
        3,
      ),
    ).toBe(
      makeMemberKickAutonomousInvocationId(
        Date.UTC(2026, 0, 1, 10, 5),
        client.clientId,
        input.workspaceId,
        "conversation-1",
        3,
      ),
    );
    expect(makeMemberKickRemovalDeliveryKey(invocationId, "member-a")).not.toBe(
      makeMemberKickRemovalDeliveryKey(invocationId, "member-b"),
    );
    expect(
      makeMemberKickSerializationKey(
        client.clientId,
        input.workspaceId,
        "conversation-1",
        3,
        "cleanup-role",
      ),
    ).not.toBe(
      makeMemberKickSerializationKey(
        client.clientId,
        input.workspaceId,
        "conversation-1",
        4,
        "cleanup-role",
      ),
    );
  });
});

describe("member cleanup serialized body", () => {
  it.effect("bypasses entity serialization for terminal resolution contexts", () =>
    Effect.gen(function* () {
      const readyRuns = yield* Ref.make(0);
      const terminalRuns = yield* Ref.make(0);
      const terminalContext = {
        ...execution.context,
        spreadsheetId: null,
        runningConversationId: "",
        conversationName: "alpha",
        roleId: null,
        hour: 0,
        status: "tooEarly" as const,
      };
      const result = yield* makeMembersKickWorkflowBody({
        resolve: () => Effect.succeed(terminalContext),
        runReady: () =>
          Ref.update(readyRuns, (count) => count + 1).pipe(
            Effect.andThen(Effect.die("unexpected ready execution")),
          ),
        runTerminal: ({ context }) =>
          Ref.update(terminalRuns, (count) => count + 1).pipe(
            Effect.as({
              workspaceId: context.workspaceId,
              runningConversationId: context.runningConversationId,
              hour: context.hour,
              roleId: context.roleId,
              removedMemberIds: [],
              status: "tooEarly" as const,
              deliveryReceipts: [],
            }),
          ),
      })(unresolvedExecution);

      expect(result.status).toBe("tooEarly");
      expect(yield* Ref.get(readyRuns)).toBe(0);
      expect(yield* Ref.get(terminalRuns)).toBe(1);
    }),
  );

  it.effect("collects per-member commits and orders the response receipt last", () =>
    Effect.gen(function* () {
      const removed = yield* Ref.make<ReadonlyArray<string>>([]);
      const result = yield* makeMembersKickSerializedWorkflowBody({
        loadSchedule: () =>
          Effect.succeed({ scheduleFound: true, scheduledMemberIds: ["scheduled"] }),
        discoverTargets: () => Effect.succeed({ memberIds: ["member-b", "member-a"] }),
        removeRole: ({ memberId }) =>
          Ref.update(removed, (members) => [...members, memberId]).pipe(
            Effect.as(removalReceipt(memberId)),
          ),
        respond: () => Effect.succeed(responseReceipt),
        removalConcurrency: 2,
      })(execution);

      expect(result).toEqual({
        workspaceId: input.workspaceId,
        runningConversationId: "conversation-1",
        hour: 3,
        roleId: "cleanup-role",
        removedMemberIds: ["member-b", "member-a"],
        status: "removed",
        deliveryReceipts: [removalReceipt("member-b"), removalReceipt("member-a"), responseReceipt],
      });
      expect(new Set(yield* Ref.get(removed))).toEqual(new Set(["member-a", "member-b"]));
    }),
  );

  it.effect(
    "attempts every removal, reports partial success, then fails without compensation",
    () =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make<ReadonlyArray<string>>([]);
        const responseRecoveryRequired = yield* Ref.make(false);
        const exit = yield* Effect.exit(
          makeMembersKickSerializedWorkflowBody({
            loadSchedule: () => Effect.succeed({ scheduleFound: true, scheduledMemberIds: [] }),
            discoverTargets: () => Effect.succeed({ memberIds: ["member-a", "member-b"] }),
            removeRole: ({ memberId }) =>
              Ref.update(attempts, (members) => [...members, memberId]).pipe(
                Effect.andThen(
                  memberId === "member-a"
                    ? Effect.succeed(removalReceipt(memberId))
                    : Effect.fail({
                        _tag: "DeliveryRejected" as const,
                        operation: "members.kick.remove-member-role",
                        message: "rejected",
                        recoveryRequired: false,
                      }),
                ),
              ),
            respond: ({ recoveryRequired }) =>
              Ref.set(responseRecoveryRequired, recoveryRequired).pipe(Effect.as(responseReceipt)),
            removalConcurrency: 2,
          })(execution),
        );

        expect(new Set(yield* Ref.get(attempts))).toEqual(new Set(["member-a", "member-b"]));
        expect(yield* Ref.get(responseRecoveryRequired)).toBe(true);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "DeliveryRejected",
            operation: "members.kick.remove-member-role",
            recoveryRequired: true,
          });
        }
      }),
  );

  it.effect("omits interaction delivery for autonomous cleanup", () =>
    Effect.gen(function* () {
      const serviceExecution = Schema.decodeUnknownSync(MemberKickResolvedExecution)({
        ...execution,
        input: {
          workspaceId: input.workspaceId,
          conversationId: "conversation-1",
          hour: 3,
        },
        principal: {
          kind: "service",
          serviceId: "auto-role-cleanup",
          oauthClientId: "sheet-auto-role-cleanup",
        },
        context: { ...execution.context, principalKind: "service" },
      });
      const result = yield* makeMembersKickSerializedWorkflowBody({
        loadSchedule: () => Effect.succeed({ scheduleFound: false, scheduledMemberIds: [] }),
        discoverTargets: () => Effect.die("unexpected target discovery"),
        removeRole: () => Effect.die("unexpected removal"),
        respond: () => Effect.die("unexpected response"),
        removalConcurrency: 2,
      })(serviceExecution);

      expect(result.status).toBe("empty");
      expect(result.deliveryReceipts).toEqual([]);
    }),
  );

  it.effect("surfaces response failure as recovery-required after a committed removal", () =>
    Effect.gen(function* () {
      const committedReference = makeMemberKickSerializationKey(
        client.clientId,
        input.workspaceId,
        "conversation-1",
        3,
        "cleanup-role",
      );
      const exit = yield* Effect.exit(
        makeMembersKickSerializedWorkflowBody({
          loadSchedule: () => Effect.succeed({ scheduleFound: true, scheduledMemberIds: [] }),
          discoverTargets: () => Effect.succeed({ memberIds: ["member-a"] }),
          removeRole: ({ memberId }) => Effect.succeed(removalReceipt(memberId)),
          respond: ({ recoveryRequired }) =>
            Effect.fail({
              _tag: "DeliveryRejected" as const,
              operation: "members.kick.deliver-member-kick-result",
              message: "response rejected",
              committedReference,
              recoveryRequired,
            }),
          removalConcurrency: 2,
        })(execution),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toEqual({
          _tag: "DeliveryRejected",
          operation: "members.kick.deliver-member-kick-result",
          message: "response rejected",
          committedReference,
          recoveryRequired: true,
        });
      }
    }),
  );
});

describe("member cleanup Sheets provider", () => {
  it.effect("preserves the original cause for event-configuration read failures", () =>
    Effect.gen(function* () {
      const cause = new Error("sheets unavailable");
      const client = {
        spreadsheets: {
          values: {
            batchGet: () => Promise.reject(cause),
          },
        },
      } as unknown as sheets_v4.Sheets;

      const error = yield* Effect.flip(makeMemberKickProvider(client).loadEventStart("sheet-1"));

      expect(error).toMatchObject({
        _tag: "MemberKickProviderError",
        operation: "read-event-configuration",
      });
      expect(error.cause).toBe(cause);
    }),
  );

  it.effect("selects the exact conversation/hour and excludes partial-name fills", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const responses = [
        [
          {
            values: [
              ["User IDs", "'Players'!A1:A2"],
              ["User Sheet Names", "'Players'!B1:B2"],
            ],
          },
          {
            values: [
              [
                "alpha",
                "1",
                "Alpha Schedule",
                "A1:A2",
                "C1:C2",
                undefined,
                "none",
                "B1:F2",
                "D1:D2",
                "E1:E2",
                undefined,
                undefined,
                "F1",
              ],
              [
                "alphabet",
                "1",
                "Wrong Schedule",
                "A1:A1",
                "C1:C1",
                undefined,
                "none",
                "B1:F1",
                "D1:D1",
                "E1:E1",
                undefined,
                undefined,
                "F1",
              ],
            ],
          },
          { values: [] },
        ],
        [
          { values: [["3"], ["4"]] },
          { values: [["alice", "Partial Name"], ["bob"]] },
          { values: [[false], [false]] },
          { values: [["member-a"], ["member-b"]] },
          { values: [["Alice"], ["Bob"]] },
        ],
      ] as const;
      let request = 0;
      const client = {
        spreadsheets: {
          values: {
            batchGet: ({ ranges = [] }: { readonly ranges?: ReadonlyArray<string> }) => {
              calls.push([...ranges]);
              return Promise.resolve({ data: { valueRanges: responses[request++] ?? [] } });
            },
          },
        },
      } as unknown as sheets_v4.Sheets;

      expect(yield* makeMemberKickProvider(client).loadSchedule("sheet-1", "alpha", 3)).toEqual({
        scheduleFound: true,
        scheduledMemberIds: ["member-a"],
      });
      expect(calls[1]).toEqual([
        "'Alpha Schedule'!A1:A2",
        "'Alpha Schedule'!B1:F2",
        "'Alpha Schedule'!C1:C2",
        "'Players'!A1:A2",
        "'Players'!B1:B2",
      ]);
    }),
  );
});
