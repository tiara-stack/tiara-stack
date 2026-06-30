import { HealthResponseSchema } from "./handlers/health/schema";
import {
  DispatchWorkflowRequests,
  type DispatchWorkflowRequestDescriptor,
} from "./sheet-workflows-workflows";
import { UnknownError } from "typhoon-core/error";

export const SheetWorkflowsRpcs = {
  requests: new Map<string, DispatchWorkflowRequestDescriptor>([
    ...DispatchWorkflowRequests,
    ["health.live", { _tag: "health.live", successSchema: HealthResponseSchema }],
    [
      "health.ready",
      { _tag: "health.ready", successSchema: HealthResponseSchema, errorSchema: UnknownError },
    ],
  ]),
};
