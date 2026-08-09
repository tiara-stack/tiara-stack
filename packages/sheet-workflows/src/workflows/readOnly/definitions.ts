import { Cause, Effect, Layer, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import {
  actionContextSqlLayer,
  makeAction,
  type WorkflowDefinition,
  type WorkflowJson,
} from "effect-zero-workflow";
import {
  InvocationId,
  workflowContractKey,
  type AnyWorkflowContract,
} from "effect-zero-workflow/contract";
import { WorkflowInvocationUnauthorized } from "effect-zero-workflow/contract/transport";
import { ActorProvenance, EffectivePrincipal } from "sheet-auth/identity";
import {
  AuthorizationLoadWorkspaceCapabilities,
  DiscordLoadProfile,
  DiscordLoadWorkspaceChannels,
  DiscordLoadWorkspaceRoles,
  NotificationsLoadSupportedClients,
  SchedulesLoadWorkspace,
  DataAcquisitionDeclaredFailure,
} from "sheet-workflow-contracts";
import { ReadOnlyWorkflowAuthorization } from "./authorization";
import { readOnlySheetWorkflowDefinitionVersion } from "./catalog";
import { ReadOnlyWorkflowDataSource } from "./dataSource";

const workflowContractExecutionSchema = <Contract extends AnyWorkflowContract>(
  contract: Contract,
) =>
  Schema.Struct({
    invocationId: InvocationId,
    input: contract.input,
    principal: EffectivePrincipal,
    actorProvenance: Schema.optional(ActorProvenance),
  });

type ReadOnlyExecution<Contract extends AnyWorkflowContract> = {
  readonly invocationId: typeof InvocationId.Type;
  readonly input: Contract["input"]["Type"];
  readonly principal: typeof EffectivePrincipal.Type;
  readonly actorProvenance?: typeof ActorProvenance.Type | undefined;
};

const preserveDeclaredFailure = <A>(
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, DataAcquisitionDeclaredFailure> =>
  effect.pipe(
    Effect.catch((error) =>
      Schema.is(DataAcquisitionDeclaredFailure)(error) ? Effect.fail(error) : Effect.die(error),
    ),
  );

const authorizationFailure = (contract: AnyWorkflowContract): DataAcquisitionDeclaredFailure => ({
  _tag: "AuthorizationRevoked",
  policy: contract.authorizationPolicy.policy,
});

const makeDefinition = <Contract extends AnyWorkflowContract>(
  contract: Contract,
  read: (
    dataSource: ReadOnlyWorkflowDataSource["Service"],
    payload: ReadOnlyExecution<Contract>,
  ) => Effect.Effect<Contract["success"]["Type"], unknown>,
) => {
  const name = workflowContractKey(contract);
  const payload = workflowContractExecutionSchema(contract);
  const action = makeAction({
    name: `${name}.read`,
    version: readOnlySheetWorkflowDefinitionVersion,
    shardGroup: "dispatch",
    input: payload,
    success: contract.success,
    error: contract.declaredFailure,
    idempotencyKey: ({ invocationId }) => invocationId,
    execute: (execution) =>
      Effect.gen(function* () {
        const authorization = yield* ReadOnlyWorkflowAuthorization;
        const dataSource = yield* ReadOnlyWorkflowDataSource;
        const input = yield* Schema.decodeUnknownEffect(contract.input)(execution.input);
        yield* authorization
          .authorize(contract, execution.principal, input)
          .pipe(
            Effect.mapError((error) =>
              Schema.is(WorkflowInvocationUnauthorized)(error)
                ? authorizationFailure(contract)
                : error,
            ),
          );
        return yield* preserveDeclaredFailure(
          read(dataSource, { ...execution, input } as ReadOnlyExecution<Contract>),
        );
      }),
  });
  const workflow = Workflow.make({
    name,
    payload,
    success: contract.success,
    error: contract.declaredFailure,
    idempotencyKey: ({ invocationId }) => invocationId,
  }).annotate(ClusterSchema.ShardGroup, () => "dispatch");
  const workflowLayer = workflow.toLayer((execution) => action.await(execution));
  return { action, contract, workflow, workflowLayer };
};

const DiscordLoadProfileDefinition = makeDefinition(
  DiscordLoadProfile,
  (dataSource, { principal }) => dataSource.loadProfile(principal),
);

const DiscordLoadWorkspaceChannelsDefinition = makeDefinition(
  DiscordLoadWorkspaceChannels,
  (dataSource, { input }) => dataSource.loadWorkspaceChannels(input.workspaceId),
);

const DiscordLoadWorkspaceRolesDefinition = makeDefinition(
  DiscordLoadWorkspaceRoles,
  (dataSource, { input }) => dataSource.loadWorkspaceRoles(input.workspaceId),
);

const AuthorizationLoadWorkspaceCapabilitiesDefinition = makeDefinition(
  AuthorizationLoadWorkspaceCapabilities,
  (dataSource, { input, principal }) =>
    dataSource.loadWorkspaceCapabilities(principal, input.workspaceId),
);

const SchedulesLoadWorkspaceDefinition = makeDefinition(
  SchedulesLoadWorkspace,
  (dataSource, { input }) => dataSource.loadWorkspaceSchedules(input.workspaceId),
);

const NotificationsLoadSupportedClientsDefinition = makeDefinition(
  NotificationsLoadSupportedClients,
  (dataSource, { input }) => dataSource.loadSupportedClients(input.platform),
);

export const ReadOnlySheetWorkflowDefinitions = Object.freeze([
  DiscordLoadProfileDefinition,
  DiscordLoadWorkspaceChannelsDefinition,
  DiscordLoadWorkspaceRolesDefinition,
  AuthorizationLoadWorkspaceCapabilitiesDefinition,
  SchedulesLoadWorkspaceDefinition,
  NotificationsLoadSupportedClientsDefinition,
]);

export const ReadOnlySheetWorkflows = Object.freeze(
  ReadOnlySheetWorkflowDefinitions.map(({ workflow }) => workflow as WorkflowDefinition),
);

const readOnlySheetWorkflowNames = new Set(ReadOnlySheetWorkflows.map(({ name }) => name));

export const isReadOnlySheetWorkflowName = (name: string): boolean =>
  readOnlySheetWorkflowNames.has(name);

export const readOnlySheetWorkflowLayers = Layer.mergeAll(
  DiscordLoadProfileDefinition.action.toLayer(),
  DiscordLoadProfileDefinition.workflowLayer,
  DiscordLoadWorkspaceChannelsDefinition.action.toLayer(),
  DiscordLoadWorkspaceChannelsDefinition.workflowLayer,
  DiscordLoadWorkspaceRolesDefinition.action.toLayer(),
  DiscordLoadWorkspaceRolesDefinition.workflowLayer,
  AuthorizationLoadWorkspaceCapabilitiesDefinition.action.toLayer(),
  AuthorizationLoadWorkspaceCapabilitiesDefinition.workflowLayer,
  SchedulesLoadWorkspaceDefinition.action.toLayer(),
  SchedulesLoadWorkspaceDefinition.workflowLayer,
  NotificationsLoadSupportedClientsDefinition.action.toLayer(),
  NotificationsLoadSupportedClientsDefinition.workflowLayer,
).pipe(Layer.provide(actionContextSqlLayer));

const declaredFailureFromCause = (
  cause: Cause.Cause<unknown>,
): DataAcquisitionDeclaredFailure | undefined => {
  const reason = cause.reasons.find(Cause.isFailReason);
  return Predicate.isNotUndefined(reason) && Schema.is(DataAcquisitionDeclaredFailure)(reason.error)
    ? reason.error
    : undefined;
};

export const materializeReadOnlyWorkflowFailure = (
  _workflow: WorkflowDefinition,
  cause: Cause.Cause<unknown>,
): WorkflowJson => {
  const declared = declaredFailureFromCause(cause);
  return Schema.decodeUnknownSync(Schema.Json)(
    Predicate.isNotUndefined(declared)
      ? { _tag: "Declared", error: declared }
      : { _tag: "System", code: "UnexpectedFailure", retryable: false },
  );
};
