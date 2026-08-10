import { Cause, Effect, Layer, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import {
  actionContextSqlLayer,
  makeAction,
  type WorkflowDefinition,
  type WorkflowJson,
} from "effect-zero-workflow";
import { InvocationId, workflowContractKey } from "effect-zero-workflow/contract";
import type { AnyWorkflowContract } from "effect-zero-workflow/contract";
import { DeliveryKey, DeliveryReceipt } from "sheet-bot-api";
import {
  ConversationsDeliverConfig,
  ConversationsSetLockdown,
  ConversationsUpdateConfigAndDeliver,
  InteractiveDeclaredFailure,
  WorkspacesDeliverConfig,
  WorkspacesSetMonitorRoleAndDeliver,
  WorkspacesUpdateConfigAndDeliver,
} from "sheet-workflow-contracts";
import {
  decodeWorkflowContractInputOrDie,
  workflowContractExecutionSchema,
} from "../shared/execution";
import { materializeWorkflowFailure } from "../shared/failure";
import {
  authorizeInteractiveWorkflow as authorize,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import { configurationSheetWorkflowDefinitionVersion } from "./catalog";
import {
  ConfigurationWorkflowOperations,
  ConversationConfigurationState,
  LockdownConfigurationState,
  WorkspaceConfigurationState,
} from "./operations";

type ConfigurationDeliveryKind = "permission-overwrites" | "response";

export const makeConfigurationDeliveryKey = (
  contract: AnyWorkflowContract,
  invocationId: typeof InvocationId.Type,
  kind: ConfigurationDeliveryKind,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    `${workflowContractKey(contract)}:${configurationSheetWorkflowDefinitionVersion}:${invocationId}:${kind}`,
  );

const workspaceDeliverName = workflowContractKey(WorkspacesDeliverConfig);
const workspaceDeliverExecution = workflowContractExecutionSchema(WorkspacesDeliverConfig);
const workspaceDeliverResponseExecution = Schema.Struct({
  ...workspaceDeliverExecution.fields,
  state: WorkspaceConfigurationState,
});

const WorkspacesDeliverConfigReadAction = makeAction({
  name: `${workspaceDeliverName}.read`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: workspaceDeliverExecution,
  success: WorkspaceConfigurationState,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(WorkspacesDeliverConfig, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        WorkspacesDeliverConfig,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.loadWorkspace(
          input.workspaceId,
          WorkspacesDeliverConfig.authorizationPolicy.policy,
          { requireConfig: true },
        ),
      );
    }),
});

const WorkspacesDeliverConfigResponseAction = makeAction({
  name: `${workspaceDeliverName}.respond`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: workspaceDeliverResponseExecution,
  success: DeliveryReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(WorkspacesDeliverConfig, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        WorkspacesDeliverConfig,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.deliverWorkspaceConfig(
          input.responseReference,
          execution.state,
          makeConfigurationDeliveryKey(WorkspacesDeliverConfig, execution.invocationId, "response"),
          WorkspacesDeliverConfig.authorizationPolicy.policy,
          { recoveryRequired: false },
        ),
      );
    }),
});

const WorkspacesDeliverConfigWorkflow = Workflow.make({
  name: workspaceDeliverName,
  payload: workspaceDeliverExecution,
  success: WorkspacesDeliverConfig.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const WorkspacesDeliverConfigDefinition = {
  contract: WorkspacesDeliverConfig,
  workflow: WorkspacesDeliverConfigWorkflow,
  actions: [WorkspacesDeliverConfigReadAction, WorkspacesDeliverConfigResponseAction],
  workflowLayer: WorkspacesDeliverConfigWorkflow.toLayer((execution) =>
    Effect.gen(function* () {
      const input = yield* decodeWorkflowContractInputOrDie(
        WorkspacesDeliverConfig,
        execution.input,
      );
      const state = yield* WorkspacesDeliverConfigReadAction.await(execution);
      const receipt = yield* WorkspacesDeliverConfigResponseAction.await({ ...execution, state });
      return {
        workspaceId: input.workspaceId,
        monitorRoleCount: state.monitorRoleIds.length,
        deliveryReceipts: [receipt],
      };
    }),
  ),
};

const workspaceUpdateName = workflowContractKey(WorkspacesUpdateConfigAndDeliver);
const workspaceUpdateExecution = workflowContractExecutionSchema(WorkspacesUpdateConfigAndDeliver);
const workspaceUpdateMutationExecution = Schema.Struct({
  ...workspaceUpdateExecution.fields,
  current: WorkspaceConfigurationState,
});
const workspaceUpdateResponseExecution = Schema.Struct({
  ...workspaceUpdateExecution.fields,
  state: WorkspaceConfigurationState,
});

const WorkspacesUpdateConfigReadAction = makeAction({
  name: `${workspaceUpdateName}.read`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: workspaceUpdateExecution,
  success: WorkspaceConfigurationState,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(WorkspacesUpdateConfigAndDeliver, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        WorkspacesUpdateConfigAndDeliver,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.loadWorkspace(
          input.workspaceId,
          WorkspacesUpdateConfigAndDeliver.authorizationPolicy.policy,
          { requireConfig: false },
        ),
      );
    }),
});

const WorkspacesUpdateConfigMutationAction = makeAction({
  name: `${workspaceUpdateName}.update`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: workspaceUpdateMutationExecution,
  success: WorkspaceConfigurationState,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(WorkspacesUpdateConfigAndDeliver, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        WorkspacesUpdateConfigAndDeliver,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.updateWorkspace(
          input,
          execution.current,
          WorkspacesUpdateConfigAndDeliver.authorizationPolicy.policy,
        ),
      );
    }),
});

const WorkspacesUpdateConfigResponseAction = makeAction({
  name: `${workspaceUpdateName}.respond`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: workspaceUpdateResponseExecution,
  success: DeliveryReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(WorkspacesUpdateConfigAndDeliver, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        WorkspacesUpdateConfigAndDeliver,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.deliverWorkspaceConfig(
          input.responseReference,
          execution.state,
          makeConfigurationDeliveryKey(
            WorkspacesUpdateConfigAndDeliver,
            execution.invocationId,
            "response",
          ),
          WorkspacesUpdateConfigAndDeliver.authorizationPolicy.policy,
          { recoveryRequired: true },
        ),
      );
    }),
});

const WorkspacesUpdateConfigWorkflow = Workflow.make({
  name: workspaceUpdateName,
  payload: workspaceUpdateExecution,
  success: WorkspacesUpdateConfigAndDeliver.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const WorkspacesUpdateConfigDefinition = {
  contract: WorkspacesUpdateConfigAndDeliver,
  workflow: WorkspacesUpdateConfigWorkflow,
  actions: [
    WorkspacesUpdateConfigReadAction,
    WorkspacesUpdateConfigMutationAction,
    WorkspacesUpdateConfigResponseAction,
  ],
  workflowLayer: WorkspacesUpdateConfigWorkflow.toLayer((execution) =>
    Effect.gen(function* () {
      const input = yield* decodeWorkflowContractInputOrDie(
        WorkspacesUpdateConfigAndDeliver,
        execution.input,
      );
      const current = yield* WorkspacesUpdateConfigReadAction.await(execution);
      const state = yield* WorkspacesUpdateConfigMutationAction.await({ ...execution, current });
      const receipt = yield* WorkspacesUpdateConfigResponseAction.await({ ...execution, state });
      return {
        workspaceId: input.workspaceId,
        monitorRoleCount: state.monitorRoleIds.length,
        deliveryReceipts: [receipt],
      };
    }),
  ),
};

const monitorRoleName = workflowContractKey(WorkspacesSetMonitorRoleAndDeliver);
const monitorRoleExecution = workflowContractExecutionSchema(WorkspacesSetMonitorRoleAndDeliver);
const monitorRoleMutationExecution = Schema.Struct({
  ...monitorRoleExecution.fields,
  current: WorkspaceConfigurationState,
});
const monitorRoleResponseExecution = Schema.Struct({
  ...monitorRoleExecution.fields,
  state: WorkspaceConfigurationState,
});

const WorkspacesSetMonitorRoleReadAction = makeAction({
  name: `${monitorRoleName}.read`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: monitorRoleExecution,
  success: WorkspaceConfigurationState,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(WorkspacesSetMonitorRoleAndDeliver, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        WorkspacesSetMonitorRoleAndDeliver,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.loadWorkspace(
          input.workspaceId,
          WorkspacesSetMonitorRoleAndDeliver.authorizationPolicy.policy,
          { requireConfig: false },
        ),
      );
    }),
});

const WorkspacesSetMonitorRoleMutationAction = makeAction({
  name: `${monitorRoleName}.update`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: monitorRoleMutationExecution,
  success: WorkspaceConfigurationState,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(WorkspacesSetMonitorRoleAndDeliver, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        WorkspacesSetMonitorRoleAndDeliver,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.setMonitorRole(
          input,
          execution.current,
          WorkspacesSetMonitorRoleAndDeliver.authorizationPolicy.policy,
        ),
      );
    }),
});

const WorkspacesSetMonitorRoleResponseAction = makeAction({
  name: `${monitorRoleName}.respond`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: monitorRoleResponseExecution,
  success: DeliveryReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(WorkspacesSetMonitorRoleAndDeliver, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        WorkspacesSetMonitorRoleAndDeliver,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.deliverMonitorRole(
          input,
          execution.state.workspaceName,
          makeConfigurationDeliveryKey(
            WorkspacesSetMonitorRoleAndDeliver,
            execution.invocationId,
            "response",
          ),
          WorkspacesSetMonitorRoleAndDeliver.authorizationPolicy.policy,
        ),
      );
    }),
});

const WorkspacesSetMonitorRoleWorkflow = Workflow.make({
  name: monitorRoleName,
  payload: monitorRoleExecution,
  success: WorkspacesSetMonitorRoleAndDeliver.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const WorkspacesSetMonitorRoleDefinition = {
  contract: WorkspacesSetMonitorRoleAndDeliver,
  workflow: WorkspacesSetMonitorRoleWorkflow,
  actions: [
    WorkspacesSetMonitorRoleReadAction,
    WorkspacesSetMonitorRoleMutationAction,
    WorkspacesSetMonitorRoleResponseAction,
  ],
  workflowLayer: WorkspacesSetMonitorRoleWorkflow.toLayer((execution) =>
    Effect.gen(function* () {
      const input = yield* decodeWorkflowContractInputOrDie(
        WorkspacesSetMonitorRoleAndDeliver,
        execution.input,
      );
      const current = yield* WorkspacesSetMonitorRoleReadAction.await(execution);
      const state = yield* WorkspacesSetMonitorRoleMutationAction.await({ ...execution, current });
      const receipt = yield* WorkspacesSetMonitorRoleResponseAction.await({ ...execution, state });
      return {
        workspaceId: input.workspaceId,
        roleId: input.roleId,
        enabled: input.enabled,
        deliveryReceipts: [receipt],
      };
    }),
  ),
};

const conversationDeliverName = workflowContractKey(ConversationsDeliverConfig);
const conversationDeliverExecution = workflowContractExecutionSchema(ConversationsDeliverConfig);
const conversationDeliverResponseExecution = Schema.Struct({
  ...conversationDeliverExecution.fields,
  state: ConversationConfigurationState,
});

const ConversationsDeliverConfigReadAction = makeAction({
  name: `${conversationDeliverName}.read`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: conversationDeliverExecution,
  success: ConversationConfigurationState,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(ConversationsDeliverConfig, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        ConversationsDeliverConfig,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.loadConversation(
          input.workspaceId,
          input.conversationId,
          ConversationsDeliverConfig.authorizationPolicy.policy,
          { requireConfig: true },
        ),
      );
    }),
});

const ConversationsDeliverConfigResponseAction = makeAction({
  name: `${conversationDeliverName}.respond`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: conversationDeliverResponseExecution,
  success: DeliveryReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(ConversationsDeliverConfig, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        ConversationsDeliverConfig,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.deliverConversationConfig(
          input.responseReference,
          execution.state,
          makeConfigurationDeliveryKey(
            ConversationsDeliverConfig,
            execution.invocationId,
            "response",
          ),
          ConversationsDeliverConfig.authorizationPolicy.policy,
          { recoveryRequired: false, updated: false },
        ),
      );
    }),
});

const ConversationsDeliverConfigWorkflow = Workflow.make({
  name: conversationDeliverName,
  payload: conversationDeliverExecution,
  success: ConversationsDeliverConfig.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const ConversationsDeliverConfigDefinition = {
  contract: ConversationsDeliverConfig,
  workflow: ConversationsDeliverConfigWorkflow,
  actions: [ConversationsDeliverConfigReadAction, ConversationsDeliverConfigResponseAction],
  workflowLayer: ConversationsDeliverConfigWorkflow.toLayer((execution) =>
    Effect.gen(function* () {
      const input = yield* decodeWorkflowContractInputOrDie(
        ConversationsDeliverConfig,
        execution.input,
      );
      const state = yield* ConversationsDeliverConfigReadAction.await(execution);
      const receipt = yield* ConversationsDeliverConfigResponseAction.await({
        ...execution,
        state,
      });
      return {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        deliveryReceipts: [receipt],
      };
    }),
  ),
};

const conversationUpdateName = workflowContractKey(ConversationsUpdateConfigAndDeliver);
const conversationUpdateExecution = workflowContractExecutionSchema(
  ConversationsUpdateConfigAndDeliver,
);
const conversationUpdateMutationExecution = Schema.Struct({
  ...conversationUpdateExecution.fields,
  current: ConversationConfigurationState,
});
const conversationUpdateResponseExecution = Schema.Struct({
  ...conversationUpdateExecution.fields,
  state: ConversationConfigurationState,
});

const ConversationsUpdateConfigReadAction = makeAction({
  name: `${conversationUpdateName}.read`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: conversationUpdateExecution,
  success: ConversationConfigurationState,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(ConversationsUpdateConfigAndDeliver, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        ConversationsUpdateConfigAndDeliver,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.loadConversation(
          input.workspaceId,
          input.conversationId,
          ConversationsUpdateConfigAndDeliver.authorizationPolicy.policy,
          { requireConfig: false },
        ),
      );
    }),
});

const ConversationsUpdateConfigMutationAction = makeAction({
  name: `${conversationUpdateName}.update`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: conversationUpdateMutationExecution,
  success: ConversationConfigurationState,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(ConversationsUpdateConfigAndDeliver, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        ConversationsUpdateConfigAndDeliver,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.updateConversation(
          input,
          execution.current,
          ConversationsUpdateConfigAndDeliver.authorizationPolicy.policy,
        ),
      );
    }),
});

const ConversationsUpdateConfigResponseAction = makeAction({
  name: `${conversationUpdateName}.respond`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: conversationUpdateResponseExecution,
  success: DeliveryReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(ConversationsUpdateConfigAndDeliver, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        ConversationsUpdateConfigAndDeliver,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.deliverConversationConfig(
          input.responseReference,
          execution.state,
          makeConfigurationDeliveryKey(
            ConversationsUpdateConfigAndDeliver,
            execution.invocationId,
            "response",
          ),
          ConversationsUpdateConfigAndDeliver.authorizationPolicy.policy,
          { recoveryRequired: true, updated: true },
        ),
      );
    }),
});

const ConversationsUpdateConfigWorkflow = Workflow.make({
  name: conversationUpdateName,
  payload: conversationUpdateExecution,
  success: ConversationsUpdateConfigAndDeliver.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const ConversationsUpdateConfigDefinition = {
  contract: ConversationsUpdateConfigAndDeliver,
  workflow: ConversationsUpdateConfigWorkflow,
  actions: [
    ConversationsUpdateConfigReadAction,
    ConversationsUpdateConfigMutationAction,
    ConversationsUpdateConfigResponseAction,
  ],
  workflowLayer: ConversationsUpdateConfigWorkflow.toLayer((execution) =>
    Effect.gen(function* () {
      const input = yield* decodeWorkflowContractInputOrDie(
        ConversationsUpdateConfigAndDeliver,
        execution.input,
      );
      const current = yield* ConversationsUpdateConfigReadAction.await(execution);
      const state = yield* ConversationsUpdateConfigMutationAction.await({
        ...execution,
        current,
      });
      const receipt = yield* ConversationsUpdateConfigResponseAction.await({
        ...execution,
        state,
      });
      return {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        deliveryReceipts: [receipt],
      };
    }),
  ),
};

const lockdownName = workflowContractKey(ConversationsSetLockdown);
const lockdownExecution = workflowContractExecutionSchema(ConversationsSetLockdown);
const lockdownPermissionExecution = Schema.Struct({
  ...lockdownExecution.fields,
  state: LockdownConfigurationState,
});

const ConversationsSetLockdownReadAction = makeAction({
  name: `${lockdownName}.read`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: lockdownExecution,
  success: LockdownConfigurationState,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(ConversationsSetLockdown, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        ConversationsSetLockdown,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.loadLockdown(input, ConversationsSetLockdown.authorizationPolicy.policy),
      );
    }),
});

const ConversationsSetLockdownPermissionAction = makeAction({
  name: `${lockdownName}.replacePermissionOverwrites`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: lockdownPermissionExecution,
  success: DeliveryReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(ConversationsSetLockdown, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      return yield* preserveDeclaredFailure(
        operations.replaceLockdownPermissions(
          execution.state,
          makeConfigurationDeliveryKey(
            ConversationsSetLockdown,
            execution.invocationId,
            "permission-overwrites",
          ),
          ConversationsSetLockdown.authorizationPolicy.policy,
        ),
      );
    }),
});

const ConversationsSetLockdownResponseAction = makeAction({
  name: `${lockdownName}.respond`,
  version: configurationSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: lockdownExecution,
  success: DeliveryReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: (execution) =>
    Effect.gen(function* () {
      yield* preserveDeclaredFailure(authorize(ConversationsSetLockdown, execution));
      const operations = yield* ConfigurationWorkflowOperations;
      const input = yield* decodeWorkflowContractInputOrDie(
        ConversationsSetLockdown,
        execution.input,
      );
      return yield* preserveDeclaredFailure(
        operations.deliverLockdownResponse(
          input,
          makeConfigurationDeliveryKey(
            ConversationsSetLockdown,
            execution.invocationId,
            "response",
          ),
          ConversationsSetLockdown.authorizationPolicy.policy,
        ),
      );
    }),
});

const ConversationsSetLockdownWorkflow = Workflow.make({
  name: lockdownName,
  payload: lockdownExecution,
  success: ConversationsSetLockdown.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

const ConversationsSetLockdownDefinition = {
  contract: ConversationsSetLockdown,
  workflow: ConversationsSetLockdownWorkflow,
  actions: [
    ConversationsSetLockdownReadAction,
    ConversationsSetLockdownPermissionAction,
    ConversationsSetLockdownResponseAction,
  ],
  workflowLayer: ConversationsSetLockdownWorkflow.toLayer((execution) =>
    Effect.gen(function* () {
      const input = yield* decodeWorkflowContractInputOrDie(
        ConversationsSetLockdown,
        execution.input,
      );
      const state = yield* ConversationsSetLockdownReadAction.await(execution);
      const permissionReceipt = yield* ConversationsSetLockdownPermissionAction.await({
        ...execution,
        state,
      });
      const responseReceipt = yield* ConversationsSetLockdownResponseAction.await(execution);
      return {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        enabled: input.enabled,
        deliveryReceipts: [permissionReceipt, responseReceipt],
      };
    }),
  ),
};

export const ConfigurationSheetWorkflowDefinitions = Object.freeze([
  WorkspacesDeliverConfigDefinition,
  WorkspacesUpdateConfigDefinition,
  WorkspacesSetMonitorRoleDefinition,
  ConversationsDeliverConfigDefinition,
  ConversationsUpdateConfigDefinition,
  ConversationsSetLockdownDefinition,
]);

export const ConfigurationSheetWorkflows = Object.freeze(
  ConfigurationSheetWorkflowDefinitions.map(({ workflow }) => workflow as WorkflowDefinition),
);

const configurationSheetWorkflowNames = new Set(
  ConfigurationSheetWorkflows.map(({ name }) => name),
);

export const isConfigurationSheetWorkflowName = (name: string): boolean =>
  configurationSheetWorkflowNames.has(name);

const configurationSheetWorkflowLayerList = [
  Layer.empty,
  ...ConfigurationSheetWorkflowDefinitions.flatMap(({ actions, workflowLayer }) => [
    ...actions.map((action) => action.toLayer()),
    workflowLayer,
  ]),
] as const;

export const configurationSheetWorkflowLayers = Layer.mergeAll(
  ...configurationSheetWorkflowLayerList,
).pipe(Layer.provide(actionContextSqlLayer));

export const materializeConfigurationWorkflowFailure = (
  _workflow: WorkflowDefinition,
  cause: Cause.Cause<unknown>,
): WorkflowJson => materializeWorkflowFailure(Schema.is(InteractiveDeclaredFailure), cause);
