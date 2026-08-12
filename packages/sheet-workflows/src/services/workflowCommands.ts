import { Array as EffectArray, Cause, Effect, Layer, Option, Random, Ref, Schema } from "effect";
import {
  defineEvent,
  enqueueWorkflowDefinition,
  reconcileWorkflowRuns,
  WorkflowStore,
  workflowRuntimeCommandExecutorLayer,
  workflowRuntimeLayer,
  type WorkflowCommandKindType,
  type WorkflowDefinition,
  type WorkflowJson,
  type WorkflowRunCursor,
  type WorkflowStoreService,
} from "effect-zero-workflow";
import {
  DispatchWorkflowCommandBadRequestError,
  DispatchWorkflowRunNotFoundError,
} from "sheet-ingress-api/internal";
import { DispatchClusterWorkflows } from "@/workflows/dispatchWorkflows";
import {
  isReadOnlySheetWorkflowName,
  materializeReadOnlyWorkflowFailure,
  readOnlySheetWorkflowDefinitionVersion,
  ReadOnlySheetWorkflows,
} from "@/workflows/readOnly";
import {
  isPreferencesSheetWorkflowName,
  materializePreferencesWorkflowFailure,
  preferencesSheetWorkflowDefinitionVersion,
  PreferencesSheetWorkflows,
} from "@/workflows/preferences";
import {
  configurationSheetWorkflowDefinitionVersion,
  ConfigurationSheetWorkflows,
  isConfigurationSheetWorkflowName,
  materializeConfigurationWorkflowFailure,
} from "@/workflows/configuration";
import {
  isSlotSheetWorkflowName,
  materializeSlotWorkflowFailure,
  slotSheetWorkflowDefinitionVersion,
  SlotSheetWorkflows,
} from "@/workflows/slots";
import {
  isScheduleSheetWorkflowName,
  materializeScheduleWorkflowFailure,
  scheduleSheetWorkflowDefinitionVersion,
  ScheduleSheetWorkflows,
} from "@/workflows/schedules";

const DispatchWorkflowPrincipal = Schema.Struct({
  requester: Schema.Struct({
    accountId: Schema.String,
  }),
});

const DispatchMailboxEvent = defineEvent({
  name: "sheet-workflows.dispatch.mailbox",
  value: Schema.Json,
});

const legacyDispatchWorkflowDefinitionVersion = "1";

type DispatchWorkflowSlice = {
  readonly isWorkflowName: (name: string) => boolean;
  readonly definitionVersion: string;
  readonly materializeFailure: (
    workflow: WorkflowDefinition,
    cause: Cause.Cause<unknown>,
  ) => WorkflowJson;
};

const dispatchWorkflowSlices: ReadonlyArray<DispatchWorkflowSlice> = [
  {
    isWorkflowName: isReadOnlySheetWorkflowName,
    definitionVersion: readOnlySheetWorkflowDefinitionVersion,
    materializeFailure: materializeReadOnlyWorkflowFailure,
  },
  {
    isWorkflowName: isPreferencesSheetWorkflowName,
    definitionVersion: preferencesSheetWorkflowDefinitionVersion,
    materializeFailure: materializePreferencesWorkflowFailure,
  },
  {
    isWorkflowName: isConfigurationSheetWorkflowName,
    definitionVersion: configurationSheetWorkflowDefinitionVersion,
    materializeFailure: materializeConfigurationWorkflowFailure,
  },
  {
    isWorkflowName: isSlotSheetWorkflowName,
    definitionVersion: slotSheetWorkflowDefinitionVersion,
    materializeFailure: materializeSlotWorkflowFailure,
  },
  {
    isWorkflowName: isScheduleSheetWorkflowName,
    definitionVersion: scheduleSheetWorkflowDefinitionVersion,
    materializeFailure: materializeScheduleWorkflowFailure,
  },
];

const findDispatchWorkflowSlice = (workflow: WorkflowDefinition) =>
  EffectArray.findFirst(dispatchWorkflowSlices, ({ isWorkflowName }) =>
    isWorkflowName(workflow.name),
  );

export const dispatchWorkflowSliceMatchCount = (workflow: WorkflowDefinition): number =>
  EffectArray.filter(dispatchWorkflowSlices, ({ isWorkflowName }) => isWorkflowName(workflow.name))
    .length;

const dispatchWorkflowDefinitionVersion = (workflow: WorkflowDefinition): string =>
  Option.match(findDispatchWorkflowSlice(workflow), {
    onNone: () => legacyDispatchWorkflowDefinitionVersion,
    onSome: ({ definitionVersion }) => definitionVersion,
  });

const materializeDispatchWorkflowFailure = (
  workflow: WorkflowDefinition,
  cause: Cause.Cause<unknown>,
): WorkflowJson =>
  Option.match(findDispatchWorkflowSlice(workflow), {
    onNone: () => ({ message: Cause.pretty(cause) }),
    onSome: ({ materializeFailure }) => materializeFailure(workflow, cause),
  });

const dispatchRuntimeLayer = workflowRuntimeLayer({
  workflows: [
    ...DispatchClusterWorkflows.all,
    ...ReadOnlySheetWorkflows,
    ...PreferencesSheetWorkflows,
    ...ConfigurationSheetWorkflows,
    ...SlotSheetWorkflows,
    ...ScheduleSheetWorkflows,
  ],
  events: [DispatchMailboxEvent],
  definitionVersion: dispatchWorkflowDefinitionVersion,
  materializeFailure: materializeDispatchWorkflowFailure,
});

const invocationContext = (payload: unknown) =>
  Schema.decodeUnknownEffect(DispatchWorkflowPrincipal)(payload).pipe(
    Effect.map(({ requester }) => ({
      principal: {
        accountId: requester.accountId,
      } satisfies WorkflowJson,
      visibilityKey: `account:${requester.accountId}`,
    })),
  );

const requireWorkflowRun = (
  store: WorkflowStoreService,
  workflow: WorkflowDefinition,
  runId: string,
) =>
  Effect.gen(function* () {
    const run = yield* store.getRun(runId).pipe(Effect.orDie);
    if (!run || run.runId !== runId || run.workflowName !== workflow.name) {
      return yield* Effect.fail(
        new DispatchWorkflowRunNotFoundError({
          runId,
          message: `Workflow run not found for ${workflow.name}: ${runId}`,
        }),
      );
    }
    return run;
  });

export const enqueueDispatchWorkflow = (
  workflow: WorkflowDefinition,
  payload: unknown,
  requestedRunId?: string,
) =>
  Effect.gen(function* () {
    const context = yield* invocationContext(payload);
    const runId = requestedRunId ?? (yield* Random.nextUUIDv4);
    const run = yield* enqueueWorkflowDefinition(workflow, payload, {
      runId,
      ...context,
    });
    return run.runId;
  }).pipe(Effect.provide(dispatchRuntimeLayer));

export const enqueueDispatchWorkflowCommand = (
  workflow: WorkflowDefinition,
  runId: string,
  commandId: string,
  kind: WorkflowCommandKindType,
  payload: unknown,
) =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    yield* requireWorkflowRun(store, workflow, runId);
    const encodedPayload = yield* Schema.decodeUnknownEffect(Schema.Json)(payload).pipe(
      Effect.mapError(
        (error) =>
          new DispatchWorkflowCommandBadRequestError({
            runId,
            message: error.message,
          }),
      ),
    );
    yield* store
      .enqueueCommand({
        commandId,
        runId,
        kind,
        payload: encodedPayload,
      })
      .pipe(Effect.orDie);
  });

export const createDispatchWorkflowEvent = (
  workflow: WorkflowDefinition,
  runId: string,
  eventKey: string,
) =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const run = yield* requireWorkflowRun(store, workflow, runId);
    return DispatchMailboxEvent.create({
      workflow,
      executionId: run.executionId,
      eventKey,
    });
  });

export const workflowCommandExecutorLayer = workflowRuntimeCommandExecutorLayer.pipe(
  Layer.provide(dispatchRuntimeLayer),
);

export const reconcileDispatchWorkflowRuns = (cursor: Ref.Ref<WorkflowRunCursor | undefined>) =>
  reconcileWorkflowRuns({ cursor }).pipe(Effect.provide(dispatchRuntimeLayer));
