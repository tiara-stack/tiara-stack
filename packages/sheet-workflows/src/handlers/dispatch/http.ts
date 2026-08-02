import { Effect, Layer, Schema } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { WorkflowStore } from "effect-zero-workflow";
import { DispatchWorkflowHttpApi, SheetWorkflowsInternalApi } from "sheet-ingress-api/internal";
import {
  DispatchWorkflowCancelPayload,
  DispatchWorkflowCreateEventPayload,
  DispatchWorkflowResumePayload,
  DispatchWorkflowSendEventPayload,
} from "sheet-ingress-api/internal";
import {
  createDispatchWorkflowEvent,
  enqueueDispatchWorkflow,
  enqueueDispatchWorkflowCommand,
} from "@/services/workflowCommands";
import { DispatchClusterWorkflows } from "@/workflows/dispatchWorkflows";

const { all: DispatchWorkflows } = DispatchClusterWorkflows;

type DispatchLayer = Layer.Layer<
  HttpApiGroup.ApiGroup<"sheet-workflows-internal", "dispatchWorkflows">,
  never,
  WorkflowEngine.WorkflowEngine | WorkflowStore
>;
type DispatchHandlers = HttpApiBuilder.Handlers.FromGroup<typeof DispatchWorkflowHttpApi>;
type DispatchEndpointName = HttpApiEndpoint.Name<
  HttpApiGroup.Endpoints<typeof DispatchWorkflowHttpApi>
>;
type DispatchWorkflow = (typeof DispatchWorkflows)[number];
type DispatchEndpoints = HttpApiGroup.Endpoints<typeof DispatchWorkflowHttpApi>;
type DispatchEndpointHandler<Name extends DispatchEndpointName> = HttpApiEndpoint.HandlerWithName<
  DispatchEndpoints,
  Name,
  HttpApiEndpoint.ErrorsWithName<DispatchEndpoints, Name>,
  WorkflowEngine.WorkflowEngine | WorkflowStore
>;
type DispatchEndpointByName<Name extends DispatchEndpointName> = Extract<
  DispatchEndpoints,
  { readonly name: Name }
>;
type DispatchEndpointPayload<Name extends DispatchEndpointName> =
  HttpApiEndpoint.Request<DispatchEndpointByName<Name>> extends {
    readonly payload: infer Payload;
  }
    ? Payload
    : never;
type DispatchExecuteName<Workflow extends DispatchWorkflow> = Extract<
  Workflow["name"],
  DispatchEndpointName
>;
type DispatchDiscardName<Workflow extends DispatchWorkflow> = Extract<
  `${Workflow["name"]}Discard`,
  DispatchEndpointName
>;
type DispatchResumeName<Workflow extends DispatchWorkflow> = Extract<
  `${Workflow["name"]}Resume`,
  DispatchEndpointName
>;
type DispatchCancelName<Workflow extends DispatchWorkflow> = Extract<
  `${Workflow["name"]}Cancel`,
  DispatchEndpointName
>;
type DispatchCreateEventName<Workflow extends DispatchWorkflow> = Extract<
  `${Workflow["name"]}CreateEvent`,
  DispatchEndpointName
>;
type DispatchSendEventName<Workflow extends DispatchWorkflow> = Extract<
  `${Workflow["name"]}SendEvent`,
  DispatchEndpointName
>;
type DispatchResumeEndpointName = Extract<DispatchEndpointName, `${string}Resume`>;
type DispatchCancelEndpointName = Extract<DispatchEndpointName, `${string}Cancel`>;
type DispatchCreateEventEndpointName = Extract<DispatchEndpointName, `${string}CreateEvent`>;
type DispatchSendEventEndpointName = Extract<DispatchEndpointName, `${string}SendEvent`>;
type DispatchWorkflowResumePayloadType = Schema.Schema.Type<typeof DispatchWorkflowResumePayload>;
type DispatchWorkflowCancelPayloadType = Schema.Schema.Type<typeof DispatchWorkflowCancelPayload>;
type DispatchWorkflowCreateEventPayloadType = Schema.Schema.Type<
  typeof DispatchWorkflowCreateEventPayload
>;
type DispatchWorkflowSendEventPayloadType = Schema.Schema.Type<
  typeof DispatchWorkflowSendEventPayload
>;
type DynamicDispatchHandlers = {
  readonly handle: <Name extends DispatchEndpointName>(
    name: Name,
    handler: DispatchEndpointHandler<Name>,
  ) => DispatchHandlers;
};

const dispatchHandlers = (handlers: DispatchHandlers): DynamicDispatchHandlers =>
  handlers as unknown as DynamicDispatchHandlers;

const completedHandlers = (handlers: DispatchHandlers) =>
  handlers as unknown as HttpApiBuilder.Handlers<
    WorkflowEngine.WorkflowEngine | WorkflowStore,
    never
  >;

const workflowExecute = <Workflow extends DispatchWorkflow>(workflow: Workflow) =>
  workflow.execute as unknown as (
    payload: DispatchEndpointPayload<DispatchExecuteName<Workflow>>,
  ) => ReturnType<Workflow["execute"]>;

const workflowDiscard =
  <Workflow extends DispatchWorkflow>(workflow: Workflow) =>
  (payload: DispatchEndpointPayload<DispatchDiscardName<Workflow>>, runId: string | undefined) =>
    enqueueDispatchWorkflow(workflow, payload, runId);

const executeWorkflow = <Workflow extends DispatchWorkflow>(
  workflow: Workflow,
): DispatchEndpointHandler<DispatchExecuteName<Workflow>> => {
  const execute = workflowExecute(workflow);
  return Effect.fnUntraced(function* ({
    payload,
  }: {
    readonly payload: DispatchEndpointPayload<DispatchExecuteName<Workflow>>;
  }) {
    return yield* execute(payload);
  }) as unknown as DispatchEndpointHandler<DispatchExecuteName<Workflow>>;
};

const discardWorkflow = <Workflow extends DispatchWorkflow>(
  workflow: Workflow,
): DispatchEndpointHandler<DispatchDiscardName<Workflow>> => {
  const discard = workflowDiscard(workflow);
  return Effect.fnUntraced(function* ({
    payload,
  }: {
    readonly payload: DispatchEndpointPayload<DispatchDiscardName<Workflow>>;
  }) {
    return yield* discard(payload, undefined);
  }) as unknown as DispatchEndpointHandler<DispatchDiscardName<Workflow>>;
};

const resumeWorkflow = <Workflow extends DispatchWorkflow>(
  workflow: Workflow,
): DispatchEndpointHandler<DispatchResumeEndpointName> =>
  Effect.fnUntraced(function* ({
    payload,
  }: {
    readonly payload: DispatchWorkflowResumePayloadType;
  }) {
    return yield* enqueueDispatchWorkflowCommand(
      workflow,
      payload.runId,
      payload.commandId,
      "resume",
      null,
    );
  });

const cancelWorkflow = <Workflow extends DispatchWorkflow>(
  workflow: Workflow,
): DispatchEndpointHandler<DispatchCancelEndpointName> =>
  Effect.fnUntraced(function* ({
    payload,
  }: {
    readonly payload: DispatchWorkflowCancelPayloadType;
  }) {
    return yield* enqueueDispatchWorkflowCommand(
      workflow,
      payload.runId,
      payload.commandId,
      "cancel",
      null,
    );
  });

const createWorkflowEvent = <Workflow extends DispatchWorkflow>(
  workflow: Workflow,
): DispatchEndpointHandler<DispatchCreateEventEndpointName> =>
  Effect.fnUntraced(function* ({
    payload,
  }: {
    readonly payload: DispatchWorkflowCreateEventPayloadType;
  }) {
    return yield* createDispatchWorkflowEvent(workflow, payload.runId, payload.eventKey);
  });

const sendWorkflowEvent = <Workflow extends DispatchWorkflow>(
  workflow: Workflow,
): DispatchEndpointHandler<DispatchSendEventEndpointName> =>
  Effect.fnUntraced(function* ({
    payload,
  }: {
    readonly payload: DispatchWorkflowSendEventPayloadType;
  }) {
    return yield* enqueueDispatchWorkflowCommand(
      workflow,
      payload.runId,
      payload.commandId,
      "event",
      {
        eventId: payload.eventId,
        value: payload.value,
      },
    );
  });

const discardName = <Workflow extends DispatchWorkflow>(workflow: Workflow) =>
  `${workflow.name}Discard` as DispatchDiscardName<Workflow>;

const resumeName = <Workflow extends DispatchWorkflow>(workflow: Workflow) =>
  `${workflow.name}Resume` as DispatchResumeName<Workflow>;
const cancelName = <Workflow extends DispatchWorkflow>(workflow: Workflow) =>
  `${workflow.name}Cancel` as DispatchCancelName<Workflow>;
const createEventName = <Workflow extends DispatchWorkflow>(workflow: Workflow) =>
  `${workflow.name}CreateEvent` as DispatchCreateEventName<Workflow>;
const sendEventName = <Workflow extends DispatchWorkflow>(workflow: Workflow) =>
  `${workflow.name}SendEvent` as DispatchSendEventName<Workflow>;

export const dispatchLayer = HttpApiBuilder.group(
  SheetWorkflowsInternalApi,
  "dispatchWorkflows",
  (handlers) => {
    let current = handlers as DispatchHandlers;

    for (const workflow of DispatchWorkflows) {
      current = dispatchHandlers(current).handle(workflow.name, executeWorkflow(workflow));
      current = dispatchHandlers(current).handle(discardName(workflow), discardWorkflow(workflow));
      current = dispatchHandlers(current).handle(resumeName(workflow), resumeWorkflow(workflow));
      current = dispatchHandlers(current).handle(cancelName(workflow), cancelWorkflow(workflow));
      current = dispatchHandlers(current).handle(
        createEventName(workflow),
        createWorkflowEvent(workflow),
      );
      current = dispatchHandlers(current).handle(
        sendEventName(workflow),
        sendWorkflowEvent(workflow),
      );
    }

    return completedHandlers(current);
  },
) satisfies DispatchLayer;
