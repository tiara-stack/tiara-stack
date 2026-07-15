import { Effect, Option, Predicate } from "effect";
import type { ClientRef } from "sheet-ingress-api/schemas/client";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import {
  DispatchRoomOrderButtonMethods,
  interactionResponseTokenExpirySafetyMarginMs,
  interactionResponseTokenLifetimeMs,
} from "sheet-ingress-api/sheet-apis-rpc";
import type { DispatchAuthorizationSnapshot } from "sheet-ingress-api/sheet-workflows-workflows";
import { makeArgumentError } from "typhoon-core/error";
import { adaptTableHandlerArgument, invokeTableHandler } from "../httpApiAdapter";
import { MessageLookup } from "../services/messageLookup";
import { clientArgsFrom } from "../services/sheetBotProxy";
import { SheetWorkflowsForwardingClient } from "../services/sheetWorkflowsForwardingClient";
import type {
  SheetWorkflowsDispatchEndpointName,
  SheetWorkflowsDispatchError,
  SheetWorkflowsDispatchHandler,
  SheetWorkflowsDispatchHandlerTable,
  SheetWorkflowsDispatchRequest,
} from "./types";

type WorkflowAuthorizationSnapshot = DispatchAuthorizationSnapshot;

type DispatchClientPayload = {
  readonly client: ClientRef;
  readonly interactionToken?: string | undefined;
  readonly interactionDeadlineEpochMs?: number | undefined;
  readonly messageId?: string | undefined;
};

const getInteractionDeadlineEpochMs = (
  payload: DispatchClientPayload,
  requester: { readonly accountId: string; readonly userId: string },
) =>
  Effect.gen(function* () {
    const hasInteractionToken = Predicate.isNotUndefined(payload.interactionToken);
    const hasInteractionDeadline = Predicate.isNotUndefined(payload.interactionDeadlineEpochMs);
    if (hasInteractionToken !== hasInteractionDeadline) {
      return yield* Effect.fail(
        makeArgumentError(
          `Dispatch interaction payload must include both interactionToken and interactionDeadlineEpochMs for ${requester.accountId}/${requester.userId}`,
        ),
      );
    }
    return hasInteractionDeadline
      ? Math.min(
          payload.interactionDeadlineEpochMs!,
          Date.now() +
            interactionResponseTokenLifetimeMs -
            interactionResponseTokenExpirySafetyMarginMs,
        )
      : undefined;
  });

const withInteractionDeadline = (
  payload: DispatchClientPayload,
  interactionDeadlineEpochMs: number | undefined,
) =>
  Predicate.isUndefined(interactionDeadlineEpochMs)
    ? payload
    : { ...payload, interactionDeadlineEpochMs };

const makeBaseDispatchPayload = (
  requester: { readonly accountId: string; readonly userId: string },
  payload: DispatchClientPayload,
  authorization: WorkflowAuthorizationSnapshot | undefined,
  interactionDeadlineEpochMs: number | undefined,
) => ({
  requester,
  payload,
  ...(Predicate.isUndefined(authorization) ? {} : { authorization }),
  ...(Predicate.isUndefined(interactionDeadlineEpochMs) ? {} : { interactionDeadlineEpochMs }),
});

const requireMessageId = (payload: DispatchClientPayload) =>
  Predicate.isUndefined(payload.messageId)
    ? Effect.fail(makeArgumentError("Cannot forward room-order button dispatch without messageId"))
    : Effect.succeed(payload.messageId);

const getRoomOrderOption = (payload: DispatchClientPayload, clientRef: ClientRef) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const messageId = yield* requireMessageId(payload);
    return yield* messages.getMessageRoomOrder(messageId, clientRef);
  });

const getRegisteredRoomOrder = (payload: DispatchClientPayload, clientRef: ClientRef) =>
  getRoomOrderOption(payload, clientRef).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Effect.fail(
            makeArgumentError("Cannot get message room order, the message might not be registered"),
          ),
      }),
    ),
  );

const augmentDispatchPayload = <Payload extends object>(
  endpoint: SheetWorkflowsDispatchEndpointName,
  basePayload: Payload,
  workflowPayload: DispatchClientPayload,
  clientRef: ClientRef,
) => {
  const withRequiredRoomOrder = () =>
    getRegisteredRoomOrder(workflowPayload, clientRef).pipe(
      Effect.map((authorizedRoomOrder) => ({ ...basePayload, authorizedRoomOrder })),
    );
  const dispatchPayloadAugmenters = {
    [DispatchRoomOrderButtonMethods.previous.endpointName]: withRequiredRoomOrder,
    [DispatchRoomOrderButtonMethods.next.endpointName]: withRequiredRoomOrder,
    [DispatchRoomOrderButtonMethods.send.endpointName]: withRequiredRoomOrder,
    [DispatchRoomOrderButtonMethods.pinTentative.endpointName]: () =>
      getRoomOrderOption(workflowPayload, clientRef).pipe(
        Effect.map((authorizedRoomOrder) => ({
          ...basePayload,
          authorizedRoomOrder: Option.getOrNull(authorizedRoomOrder),
        })),
      ),
  } as const;
  const augmentPayload = Option.fromNullishOr(
    dispatchPayloadAugmenters[endpoint as keyof typeof dispatchPayloadAugmenters],
  ).pipe(Option.getOrElse(() => () => Effect.succeed(basePayload)));
  return augmentPayload();
};

const forwardSheetWorkflowsDispatch =
  <EndpointName extends SheetWorkflowsDispatchEndpointName>(
    endpoint: EndpointName,
    authorization?: WorkflowAuthorizationSnapshot,
  ): SheetWorkflowsDispatchHandler<EndpointName, MessageLookup> =>
  (rawArgs) =>
    Effect.gen(function* () {
      const args = rawArgs as SheetWorkflowsDispatchRequest<EndpointName>;
      const client = yield* SheetWorkflowsForwardingClient;
      const handlerTable: SheetWorkflowsDispatchHandlerTable =
        client.dispatch satisfies SheetWorkflowsDispatchHandlerTable;
      const requester = yield* SheetAuthUser;
      const { payload } = clientArgsFrom(args) as {
        readonly payload: DispatchClientPayload;
      };
      const clientRef = payload.client;
      const requesterRef = { accountId: requester.accountId, userId: requester.userId };
      const interactionDeadlineEpochMs = yield* getInteractionDeadlineEpochMs(
        payload,
        requesterRef,
      );
      const workflowPayload = withInteractionDeadline(payload, interactionDeadlineEpochMs);
      const basePayload = makeBaseDispatchPayload(
        requesterRef,
        workflowPayload,
        authorization,
        interactionDeadlineEpochMs,
      );
      const finalPayload = yield* augmentDispatchPayload(
        endpoint,
        basePayload,
        workflowPayload,
        clientRef,
      );
      return yield* invokeTableHandler(
        handlerTable,
        endpoint,
        adaptTableHandlerArgument(handlerTable, endpoint, finalPayload),
      );
    }) as ReturnType<SheetWorkflowsDispatchHandler<EndpointName, MessageLookup>>;

export const authorizedSheetWorkflowsDispatch =
  <EndpointName extends SheetWorkflowsDispatchEndpointName, R>(
    endpoint: EndpointName,
    authorize: (
      args: SheetWorkflowsDispatchRequest<EndpointName>,
    ) => Effect.Effect<
      WorkflowAuthorizationSnapshot | void,
      SheetWorkflowsDispatchError<EndpointName>,
      R
    >,
  ): SheetWorkflowsDispatchHandler<EndpointName, R | MessageLookup> =>
  (rawArgs) =>
    Effect.gen(function* () {
      const args = rawArgs as SheetWorkflowsDispatchRequest<EndpointName>;
      const authorization = yield* authorize(args);
      return yield* forwardSheetWorkflowsDispatch(endpoint, authorization ?? undefined)(rawArgs);
    }) as ReturnType<SheetWorkflowsDispatchHandler<EndpointName, R | MessageLookup>>;
