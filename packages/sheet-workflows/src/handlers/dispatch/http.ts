import { Effect, Layer, Schema } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  DispatchWorkflowHttpApi,
  SheetWorkflowsInternalApi,
} from "sheet-ingress-api/sheet-workflows-internal";
import { DispatchWorkflowResumePayload } from "sheet-ingress-api/sheet-workflows-workflows";
import { DispatchWorkflows } from "@/workflows/dispatchWorkflows";

type DispatchLayer = Layer.Layer<
  HttpApiGroup.ApiGroup<"sheet-workflows-internal", "dispatchWorkflows">,
  never,
  WorkflowEngine.WorkflowEngine
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
  WorkflowEngine.WorkflowEngine
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
type DispatchWorkflowResumePayloadType = Schema.Schema.Type<typeof DispatchWorkflowResumePayload>;
type DynamicDispatchHandlers = {
  readonly handle: <Name extends DispatchEndpointName>(
    name: Name,
    handler: DispatchEndpointHandler<Name>,
  ) => DispatchHandlers;
};

const dispatchHandlers = (handlers: DispatchHandlers): DynamicDispatchHandlers =>
  handlers as unknown as DynamicDispatchHandlers;

const completedHandlers = (handlers: DispatchHandlers) =>
  handlers as unknown as HttpApiBuilder.Handlers<WorkflowEngine.WorkflowEngine, never>;

const workflowExecute = <Workflow extends DispatchWorkflow>(workflow: Workflow) =>
  workflow.execute as unknown as (
    payload: DispatchEndpointPayload<DispatchExecuteName<Workflow>>,
  ) => ReturnType<Workflow["execute"]>;

const workflowDiscard = <Workflow extends DispatchWorkflow>(workflow: Workflow) =>
  workflow.execute as unknown as (
    payload: DispatchEndpointPayload<DispatchDiscardName<Workflow>>,
    options: { readonly discard: true },
  ) => Effect.Effect<string, never, WorkflowEngine.WorkflowEngine>;

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
    return yield* discard(payload, { discard: true });
  }) as unknown as DispatchEndpointHandler<DispatchDiscardName<Workflow>>;
};

const resumeWorkflow = <Workflow extends DispatchWorkflow>(
  workflow: Workflow,
): DispatchEndpointHandler<DispatchResumeName<Workflow>> => {
  return Effect.fnUntraced(function* ({
    payload,
  }: {
    readonly payload: DispatchWorkflowResumePayloadType;
  }) {
    return yield* workflow.resume(payload.executionId);
  }) as unknown as DispatchEndpointHandler<DispatchResumeName<Workflow>>;
};

const discardName = <Workflow extends DispatchWorkflow>(workflow: Workflow) =>
  `${workflow.name}Discard` as DispatchDiscardName<Workflow>;

const resumeName = <Workflow extends DispatchWorkflow>(workflow: Workflow) =>
  `${workflow.name}Resume` as DispatchResumeName<Workflow>;

export const dispatchLayer = HttpApiBuilder.group(
  SheetWorkflowsInternalApi,
  "dispatchWorkflows",
  (handlers) => {
    let current = handlers as DispatchHandlers;

    for (const workflow of DispatchWorkflows) {
      current = dispatchHandlers(current).handle(workflow.name, executeWorkflow(workflow));
      current = dispatchHandlers(current).handle(discardName(workflow), discardWorkflow(workflow));
      current = dispatchHandlers(current).handle(resumeName(workflow), resumeWorkflow(workflow));
    }

    return completedHandlers(current);
  },
) satisfies DispatchLayer;
