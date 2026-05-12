import { Layer } from "effect";
import { WorkflowProxyServer } from "effect/unstable/workflow";
import { DispatchWorkflows } from "sheet-ingress-api/sheet-cluster-workflows";
import { dispatchWorkflowLayer } from "@/workflows/dispatch";

export const dispatchLayer = WorkflowProxyServer.layerRpcHandlers(DispatchWorkflows).pipe(
  Layer.provide(dispatchWorkflowLayer),
);
