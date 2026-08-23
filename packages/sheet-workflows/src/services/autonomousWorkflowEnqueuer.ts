import { Context, Duration, Effect, Layer, Predicate, Schedule, Schema } from "effect";
import { SqlError } from "effect/unstable/sql";
import { WorkflowStore, type WorkflowDefinition } from "effect-zero-workflow";
import { InvocationId } from "effect-zero-workflow/contract";
import type { ActorProvenance, EffectivePrincipal } from "sheet-auth/identity";
import { CheckinsOpen, MembersKick } from "sheet-workflow-contracts";
import {
  ownerKeyForEffectivePrincipal,
  ReadOnlyWorkflowAuthorization,
} from "@/workflows/readOnly/authorization";
import { CheckinsOpenWorkflow } from "@/workflows/checkins/openDefinition";
import { checkinSheetWorkflowDefinitionVersion } from "@/workflows/checkins/catalog";
import { MembersKickWorkflow } from "@/workflows/members/definition";
import { memberSheetWorkflowDefinitionVersion } from "@/workflows/members/catalog";

const checkinsOpenWorkflow = CheckinsOpenWorkflow;
const membersKickWorkflow = MembersKickWorkflow;

const acceptanceRetrySchedule = Schedule.exponential(Duration.millis(100)).pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(2)),
);

const isRetryableAcceptanceFailure = (error: unknown) =>
  SqlError.isSqlError(error) &&
  !Predicate.isTagged("UniqueViolation")(error.reason) &&
  error.isRetryable;

const isUniqueViolation = (error: unknown) =>
  SqlError.isSqlError(error) && Predicate.isTagged("UniqueViolation")(error.reason);

// The service-owned enqueue boundary must encode the payload before handing it to the generic store.
// fallow-ignore-next-line code-duplication
const encodeWorkflowPayload = (workflow: WorkflowDefinition, payload: unknown) =>
  Schema.encodeUnknownEffect(workflow.payloadSchema)(payload).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
  );

type WorkflowPayload<TWorkflow extends WorkflowDefinition> = Schema.Schema.Type<
  TWorkflow["payloadSchema"]
>;

const enqueueWorkflow = <TWorkflow extends WorkflowDefinition>(options: {
  readonly store: typeof WorkflowStore.Service;
  readonly workflow: TWorkflow;
  readonly definitionVersion: string;
  readonly invocationId: typeof InvocationId.Type;
  readonly principal: EffectivePrincipal;
  readonly payload: WorkflowPayload<TWorkflow>;
}) =>
  Effect.gen(function* () {
    const executionId = yield* options.workflow.executionId(options.payload);
    const payload = yield* encodeWorkflowPayload(options.workflow, options.payload);
    const principal = yield* Schema.decodeUnknownEffect(Schema.Json)(options.principal);
    const input = {
      runId: options.invocationId,
      workflowName: options.workflow.name,
      definitionVersion: options.definitionVersion,
      executionId,
      idempotencyKey: executionId,
      visibilityKey: ownerKeyForEffectivePrincipal(options.principal),
      principal,
      payload,
    } as const;
    yield* options.store.enqueue(input).pipe(
      Effect.retry({
        schedule: acceptanceRetrySchedule,
        while: isRetryableAcceptanceFailure,
      }),
      Effect.catch((error) =>
        isUniqueViolation(error)
          ? options.store
              .getRun(input.runId)
              .pipe(
                Effect.flatMap((run) =>
                  !Predicate.isUndefined(run) &&
                  run.workflowName === input.workflowName &&
                  run.definitionVersion === input.definitionVersion &&
                  run.executionId === input.executionId
                    ? Effect.void
                    : Effect.fail(error),
                ),
              )
          : Effect.fail(error),
      ),
    );
  });

export interface AutonomousWorkflowEnqueuerShape {
  readonly enqueueCheckinsOpen: (request: {
    readonly invocationId: typeof InvocationId.Type;
    readonly input: typeof CheckinsOpen.input.Type;
    readonly principal: EffectivePrincipal;
    readonly actorProvenance?: ActorProvenance | undefined;
  }) => Effect.Effect<void, unknown>;
  readonly enqueueMembersKick: (request: {
    readonly invocationId: typeof InvocationId.Type;
    readonly input: typeof MembersKick.input.Type;
    readonly principal: EffectivePrincipal;
    readonly actorProvenance?: ActorProvenance | undefined;
    readonly acceptedAt: number;
  }) => Effect.Effect<void, unknown>;
}

export class AutonomousWorkflowEnqueuer extends Context.Service<
  AutonomousWorkflowEnqueuer,
  AutonomousWorkflowEnqueuerShape
>()("sheet-workflows/AutonomousWorkflowEnqueuer", {
  make: Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const authorization = yield* ReadOnlyWorkflowAuthorization;

    const enqueueCheckinsOpen: AutonomousWorkflowEnqueuerShape["enqueueCheckinsOpen"] = (request) =>
      authorization.authorize(CheckinsOpen, request.principal, request.input).pipe(
        Effect.andThen(
          enqueueWorkflow({
            store,
            workflow: checkinsOpenWorkflow,
            definitionVersion: checkinSheetWorkflowDefinitionVersion,
            invocationId: request.invocationId,
            principal: request.principal,
            payload: {
              invocationId: request.invocationId,
              input: request.input,
              principal: request.principal,
              ...(request.actorProvenance === undefined
                ? {}
                : { actorProvenance: request.actorProvenance }),
            },
          }),
        ),
        Effect.asVoid,
      );

    const enqueueMembersKick: AutonomousWorkflowEnqueuerShape["enqueueMembersKick"] = (request) =>
      authorization.authorize(MembersKick, request.principal, request.input).pipe(
        Effect.andThen(
          enqueueWorkflow({
            store,
            workflow: membersKickWorkflow,
            definitionVersion: memberSheetWorkflowDefinitionVersion,
            invocationId: request.invocationId,
            principal: request.principal,
            payload: {
              invocationId: request.invocationId,
              input: request.input,
              principal: request.principal,
              acceptedAt: request.acceptedAt,
              ...(request.actorProvenance === undefined
                ? {}
                : { actorProvenance: request.actorProvenance }),
            },
          }),
        ),
        Effect.asVoid,
      );

    return { enqueueCheckinsOpen, enqueueMembersKick };
  }),
}) {
  static layer = Layer.effect(AutonomousWorkflowEnqueuer, this.make);
}
