import {
  Cause,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  Semaphore,
} from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { ServicePrincipal, type ActorProvenance } from "sheet-auth/identity";
import { CheckinsOpen, MembersKick, WorkspaceId } from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { config } from "@/config";
import {
  resolveAuthoritativeSheetConfigurationForWorkspace,
  type AuthoritativeSheetConfiguration,
} from "./authoritativeSheetConfiguration";
import {
  AutoCheckinSweepWorkflow,
  AutoRoleCleanupSweepWorkflow,
  canonicalScheduledHourBucket,
  scheduledHourMillis,
  type AutonomousSweepResult,
} from "@/workflows/autoCheckinContract";
import { makeCheckinsOpenAutonomousInvocationId } from "@/workflows/checkins/keys";
import { makeMemberKickAutonomousInvocationId } from "@/workflows/members/keys";
import {
  autonomousTriggerProviderLayer,
  AutonomousTriggerProvider,
} from "@/workflows/autonomous/provider";
import { AutonomousWorkflowEnqueuer } from "./autonomousWorkflowEnqueuer";

const hourMillis = scheduledHourMillis;
const autonomousProviderTimeout = Duration.seconds(30);

class AutonomousTriggerError extends Data.TaggedError("AutonomousTriggerError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const deriveAutonomousEventHour = (
  eventStartEpochMs: number,
  targetHourBucketEpochMs: number,
): number => {
  if (!Number.isFinite(eventStartEpochMs) || !Number.isFinite(targetHourBucketEpochMs)) {
    throw new RangeError("event start and target hour must be finite");
  }
  return Math.floor((targetHourBucketEpochMs - eventStartEpochMs) / hourMillis) + 1;
};

export const deriveAutomaticRoleCleanupHour = (
  eventStartEpochMs: number,
  targetHourBucketEpochMs: number,
): number => Math.max(0, deriveAutonomousEventHour(eventStartEpochMs, targetHourBucketEpochMs));

const isRunningConversation = (conversation: {
  readonly running: boolean | null;
}): conversation is { readonly running: true } => Predicate.isTruthy(conversation.running);

const hasNonEmptyConversationName = (conversation: {
  readonly name: string | null;
}): conversation is { readonly name: string } =>
  Predicate.isString(conversation.name) && conversation.name.length > 0;

const uniqueRunningConversationNames = (
  conversations: ReadonlyArray<{
    readonly running: boolean | null;
    readonly name: string | null;
  }>,
): ReadonlyArray<string> => {
  const names: Array<string> = [];
  const seen = new Set<string>();
  for (const conversation of conversations) {
    if (
      !isRunningConversation(conversation) ||
      !hasNonEmptyConversationName(conversation) ||
      seen.has(conversation.name)
    ) {
      continue;
    }
    seen.add(conversation.name);
    names.push(conversation.name);
  }
  return names;
};

type WorkspaceConversation = Effect.Success<
  ReturnType<TrustedSheetPersistence["Service"]["workspaces"]["getWorkspaceConversations"]>
>[number];

type AutoCheckinWorkspace = Effect.Success<
  ReturnType<TrustedSheetPersistence["Service"]["workspaces"]["getAutoCheckinWorkspaces"]>
>[number];

interface AutonomousTriggerServiceShape {
  readonly sweepAutoCheckin: (
    scheduledHourBucketEpochMs: number,
  ) => Effect.Effect<AutonomousSweepResult, unknown>;
  readonly sweepAutoRoleCleanup: (
    scheduledHourBucketEpochMs: number,
  ) => Effect.Effect<AutonomousSweepResult, unknown>;
}

const servicePrincipal = (serviceId: string, oauthClientId: string) =>
  Schema.decodeUnknownSync(ServicePrincipal)({
    kind: "service",
    serviceId,
    oauthClientId,
  });

const actorProvenance = (
  principal: typeof ServicePrincipal.Type,
  jobKind: string,
): ActorProvenance => ({
  actorServiceId: principal.serviceId,
  jobKind,
});

const requireActiveConfiguration = (
  persistence: TrustedSheetPersistence["Service"],
  workspaceId: WorkspaceId,
  workspace: AutoCheckinWorkspace,
): Effect.Effect<AuthoritativeSheetConfiguration, AutonomousTriggerError> =>
  resolveAuthoritativeSheetConfigurationForWorkspace(
    persistence,
    workspaceId,
    Option.some(workspace),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new AutonomousTriggerError({
          operation: "resolve-spreadsheet",
          message: `Workspace ${workspaceId} Sheet Configuration resolution failed during ${cause.operation}`,
          cause: cause.cause,
        }),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new AutonomousTriggerError({
              operation: "resolve-spreadsheet",
              message: `Workspace ${workspaceId} has no configured spreadsheet`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

const managedConversations = (
  conversations: ReadonlyArray<WorkspaceConversation>,
): ReadonlyArray<WorkspaceConversation> =>
  conversations.filter(
    (conversation) =>
      isRunningConversation(conversation) &&
      Predicate.isNotNull(conversation.roleId) &&
      hasNonEmptyConversationName(conversation),
  );

const recoverNonInterruptingSweepFailure = (
  message: string,
  attributes: Readonly<Record<string, unknown>>,
  cause: Cause.Cause<unknown>,
) =>
  Cause.hasInterrupts(cause)
    ? Effect.failCause(cause)
    : Effect.logWarning(message).pipe(Effect.annotateLogs({ ...attributes, cause }), Effect.as(0));

interface AutonomousTriggerWorkflowClientShape {
  readonly enqueueAutoCheckinSweep: (scheduledHourBucketEpochMs: number) => Effect.Effect<string>;
  readonly enqueueAutoRoleCleanupSweep: (
    scheduledHourBucketEpochMs: number,
  ) => Effect.Effect<string>;
}

export class AutonomousTriggerWorkflowClient extends Context.Service<
  AutonomousTriggerWorkflowClient,
  AutonomousTriggerWorkflowClientShape
>()("sheet-workflows/AutonomousTriggerWorkflowClient", {
  make: Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    return {
      enqueueAutoCheckinSweep: (scheduledHourBucketEpochMs: number) =>
        AutoCheckinSweepWorkflow.execute({ scheduledHourBucketEpochMs }, { discard: true }).pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
          Effect.withSpan("AutonomousTriggerWorkflowClient.enqueueAutoCheckinSweep", {
            attributes: { scheduledHourBucketEpochMs },
          }),
        ),
      enqueueAutoRoleCleanupSweep: (scheduledHourBucketEpochMs: number) =>
        AutoRoleCleanupSweepWorkflow.execute(
          { scheduledHourBucketEpochMs },
          { discard: true },
        ).pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
          Effect.withSpan("AutonomousTriggerWorkflowClient.enqueueAutoRoleCleanupSweep", {
            attributes: { scheduledHourBucketEpochMs },
          }),
        ),
    };
  }),
}) {
  static layer = Layer.effect(AutonomousTriggerWorkflowClient, this.make);
}

export class AutonomousTriggerService extends Context.Service<
  AutonomousTriggerService,
  AutonomousTriggerServiceShape
>()("sheet-workflows/AutonomousTriggerService", {
  make: Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* AutonomousTriggerProvider;
    const enqueuer = yield* AutonomousWorkflowEnqueuer;
    const autoCheckinConcurrency = yield* config.autoCheckinConcurrency;
    const autoCheckinEnqueueSemaphore = yield* Semaphore.make(autoCheckinConcurrency);
    const botClientId = yield* config.sheetBotClientId;
    const autoCheckinServiceId = yield* config.sheetAutoCheckinServiceId;
    const autoCheckinOAuthClientId = yield* config.sheetAutoCheckinOAuthClientId;
    const autoRoleCleanupServiceId = yield* config.sheetAutoRoleCleanupServiceId;
    const autoRoleCleanupOAuthClientId = yield* config.sheetAuthOAuthClientId;

    const checkinPrincipal = servicePrincipal(autoCheckinServiceId, autoCheckinOAuthClientId);
    const checkinActor = actorProvenance(checkinPrincipal, "auto-checkin-sweep");
    const roleCleanupPrincipal = servicePrincipal(
      autoRoleCleanupServiceId,
      autoRoleCleanupOAuthClientId,
    );
    const roleCleanupActor = actorProvenance(roleCleanupPrincipal, "auto-role-cleanup-sweep");

    const sweepAutoCheckin = Effect.fn("AutonomousTriggerService.sweepAutoCheckin")(function* (
      scheduledHourBucketEpochMs: number,
    ) {
      const bucket = canonicalScheduledHourBucket(scheduledHourBucketEpochMs);
      const targetHourBucket = bucket + hourMillis;
      const workspaces = yield* persistence.workspaces.getAutoCheckinWorkspaces({});
      const counts = yield* Effect.forEach(
        workspaces,
        (workspace) =>
          Effect.gen(function* () {
            const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(
              workspace.workspaceId,
            );
            const active = yield* requireActiveConfiguration(persistence, workspaceId, workspace);
            const eventStartEpochMs = yield* provider
              .loadEventStart(active.spreadsheetId, active.configuration)
              .pipe(Effect.timeout(autonomousProviderTimeout));
            const hour = deriveAutonomousEventHour(eventStartEpochMs, targetHourBucket);
            const conversations = yield* persistence.workspaces.getWorkspaceConversations({
              workspaceId,
              running: true,
            });
            const names = uniqueRunningConversationNames(conversations);
            const accepted = yield* Effect.forEach(
              names,
              (conversationName) => {
                const invocationId = makeCheckinsOpenAutonomousInvocationId({
                  workspaceId,
                  eventStartEpochMs,
                  hour,
                  conversationName,
                });
                return autoCheckinEnqueueSemaphore
                  .withPermit(
                    enqueuer.enqueueCheckinsOpen({
                      invocationId,
                      input: {
                        workspaceId,
                        conversationName,
                        hour,
                      } satisfies typeof CheckinsOpen.input.Type,
                      principal: checkinPrincipal,
                      actorProvenance: checkinActor,
                    }),
                  )
                  .pipe(
                    Effect.as(1),
                    Effect.catchCause((cause) =>
                      recoverNonInterruptingSweepFailure(
                        "auto check-in enqueue failed",
                        { conversationName },
                        cause,
                      ),
                    ),
                  );
              },
              { concurrency: "unbounded" },
            );
            return accepted.reduce((total, count) => total + count, 0);
          }).pipe(
            Effect.catchCause((cause) =>
              recoverNonInterruptingSweepFailure(
                "auto check-in workspace sweep failed",
                { workspaceId: workspace.workspaceId },
                cause,
              ),
            ),
          ),
        { concurrency: autoCheckinConcurrency },
      );
      return {
        scheduledHourBucketEpochMs: bucket,
        acceptedInvocationCount: counts.reduce((total, count) => total + count, 0),
      } satisfies AutonomousSweepResult;
    });

    const sweepAutoRoleCleanup = Effect.fn("AutonomousTriggerService.sweepAutoRoleCleanup")(
      function* (scheduledHourBucketEpochMs: number) {
        const bucket = canonicalScheduledHourBucket(scheduledHourBucketEpochMs);
        const workspaces = yield* persistence.workspaces.getAutoCheckinWorkspaces({});
        const counts = yield* Effect.forEach(
          workspaces,
          (workspace) =>
            Effect.gen(function* () {
              const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(
                workspace.workspaceId,
              );
              const active = yield* requireActiveConfiguration(persistence, workspaceId, workspace);
              const eventStartEpochMs = yield* provider
                .loadEventStart(active.spreadsheetId, active.configuration)
                .pipe(Effect.timeout(autonomousProviderTimeout));
              const hour = deriveAutomaticRoleCleanupHour(eventStartEpochMs, bucket);
              const conversations = yield* persistence.workspaces.getWorkspaceConversations({
                workspaceId,
                running: true,
              });
              const managed = managedConversations(conversations);
              const accepted = yield* Effect.forEach(
                managed,
                (conversation) => {
                  const invocationId = makeMemberKickAutonomousInvocationId(
                    bucket,
                    botClientId,
                    workspaceId,
                    conversation.conversationId,
                    hour,
                  );
                  return enqueuer
                    .enqueueMembersKick({
                      invocationId,
                      input: {
                        workspaceId,
                        conversationId: conversation.conversationId,
                        hour,
                      } satisfies typeof MembersKick.input.Type,
                      principal: roleCleanupPrincipal,
                      actorProvenance: roleCleanupActor,
                      acceptedAt: bucket,
                    })
                    .pipe(
                      Effect.as(1),
                      Effect.catchCause((cause) =>
                        recoverNonInterruptingSweepFailure(
                          "auto role-cleanup enqueue failed",
                          {
                            conversationId: conversation.conversationId,
                            workspaceId,
                          },
                          cause,
                        ),
                      ),
                    );
                },
                { concurrency: 1 },
              );
              return accepted.reduce((total, count) => total + count, 0);
            }).pipe(
              Effect.catchCause((cause) =>
                recoverNonInterruptingSweepFailure(
                  "auto role-cleanup workspace sweep failed",
                  { workspaceId: workspace.workspaceId },
                  cause,
                ),
              ),
            ),
          { concurrency: 1 },
        );
        return {
          scheduledHourBucketEpochMs: bucket,
          acceptedInvocationCount: counts.reduce((total, count) => total + count, 0),
        } satisfies AutonomousSweepResult;
      },
    );

    return { sweepAutoCheckin, sweepAutoRoleCleanup };
  }),
}) {
  static layer = Layer.effect(AutonomousTriggerService, this.make).pipe(
    Layer.provide(autonomousTriggerProviderLayer),
    Layer.provide(AutonomousWorkflowEnqueuer.layer),
  );
}
