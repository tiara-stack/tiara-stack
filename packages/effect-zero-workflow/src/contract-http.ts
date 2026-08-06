import { Effect, Option, Predicate, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  InvocationConflict,
  InvocationId,
  WorkflowRunListFilter,
  makeRunReference,
  makeWorkflowRunSchema,
  type AnyWorkflowContract,
  type WorkflowClient,
  type WorkflowEnqueueOptions,
  type WorkflowRun,
} from "./contract";
import {
  WorkflowInputRejected,
  WorkflowInvocationUnauthorized,
  WorkflowObservationInvalidData,
  WorkflowObservationUnauthorized,
  WorkflowTransportUnavailable,
  WorkflowEnqueueError,
  WorkflowEnqueueRequest,
  WorkflowObservationError,
  workflowContractRoutes,
} from "./contract-transport";

export interface WorkflowHttpClientOptions {
  readonly baseUrl: string;
  readonly transformRequest?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest;
}

const makeInvocationId = (): InvocationId =>
  Schema.decodeUnknownSync(InvocationId)(globalThis.crypto.randomUUID());

const urlFor = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

const transportUnavailable = (operation: "Enqueue" | "Observe", message: string) =>
  new WorkflowTransportUnavailable({ operation, retryable: true, message });

const isEnqueueError = Schema.is(WorkflowEnqueueError);

const isObservationError = Schema.is(WorkflowObservationError);

const execute = (
  httpClient: HttpClient.HttpClient,
  options: WorkflowHttpClientOptions,
  request: HttpClientRequest.HttpClientRequest,
) => httpClient.execute(options.transformRequest?.(request) ?? request);

const enqueueResponse = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<void, WorkflowEnqueueError> => {
  if (response.status === 400) {
    return Effect.fail(new WorkflowInputRejected({ message: "Workflow input was rejected" }));
  }
  if (response.status === 401 || response.status === 403) {
    return Effect.fail(
      new WorkflowInvocationUnauthorized({ message: "Workflow invocation is unauthorized" }),
    );
  }
  if (response.status === 409) {
    return HttpClientResponse.schemaBodyJson(InvocationConflict)(response).pipe(
      Effect.flatMap(Effect.fail),
      Effect.mapError((error) =>
        Predicate.isTagged("InvocationConflict")(error)
          ? error
          : transportUnavailable("Enqueue", "Conflict response was invalid"),
      ),
    );
  }
  return HttpClientResponse.filterStatusOk(response).pipe(
    Effect.asVoid,
    Effect.mapError(() =>
      transportUnavailable("Enqueue", `Workflow enqueue failed with ${response.status}`),
    ),
  );
};

const observationResponse = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<HttpClientResponse.HttpClientResponse, WorkflowObservationError> => {
  if (response.status === 401 || response.status === 403) {
    return Effect.fail(
      new WorkflowObservationUnauthorized({ message: "Workflow observation is unauthorized" }),
    );
  }
  return HttpClientResponse.filterStatusOk(response).pipe(
    Effect.mapError(() =>
      transportUnavailable("Observe", `Workflow observation failed with ${response.status}`),
    ),
  );
};

export const decodeWorkflowSse = <
  S extends Schema.Top & { readonly DecodingServices: never },
  Error,
  Requirements,
>(
  schema: S,
  stream: Stream.Stream<Uint8Array, Error, Requirements>,
): Stream.Stream<S["Type"], WorkflowObservationError, Requirements | S["DecodingServices"]> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.startsWith("data:")),
    Stream.mapEffect((line) =>
      Effect.try({
        try: () => JSON.parse(line.slice(5).trim()),
        catch: () =>
          new WorkflowObservationInvalidData({ message: "Workflow SSE data is not JSON" }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.mapError((error) =>
          Predicate.isTagged("WorkflowObservationInvalidData")(error)
            ? error
            : new WorkflowObservationInvalidData({
                message: "Workflow SSE data does not match its contract",
              }),
        ),
      ),
    ),
    Stream.mapError(
      (error): WorkflowObservationError =>
        isObservationError(error)
          ? error
          : transportUnavailable("Observe", "Workflow event stream failed"),
    ),
  );

export const encodeWorkflowSse = <S extends Schema.Top & { readonly EncodingServices: never }>(
  schema: S,
  value: Schema.Schema.Type<S>,
): Effect.Effect<string, WorkflowObservationInvalidData> =>
  Schema.encodeEffect(schema)(value).pipe(
    Effect.flatMap((encoded) =>
      Effect.try({
        try: () => `data: ${JSON.stringify(encoded)}\n\n`,
        catch: () =>
          new WorkflowObservationInvalidData({
            message: "Workflow event is not JSON encodable",
          }),
      }),
    ),
    Effect.mapError((error) =>
      Predicate.isTagged("WorkflowObservationInvalidData")(error)
        ? error
        : new WorkflowObservationInvalidData({
            message: "Workflow event does not match its contract",
          }),
    ),
  );

const listUrl = (
  contract: AnyWorkflowContract,
  options: WorkflowHttpClientOptions,
  filter: typeof WorkflowRunListFilter.Type,
): string => {
  const query: Array<readonly [string, string]> = [];
  for (const state of filter.states ?? []) {
    query.push(["state", state]);
  }
  if (Predicate.isNotUndefined(filter.cursor)) {
    query.push(["cursorSubmittedAt", filter.cursor.submittedAt.toISOString()]);
    query.push(["cursorInvocationId", filter.cursor.invocationId]);
  }
  if (Predicate.isNotUndefined(filter.limit)) {
    query.push(["limit", String(filter.limit)]);
  }
  const suffix = query
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const url = urlFor(options.baseUrl, workflowContractRoutes(contract).list);
  return suffix.length === 0 ? url : `${url}?${suffix}`;
};

export const makeWorkflowHttpClient = <Contract extends AnyWorkflowContract>(
  contract: Contract,
  httpClient: HttpClient.HttpClient,
  options: WorkflowHttpClientOptions,
): WorkflowClient<Contract, WorkflowEnqueueError, WorkflowObservationError> => ({
  enqueue: (input, enqueueOptions?: WorkflowEnqueueOptions) => {
    const invocationId = enqueueOptions?.invocationId ?? makeInvocationId();
    return Schema.encodeEffect(WorkflowEnqueueRequest(contract))({ invocationId, input }).pipe(
      Effect.flatMap((body) =>
        HttpClientRequest.bodyJson(
          HttpClientRequest.post(urlFor(options.baseUrl, workflowContractRoutes(contract).enqueue)),
          body,
        ),
      ),
      Effect.flatMap((request) => execute(httpClient, options, request)),
      Effect.flatMap(enqueueResponse),
      Effect.as(makeRunReference(contract, invocationId)),
      Effect.mapError((error) =>
        isEnqueueError(error)
          ? error
          : transportUnavailable("Enqueue", "Workflow enqueue request failed"),
      ),
    );
  },
  get: (reference) => {
    const route = workflowContractRoutes(contract).get.replace(
      ":invocationId",
      encodeURIComponent(reference.invocationId),
    );
    const schema = Schema.OptionFromNullishOr(makeWorkflowRunSchema(contract));
    return Stream.unwrap(
      execute(httpClient, options, HttpClientRequest.get(urlFor(options.baseUrl, route))).pipe(
        Effect.flatMap(observationResponse),
        Effect.map((response) => decodeWorkflowSse(schema, response.stream)),
        Effect.mapError((error) =>
          isObservationError(error)
            ? error
            : transportUnavailable("Observe", "Workflow observation request failed"),
        ),
      ),
    ) as Stream.Stream<Option.Option<WorkflowRun<Contract>>, WorkflowObservationError>;
  },
  list: (filter = {}) => {
    const schema = Schema.Array(makeWorkflowRunSchema(contract));
    return Stream.unwrap(
      execute(httpClient, options, HttpClientRequest.get(listUrl(contract, options, filter))).pipe(
        Effect.flatMap(observationResponse),
        Effect.map((response) => decodeWorkflowSse(schema, response.stream)),
        Effect.mapError((error) =>
          isObservationError(error)
            ? error
            : transportUnavailable("Observe", "Workflow list request failed"),
        ),
      ),
    ) as Stream.Stream<ReadonlyArray<WorkflowRun<Contract>>, WorkflowObservationError>;
  },
});

export const makeWorkflowHttpEnqueueClient = <Contract extends AnyWorkflowContract>(
  contract: Contract,
  httpClient: HttpClient.HttpClient,
  options: WorkflowHttpClientOptions,
) => makeWorkflowHttpClient(contract, httpClient, options).enqueue;

export const workflowHttpRouteManifest = (contracts: ReadonlyArray<AnyWorkflowContract>) =>
  Object.freeze(
    contracts.flatMap((contract) => {
      const routes = workflowContractRoutes(contract);
      return [
        Object.freeze({ method: "POST" as const, path: routes.enqueue }),
        Object.freeze({ method: "GET" as const, path: routes.get }),
        Object.freeze({ method: "GET" as const, path: routes.list }),
      ];
    }),
  );
