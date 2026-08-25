import {
  Cause,
  Effect,
  Layer,
  Match,
  Metric,
  Option,
  Predicate,
  Pull,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  defaultWorkflowRunListLimit,
  InvocationConflict,
  InvocationId,
  WorkflowRunListFilter,
  WorkflowRunState,
} from "effect-zero-workflow/contract";
import {
  makeWorkflowHttpRouteCatalog,
  workflowEnqueueErrorStatus,
  workflowHttpServerExecutorFromHandler,
  workflowObservationErrorStatus,
  type WorkflowHttpServerExecutor,
} from "effect-zero-workflow/contract/http/server";
import {
  WorkflowInputRejected,
  WorkflowObservationInvalidData,
  WorkflowObservationError,
  WorkflowTransportUnavailable,
  WorkflowEnqueueError,
} from "effect-zero-workflow/contract/transport";
import {
  WorkflowStore,
  allWorkflowRunStatuses,
  effectWorkflowExecutionId,
  type WorkflowInvocationStore,
  workflowContractExecutionPayload,
  type WorkflowJson,
  type WorkflowRunObservation,
  type WorkflowRunStatusType,
} from "effect-zero-workflow";
import {
  actorProvenanceFromVerifiedOAuthClaims,
  effectivePrincipalFromVerifiedOAuthClaims,
} from "sheet-auth/identity/server";
import { EffectivePrincipal } from "sheet-auth/identity";
import {
  makeOAuthResourceTokenAuthorizer,
  type VerifiedOAuthResourceToken,
} from "sheet-auth/oauth-resource-authorization";
import { Unauthorized } from "typhoon-core/error";
import { SheetWorkflowContractCatalog } from "sheet-workflow-contracts";
import type { SheetWorkflowZeroContext } from "sheet-zero-server";
import { config } from "@/config";
import { sheetWorkflowsHttpEnqueues } from "@/metrics";
import {
  ownerKeyForEffectivePrincipal,
  ReadOnlyWorkflowAuthorization,
} from "@/workflows/readOnly/authorization";
import { makeSelectedWorkflowTransportHandler } from "@/workflows/selected/registry";

const sheetWorkflowHttpContracts = SheetWorkflowContractCatalog;

const workflowStatusesByState: Record<
  typeof WorkflowRunState.Type,
  ReadonlyArray<WorkflowRunStatusType>
> = {
  Pending: ["pending", "running"],
  Success: ["succeeded"],
  Failure: ["failed", "cancelled"],
};

const statusesForObservationFilter = (
  filter: typeof WorkflowRunListFilter.Type,
): ReadonlyArray<WorkflowRunStatusType> => {
  if (Predicate.isUndefined(filter.states) || filter.states.length === 0) {
    return allWorkflowRunStatuses;
  }
  return [...new Set(filter.states.flatMap((state) => workflowStatusesByState[state]))];
};

const materializedRun = (run: WorkflowRunObservation) => ({
  runId: run.runId,
  status: run.status,
  result: run.result,
  error: run.error,
  completedAt: run.completedAt,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
});

export const makeWorkflowInvocationStore = (
  store: typeof WorkflowStore.Service,
): WorkflowInvocationStore<
  SheetWorkflowZeroContext["principal"],
  ReadOnlyWorkflowAuthorization,
  NonNullable<SheetWorkflowZeroContext["actorProvenance"]>
> => ({
  enqueue: (invocation) =>
    Effect.gen(function* () {
      const executionPayload = workflowContractExecutionPayload(invocation);
      // The generic PostgreSQL store compares its command payload during replay.
      // Acceptance time is transport metadata and would make the same invocation
      // look different on an ambiguous retry, while the workflow execution schemas
      // do not consume it.
      const replayStablePayload = {
        invocationId: executionPayload.invocationId,
        input: executionPayload.input,
        principal: executionPayload.principal,
        ...(Predicate.isUndefined(executionPayload.actorProvenance)
          ? {}
          : { actorProvenance: executionPayload.actorProvenance }),
      };
      const executionId = yield* effectWorkflowExecutionId(
        invocation.workflowName,
        invocation.fingerprint.invocationId,
      );

      const recordEnqueue = (outcome: "accepted" | "conflict" | "unavailable") =>
        Metric.update(
          Metric.withAttributes(sheetWorkflowsHttpEnqueues, {
            contract: invocation.fingerprint.contractIdentity,
            outcome,
          }),
          1,
        );

      return yield* store
        .enqueue({
          runId: invocation.fingerprint.invocationId,
          workflowName: invocation.workflowName,
          definitionVersion: invocation.definitionVersion,
          executionId,
          idempotencyKey: invocation.fingerprint.invocationId,
          visibilityKey: invocation.ownerKey,
          principal: Schema.decodeUnknownSync(Schema.Json)(invocation.principal),
          payload: replayStablePayload as unknown as WorkflowJson,
        })
        .pipe(
          Effect.tap(() => recordEnqueue("accepted")),
          Effect.tapError((error) =>
            recordEnqueue(
              Predicate.isTagged("InvocationConflict")(error) ? "conflict" : "unavailable",
            ),
          ),
          Effect.as(invocation.fingerprint),
          Effect.mapError((error) =>
            Schema.is(InvocationConflict)(error)
              ? error
              : new WorkflowTransportUnavailable({
                  operation: "Enqueue",
                  retryable: true,
                  message: "Workflow enqueue transport is unavailable",
                }),
          ),
        );
    }),
  get: (ownerKey, workflowName, invocationId) =>
    withObservationStoreErrorHandling(
      "Get",
      store
        .getRunForOwner(ownerKey, workflowName, invocationId)
        .pipe(Effect.map((run) => (Predicate.isUndefined(run) ? undefined : materializedRun(run)))),
    ),
  list: (ownerKey, workflowName, filter) =>
    withObservationStoreErrorHandling(
      "List",
      store
        .listRunsForOwner(
          ownerKey,
          workflowName,
          statusesForObservationFilter(filter),
          filter.limit ?? defaultWorkflowRunListLimit,
          Predicate.isUndefined(filter.cursor)
            ? undefined
            : {
                createdAt: filter.cursor.submittedAt,
                runId: filter.cursor.invocationId,
              },
        )
        .pipe(Effect.map((runs) => runs.map(materializedRun))),
    ),
});

const makeAuthorizer = (requiredScopes: readonly string[]) =>
  Effect.gen(function* () {
    const issuer = yield* config.sheetAuthIssuer;
    const audience = yield* config.sheetAuthWorkflowHttpAudience;
    return yield* makeOAuthResourceTokenAuthorizer({
      issuer,
      audience,
      requiredScopes,
      headerName: "authorization",
      makeUnauthorized: ({ message, cause }) => new Unauthorized({ message, cause }),
    });
  });

export type WorkflowHttpAuthorizer = Effect.Success<ReturnType<typeof makeAuthorizer>>;

export interface WorkflowHttpGatewayIdentity {
  readonly serviceId: string;
  readonly oauthClientId: string;
}

const principalWithGatewayIdentity = (
  principal: typeof EffectivePrincipal.Type,
  gatewayIdentity: WorkflowHttpGatewayIdentity | undefined,
): typeof EffectivePrincipal.Type =>
  Match.type<typeof EffectivePrincipal.Type>().pipe(
    Match.discriminatorsExhaustive("kind")({
      user: () => principal,
      service: (servicePrincipal) =>
        Predicate.isUndefined(gatewayIdentity) ||
        servicePrincipal.oauthClientId !== gatewayIdentity.oauthClientId
          ? servicePrincipal
          : Schema.decodeUnknownSync(EffectivePrincipal)({
              ...servicePrincipal,
              serviceId: gatewayIdentity.serviceId,
            }),
    }),
  )(principal);

export const contextFromToken = (
  token: VerifiedOAuthResourceToken,
  gatewayIdentity?: WorkflowHttpGatewayIdentity,
): Effect.Effect<SheetWorkflowZeroContext, Unauthorized> =>
  Effect.try({
    try: () => {
      const principal = principalWithGatewayIdentity(
        effectivePrincipalFromVerifiedOAuthClaims(token),
        gatewayIdentity,
      );
      const actorProvenance = actorProvenanceFromVerifiedOAuthClaims(token);
      return {
        ownerKey: ownerKeyForEffectivePrincipal(principal),
        principal,
        ...(Predicate.isUndefined(actorProvenance) ? {} : { actorProvenance }),
      } satisfies SheetWorkflowZeroContext;
    },
    catch: (cause) => new Unauthorized({ message: "Invalid workflow HTTP identity", cause }),
  });

const decodeRequestBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.text.pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () => new WorkflowInputRejected({ message: "Workflow input is invalid" }),
      }),
    ),
  );

const enqueueErrorResponse = (error: WorkflowEnqueueError) =>
  Schema.is(InvocationConflict)(error)
    ? HttpServerResponse.json(
        {
          _tag: error._tag,
          message: error.message,
          invocationId: error.invocationId,
          reason: error.reason,
          existing: error.existing,
          requested: error.requested,
        },
        { status: workflowEnqueueErrorStatus(error) },
      )
    : HttpServerResponse.json(
        { _tag: error._tag, message: error.message },
        { status: workflowEnqueueErrorStatus(error) },
      );

const isEnqueueError = Schema.is(WorkflowEnqueueError);
const isObservationError = Schema.is(WorkflowObservationError);

const observationErrorResponse = (error: WorkflowObservationError) =>
  HttpServerResponse.json(
    { _tag: error._tag, message: error.message },
    { status: workflowObservationErrorStatus(error) },
  );

const routeErrorResponse = (error: unknown) => {
  if (Predicate.isTagged("Unauthorized")(error)) {
    return HttpServerResponse.json(
      { _tag: "Unauthorized", message: "Workflow HTTP authorization is required" },
      { status: 401 },
    );
  }
  if (isObservationError(error)) {
    return observationErrorResponse(error);
  }
  return isEnqueueError(error) ? enqueueErrorResponse(error) : Effect.fail(error);
};

const addWorkflowEnqueueRoute = <E, R>(
  path: string,
  authorizer: WorkflowHttpAuthorizer,
  gatewayIdentity: WorkflowHttpGatewayIdentity | undefined,
  enqueue: (context: SheetWorkflowZeroContext, request: unknown) => Effect.Effect<unknown, E, R>,
) =>
  HttpRouter.add(
    "POST",
    path as HttpRouter.PathInput,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return yield* Effect.gen(function* () {
        const token = yield* authorizer.requireAuthorizedHeaders(request.headers);
        const context = yield* contextFromToken(token, gatewayIdentity);
        const body = yield* decodeRequestBody(request);
        const reference = yield* enqueue(context, body);
        return yield* HttpServerResponse.json(reference, { status: 202 });
      }).pipe(Effect.catch(routeErrorResponse));
    }),
  );

const WorkflowHttpListQuery = Schema.Struct({
  state: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  cursorSubmittedAt: Schema.optional(Schema.String),
  cursorInvocationId: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
});

const invalidObservationRequest = () =>
  new WorkflowObservationInvalidData({ message: "Workflow observation request is invalid" });

const observationStoreUnavailable = () =>
  new WorkflowTransportUnavailable({
    operation: "Observe",
    retryable: true,
    message: "Workflow observation transport is unavailable",
  });

const withObservationStoreErrorHandling = <A, E, R>(
  operation: "Get" | "List",
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, WorkflowTransportUnavailable, R> =>
  effect.pipe(
    Effect.tapError((error) =>
      Effect.logError("Workflow observation store read failed", error).pipe(
        Effect.annotateLogs({ operation }),
      ),
    ),
    Effect.mapError(() => observationStoreUnavailable()),
  );

const decodeWorkflowListFilter = HttpServerRequest.schemaSearchParams(WorkflowHttpListQuery).pipe(
  Effect.mapError(() => invalidObservationRequest()),
  Effect.flatMap(({ state, cursorSubmittedAt, cursorInvocationId, limit }) => {
    const hasSubmittedAt = Predicate.isNotUndefined(cursorSubmittedAt);
    const hasInvocationId = Predicate.isNotUndefined(cursorInvocationId);
    if (hasSubmittedAt !== hasInvocationId) {
      return Effect.fail(invalidObservationRequest());
    }

    const states = Predicate.isUndefined(state)
      ? undefined
      : Array.isArray(state)
        ? state
        : [state];
    const filter = {
      ...(Predicate.isUndefined(states) ? {} : { states }),
      ...(hasSubmittedAt && hasInvocationId
        ? { cursor: { submittedAt: cursorSubmittedAt, invocationId: cursorInvocationId } }
        : {}),
      ...(Predicate.isUndefined(limit) ? {} : { limit }),
    };
    // The generated route handler decodes its input, so pass the validated
    // representation back in its encoded form to avoid decoding transformed
    // cursor dates a second time.
    return Schema.decodeUnknownEffect(WorkflowRunListFilter)(filter).pipe(
      Effect.flatMap((decoded) => Schema.encodeEffect(WorkflowRunListFilter)(decoded)),
      Effect.mapError(() => invalidObservationRequest()),
    );
  }),
);

const observationResponse = <Requirements>(
  events: Stream.Stream<string, WorkflowObservationError, Requirements>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  WorkflowObservationError,
  Requirements | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Requirements>();
    const pull = yield* Stream.toPull(events.pipe(Stream.provideContext(context)));
    const firstChunk = yield* Pull.catchDone(pull.pipe(Effect.map(Option.some)), () =>
      Effect.succeed(Option.none()),
    );
    let firstChunkPending = true;
    const body = Stream.fromPull(
      Effect.succeed(
        Effect.suspend(() => {
          if (!firstChunkPending) {
            return pull;
          }
          firstChunkPending = false;
          return Option.match(firstChunk, {
            onNone: () => Cause.done(),
            onSome: Effect.succeed,
          });
        }),
      ),
    );
    return HttpServerResponse.stream(Stream.encodeText(body), {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
    });
  });

const observationContext = (
  authorizer: WorkflowHttpAuthorizer,
  headers: Headers.Headers,
  gatewayIdentity: WorkflowHttpGatewayIdentity | undefined,
) =>
  authorizer
    .requireAuthorizedHeaders(headers)
    .pipe(Effect.flatMap((token) => contextFromToken(token, gatewayIdentity)));

const addWorkflowObservationRoute = <
  Input,
  DecodeError extends WorkflowObservationError,
  DecodeRequirements,
  Requirements,
>(
  path: string,
  authorizer: WorkflowHttpAuthorizer,
  gatewayIdentity: WorkflowHttpGatewayIdentity | undefined,
  decode: Effect.Effect<Input, DecodeError, DecodeRequirements>,
  observe: (
    context: SheetWorkflowZeroContext,
    input: Input,
  ) => Stream.Stream<string, WorkflowObservationError, Requirements>,
) =>
  HttpRouter.add(
    "GET",
    path as HttpRouter.PathInput,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return yield* Effect.gen(function* () {
        const context = yield* observationContext(authorizer, request.headers, gatewayIdentity);
        const input = yield* decode;
        return yield* observationResponse(observe(context, input));
      }).pipe(Effect.catch(routeErrorResponse));
    }),
  );

const decodeWorkflowInvocationId = HttpRouter.schemaPathParams(
  Schema.Struct({ invocationId: InvocationId }),
).pipe(
  Effect.map(({ invocationId }) => invocationId),
  Effect.mapError(() => invalidObservationRequest()),
);

export const makeWorkflowHttpRoutesLayer = <Requirements>(
  enqueueAuthorizer: WorkflowHttpAuthorizer,
  observationAuthorizer: WorkflowHttpAuthorizer,
  executor: WorkflowHttpServerExecutor<SheetWorkflowZeroContext, Requirements>,
  gatewayIdentity?: WorkflowHttpGatewayIdentity,
) => {
  const workflowRoutes = makeWorkflowHttpRouteCatalog(sheetWorkflowHttpContracts, executor);
  const routeLayers = workflowRoutes.flatMap(({ routes, enqueue, get, list }) => [
    addWorkflowEnqueueRoute(routes.enqueue, enqueueAuthorizer, gatewayIdentity, enqueue),
    addWorkflowObservationRoute(
      routes.get,
      observationAuthorizer,
      gatewayIdentity,
      decodeWorkflowInvocationId,
      get,
    ),
    addWorkflowObservationRoute(
      routes.list,
      observationAuthorizer,
      gatewayIdentity,
      decodeWorkflowListFilter,
      list,
    ),
  ]);

  return Layer.mergeAll(Layer.empty, ...routeLayers);
};

export const workflowHttpRoutesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const gatewayIdentity = yield* Effect.all({
      serviceId: config.sheetBotGatewayServiceId,
      oauthClientId: config.sheetBotGatewayOAuthClientId,
    });
    const enqueueAuthorizer = yield* makeAuthorizer(["workflow.enqueue"]);
    const observationAuthorizer = yield* makeAuthorizer(["workflow.observe"]);
    const handler = yield* makeSelectedWorkflowTransportHandler(makeWorkflowInvocationStore(store));
    const executor = workflowHttpServerExecutorFromHandler(handler);
    return makeWorkflowHttpRoutesLayer(
      enqueueAuthorizer,
      observationAuthorizer,
      executor,
      gatewayIdentity,
    );
  }),
);
