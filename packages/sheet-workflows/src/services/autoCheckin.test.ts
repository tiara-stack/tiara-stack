import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Schema } from "effect";
import { SqlError } from "effect/unstable/sql";
import { ServicePrincipal } from "sheet-auth/identity";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { WorkflowStore } from "effect-zero-workflow";
import { CheckinsOpen, WorkspaceId } from "sheet-workflow-contracts";
import {
  canonicalScheduledHourBucket,
  scheduledHourMillis,
  type AutonomousSweepResult,
} from "@/workflows/autoCheckinContract";
import { makeCheckinsOpenAutonomousInvocationId } from "@/workflows/checkins/keys";
import { checkinSheetWorkflowDefinitionVersion } from "@/workflows/checkins/catalog";
import { CheckinsOpenWorkflow } from "@/workflows/checkins/openDefinition";
import { AutonomousTriggerProvider } from "@/workflows/autonomous/provider";
import { ReadOnlyWorkflowAuthorization } from "@/workflows/readOnly/authorization";
import {
  AutonomousTriggerService,
  deriveAutomaticRoleCleanupHour,
  deriveAutonomousEventHour,
} from "./autoCheckin";
import {
  AutonomousWorkflowEnqueuer,
  type AutonomousWorkflowEnqueuerShape,
} from "./autonomousWorkflowEnqueuer";

const configLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    AUTO_CHECKIN_CONCURRENCY: "4",
    SHEET_AUTH_OAUTH_CLIENT_ID: "sheet-auto-role-cleanup",
    SHEET_AUTO_CHECKIN_OAUTH_CLIENT_ID: "sheet-auto-checkin",
    SHEET_AUTO_CHECKIN_SERVICE_ID: "auto-checkin",
    SHEET_AUTO_ROLE_CLEANUP_SERVICE_ID: "auto-role-cleanup",
    SHEET_BOT_CLIENT_ID: "discord-main",
  }),
);

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");

const workspace = (workspaceId: string, sheetId: string | null = "sheet-1") => ({
  workspaceId,
  sheetId,
  autoCheckin: true,
  monitorConversationId: null,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
});

const conversation = (
  conversationId: string,
  name: string | null,
  roleId: string | null = null,
  running = true,
  workspaceId = "workspace-1",
) => ({
  workspaceId,
  conversationId,
  name,
  running,
  roleId,
  checkinConversationId: null,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
});

const makePersistence = (
  conversations: ReadonlyArray<ReturnType<typeof conversation>>,
  workspaces: ReadonlyArray<ReturnType<typeof workspace>> = [workspace("workspace-1")],
) =>
  ({
    workspaces: {
      getAutoCheckinWorkspaces: () => Effect.succeed(workspaces),
      getWorkspaceConversations: ({ workspaceId }: { readonly workspaceId: string }) =>
        Effect.succeed(conversations.filter((candidate) => candidate.workspaceId === workspaceId)),
    },
  }) as unknown as TrustedSheetPersistence["Service"];

const makeProvider = (eventStartEpochMs: number) =>
  ({
    loadEventStart: () => Effect.succeed(eventStartEpochMs),
  }) as typeof AutonomousTriggerProvider.Service;

const runService = <A>(
  effect: (service: typeof AutonomousTriggerService.Service) => Effect.Effect<A, unknown>,
  options: {
    readonly conversations: ReadonlyArray<ReturnType<typeof conversation>>;
    readonly enqueuer: typeof AutonomousWorkflowEnqueuer.Service;
    readonly eventStartEpochMs?: number;
    readonly workspaces?: ReadonlyArray<ReturnType<typeof workspace>>;
  },
): Effect.Effect<A, never, never> =>
  AutonomousTriggerService.make.pipe(
    Effect.flatMap(effect),
    Effect.provideService(
      TrustedSheetPersistence,
      makePersistence(options.conversations, options.workspaces),
    ),
    Effect.provideService(
      AutonomousTriggerProvider,
      makeProvider(options.eventStartEpochMs ?? Date.UTC(2026, 3, 1, 12)),
    ),
    Effect.provideService(AutonomousWorkflowEnqueuer, options.enqueuer),
    Effect.provide(configLayer),
    Effect.orDie,
  );

describe("AutonomousTriggerService", () => {
  it("derives scheduled target hours from one canonical bucket", () => {
    const eventStart = Date.UTC(2026, 3, 1, 12);
    const bucket = Date.UTC(2026, 3, 1, 13);

    expect(canonicalScheduledHourBucket(bucket + 45 * 60_000)).toBe(bucket);
    expect(deriveAutonomousEventHour(eventStart, bucket + scheduledHourMillis)).toBe(3);
    expect(deriveAutomaticRoleCleanupHour(eventStart, bucket)).toBe(2);
  });

  it.effect("uses stable per-target identities when the same sweep fires twice", () =>
    Effect.gen(function* () {
      const calls: Array<Parameters<AutonomousWorkflowEnqueuerShape["enqueueCheckinsOpen"]>[0]> =
        [];
      const enqueuer = {
        enqueueCheckinsOpen: (request: (typeof calls)[number]) =>
          Effect.sync(() => {
            calls.push(request);
          }),
        enqueueMembersKick: () => Effect.void,
      } as typeof AutonomousWorkflowEnqueuer.Service;
      const bucket = Date.UTC(2026, 3, 1, 13);
      const conversations = [
        conversation("conversation-main", "main"),
        conversation("conversation-main-duplicate", "main"),
        conversation("conversation-side", "side"),
        conversation("conversation-unnamed", null),
        conversation("conversation-not-running", "not-running", null, false),
      ];

      const first = yield* runService<AutonomousSweepResult>(
        (service) => service.sweepAutoCheckin(bucket),
        {
          conversations,
          enqueuer,
        },
      );
      const firstIds = calls.map(({ invocationId }) => invocationId);
      const second = yield* runService<AutonomousSweepResult>(
        (service) => service.sweepAutoCheckin(bucket),
        {
          conversations,
          enqueuer,
        },
      );
      const secondIds = calls.slice(firstIds.length).map(({ invocationId }) => invocationId);

      expect(first.acceptedInvocationCount).toBe(2);
      expect(second.acceptedInvocationCount).toBe(2);
      expect([...secondIds].sort()).toEqual([...firstIds].sort());
      expect(
        calls
          .map(({ input }) => input)
          .sort((left, right) =>
            (left.conversationName ?? "").localeCompare(right.conversationName ?? ""),
          ),
      ).toEqual([
        { workspaceId: "workspace-1", conversationName: "main", hour: 3 },
        { workspaceId: "workspace-1", conversationName: "main", hour: 3 },
        { workspaceId: "workspace-1", conversationName: "side", hour: 3 },
        { workspaceId: "workspace-1", conversationName: "side", hour: 3 },
      ]);
    }),
  );

  it.effect("accepts only managed running conversations for role cleanup", () =>
    Effect.gen(function* () {
      const calls: Array<Parameters<AutonomousWorkflowEnqueuerShape["enqueueMembersKick"]>[0]> = [];
      const enqueuer = {
        enqueueCheckinsOpen: () => Effect.void,
        enqueueMembersKick: (request: (typeof calls)[number]) =>
          Effect.sync(() => {
            calls.push(request);
          }),
      } as typeof AutonomousWorkflowEnqueuer.Service;

      const result = yield* runService<AutonomousSweepResult>(
        (service) => service.sweepAutoRoleCleanup(Date.UTC(2026, 3, 1, 13)),
        {
          conversations: [
            conversation("conversation-managed", "main", "role-1"),
            conversation("conversation-no-role", "side"),
            conversation("conversation-no-name", null, "role-2"),
            conversation("conversation-not-running", "not-running", "role-3", false),
          ],
          enqueuer,
        },
      );

      expect(result.acceptedInvocationCount).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        acceptedAt: Date.UTC(2026, 3, 1, 13),
        input: {
          workspaceId,
          conversationId: "conversation-managed",
          hour: 2,
        },
        principal: {
          kind: "service",
          serviceId: "auto-role-cleanup",
          oauthClientId: "sheet-auto-role-cleanup",
        },
      });
    }),
  );

  it.effect("continues check-in sweeps after workspace and target failures", () =>
    Effect.gen(function* () {
      const calls: Array<Parameters<AutonomousWorkflowEnqueuerShape["enqueueCheckinsOpen"]>[0]> =
        [];
      const enqueuer = {
        enqueueCheckinsOpen: (request: (typeof calls)[number]) =>
          request.input.conversationName === "failed"
            ? Effect.fail(new Error("target acceptance failed"))
            : Effect.sync(() => {
                calls.push(request);
              }),
        enqueueMembersKick: () => Effect.void,
      } as typeof AutonomousWorkflowEnqueuer.Service;

      const result = yield* runService<AutonomousSweepResult>(
        (service) => service.sweepAutoCheckin(Date.UTC(2026, 3, 1, 13)),
        {
          conversations: [
            conversation("conversation-failed", "failed"),
            conversation("conversation-ok", "ok"),
            conversation("conversation-invalid-workspace", "invalid-workspace", null, true, " "),
          ],
          enqueuer,
          workspaces: [
            workspace("workspace-no-sheet", null),
            workspace(" "),
            workspace("workspace-1"),
          ],
        },
      );

      expect(result.acceptedInvocationCount).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input.conversationName).toBe("ok");
    }),
  );

  it.effect("propagates check-in sweep interruptions", () =>
    Effect.gen(function* () {
      const enqueuer = {
        enqueueCheckinsOpen: () => Effect.interrupt,
        enqueueMembersKick: () => Effect.void,
      } as typeof AutonomousWorkflowEnqueuer.Service;

      const exit = yield* Effect.exit(
        runService<AutonomousSweepResult>(
          (service) => service.sweepAutoCheckin(Date.UTC(2026, 3, 1, 13)),
          {
            conversations: [conversation("conversation-interrupted", "interrupted")],
            enqueuer,
          },
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      }
    }),
  );

  it.effect("continues role-cleanup sweeps after workspace and target failures", () =>
    Effect.gen(function* () {
      const calls: Array<Parameters<AutonomousWorkflowEnqueuerShape["enqueueMembersKick"]>[0]> = [];
      const enqueuer = {
        enqueueCheckinsOpen: () => Effect.void,
        enqueueMembersKick: (request: (typeof calls)[number]) =>
          request.input.conversationId === "conversation-failed"
            ? Effect.fail(new Error("target acceptance failed"))
            : Effect.sync(() => {
                calls.push(request);
              }),
      } as typeof AutonomousWorkflowEnqueuer.Service;

      const result = yield* runService<AutonomousSweepResult>(
        (service) => service.sweepAutoRoleCleanup(Date.UTC(2026, 3, 1, 13)),
        {
          conversations: [
            conversation("conversation-failed", "failed", "role-1"),
            conversation("conversation-ok", "ok", "role-2"),
          ],
          enqueuer,
          workspaces: [workspace(" "), workspace("workspace-1")],
        },
      );

      expect(result.acceptedInvocationCount).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input.conversationId).toBe("conversation-ok");
    }),
  );

  it.live("retries an ambiguous contract acceptance with the same run payload", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let acceptedInput: unknown;
      const store = {
        enqueue: (input: { readonly runId: string; readonly payload: unknown }) =>
          Effect.suspend(() => {
            attempts += 1;
            if (attempts === 1) {
              return Effect.fail(
                new SqlError.SqlError({
                  reason: new SqlError.ConnectionError({
                    cause: new Error("ambiguous acceptance"),
                  }),
                }),
              );
            }
            acceptedInput = input;
            return Effect.succeed({ runId: input.runId, executionId: "execution-1" });
          }),
      } as unknown as typeof WorkflowStore.Service;
      const authorization = {
        authorize: () => Effect.void,
      } as unknown as typeof ReadOnlyWorkflowAuthorization.Service;
      const enqueuer = yield* AutonomousWorkflowEnqueuer.make.pipe(
        Effect.provideService(WorkflowStore, store),
        Effect.provideService(ReadOnlyWorkflowAuthorization, authorization),
      );
      const principal = Schema.decodeUnknownSync(ServicePrincipal)({
        kind: "service",
        serviceId: "auto-checkin",
        oauthClientId: "sheet-auto-checkin",
      });
      const invocationId = makeCheckinsOpenAutonomousInvocationId({
        workspaceId: "workspace-1",
        eventStartEpochMs: Date.UTC(2026, 3, 1, 12),
        hour: 3,
        conversationName: "main",
      });

      yield* enqueuer.enqueueCheckinsOpen({
        invocationId,
        input: {
          workspaceId,
          conversationName: "main",
          hour: 3,
        } satisfies typeof CheckinsOpen.input.Type,
        principal,
      });

      expect(attempts).toBe(2);
      expect(acceptedInput).toMatchObject({
        runId: invocationId,
        payload: { invocationId },
      });
    }),
  );

  it.live("reconciles a committed acceptance after a unique violation", () =>
    Effect.gen(function* () {
      let getRunCalls = 0;
      const principal = Schema.decodeUnknownSync(ServicePrincipal)({
        kind: "service",
        serviceId: "auto-checkin",
        oauthClientId: "sheet-auto-checkin",
      });
      const invocationId = makeCheckinsOpenAutonomousInvocationId({
        workspaceId: "workspace-1",
        eventStartEpochMs: Date.UTC(2026, 3, 1, 12),
        hour: 3,
        conversationName: "main",
      });
      const input = {
        workspaceId,
        conversationName: "main",
        hour: 3,
      } satisfies typeof CheckinsOpen.input.Type;
      const executionId = yield* CheckinsOpenWorkflow.executionId({
        invocationId,
        input,
        principal,
      });
      const store = {
        enqueue: () =>
          Effect.fail(
            new SqlError.SqlError({
              reason: new SqlError.UniqueViolation({
                cause: new Error("ambiguous committed acceptance"),
                constraint: "workflow_run_run_id_pk",
              }),
            }),
          ),
        getRun: (runId: string) =>
          Effect.sync(() => {
            getRunCalls += 1;
            return {
              runId,
              workflowName: CheckinsOpenWorkflow.name,
              definitionVersion: checkinSheetWorkflowDefinitionVersion,
              executionId,
              status: "pending" as const,
              result: null,
              error: null,
              updatedAt: new Date(0),
            };
          }),
      } as unknown as typeof WorkflowStore.Service;
      const authorization = {
        authorize: () => Effect.void,
      } as unknown as typeof ReadOnlyWorkflowAuthorization.Service;
      const enqueuer = yield* AutonomousWorkflowEnqueuer.make.pipe(
        Effect.provideService(WorkflowStore, store),
        Effect.provideService(ReadOnlyWorkflowAuthorization, authorization),
      );

      yield* enqueuer.enqueueCheckinsOpen({ invocationId, input, principal });

      expect(getRunCalls).toBe(1);
    }),
  );

  it.live("does not retry deterministic workflow acceptance failures", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const store = {
        enqueue: () =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(
              new SqlError.SqlError({
                reason: new SqlError.UniqueViolation({
                  cause: new Error("duplicate workflow"),
                  constraint: "workflow_run_workflow_idempotency_idx",
                }),
              }),
            );
          }),
        getRun: () => Effect.succeed(undefined),
      } as unknown as typeof WorkflowStore.Service;
      const authorization = {
        authorize: () => Effect.void,
      } as unknown as typeof ReadOnlyWorkflowAuthorization.Service;
      const enqueuer = yield* AutonomousWorkflowEnqueuer.make.pipe(
        Effect.provideService(WorkflowStore, store),
        Effect.provideService(ReadOnlyWorkflowAuthorization, authorization),
      );
      const principal = Schema.decodeUnknownSync(ServicePrincipal)({
        kind: "service",
        serviceId: "auto-checkin",
        oauthClientId: "sheet-auto-checkin",
      });
      const invocationId = makeCheckinsOpenAutonomousInvocationId({
        workspaceId: "workspace-1",
        eventStartEpochMs: Date.UTC(2026, 3, 1, 12),
        hour: 3,
        conversationName: "main",
      });

      const exit = yield* Effect.exit(
        enqueuer.enqueueCheckinsOpen({
          invocationId,
          input: {
            workspaceId,
            conversationName: "main",
            hour: 3,
          } satisfies typeof CheckinsOpen.input.Type,
          principal,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(attempts).toBe(1);
    }),
  );
});
