export { DispatchWorkflowRpcs } from "./sheet-cluster-workflows";
import { DispatchWorkflowRpcs } from "./sheet-cluster-workflows";
import { HealthRpcs } from "./sheet-apis-rpc";

export const SheetClusterRpcs = DispatchWorkflowRpcs.merge(HealthRpcs);
