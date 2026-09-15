import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Option, Schema } from "effect";
import { SqlError } from "effect/unstable/sql";
import { ServicePrincipal } from "sheet-auth/identity";
import {
  scheduleTimeReferenceFromLegacy,
  scheduleTimeReferenceFromLegacyFirstHour,
  scheduleTimeReferenceMetadataFrom,
} from "sheet-domain";
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
  scheduleTimeReference?: {
    readonly kind: "event-start" | "chapter-start";
    readonly instantEpochMs: number;
    readonly hour: number;
  },
) =>
  ({
    workspaces: {
      getAutoCheckinWorkspaces: () => Effect.succeed(workspaces),
      getWorkspaceConversations: ({ workspaceId }: { readonly workspaceId: string }) =>
        Effect.succeed(conversations.filter((candidate) => candidate.workspaceId === workspaceId)),
    },
    ...(scheduleTimeReference === undefined
      ? {}
      : {
          sheetConfiguration: {
            getSheetConfiguration: () =>
              Effect.succeed(
                Option.some({
                  source: {
                    kind: "legacy",
                    binding: {
                      status: "bound",
                      expectedTitle: "Thee's Sheet Settings",
                      spreadsheetId: "sheet-1",
                      sheetId: 1,
                      scheduleTimeReference,
                    },
                  },
                }),
              ),
          },
        }),
  }) as unknown as TrustedSheetPersistence["Service"];

const makeProvider = (
  eventStartEpochMs: number,
  firstEventHour: number | undefined,
  onLegacyTimingRowsRead?: () => void,
  onEventStartRead?: () => void,
) =>
  ({
    loadEventStart: () =>
      Effect.sync(() => {
        onEventStartRead?.();
        return eventStartEpochMs;
      }),
    loadLegacyScheduleTimeReference: ({ referenceInstantEpochMs }) =>
      Effect.sync(() => {
        onLegacyTimingRowsRead?.();
        return firstEventHour === undefined
          ? undefined
          : scheduleTimeReferenceFromLegacyFirstHour(referenceInstantEpochMs, firstEventHour);
      }),
  }) as typeof AutonomousTriggerProvider.Service;

const runService = <A>(
  effect: (service: typeof AutonomousTriggerService.Service) => Effect.Effect<A, unknown>,
  options: {
    readonly conversations: ReadonlyArray<ReturnType<typeof conversation>>;
    readonly enqueuer: typeof AutonomousWorkflowEnqueuer.Service;
    readonly eventStartEpochMs?: number;
    readonly firstEventHour?: number;
    readonly scheduleTimeReference?: {
      readonly kind: "event-start" | "chapter-start";
      readonly instantEpochMs: number;
      readonly hour: number;
    };
    readonly onLegacyTimingRowsRead?: () => void;
    readonly onEventStartRead?: () => void;
    readonly workspaces?: ReadonlyArray<ReturnType<typeof workspace>>;
  },
): Effect.Effect<A, never, never> =>
  AutonomousTriggerService.make.pipe(
    Effect.flatMap(effect),
    Effect.provideService(
      TrustedSheetPersistence,
      makePersistence(options.conversations, options.workspaces, options.scheduleTimeReference),
    ),
    Effect.provideService(
      AutonomousTriggerProvider,
      makeProvider(
        options.eventStartEpochMs ?? Date.UTC(2026, 3, 1, 12),
        options.firstEventHour,
        options.onLegacyTimingRowsRead,
        options.onEventStartRead,
      ),
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
    expect(deriveAutonomousEventHour(eventStart, eventStart, 49)).toBe(49);
    expect(deriveAutomaticRoleCleanupHour(eventStart, bucket)).toBe(2);
    expect(deriveAutomaticRoleCleanupHour(eventStart, eventStart, 49)).toBe(49);
    expect(
      deriveAutomaticRoleCleanupHour(eventStart, eventStart - 50 * scheduledHourMillis, 49),
    ).toBe(0);
  });

  it("rejects invalid first event-wide hours", () => {
    const eventStart = Date.UTC(2026, 3, 1, 12);
    const target = eventStart + scheduledHourMillis;

    expect(() => deriveAutonomousEventHour(eventStart, target, 0)).toThrow(RangeError);
    expect(() => deriveAutonomousEventHour(eventStart, target, 1.5)).toThrow(RangeError);
    expect(() => deriveAutonomousEventHour(eventStart, target, Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
  });

  it("preserves the recorded event 179 chapter and full-event hour mappings", () => {
    const eventStart = Date.UTC(2026, 8, 7, 3);
    const chapterStart = Date.UTC(2026, 8, 9, 3);
    const capturedTargets = [
      [Date.UTC(2026, 8, 9, 16), 62],
      [Date.UTC(2026, 8, 9, 17), 63],
      [Date.UTC(2026, 8, 10, 5), 75],
      [Date.UTC(2026, 8, 10, 7), 77],
      [Date.UTC(2026, 8, 10, 9), 79],
      [Date.UTC(2026, 8, 10, 10), 80],
      [Date.UTC(2026, 8, 10, 11), 81],
      [Date.UTC(2026, 8, 10, 12), 82],
    ] as const;

    for (const [target, expectedHour] of capturedTargets) {
      expect(deriveAutonomousEventHour(eventStart, target)).toBe(expectedHour);
      expect(deriveAutonomousEventHour(chapterStart, target, 49)).toBe(expectedHour);
    }

    expect(deriveAutonomousEventHour(chapterStart, Date.UTC(2026, 8, 10, 12), 1)).toBe(34);
  });

  it("resolves one explicit legacy reference across all schedule rows", () => {
    const chapterStart = Date.UTC(2026, 8, 9, 3);
    const reference = scheduleTimeReferenceFromLegacy(chapterStart, [null, 50, 49, 193]);

    expect(reference).toBeDefined();
    expect(scheduleTimeReferenceMetadataFrom(reference!)).toEqual({
      kind: "chapter-start",
      instantEpochMs: chapterStart,
      hour: 49,
    });
  });

  it.effect("derives autonomous hours from the event-global first hour", () =>
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
      const eventStart = Date.UTC(2026, 3, 1, 12);

      const result = yield* runService<AutonomousSweepResult>(
        (service) => service.sweepAutoCheckin(eventStart + 9 * scheduledHourMillis),
        {
          conversations: [
            conversation("conversation-main", "main"),
            conversation("conversation-side", "side"),
          ],
          enqueuer,
          eventStartEpochMs: eventStart,
          firstEventHour: 49,
        },
      );

      expect(result.acceptedInvocationCount).toBe(2);
      expect(
        calls
          .map(({ input }) => input)
          .sort((left, right) =>
            (left.conversationName ?? "").localeCompare(right.conversationName ?? ""),
          ),
      ).toEqual([
        { workspaceId: "workspace-1", conversationName: "main", hour: 59 },
        { workspaceId: "workspace-1", conversationName: "side", hour: 59 },
      ]);
    }),
  );

  it.effect("sweeps the recorded chapter configuration at event-wide hour 82", () =>
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
      const chapterStart = Date.UTC(2026, 8, 9, 3);
      const target = Date.UTC(2026, 8, 10, 12);

      yield* runService<AutonomousSweepResult>(
        (service) => service.sweepAutoCheckin(target - scheduledHourMillis),
        {
          conversations: [conversation("conversation-main", "main")],
          enqueuer,
          eventStartEpochMs: chapterStart,
          firstEventHour: 49,
        },
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toEqual({
        workspaceId: "workspace-1",
        conversationName: "main",
        hour: 82,
      });
    }),
  );

  it.effect("uses an established reference without rereading legacy timing rows", () =>
    Effect.gen(function* () {
      const calls: Array<Parameters<AutonomousWorkflowEnqueuerShape["enqueueCheckinsOpen"]>[0]> =
        [];
      let legacyTimingRowsReads = 0;
      let eventStartReads = 0;
      const enqueuer = {
        enqueueCheckinsOpen: (request: (typeof calls)[number]) =>
          Effect.sync(() => {
            calls.push(request);
          }),
        enqueueMembersKick: () => Effect.void,
      } as typeof AutonomousWorkflowEnqueuer.Service;
      const chapterStart = Date.UTC(2026, 8, 9, 3);
      const target = Date.UTC(2026, 8, 10, 12);

      yield* runService<AutonomousSweepResult>(
        (service) => service.sweepAutoCheckin(target - scheduledHourMillis),
        {
          conversations: [conversation("conversation-main", "main")],
          enqueuer,
          eventStartEpochMs: chapterStart,
          scheduleTimeReference: {
            kind: "chapter-start",
            instantEpochMs: chapterStart,
            hour: 49,
          },
          onLegacyTimingRowsRead: () => {
            legacyTimingRowsReads += 1;
          },
          onEventStartRead: () => {
            eventStartReads += 1;
          },
        },
      );

      expect(calls[0]?.input).toMatchObject({
        workspaceId: "workspace-1",
        conversationName: "main",
        hour: 82,
      });
      expect(legacyTimingRowsReads).toBe(0);
      expect(eventStartReads).toBe(1);
    }),
  );

  it.effect("keeps legacy event identity separate from an established timing reference", () =>
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
      const chapterStart = Date.UTC(2026, 8, 9, 3);
      const eventA = Date.UTC(2026, 8, 7, 3);
      const eventB = Date.UTC(2026, 8, 8, 3);
      const run = (eventStartEpochMs: number) =>
        runService<AutonomousSweepResult>(
          (service) => service.sweepAutoCheckin(chapterStart - scheduledHourMillis),
          {
            conversations: [conversation("conversation-main", "main")],
            enqueuer,
            eventStartEpochMs,
            scheduleTimeReference: {
              kind: "chapter-start",
              instantEpochMs: chapterStart,
              hour: 49,
            },
          },
        );

      yield* run(eventA);
      yield* run(eventB);
      yield* run(eventA);

      expect(calls).toHaveLength(3);
      expect(calls[0]?.input.hour).toBe(49);
      expect(calls[1]?.input.hour).toBe(49);
      expect(calls[2]?.input.hour).toBe(49);
      expect(calls[0]?.invocationId).not.toBe(calls[1]?.invocationId);
      expect(calls[0]?.invocationId).toBe(calls[2]?.invocationId);
    }),
  );

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
          firstEventHour: 1,
        },
      );
      const firstIds = calls.map(({ invocationId }) => invocationId);
      const second = yield* runService<AutonomousSweepResult>(
        (service) => service.sweepAutoCheckin(bucket),
        {
          conversations,
          enqueuer,
          firstEventHour: 1,
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
          firstEventHour: 1,
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
          firstEventHour: 1,
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
            firstEventHour: 1,
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
          firstEventHour: 1,
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
