import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { annotateSheetScopePolicy, SheetScopePolicies } from "./middlewares/rpcScopePolicy";
import { SheetIngressServiceAuthorization } from "./middlewares/sheetIngressServiceAuthorization/tag";
import {
  DispatchWorkflowExecutionId,
  DispatchWorkflowResumePayload,
  DispatchWorkflows,
} from "./sheet-workflows-workflows";
import { SheetAuthTokenAuthorization } from "./middlewares/sheetAuthTokenAuthorization/tag";

const workflowDispatchScopePolicy = SheetScopePolicies.oauth("workflow.dispatch");

const workflowPath = (tag: string) => `/internal/workflows/${tag.replace(/\./g, "/")}`;

const dispatchWorkflowEndpoints = DispatchWorkflows.flatMap((workflow) => {
  const path = workflowPath(workflow.name) as `/${string}`;

  return [
    annotateSheetScopePolicy(
      HttpApiEndpoint.post(workflow.name, path, {
        payload: workflow.payloadSchema,
        success: workflow.successSchema,
        error: workflow.errorSchema,
      }).annotateMerge(workflow.annotations),
      workflowDispatchScopePolicy,
    ),
    annotateSheetScopePolicy(
      HttpApiEndpoint.post(`${workflow.name}Discard`, `${path}/discard` as `/${string}`, {
        payload: workflow.payloadSchema,
        success: DispatchWorkflowExecutionId,
      }).annotateMerge(workflow.annotations),
      workflowDispatchScopePolicy,
    ),
    annotateSheetScopePolicy(
      HttpApiEndpoint.post(`${workflow.name}Resume`, `${path}/resume` as `/${string}`, {
        payload: DispatchWorkflowResumePayload,
        success: Schema.Void,
      }).annotateMerge(workflow.annotations),
      workflowDispatchScopePolicy,
    ),
  ] as const;
});

const [firstDispatchWorkflowEndpoint, ...remainingDispatchWorkflowEndpoints] =
  dispatchWorkflowEndpoints;

if (!firstDispatchWorkflowEndpoint) {
  throw new Error("DispatchWorkflows must include at least one workflow");
}

export const DispatchWorkflowHttpApi = HttpApiGroup.make("dispatchWorkflows")
  .add(firstDispatchWorkflowEndpoint, ...remainingDispatchWorkflowEndpoints)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Dispatch Workflows");

export class SheetWorkflowsInternalApi extends HttpApi.make("sheet-workflows-internal")
  .add(DispatchWorkflowHttpApi)
  .middleware(SheetIngressServiceAuthorization) {}
