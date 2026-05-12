import { Effect, Layer, Option } from "effect";
import { Activity } from "effect/unstable/workflow";
import {
  DispatchCheckinButtonWorkflow,
  DispatchCheckinWorkflow,
  DispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow,
  DispatchRoomOrderWorkflow,
  DispatchWorkflows,
  type DispatchWorkflowOperation,
  type DispatchRequester,
} from "sheet-ingress-api/sheet-cluster-workflows";
import {
  MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE,
  type RoomOrderPinTentativeButtonPayload,
  type RoomOrderPreviousButtonPayload,
} from "sheet-ingress-api/sheet-apis-rpc";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import { Unauthorized } from "typhoon-core/error";
import { normalizeDispatchError } from "@/handlers/shared/dispatchError";
import { DispatchService, IngressBotClient, SheetApisClient } from "@/services";

const entityFailureMessage = "Dispatch failed. Please try again.";

const isMissingMessageRoomOrderError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "ArgumentError" &&
  "message" in error &&
  error.message === MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE;

const notifyInteractionFailure = (interactionToken: string | undefined) =>
  typeof interactionToken === "string"
    ? Effect.gen(function* () {
        const botClient = yield* IngressBotClient;
        yield* botClient
          .updateOriginalInteractionResponse(interactionToken, { content: entityFailureMessage })
          .pipe(Effect.catch(() => Effect.void));
      })
    : Effect.void;

type DispatchWorkflow = (typeof DispatchWorkflows)[number];

type DispatchWorkflowPayload<TWorkflow extends DispatchWorkflow> =
  TWorkflow["payloadSchema"]["Type"];

type DispatchWorkflowSuccess<TWorkflow extends DispatchWorkflow> =
  TWorkflow["successSchema"]["Type"];

type DispatchWorkflowError<TWorkflow extends DispatchWorkflow> = TWorkflow["errorSchema"]["Type"];

type DispatchWorkflowHandler<TWorkflow extends DispatchWorkflow, R> = (
  request: DispatchWorkflowPayload<TWorkflow>,
  executionId: string,
) => Effect.Effect<DispatchWorkflowSuccess<TWorkflow>, DispatchWorkflowError<TWorkflow>, R>;

type DispatchWorkflowHandlerOptions<
  TWorkflow extends DispatchWorkflow,
  TAuthorization,
  RAuthorize,
  RExecute,
> = {
  readonly operation: DispatchWorkflowOperation;
  readonly workflow: TWorkflow;
  readonly getInteractionToken: (request: DispatchWorkflowPayload<TWorkflow>) => string | undefined;
  readonly authorize: (
    request: DispatchWorkflowPayload<TWorkflow>,
  ) => Effect.Effect<TAuthorization, unknown, RAuthorize>;
  readonly execute: (
    request: DispatchWorkflowPayload<TWorkflow>,
    authorization: TAuthorization,
  ) => Effect.Effect<DispatchWorkflowSuccess<TWorkflow>, unknown, RExecute>;
};

const requireCheckinButtonAccess = (messageId: string, requester: DispatchRequester) =>
  Effect.gen(function* () {
    const sheetApis = (yield* SheetApisClient).get();
    const members = yield* sheetApis.messageCheckin
      .getMessageCheckinMembers({
        query: { messageId },
      })
      .pipe(Effect.mapError(normalizeDispatchError("Failed to verify check-in button access")));

    if (members.some((member) => member.memberId === requester.accountId)) {
      return;
    }

    return yield* Effect.fail(
      new Unauthorized({ message: "User is not a recorded participant on this check-in message" }),
    );
  });

const requirePayloadRoomOrderMatch = (
  roomOrder: MessageRoomOrder,
  payload: RoomOrderPreviousButtonPayload,
) =>
  Effect.gen(function* () {
    if (Option.isNone(roomOrder.guildId) || Option.isNone(roomOrder.messageChannelId)) {
      return yield* Effect.fail(
        new Unauthorized({ message: "Legacy message room order records are no longer accessible" }),
      );
    }

    if (
      roomOrder.guildId.value !== payload.guildId ||
      roomOrder.messageChannelId.value !== payload.messageChannelId
    ) {
      return yield* Effect.fail(
        new Unauthorized({ message: "Room-order message authorization changed" }),
      );
    }
  });

const requireRegisteredRoomOrderButtonAccess = (payload: RoomOrderPreviousButtonPayload) =>
  Effect.gen(function* () {
    const sheetApis = (yield* SheetApisClient).get();
    const roomOrder = yield* sheetApis.messageRoomOrder
      .getMessageRoomOrder({
        query: { messageId: payload.messageId },
      })
      .pipe(Effect.mapError(normalizeDispatchError("Failed to verify room-order button access")));
    yield* requirePayloadRoomOrderMatch(roomOrder, payload);
    return roomOrder;
  });

const requireRoomOrderPinTentativeButtonAccess = (payload: RoomOrderPinTentativeButtonPayload) =>
  Effect.gen(function* () {
    const sheetApis = (yield* SheetApisClient).get();
    return yield* sheetApis.messageRoomOrder
      .getMessageRoomOrder({
        query: { messageId: payload.messageId },
      })
      .pipe(
        Effect.flatMap((roomOrder) =>
          requirePayloadRoomOrderMatch(roomOrder, payload).pipe(Effect.as(roomOrder)),
        ),
        Effect.catchIf(isMissingMessageRoomOrderError, () => Effect.succeed(null)),
        Effect.mapError(
          normalizeDispatchError("Failed to verify tentative room-order button access"),
        ),
      );
  });

const makeWorkflowHandler =
  <TWorkflow extends DispatchWorkflow, TAuthorization, RAuthorize, RExecute>(
    options: DispatchWorkflowHandlerOptions<TWorkflow, TAuthorization, RAuthorize, RExecute>,
  ): DispatchWorkflowHandler<TWorkflow, RAuthorize | RExecute | IngressBotClient> =>
  (request, executionId) =>
    Effect.gen(function* () {
      const effect = options.authorize(request).pipe(
        Effect.flatMap((authorization) => options.execute(request, authorization)),
        Effect.mapError(
          (error): DispatchWorkflowError<TWorkflow> =>
            normalizeDispatchError(`Failed to dispatch ${options.operation}`)(
              error,
            ) as DispatchWorkflowError<TWorkflow>,
        ),
        Effect.tapError(() => notifyInteractionFailure(options.getInteractionToken(request))),
      );

      return yield* Activity.make({
        name: `dispatch.${options.operation}.${executionId}.execute`,
        success: options.workflow.successSchema,
        error: options.workflow.errorSchema,
        execute: effect,
      });
    }) as Effect.Effect<
      DispatchWorkflowSuccess<TWorkflow>,
      DispatchWorkflowError<TWorkflow>,
      RAuthorize | RExecute | IngressBotClient
    >;

export const dispatchWorkflowRegistry = {
  checkin: {
    operation: "checkin",
    workflow: DispatchCheckinWorkflow,
    getInteractionToken: (request: typeof DispatchCheckinWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchCheckinWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.checkin(request.payload, request.requester);
      }),
  },
  roomOrder: {
    operation: "roomOrder",
    workflow: DispatchRoomOrderWorkflow,
    getInteractionToken: (request: typeof DispatchRoomOrderWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchRoomOrderWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.roomOrder(request.payload, request.requester);
      }),
  },
  checkinButton: {
    operation: "checkinButton",
    workflow: DispatchCheckinButtonWorkflow,
    getInteractionToken: (request: typeof DispatchCheckinButtonWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: (request: typeof DispatchCheckinButtonWorkflow.payloadSchema.Type) =>
      requireCheckinButtonAccess(request.payload.messageId, request.requester),
    execute: (request: typeof DispatchCheckinButtonWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.checkinButton(request.payload, request.requester);
      }),
  },
  roomOrderPreviousButton: {
    operation: "roomOrderPreviousButton",
    workflow: DispatchRoomOrderPreviousButtonWorkflow,
    getInteractionToken: (
      request: typeof DispatchRoomOrderPreviousButtonWorkflow.payloadSchema.Type,
    ) => request.payload.interactionToken,
    authorize: (request: typeof DispatchRoomOrderPreviousButtonWorkflow.payloadSchema.Type) =>
      requireRegisteredRoomOrderButtonAccess(request.payload),
    execute: (
      request: typeof DispatchRoomOrderPreviousButtonWorkflow.payloadSchema.Type,
      authorizedRoomOrder: MessageRoomOrder,
    ) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.roomOrderPreviousButton(request.payload, authorizedRoomOrder);
      }),
  },
  roomOrderNextButton: {
    operation: "roomOrderNextButton",
    workflow: DispatchRoomOrderNextButtonWorkflow,
    getInteractionToken: (request: typeof DispatchRoomOrderNextButtonWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: (request: typeof DispatchRoomOrderNextButtonWorkflow.payloadSchema.Type) =>
      requireRegisteredRoomOrderButtonAccess(request.payload),
    execute: (
      request: typeof DispatchRoomOrderNextButtonWorkflow.payloadSchema.Type,
      authorizedRoomOrder: MessageRoomOrder,
    ) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.roomOrderNextButton(request.payload, authorizedRoomOrder);
      }),
  },
  roomOrderSendButton: {
    operation: "roomOrderSendButton",
    workflow: DispatchRoomOrderSendButtonWorkflow,
    getInteractionToken: (request: typeof DispatchRoomOrderSendButtonWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: (request: typeof DispatchRoomOrderSendButtonWorkflow.payloadSchema.Type) =>
      requireRegisteredRoomOrderButtonAccess(request.payload),
    execute: (
      request: typeof DispatchRoomOrderSendButtonWorkflow.payloadSchema.Type,
      authorizedRoomOrder: MessageRoomOrder,
    ) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.roomOrderSendButton(request.payload, authorizedRoomOrder);
      }),
  },
  roomOrderPinTentativeButton: {
    operation: "roomOrderPinTentativeButton",
    workflow: DispatchRoomOrderPinTentativeButtonWorkflow,
    getInteractionToken: (
      request: typeof DispatchRoomOrderPinTentativeButtonWorkflow.payloadSchema.Type,
    ) => request.payload.interactionToken,
    authorize: (request: typeof DispatchRoomOrderPinTentativeButtonWorkflow.payloadSchema.Type) =>
      requireRoomOrderPinTentativeButtonAccess(request.payload),
    execute: (
      request: typeof DispatchRoomOrderPinTentativeButtonWorkflow.payloadSchema.Type,
      authorizedRoomOrder: MessageRoomOrder | null,
    ) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.roomOrderPinTentativeButton(request.payload, authorizedRoomOrder);
      }),
  },
} as const;

export const dispatchWorkflowLayer = Layer.mergeAll(
  DispatchCheckinWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.checkin,
    }),
  ),
  DispatchRoomOrderWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.roomOrder,
    }),
  ),
  DispatchCheckinButtonWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.checkinButton,
    }),
  ),
  DispatchRoomOrderPreviousButtonWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.roomOrderPreviousButton,
    }),
  ),
  DispatchRoomOrderNextButtonWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.roomOrderNextButton,
    }),
  ),
  DispatchRoomOrderSendButtonWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.roomOrderSendButton,
    }),
  ),
  DispatchRoomOrderPinTentativeButtonWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.roomOrderPinTentativeButton,
    }),
  ),
).pipe(Layer.provide([DispatchService.layer, IngressBotClient.layer]));

export const dispatchWorkflowNames = DispatchWorkflows.map((workflow) => workflow.name);
