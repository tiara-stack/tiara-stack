import { WorkflowProxyServer } from "effect/unstable/workflow";
import { DispatchWorkflows } from "@/workflows/dispatchWorkflows";

export const dispatchLayer = WorkflowProxyServer.layerRpcHandlers(DispatchWorkflows);
