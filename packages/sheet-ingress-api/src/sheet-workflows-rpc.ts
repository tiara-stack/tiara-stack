export { DispatchWorkflowRpcs } from "./sheet-workflows-workflows";
import { DispatchWorkflowRpcs } from "./sheet-workflows-workflows";
import { HealthRpcs } from "./sheet-apis-rpc";

export const SheetWorkflowsRpcs = DispatchWorkflowRpcs.merge(HealthRpcs);
