import { Effect, Schema } from "effect";
import { HttpClientRequest, HttpClientResponse, type HttpClient } from "effect/unstable/http";
import {
  InvocationId,
  mapWorkflowContractTree,
  type AnyWorkflowContract,
  type WorkflowClient,
} from "effect-zero-workflow/contract";
import { makeWorkflowHttpClient } from "effect-zero-workflow/contract/http";
import type {
  WorkflowEnqueueError,
  WorkflowObservationError,
} from "effect-zero-workflow/contract/transport";
import {
  RolloutGateDecision,
  RolloutGateEvaluatePath,
  SheetWorkflowContracts,
  type RolloutGateEvaluationRequest,
} from "sheet-workflow-contracts";
import type { SheetWorkflowHttpClientOptions } from "./options";

type WorkflowHttpClientTree<Node> = Node extends AnyWorkflowContract
  ? WorkflowClient<Node, WorkflowEnqueueError, WorkflowObservationError>
  : { readonly [Key in keyof Node]: WorkflowHttpClientTree<Node[Key]> };

export type SheetWorkflowHttpClients = WorkflowHttpClientTree<typeof SheetWorkflowContracts>;

const PublicMessage = Schema.Trimmed.check(Schema.isNonEmpty());
const WorkflowTransportOperation = Schema.Literals(["Enqueue", "Observe"]);

export class WorkflowInputRejected extends Schema.TaggedErrorClass<WorkflowInputRejected>()(
  "WorkflowInputRejected",
  { message: PublicMessage },
) {}

export class WorkflowTransportUnavailable extends Schema.TaggedErrorClass<WorkflowTransportUnavailable>()(
  "WorkflowTransportUnavailable",
  {
    operation: WorkflowTransportOperation,
    retryable: Schema.Boolean,
    message: PublicMessage,
  },
) {}

export class RolloutGateBaseUrlInvalid extends Schema.TaggedErrorClass<RolloutGateBaseUrlInvalid>()(
  "RolloutGateBaseUrlInvalid",
  { message: PublicMessage },
) {}

export const makeWorkflowInvocationId = () =>
  Schema.decodeUnknownEffect(InvocationId)(globalThis.crypto.randomUUID());

export const makeSheetWorkflowHttpClients = (
  httpClient: HttpClient.HttpClient,
  options: SheetWorkflowHttpClientOptions,
): SheetWorkflowHttpClients =>
  mapWorkflowContractTree(SheetWorkflowContracts, (contract) =>
    makeWorkflowHttpClient(contract, httpClient, options),
  ) as SheetWorkflowHttpClients;

export const makeRolloutGateHttpClient = (
  httpClient: HttpClient.HttpClient,
  options: SheetWorkflowHttpClientOptions,
) => {
  const rolloutGateUrl = Effect.try({
    try: () =>
      new URL(
        RolloutGateEvaluatePath.slice(1),
        options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
      ),
    catch: () => new RolloutGateBaseUrlInvalid({ message: "Rollout Gate base URL is invalid" }),
  });

  return {
    evaluate: (input: RolloutGateEvaluationRequest) =>
      rolloutGateUrl.pipe(
        Effect.flatMap((url) =>
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.bodyJson(input),
            Effect.flatMap(httpClient.execute),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(RolloutGateDecision)),
          ),
        ),
      ),
  };
};

export type { SheetWorkflowHttpClientOptions } from "./options";
export { sheetWorkflowHttpRouteManifest } from "./routes";
