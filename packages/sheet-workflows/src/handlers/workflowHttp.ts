import { Effect, Layer, Predicate, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { InvocationConflict } from "effect-zero-workflow/contract";
import {
  makeWorkflowHttpRouteHandlers,
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
import { ServicesDeliverStatus } from "sheet-workflow-contracts";
import {
  ServiceSheetWorkflowContracts,
  ServiceSheetWorkflowRegistrations,
} from "@/workflows/services";
import type { SheetWorkflowZeroContext } from "sheet-zero-server";
import { config } from "@/config";
import {
  ownerKeyForEffectivePrincipal,
  ReadOnlyWorkflowAuthorization,
} from "@/workflows/readOnly/authorization";
import { makeSheetWorkflowTransportHandler } from "@/workflows/shared/registration";

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
      // look different on an ambiguous retry, while the service-status execution
      // schema does not consume it.
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

export const workflowHttpRoutesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const authorizer = yield* makeAuthorizer;
    const handler = yield* makeSheetWorkflowTransportHandler(
      ServiceSheetWorkflowContracts,
      ServiceSheetWorkflowRegistrations,
      makeWorkflowInvocationStore(store),
    );
    const route = makeWorkflowHttpRouteHandlers(
      ServicesDeliverStatus,
      workflowHttpServerExecutorFromHandler(handler),
    );

    return HttpRouter.add(
      "POST",
      route.routes.enqueue as HttpRouter.PathInput,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* Effect.gen(function* () {
          const token = yield* authorizer.requireAuthorizedHeaders(request.headers);
          const context = yield* contextFromToken(token);
          const body = yield* decodeRequestBody(request);
          const reference = yield* route.enqueue(context, body);
          return yield* HttpServerResponse.json(reference, { status: 202 });
        }).pipe(Effect.catchIf(() => true, routeErrorResponse));
      }),
    );
  }),
);
