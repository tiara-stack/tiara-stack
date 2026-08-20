import { Data, Duration, Effect, Predicate, Schedule, Schema } from "effect";
import { ClusterError, ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  AutonomousDeclaredFailure,
  InteractiveDeclaredFailure,
  TeamSubmissionsDecide,
  TeamSubmissionsProcess,
} from "sheet-workflow-contracts";
import { TeamSubmissionsEntity } from "@/entities/teamSubmissions";
import { interactiveExternalOperationRejected } from "../shared/interactive";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";
import { makeTeamSubmissionsSerializationKey } from "./keys";
import { TeamSubmissionsDecideExecution, TeamSubmissionsProcessExecution } from "./schema";

const processName = workflowContractKey(TeamSubmissionsProcess);
const decideName = workflowContractKey(TeamSubmissionsDecide);
const teamSubmissionsEntityRetrySchedule = Schedule.exponential("500 millis").pipe(
  Schedule.jittered,
);
const teamSubmissionsEntityRetryTimes = 5;
const teamSubmissionsEntityTimeout = Duration.seconds(30);
// Keep retries bounded before the surrounding workflow step deadline and leave time for failure
// materialization and delivery.
const teamSubmissionsEntityRetryDeadline = Duration.minutes(4);

const RetryableTeamSubmissionsClusterError = Schema.Union([
  ClusterError.EntityNotAssignedToRunner,
  ClusterError.RunnerNotRegistered,
  ClusterError.RunnerUnavailable,
  ClusterError.MailboxFull,
  ClusterError.AlreadyProcessingMessage,
  ClusterError.PersistenceError,
]);
const isRetryableTeamSubmissionsClusterError = Schema.is(RetryableTeamSubmissionsClusterError);
const isRetryableTeamSubmissionsEntityError = (error: unknown): boolean =>
  isRetryableTeamSubmissionsClusterError(error) ||
  Predicate.isTagged("TeamSubmissionsEntityTimeout")(error);
const isAutonomousDeclaredFailure = Schema.is(AutonomousDeclaredFailure);
const isInteractiveDeclaredFailure = Schema.is(InteractiveDeclaredFailure);

class TeamSubmissionsEntityTimeout extends Data.TaggedError("TeamSubmissionsEntityTimeout")<{
  readonly operation: "process" | "decide";
}> {}

const entityUnavailable = () =>
  interactiveExternalOperationRejected(
    "teamSubmissions.entity",
    "EntityUnavailable",
    "The team-submission workflow entity was unavailable",
  );

const mapProcessEntityFailure = (error: unknown): typeof AutonomousDeclaredFailure.Type =>
  isAutonomousDeclaredFailure(error) ? error : entityUnavailable();

const mapDecideEntityFailure = (error: unknown): typeof InteractiveDeclaredFailure.Type =>
  isInteractiveDeclaredFailure(error) ? error : entityUnavailable();

const runThroughTeamSubmissionsEntity = <
  EntityClient,
  Success,
  Failure,
  EntityRequirements,
  InvocationRequirements,
>({
  entityClient,
  serializationKey,
  operation,
  invoke,
  mapError,
}: {
  readonly entityClient: Effect.Effect<EntityClient, unknown, EntityRequirements>;
  readonly serializationKey: string;
  readonly operation: "process" | "decide";
  readonly invoke: (
    entity: EntityClient,
    serializationKey: string,
  ) => Effect.Effect<Success, unknown, InvocationRequirements>;
  readonly mapError: (error: unknown) => Failure;
}) =>
  Effect.gen(function* () {
    const entity = yield* entityClient;
    return yield* invoke(entity, serializationKey).pipe(
      Effect.timeoutOrElse({
        duration: teamSubmissionsEntityTimeout,
        orElse: () => Effect.fail(new TeamSubmissionsEntityTimeout({ operation })),
      }),
    );
  }).pipe(
    Effect.retry({
      schedule: teamSubmissionsEntityRetrySchedule,
      times: teamSubmissionsEntityRetryTimes,
      while: isRetryableTeamSubmissionsEntityError,
    }),
    Effect.timeoutOrElse({
      duration: teamSubmissionsEntityRetryDeadline,
      orElse: () => Effect.fail(new TeamSubmissionsEntityTimeout({ operation })),
    }),
    Effect.mapError(mapError),
  );

const TeamSubmissionsProcessWorkflow = Workflow.make({
  name: processName,
  payload: TeamSubmissionsProcessExecution,
  success: TeamSubmissionsProcess.success,
  error: AutonomousDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const TeamSubmissionsDecideWorkflow = Workflow.make({
  name: decideName,
  payload: TeamSubmissionsDecideExecution,
  success: TeamSubmissionsDecide.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const runProcessThroughEntity = (execution: typeof TeamSubmissionsProcessExecution.Type) =>
  Effect.gen(function* () {
    const input = yield* decodeWorkflowContractInputOrDie(TeamSubmissionsProcess, execution.input);
    const serializationKey = makeTeamSubmissionsSerializationKey(input.sourceMessage);
    return yield* runThroughTeamSubmissionsEntity({
      entityClient: TeamSubmissionsEntity.client,
      serializationKey,
      operation: "process",
      invoke: (entity, key) => entity(key).process(execution),
      mapError: mapProcessEntityFailure,
    });
  });

const runDecideThroughEntity = (execution: typeof TeamSubmissionsDecideExecution.Type) =>
  Effect.gen(function* () {
    const input = yield* decodeWorkflowContractInputOrDie(TeamSubmissionsDecide, execution.input);
    const serializationKey = makeTeamSubmissionsSerializationKey(input.sourceMessage);
    return yield* runThroughTeamSubmissionsEntity({
      entityClient: TeamSubmissionsEntity.client,
      serializationKey,
      operation: "decide",
      invoke: (entity, key) => entity(key).decide(execution),
      mapError: mapDecideEntityFailure,
    });
  });

export const makeTeamSubmissionsProcessDefinition = () => ({
  contract: TeamSubmissionsProcess,
  workflow: TeamSubmissionsProcessWorkflow,
  actions: [] as const,
  workflowLayer: TeamSubmissionsProcessWorkflow.toLayer((execution) =>
    runProcessThroughEntity(execution),
  ),
});

export const makeTeamSubmissionsDecideDefinition = () => ({
  contract: TeamSubmissionsDecide,
  workflow: TeamSubmissionsDecideWorkflow,
  actions: [] as const,
  workflowLayer: TeamSubmissionsDecideWorkflow.toLayer((execution) =>
    runDecideThroughEntity(execution),
  ),
});
