import { Effect, Layer, Metric, Predicate, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { InvocationConflict } from "effect-zero-workflow/contract";
import {
  makeWorkflowHttpRouteCatalog,
  workflowEnqueueErrorStatus,
  workflowHttpServerExecutorFromHandler,
} from "effect-zero-workflow/contract/http/server";
import {
  WorkflowInputRejected,
  WorkflowTransportUnavailable,
  WorkflowEnqueueError,
  type WorkflowObservationError,
} from "effect-zero-workflow/contract/transport";
import {
  WorkflowStore,
  effectWorkflowExecutionId,
  type WorkflowInvocationStore,
  workflowContractExecutionPayload,
  type WorkflowJson,
} from "effect-zero-workflow";
import {
  actorProvenanceFromVerifiedOAuthClaims,
  effectivePrincipalFromVerifiedOAuthClaims,
} from "sheet-auth/identity/server";
import {
  makeOAuthResourceTokenAuthorizer,
  type VerifiedOAuthResourceToken,
} from "sheet-auth/oauth-resource-authorization";
import { Unauthorized } from "typhoon-core/error";
import {
  AnnouncementsDeliverUpdate,
  CheckinsOpen,
  CheckinsRespond,
  CheckinsTestAuto,
  CalculationsRecalculateSheet,
  ConversationsDeliverConfig,
  ConversationsSetLockdown,
  ConversationsUpdateConfigAndDeliver,
  MembersKick,
  PreferencesDeliverStatus,
  PreferencesUpdateAndDeliver,
  RoomOrdersCreate,
  RoomOrdersNavigate,
  RoomOrdersPinTentative,
  RoomOrdersSend,
  SchedulesDeliverUserSchedule,
  ScreenshotsCaptureAndDeliver,
  ServicesDeliverStatus,
  SlotsDeliverList,
  SlotsOpen,
  SlotsPublishButton,
  TeamsDeliverList,
  TeamSubmissionsDecide,
  TeamSubmissionsProcess,
  WorkspacesDeliverConfig,
  WorkspacesDeliverWelcome,
  WorkspacesSetMonitorRoleAndDeliver,
  WorkspacesUpdateConfigAndDeliver,
} from "sheet-workflow-contracts";
import type { SheetWorkflowZeroContext } from "sheet-zero-server";
import { config } from "@/config";
import { sheetWorkflowsHttpEnqueues } from "@/metrics";
import {
  ownerKeyForEffectivePrincipal,
  ReadOnlyWorkflowAuthorization,
} from "@/workflows/readOnly/authorization";
import { makeSelectedWorkflowTransportHandler } from "@/workflows/selected/registry";

export const sheetWorkflowHttpEnqueueContracts = Object.freeze([
  ServicesDeliverStatus,
  SchedulesDeliverUserSchedule,
  CalculationsRecalculateSheet,
  WorkspacesDeliverWelcome,
  TeamSubmissionsProcess,
  TeamSubmissionsDecide,
  AnnouncementsDeliverUpdate,
  CheckinsOpen,
  CheckinsTestAuto,
  CheckinsRespond,
  RoomOrdersCreate,
  RoomOrdersNavigate,
  RoomOrdersSend,
  RoomOrdersPinTentative,
  SlotsDeliverList,
  SlotsPublishButton,
  SlotsOpen,
  MembersKick,
  PreferencesDeliverStatus,
  PreferencesUpdateAndDeliver,
  WorkspacesDeliverConfig,
  WorkspacesUpdateConfigAndDeliver,
  WorkspacesSetMonitorRoleAndDeliver,
  ConversationsDeliverConfig,
  ConversationsUpdateConfigAndDeliver,
  ConversationsSetLockdown,
  TeamsDeliverList,
  ScreenshotsCaptureAndDeliver,
] as const);

const observeUnavailable = (): Effect.Effect<never, WorkflowObservationError> =>
  Effect.fail(
    new WorkflowTransportUnavailable({
      operation: "Observe",
      retryable: true,
      message: "Workflow observation is unavailable on this enqueue boundary",
    }),
  );

const makeWorkflowInvocationStore = (
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
  get: () => observeUnavailable(),
  list: () => observeUnavailable(),
});

const makeAuthorizer = Effect.gen(function* () {
  const issuer = yield* config.sheetAuthIssuer;
  const audience = yield* config.sheetAuthWorkflowHttpAudience;
  return yield* makeOAuthResourceTokenAuthorizer({
    issuer,
    audience,
    requiredScopes: ["workflow.enqueue"],
    headerName: "authorization",
    makeUnauthorized: ({ message, cause }) => new Unauthorized({ message, cause }),
  });
});

const contextFromToken = (
  token: VerifiedOAuthResourceToken,
): Effect.Effect<SheetWorkflowZeroContext, Unauthorized> =>
  Effect.try({
    try: () => {
      const principal = effectivePrincipalFromVerifiedOAuthClaims(token);
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

const routeErrorResponse = (error: unknown) => {
  if (Predicate.isTagged("Unauthorized")(error)) {
    return HttpServerResponse.json(
      { _tag: "Unauthorized", message: "Workflow HTTP authorization is required" },
      { status: 401 },
    );
  }
  return isEnqueueError(error) ? enqueueErrorResponse(error) : Effect.fail(error);
};

const addWorkflowEnqueueRoute = <E, R>(
  path: string,
  authorizer: Effect.Success<typeof makeAuthorizer>,
  enqueue: (context: SheetWorkflowZeroContext, request: unknown) => Effect.Effect<unknown, E, R>,
) =>
  HttpRouter.add(
    "POST",
    path as HttpRouter.PathInput,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return yield* Effect.gen(function* () {
        const token = yield* authorizer.requireAuthorizedHeaders(request.headers);
        const context = yield* contextFromToken(token);
        const body = yield* decodeRequestBody(request);
        const reference = yield* enqueue(context, body);
        return yield* HttpServerResponse.json(reference, { status: 202 });
      }).pipe(Effect.catch(routeErrorResponse));
    }),
  );

export const workflowHttpRoutesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const authorizer = yield* makeAuthorizer;
    const handler = yield* makeSelectedWorkflowTransportHandler(makeWorkflowInvocationStore(store));
    const executor = workflowHttpServerExecutorFromHandler(handler);
    const workflowRoutes = makeWorkflowHttpRouteCatalog(
      sheetWorkflowHttpEnqueueContracts,
      executor,
    );
    const routeLayers = workflowRoutes.map(({ routes, enqueue }) =>
      addWorkflowEnqueueRoute(routes.enqueue, authorizer, enqueue),
    );

    return Layer.mergeAll(Layer.empty, ...routeLayers);
  }),
);
