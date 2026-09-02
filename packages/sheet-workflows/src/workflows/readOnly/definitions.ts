import { Cause, Effect, Layer, Schema } from "effect";
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
  SheetsDescribe,
  SheetsReadSnapshot,
} from "sheet-workflow-contracts";
import { ReadOnlyWorkflowAuthorization } from "./authorization";
import { readOnlySheetWorkflowDefinitionVersion } from "./catalog";
import { ReadOnlyWorkflowDataSource } from "./dataSource";
import { workflowContractExecutionSchema } from "../shared/execution";
import { materializeWorkflowFailure } from "../shared/failure";

type ReadOnlyExecution<Contract extends AnyWorkflowContract> = {
  readonly invocationId: typeof InvocationId.Type;
  readonly input: Contract["input"]["Type"];
  readonly principal: typeof EffectivePrincipal.Type;
  readonly actorProvenance?: typeof ActorProvenance.Type | undefined;
};

const preserveDeclaredFailure = <A, Failure extends Schema.Top>(
  effect: Effect.Effect<A, unknown>,
  failure: Failure,
): Effect.Effect<A, Schema.Schema.Type<Failure>> =>
  effect.pipe(
    Effect.catchIf(
      (error): error is Schema.Schema.Type<Failure> => Schema.is(failure)(error),
      (error) => Effect.fail<Schema.Schema.Type<Failure>>(error),
      (error) => Effect.die(error),
    ),
  );

const authorizationFailure = (
  contract: AnyWorkflowContract,
): { readonly _tag: "AuthorizationRevoked"; readonly policy: string } => ({
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
          contract.declaredFailure,
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

const SheetsDescribeDefinition = makeDefinition(SheetsDescribe, (dataSource, { input }) =>
  dataSource.describeSheets(input),
);

const SheetsReadSnapshotDefinition = makeDefinition(SheetsReadSnapshot, (dataSource, { input }) =>
  dataSource.readSheetSnapshot(input),
);

export const ReadOnlySheetWorkflowDefinitions = Object.freeze([
  DiscordLoadProfileDefinition,
  DiscordLoadWorkspaceChannelsDefinition,
  DiscordLoadWorkspaceRolesDefinition,
  AuthorizationLoadWorkspaceCapabilitiesDefinition,
  SheetsDescribeDefinition,
  SheetsReadSnapshotDefinition,
  SchedulesLoadWorkspaceDefinition,
  NotificationsLoadSupportedClientsDefinition,
]);

export const ReadOnlySheetWorkflows = Object.freeze(
  ReadOnlySheetWorkflowDefinitions.map(({ workflow }) => workflow),
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
  SheetsDescribeDefinition.action.toLayer(),
  SheetsDescribeDefinition.workflowLayer,
  SheetsReadSnapshotDefinition.action.toLayer(),
  SheetsReadSnapshotDefinition.workflowLayer,
  SchedulesLoadWorkspaceDefinition.action.toLayer(),
  SchedulesLoadWorkspaceDefinition.workflowLayer,
  NotificationsLoadSupportedClientsDefinition.action.toLayer(),
  NotificationsLoadSupportedClientsDefinition.workflowLayer,
).pipe(Layer.provide(actionContextSqlLayer));

export const materializeReadOnlyWorkflowFailure = (
  workflow: WorkflowDefinition,
  cause: Cause.Cause<unknown>,
): WorkflowJson => materializeWorkflowFailure(Schema.is(workflow.errorSchema), cause);
