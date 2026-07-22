import { Cause, Duration, Effect, Option, Predicate, Random, Schema } from "effect";
import { Activity } from "effect/unstable/workflow";
import { DispatchButtonEntity, type DispatchButtonOperation } from "@/entities/dispatchButton";
import { type DispatchWorkflowOperation, type DispatchRequester } from "sheet-ingress-api/internal";
import type { ClientRef } from "sheet-ingress-api/schemas/client";
import { normalizeDispatchError } from "@/handlers/shared/dispatchError";
import {
  isInteractionFailureHandled,
  unwrapInteractionFailure,
} from "@/handlers/shared/interactionFailure";
import { ClientDeliveryClient, ClientDeliveryClientRef } from "@/services";
import { DispatchClusterWorkflows } from "../dispatchWorkflows";
import { dispatchFailureResponse, dispatchFailureTrace } from "./failure";
import { retryClusterPersistenceCause } from "./persistence";

const {
  DispatchCheckinButtonWorkflow,
  DispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow,
  DispatchSlotOpenButtonWorkflow,
  DispatchTeamSubmissionConfirmButtonWorkflow,
  DispatchTeamSubmissionRejectButtonWorkflow,
} = DispatchClusterWorkflows;

const interactionFailureNotificationTimeout = Duration.seconds(10);

const withRequestClientRef = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  clientRef: ClientRef | undefined,
) =>
  clientRef === undefined
    ? effect
    : effect.pipe(Effect.provideService(ClientDeliveryClientRef, clientRef));

const requestClientRef = (request: { readonly payload: { readonly client: ClientRef } }) =>
  request.payload.client;

const notifyInteractionFailure = (
  clientRef: ClientRef | undefined,
  interactionResponseToken: string | undefined,
  error: unknown,
) =>
  Effect.gen(function* () {
    const unwrappedError = unwrapInteractionFailure(error);
    const correlationId = yield* Random.nextUUIDv4;
    yield* Effect.logError("Dispatch operation failed", {
      correlationId,
      error: dispatchFailureTrace(unwrappedError),
    }).pipe(Effect.annotateLogs({ correlationId }));
    if (!Predicate.isString(interactionResponseToken) || interactionResponseToken.length === 0) {
      return;
    }
    const botClient = yield* ClientDeliveryClient;
    const response = dispatchFailureResponse(unwrappedError, correlationId);
    yield* botClient
      .updateOriginalInteractionResponse(interactionResponseToken, response.payload)
      .pipe(
        Effect.timeout(interactionFailureNotificationTimeout),
        Effect.catch((notifyError) =>
          Effect.logWarning("Failed to deliver dispatch failure notification").pipe(
            Effect.annotateLogs({ correlationId, notifyError }),
          ),
        ),
      );
  }).pipe((effect) => withRequestClientRef(effect, clientRef));

type DispatchWorkflowRequest = {
  readonly requester: DispatchRequester;
  readonly payload: { readonly client: ClientRef };
};

type DispatchWorkflowHandlerOptions<
  Payload extends Schema.Schema<DispatchWorkflowRequest>,
  Success extends Schema.Top,
  Error extends Schema.Top,
  TAuthorization,
  RAuthorize,
  RExecute,
> = {
  readonly operation: DispatchWorkflowOperation;
  readonly workflow: {
    readonly payloadSchema: Payload;
    readonly successSchema: Success;
    readonly errorSchema: Error;
  };
  readonly getInteractionToken: (request: Payload["Type"]) => string | undefined;
  readonly authorize: (
    request: Payload["Type"],
  ) => Effect.Effect<TAuthorization, unknown, RAuthorize>;
  readonly execute: (
    request: Payload["Type"],
    authorization: TAuthorization,
  ) => Effect.Effect<Success["Type"], unknown, RExecute>;
};

type DispatchButtonWorkflowHandlerOptions<
  TOperation extends DispatchButtonOperation,
  Payload extends Schema.Schema<DispatchWorkflowRequest>,
  Success extends Schema.Top,
  Error extends Schema.Top,
  TAuthorization,
  RAuthorize,
  RExecute,
> = DispatchWorkflowHandlerOptions<
  Payload,
  Success,
  Error,
  TAuthorization,
  RAuthorize,
  RExecute
> & {
  readonly operation: TOperation;
};

const validateActivityEffect = <Success extends Schema.Top, Error extends Schema.Top, R>(
  effect: Effect.Effect<unknown, unknown, R>,
  successSchema: Success,
  errorSchema: Error,
) =>
  Effect.matchEffect(effect, {
    onFailure: (error) =>
      Schema.decodeUnknownEffect(errorSchema)(error).pipe(
        Effect.orDie,
        Effect.flatMap((decodedError) => Effect.fail(decodedError)),
      ),
    onSuccess: (value) => Schema.decodeUnknownEffect(successSchema)(value).pipe(Effect.orDie),
  });

const WorkflowAttributesPayload = Schema.Struct({
  dispatchRequestId: Schema.optional(Schema.String),
});

const DispatchButtonMessageIdPayload = Schema.Struct({
  messageId: Schema.String,
});

const workflowAttributes = (
  operation: DispatchWorkflowOperation,
  executionId: string,
  request: { readonly payload: unknown; readonly requester: DispatchRequester },
) => {
  const dispatchRequestId = Option.match(
    Schema.decodeUnknownOption(WorkflowAttributesPayload)(request.payload),
    {
      onNone: () => undefined,
      onSome: (payload) => payload.dispatchRequestId,
    },
  );

  return {
    operation,
    executionId,
    dispatchRequestId,
  };
};

const notifyUnhandledDispatchFailure = (
  clientRef: ClientRef | undefined,
  interactionResponseToken: string | undefined,
  attributes: ReturnType<typeof workflowAttributes>,
) =>
  Effect.tapCause((cause) => {
    if (Cause.hasInterrupts(cause)) {
      return Effect.void;
    }
    const error = Cause.findErrorOption(cause);
    return Option.isSome(error) && isInteractionFailureHandled(error.value)
      ? Effect.void
      : notifyInteractionFailure(clientRef, interactionResponseToken, cause).pipe(
          Effect.withSpan("DispatchWorkflow.notifyInteractionFailure", { attributes }),
        );
  });

const finalizeDispatchWorkflow = <A, E, R, Error extends Schema.Top>({
  attributes,
  clientRef,
  dispatch,
  errorSchema,
  interactionResponseToken,
  operation,
}: {
  readonly attributes: ReturnType<typeof workflowAttributes>;
  readonly clientRef: ClientRef | undefined;
  readonly dispatch: Effect.Effect<A, E, R>;
  readonly errorSchema: Error;
  readonly interactionResponseToken: string | undefined;
  readonly operation: DispatchWorkflowOperation;
}) =>
  retryClusterPersistenceCause(dispatch).pipe(
    notifyUnhandledDispatchFailure(clientRef, interactionResponseToken, attributes),
    Effect.mapError((error) => {
      const unwrappedError = unwrapInteractionFailure(error);
      return Schema.is(errorSchema)(unwrappedError)
        ? unwrappedError
        : normalizeDispatchError(`Failed to dispatch ${operation}`)(unwrappedError);
    }),
    Effect.annotateLogs(attributes),
  );

export const makeWorkflowHandler =
  <
    Payload extends Schema.Schema<DispatchWorkflowRequest>,
    Success extends Schema.Top,
    Error extends Schema.Top,
    TAuthorization,
    RAuthorize,
    RExecute,
  >(
    options: DispatchWorkflowHandlerOptions<
      Payload,
      Success,
      Error,
      TAuthorization,
      RAuthorize,
      RExecute
    >,
  ) =>
  (request: Payload["Type"], executionId: string) =>
    Activity.make({
      name: `dispatch.${options.operation}.${executionId}.execute`,
      success: options.workflow.successSchema,
      error: options.workflow.errorSchema,
      execute: runDispatchWorkflowOperation(options, request, executionId),
    });

export const makeButtonWorkflowHandler =
  <
    const TOperation extends DispatchButtonOperation,
    Payload extends Schema.Schema<DispatchWorkflowRequest>,
    Success extends Schema.Top,
    Error extends Schema.Top,
    TAuthorization,
    RAuthorize,
    RExecute,
  >(
    options: DispatchButtonWorkflowHandlerOptions<
      TOperation,
      Payload,
      Success,
      Error,
      TAuthorization,
      RAuthorize,
      RExecute
    >,
  ) =>
  (request: Payload["Type"], executionId: string) => {
    const attributes = workflowAttributes(options.operation, executionId, request);
    const clientRef = requestClientRef(request);
    return Activity.make({
      name: `dispatch.${options.operation}.${executionId}.execute`,
      success: options.workflow.successSchema,
      error: options.workflow.errorSchema,
      execute: validateActivityEffect(
        finalizeDispatchWorkflow({
          attributes,
          clientRef,
          dispatch: dispatchViaButtonEntity(options, request, executionId),
          errorSchema: options.workflow.errorSchema,
          interactionResponseToken: options.getInteractionToken(request),
          operation: options.operation,
        }),
        options.workflow.successSchema,
        options.workflow.errorSchema,
      ),
    });
  };

export const runDispatchWorkflowOperation = <
  Payload extends Schema.Schema<DispatchWorkflowRequest>,
  Success extends Schema.Top,
  Error extends Schema.Top,
  TAuthorization,
  RAuthorize,
  RExecute,
>(
  options: DispatchWorkflowHandlerOptions<
    Payload,
    Success,
    Error,
    TAuthorization,
    RAuthorize,
    RExecute
  >,
  request: Payload["Type"],
  executionId: string,
) => {
  const attributes = workflowAttributes(options.operation, executionId, request);
  const clientRef = requestClientRef(request);
  return validateActivityEffect(
    finalizeDispatchWorkflow({
      attributes,
      clientRef,
      dispatch: options.authorize(request).pipe(
        Effect.withSpan("DispatchWorkflow.authorize", { attributes }),
        Effect.flatMap((authorization) =>
          withRequestClientRef(options.execute(request, authorization), clientRef).pipe(
            Effect.withSpan("DispatchWorkflow.execute", { attributes }),
          ),
        ),
      ),
      errorSchema: options.workflow.errorSchema,
      interactionResponseToken: options.getInteractionToken(request),
      operation: options.operation,
    }),
    options.workflow.successSchema,
    options.workflow.errorSchema,
  );
};

export const dispatchViaButtonEntity = <
  TOperation extends DispatchButtonOperation,
  Payload extends Schema.Schema<DispatchWorkflowRequest>,
  Success extends Schema.Top,
  Error extends Schema.Top,
  TAuthorization,
  RAuthorize,
  RExecute,
>(
  options: DispatchButtonWorkflowHandlerOptions<
    TOperation,
    Payload,
    Success,
    Error,
    TAuthorization,
    RAuthorize,
    RExecute
  >,
  request: Payload["Type"],
  executionId: string,
) =>
  Effect.gen(function* () {
    const messageId = yield* dispatchButtonMessageId(request);
    const attributes = { operation: options.operation, executionId, messageId };
    yield* Effect.logDebug("Dispatching button workflow through message entity").pipe(
      Effect.annotateLogs(attributes),
    );
    const clientFor = yield* DispatchButtonEntity.client;
    const client = clientFor(messageId);
    const dispatchers = {
      slotOpenButton: (nextRequest: unknown) =>
        client.slotOpenButton({
          request: nextRequest as typeof DispatchSlotOpenButtonWorkflow.payloadSchema.Type,
          executionId,
        }),
      checkinButton: (nextRequest: unknown) =>
        client.checkinButton({
          request: nextRequest as typeof DispatchCheckinButtonWorkflow.payloadSchema.Type,
          executionId,
        }),
      roomOrderPreviousButton: (nextRequest: unknown) =>
        client.roomOrderPreviousButton({
          request: nextRequest as typeof DispatchRoomOrderPreviousButtonWorkflow.payloadSchema.Type,
          executionId,
        }),
      roomOrderNextButton: (nextRequest: unknown) =>
        client.roomOrderNextButton({
          request: nextRequest as typeof DispatchRoomOrderNextButtonWorkflow.payloadSchema.Type,
          executionId,
        }),
      roomOrderSendButton: (nextRequest: unknown) =>
        client.roomOrderSendButton({
          request: nextRequest as typeof DispatchRoomOrderSendButtonWorkflow.payloadSchema.Type,
          executionId,
        }),
      roomOrderPinTentativeButton: (nextRequest: unknown) =>
        client.roomOrderPinTentativeButton({
          request:
            nextRequest as typeof DispatchRoomOrderPinTentativeButtonWorkflow.payloadSchema.Type,
          executionId,
        }),
      teamSubmissionConfirmButton: (nextRequest: unknown) =>
        client.teamSubmissionConfirmButton({
          request:
            nextRequest as typeof DispatchTeamSubmissionConfirmButtonWorkflow.payloadSchema.Type,
          executionId,
        }),
      teamSubmissionRejectButton: (nextRequest: unknown) =>
        client.teamSubmissionRejectButton({
          request:
            nextRequest as typeof DispatchTeamSubmissionRejectButtonWorkflow.payloadSchema.Type,
          executionId,
        }),
    } satisfies Record<
      DispatchButtonOperation,
      (nextRequest: unknown) => Effect.Effect<unknown, unknown>
    >;

    return yield* dispatchers[options.operation](request);
  }).pipe(
    Effect.withSpan("DispatchWorkflow.dispatchButtonEntity", {
      attributes: {
        operation: options.operation,
        executionId,
      },
    }),
  );

const dispatchButtonMessageId = (request: { readonly payload: unknown }) =>
  Schema.decodeUnknownEffect(DispatchButtonMessageIdPayload)(request.payload).pipe(
    Effect.map((payload) => payload.messageId),
    Effect.catch((parseError) =>
      Effect.die(
        new Error("Dispatch button request payload is missing messageId", { cause: parseError }),
      ),
    ),
  );
