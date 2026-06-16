import { Cause, Duration, Effect, Layer, Option, Predicate, Schema } from "effect";
import { Sharding } from "effect/unstable/cluster";
import { Activity } from "effect/unstable/workflow";
import {
  DispatchButtonEntity,
  type DispatchButtonOperation,
  makeDispatchButtonEntityLayer,
} from "@/entities/dispatchButton";
import {
  type DispatchAuthorizationSnapshot,
  type DispatchWorkflowOperation,
  type DispatchRequester,
} from "sheet-ingress-api/sheet-workflows-workflows";
import {
  MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE,
  type RoomOrderPinTentativeButtonPayload,
  type RoomOrderPreviousButtonPayload,
} from "sheet-ingress-api/sheet-apis-rpc";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import type { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import { Unauthorized } from "typhoon-core/error";
import { normalizeDispatchError } from "@/handlers/shared/dispatchError";
import {
  isInteractionFailureHandled,
  unwrapInteractionFailure,
} from "@/handlers/shared/interactionFailure";
import { DispatchService, IngressBotClient, SheetApisClient } from "@/services";
import {
  DispatchAutoCheckinTestWorkflow,
  DispatchCheckinButtonWorkflow,
  DispatchCheckinWorkflow,
  DispatchChannelListConfigWorkflow,
  DispatchChannelSetWorkflow,
  DispatchChannelUnsetWorkflow,
  DispatchGuildWelcomeWorkflow,
  DispatchKickoutWorkflow,
  DispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow,
  DispatchRoomOrderWorkflow,
  DispatchScheduleListWorkflow,
  DispatchServiceAddGuildFeatureFlagWorkflow,
  DispatchServiceRemoveGuildFeatureFlagWorkflow,
  DispatchServiceStatusWorkflow,
  DispatchServerAddMonitorRoleWorkflow,
  DispatchServerListConfigWorkflow,
  DispatchServerRemoveMonitorRoleWorkflow,
  DispatchServerSetAutoCheckinWorkflow,
  DispatchServerSetSheetWorkflow,
  DispatchScreenshotWorkflow,
  DispatchSlotButtonWorkflow,
  DispatchSlotListWorkflow,
  DispatchSlotOpenButtonWorkflow,
  DispatchTeamListWorkflow,
  DispatchUpdateAnnouncementWorkflow,
  DispatchWorkflows,
} from "./dispatchWorkflows";

const entityFailureMessage = "Dispatch failed. Please try again.";

const isMissingMessageRoomOrderError = (error: unknown) =>
  Predicate.hasProperty(error, "_tag") &&
  error._tag === "ArgumentError" &&
  Predicate.hasProperty(error, "message") &&
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

type DispatchButtonWorkflowByOperation = {
  readonly slotOpenButton: typeof DispatchSlotOpenButtonWorkflow;
  readonly checkinButton: typeof DispatchCheckinButtonWorkflow;
  readonly roomOrderPreviousButton: typeof DispatchRoomOrderPreviousButtonWorkflow;
  readonly roomOrderNextButton: typeof DispatchRoomOrderNextButtonWorkflow;
  readonly roomOrderSendButton: typeof DispatchRoomOrderSendButtonWorkflow;
  readonly roomOrderPinTentativeButton: typeof DispatchRoomOrderPinTentativeButtonWorkflow;
};

type DispatchButtonWorkflowHandlerOptions<
  TOperation extends DispatchButtonOperation,
  TAuthorization,
  RAuthorize,
  RExecute,
> = DispatchWorkflowHandlerOptions<
  DispatchButtonWorkflowByOperation[TOperation],
  TAuthorization,
  RAuthorize,
  RExecute
> & {
  readonly operation: TOperation;
};

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
    "requester.accountId": request.requester.accountId,
    "requester.userId": request.requester.userId,
  };
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

const requireSlotOpenButtonAccess = (messageId: string) =>
  Effect.gen(function* () {
    const sheetApis = (yield* SheetApisClient).get();
    const messageSlot = yield* sheetApis.messageSlot
      .getMessageSlotData({
        query: { messageId },
      })
      .pipe(Effect.mapError(normalizeDispatchError("Failed to verify slot button access")));

    if (Option.isNone(messageSlot.guildId) || Option.isNone(messageSlot.messageChannelId)) {
      return yield* Effect.fail(
        new Unauthorized({ message: "Legacy message slot records are no longer accessible" }),
      );
    }

    return messageSlot;
  });

const scopeRank = {
  member: 0,
  monitor: 1,
  manage: 2,
} as const;

const requireAuthorizedGuild = (
  authorization: DispatchAuthorizationSnapshot | undefined,
  guildId: string,
  scope: DispatchAuthorizationSnapshot["scope"],
) =>
  Effect.gen(function* () {
    if (authorization?.guildId === guildId && scopeRank[authorization.scope] >= scopeRank[scope]) {
      return;
    }

    return yield* Effect.fail(
      new Unauthorized({
        message: `Dispatch requester is not authorized to ${scope} guild ${guildId}`,
      }),
    );
  });

const requireSelfOrAuthorizedGuild = (
  request: {
    readonly requester: DispatchRequester;
    readonly authorization?: DispatchAuthorizationSnapshot | undefined;
    readonly payload: {
      readonly guildId: string;
      readonly targetUserId: string;
    };
  },
  scope: DispatchAuthorizationSnapshot["scope"],
) =>
  request.requester.accountId === request.payload.targetUserId
    ? Effect.void
    : requireAuthorizedGuild(request.authorization, request.payload.guildId, scope);

export const makeWorkflowHandler =
  <TWorkflow extends DispatchWorkflow, TAuthorization, RAuthorize, RExecute>(
    options: DispatchWorkflowHandlerOptions<TWorkflow, TAuthorization, RAuthorize, RExecute>,
  ): DispatchWorkflowHandler<TWorkflow, RAuthorize | RExecute | IngressBotClient> =>
  (request, executionId) =>
    Effect.gen(function* () {
      return yield* retryClusterPersistenceCause(
        Activity.make({
          name: `dispatch.${options.operation}.${executionId}.execute`,
          success: options.workflow.successSchema,
          error: options.workflow.errorSchema,
          execute: runDispatchWorkflowOperation(options, request, executionId),
        }),
      );
    }) as Effect.Effect<
      DispatchWorkflowSuccess<TWorkflow>,
      DispatchWorkflowError<TWorkflow>,
      RAuthorize | RExecute | IngressBotClient
    >;

export const makeButtonWorkflowHandler =
  <TOperation extends DispatchButtonOperation, TAuthorization, RAuthorize, RExecute>(
    options: DispatchButtonWorkflowHandlerOptions<TOperation, TAuthorization, RAuthorize, RExecute>,
  ): DispatchWorkflowHandler<DispatchButtonWorkflowByOperation[TOperation], Sharding.Sharding> =>
  (request, executionId) =>
    Effect.gen(function* () {
      return yield* retryClusterPersistenceCause(
        Activity.make({
          name: `dispatch.${options.operation}.${executionId}.execute`,
          success: options.workflow.successSchema,
          error: options.workflow.errorSchema,
          execute: dispatchViaButtonEntity(options, request, executionId) as Effect.Effect<
            DispatchWorkflowSuccess<DispatchButtonWorkflowByOperation[TOperation]>,
            DispatchWorkflowError<DispatchButtonWorkflowByOperation[TOperation]>,
            Sharding.Sharding
          >,
        }),
      );
    }) as Effect.Effect<
      DispatchWorkflowSuccess<DispatchButtonWorkflowByOperation[TOperation]>,
      DispatchWorkflowError<DispatchButtonWorkflowByOperation[TOperation]>,
      Sharding.Sharding
    >;

const isClusterPersistenceDefect = (defect: unknown): boolean => {
  const tag =
    Predicate.hasProperty(defect, "_tag") && typeof defect._tag === "string"
      ? defect._tag
      : undefined;
  const name =
    Predicate.hasProperty(defect, "name") && typeof defect.name === "string"
      ? defect.name
      : undefined;

  return tag === "PersistenceError" || name === "~effect/cluster/ClusterError/PersistenceError";
};

export const isClusterPersistenceCause = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some(
    (reason) => Cause.isDieReason(reason) && isClusterPersistenceDefect(reason.defect),
  );

export const retryClusterPersistenceCause = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  remainingAttempts = 3,
  retryDelay = Duration.millis(250),
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (remainingAttempts <= 0 || !isClusterPersistenceCause(cause)) {
        return Effect.failCause(cause);
      }

      const retryPause = Duration.isZero(retryDelay) ? Effect.void : Effect.sleep(retryDelay);

      return Effect.logWarning(
        "Retrying dispatch workflow activity after cluster persistence error",
      ).pipe(
        Effect.annotateLogs({ remainingAttempts }),
        Effect.andThen(retryPause),
        Effect.andThen(retryClusterPersistenceCause(effect, remainingAttempts - 1, retryDelay)),
      );
    }),
  );

const runDispatchWorkflowOperation = <
  TWorkflow extends DispatchWorkflow,
  TAuthorization,
  RAuthorize,
  RExecute,
>(
  options: DispatchWorkflowHandlerOptions<TWorkflow, TAuthorization, RAuthorize, RExecute>,
  request: DispatchWorkflowPayload<TWorkflow>,
  executionId: string,
) => {
  const attributes = workflowAttributes(options.operation, executionId, request);
  return options.authorize(request).pipe(
    Effect.withSpan("DispatchWorkflow.authorize", { attributes }),
    Effect.flatMap((authorization) =>
      options
        .execute(request, authorization)
        .pipe(Effect.withSpan("DispatchWorkflow.execute", { attributes })),
    ),
    Effect.tapError((error) =>
      isInteractionFailureHandled(error)
        ? Effect.void
        : notifyInteractionFailure(options.getInteractionToken(request)).pipe(
            Effect.withSpan("DispatchWorkflow.notifyInteractionFailure", { attributes }),
          ),
    ),
    Effect.mapError(
      (error): DispatchWorkflowError<TWorkflow> =>
        normalizeDispatchError(`Failed to dispatch ${options.operation}`)(
          unwrapInteractionFailure(error),
        ) as DispatchWorkflowError<TWorkflow>,
    ),
    Effect.annotateLogs(attributes),
  );
};

const dispatchViaButtonEntity = <
  TOperation extends DispatchButtonOperation,
  TAuthorization,
  RAuthorize,
  RExecute,
>(
  options: DispatchButtonWorkflowHandlerOptions<TOperation, TAuthorization, RAuthorize, RExecute>,
  request: DispatchWorkflowPayload<DispatchButtonWorkflowByOperation[TOperation]>,
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
          request: Schema.decodeUnknownSync(DispatchSlotOpenButtonWorkflow.payloadSchema)(
            nextRequest,
          ),
          executionId,
        }),
      checkinButton: (nextRequest: unknown) =>
        client.checkinButton({
          request: Schema.decodeUnknownSync(DispatchCheckinButtonWorkflow.payloadSchema)(
            nextRequest,
          ),
          executionId,
        }),
      roomOrderPreviousButton: (nextRequest: unknown) =>
        client.roomOrderPreviousButton({
          request: Schema.decodeUnknownSync(DispatchRoomOrderPreviousButtonWorkflow.payloadSchema)(
            nextRequest,
          ),
          executionId,
        }),
      roomOrderNextButton: (nextRequest: unknown) =>
        client.roomOrderNextButton({
          request: Schema.decodeUnknownSync(DispatchRoomOrderNextButtonWorkflow.payloadSchema)(
            nextRequest,
          ),
          executionId,
        }),
      roomOrderSendButton: (nextRequest: unknown) =>
        client.roomOrderSendButton({
          request: Schema.decodeUnknownSync(DispatchRoomOrderSendButtonWorkflow.payloadSchema)(
            nextRequest,
          ),
          executionId,
        }),
      roomOrderPinTentativeButton: (nextRequest: unknown) =>
        client.roomOrderPinTentativeButton({
          request: Schema.decodeUnknownSync(
            DispatchRoomOrderPinTentativeButtonWorkflow.payloadSchema,
          )(nextRequest),
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
    Effect.catch(() =>
      Effect.die(new Error("Dispatch button request payload is missing messageId")),
    ),
  );

export const dispatchWorkflowRegistry = {
  autoCheckinTest: {
    operation: "autoCheckinTest",
    workflow: DispatchAutoCheckinTestWorkflow,
    getInteractionToken: (request: typeof DispatchAutoCheckinTestWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchAutoCheckinTestWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.autoCheckinTest(request.payload, request.requester);
      }),
  },
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
  kickout: {
    operation: "kickout",
    workflow: DispatchKickoutWorkflow,
    getInteractionToken: (request: typeof DispatchKickoutWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchKickoutWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.kickout(request.payload, request.requester);
      }),
  },
  slotButton: {
    operation: "slotButton",
    workflow: DispatchSlotButtonWorkflow,
    getInteractionToken: (request: typeof DispatchSlotButtonWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchSlotButtonWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.slotButton(request.payload, request.requester);
      }),
  },
  slotList: {
    operation: "slotList",
    workflow: DispatchSlotListWorkflow,
    getInteractionToken: (request: typeof DispatchSlotListWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchSlotListWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.slotList(request.payload);
      }),
  },
  slotOpenButton: {
    operation: "slotOpenButton",
    workflow: DispatchSlotOpenButtonWorkflow,
    getInteractionToken: (request: typeof DispatchSlotOpenButtonWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: (request: typeof DispatchSlotOpenButtonWorkflow.payloadSchema.Type) =>
      requireSlotOpenButtonAccess(request.payload.messageId),
    execute: (
      request: typeof DispatchSlotOpenButtonWorkflow.payloadSchema.Type,
      messageSlot: MessageSlot,
    ) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.slotOpenButton(request.payload, messageSlot);
      }),
  },
  serviceStatus: {
    operation: "serviceStatus",
    workflow: DispatchServiceStatusWorkflow,
    getInteractionToken: (request: typeof DispatchServiceStatusWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchServiceStatusWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.serviceStatus(request.payload);
      }),
  },
  guildWelcome: {
    operation: "guildWelcome",
    workflow: DispatchGuildWelcomeWorkflow,
    getInteractionToken: () => undefined,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchGuildWelcomeWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.guildWelcome(request.payload);
      }),
  },
  updateAnnouncement: {
    operation: "updateAnnouncement",
    workflow: DispatchUpdateAnnouncementWorkflow,
    getInteractionToken: () => undefined,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchUpdateAnnouncementWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.updateAnnouncement(request.payload);
      }),
  },
  serviceAddGuildFeatureFlag: {
    operation: "serviceAddGuildFeatureFlag",
    workflow: DispatchServiceAddGuildFeatureFlagWorkflow,
    getInteractionToken: () => undefined,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchServiceAddGuildFeatureFlagWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.serviceAddGuildFeatureFlag(request.payload);
      }),
  },
  serviceRemoveGuildFeatureFlag: {
    operation: "serviceRemoveGuildFeatureFlag",
    workflow: DispatchServiceRemoveGuildFeatureFlagWorkflow,
    getInteractionToken: () => undefined,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchServiceRemoveGuildFeatureFlagWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.serviceRemoveGuildFeatureFlag(request.payload);
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
  channelListConfig: {
    operation: "channelListConfig",
    workflow: DispatchChannelListConfigWorkflow,
    getInteractionToken: (request: typeof DispatchChannelListConfigWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: (request: typeof DispatchChannelListConfigWorkflow.payloadSchema.Type) =>
      requireAuthorizedGuild(request.authorization, request.payload.guildId, "manage"),
    execute: (request: typeof DispatchChannelListConfigWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.channelListConfig(request.payload);
      }),
  },
  channelSet: {
    operation: "channelSet",
    workflow: DispatchChannelSetWorkflow,
    getInteractionToken: (request: typeof DispatchChannelSetWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: (request: typeof DispatchChannelSetWorkflow.payloadSchema.Type) =>
      requireAuthorizedGuild(request.authorization, request.payload.guildId, "manage"),
    execute: (request: typeof DispatchChannelSetWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.channelSet(request.payload);
      }),
  },
  channelUnset: {
    operation: "channelUnset",
    workflow: DispatchChannelUnsetWorkflow,
    getInteractionToken: (request: typeof DispatchChannelUnsetWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: (request: typeof DispatchChannelUnsetWorkflow.payloadSchema.Type) =>
      requireAuthorizedGuild(request.authorization, request.payload.guildId, "manage"),
    execute: (request: typeof DispatchChannelUnsetWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.channelUnset(request.payload);
      }),
  },
  serverListConfig: {
    operation: "serverListConfig",
    workflow: DispatchServerListConfigWorkflow,
    getInteractionToken: (request: typeof DispatchServerListConfigWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: (request: typeof DispatchServerListConfigWorkflow.payloadSchema.Type) =>
      requireAuthorizedGuild(request.authorization, request.payload.guildId, "manage"),
    execute: (request: typeof DispatchServerListConfigWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.serverListConfig(request.payload);
      }),
  },
  serverAddMonitorRole: {
    operation: "serverAddMonitorRole",
    workflow: DispatchServerAddMonitorRoleWorkflow,
    getInteractionToken: (
      request: typeof DispatchServerAddMonitorRoleWorkflow.payloadSchema.Type,
    ) => request.payload.interactionToken,
    authorize: (request: typeof DispatchServerAddMonitorRoleWorkflow.payloadSchema.Type) =>
      requireAuthorizedGuild(request.authorization, request.payload.guildId, "manage"),
    execute: (request: typeof DispatchServerAddMonitorRoleWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.serverAddMonitorRole(request.payload);
      }),
  },
  serverRemoveMonitorRole: {
    operation: "serverRemoveMonitorRole",
    workflow: DispatchServerRemoveMonitorRoleWorkflow,
    getInteractionToken: (
      request: typeof DispatchServerRemoveMonitorRoleWorkflow.payloadSchema.Type,
    ) => request.payload.interactionToken,
    authorize: (request: typeof DispatchServerRemoveMonitorRoleWorkflow.payloadSchema.Type) =>
      requireAuthorizedGuild(request.authorization, request.payload.guildId, "manage"),
    execute: (request: typeof DispatchServerRemoveMonitorRoleWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.serverRemoveMonitorRole(request.payload);
      }),
  },
  serverSetSheet: {
    operation: "serverSetSheet",
    workflow: DispatchServerSetSheetWorkflow,
    getInteractionToken: (request: typeof DispatchServerSetSheetWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: (request: typeof DispatchServerSetSheetWorkflow.payloadSchema.Type) =>
      requireAuthorizedGuild(request.authorization, request.payload.guildId, "manage"),
    execute: (request: typeof DispatchServerSetSheetWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.serverSetSheet(request.payload);
      }),
  },
  serverSetAutoCheckin: {
    operation: "serverSetAutoCheckin",
    workflow: DispatchServerSetAutoCheckinWorkflow,
    getInteractionToken: (
      request: typeof DispatchServerSetAutoCheckinWorkflow.payloadSchema.Type,
    ) => request.payload.interactionToken,
    authorize: (request: typeof DispatchServerSetAutoCheckinWorkflow.payloadSchema.Type) =>
      requireAuthorizedGuild(request.authorization, request.payload.guildId, "manage"),
    execute: (request: typeof DispatchServerSetAutoCheckinWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.serverSetAutoCheckin(request.payload);
      }),
  },
  teamList: {
    operation: "teamList",
    workflow: DispatchTeamListWorkflow,
    getInteractionToken: (request: typeof DispatchTeamListWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: (request: typeof DispatchTeamListWorkflow.payloadSchema.Type) =>
      requireSelfOrAuthorizedGuild(request, "monitor"),
    execute: (request: typeof DispatchTeamListWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.teamList(request.payload);
      }),
  },
  scheduleList: {
    operation: "scheduleList",
    workflow: DispatchScheduleListWorkflow,
    getInteractionToken: (request: typeof DispatchScheduleListWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: (request: typeof DispatchScheduleListWorkflow.payloadSchema.Type) =>
      requireSelfOrAuthorizedGuild(request, "monitor"),
    execute: (request: typeof DispatchScheduleListWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.scheduleList(request.payload);
      }),
  },
  screenshot: {
    operation: "screenshot",
    workflow: DispatchScreenshotWorkflow,
    getInteractionToken: (request: typeof DispatchScreenshotWorkflow.payloadSchema.Type) =>
      request.payload.interactionToken,
    authorize: (request: typeof DispatchScreenshotWorkflow.payloadSchema.Type) =>
      requireAuthorizedGuild(request.authorization, request.payload.guildId, "monitor"),
    execute: (request: typeof DispatchScreenshotWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.screenshot(request.payload);
      }),
  },
} as const;

export const dispatchButtonEntityLayer = makeDispatchButtonEntityLayer({
  slotOpenButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.slotOpenButton,
      payload.request,
      payload.executionId,
    ),
  checkinButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.checkinButton,
      payload.request,
      payload.executionId,
    ),
  roomOrderPreviousButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.roomOrderPreviousButton,
      payload.request,
      payload.executionId,
    ),
  roomOrderNextButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.roomOrderNextButton,
      payload.request,
      payload.executionId,
    ),
  roomOrderSendButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.roomOrderSendButton,
      payload.request,
      payload.executionId,
    ),
  roomOrderPinTentativeButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.roomOrderPinTentativeButton,
      payload.request,
      payload.executionId,
    ),
});

export const dispatchWorkflowLayer = Layer.mergeAll(
  DispatchAutoCheckinTestWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.autoCheckinTest,
    }),
  ),
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
  DispatchKickoutWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.kickout,
    }),
  ),
  DispatchSlotButtonWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.slotButton,
    }),
  ),
  DispatchSlotListWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.slotList,
    }),
  ),
  DispatchSlotOpenButtonWorkflow.toLayer(
    makeButtonWorkflowHandler({
      ...dispatchWorkflowRegistry.slotOpenButton,
    }),
  ),
  DispatchServiceStatusWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.serviceStatus,
    }),
  ),
  DispatchGuildWelcomeWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.guildWelcome,
    }),
  ),
  DispatchUpdateAnnouncementWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.updateAnnouncement,
    }),
  ),
  DispatchServiceAddGuildFeatureFlagWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.serviceAddGuildFeatureFlag,
    }),
  ),
  DispatchServiceRemoveGuildFeatureFlagWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.serviceRemoveGuildFeatureFlag,
    }),
  ),
  DispatchCheckinButtonWorkflow.toLayer(
    makeButtonWorkflowHandler({
      ...dispatchWorkflowRegistry.checkinButton,
    }),
  ),
  DispatchRoomOrderPreviousButtonWorkflow.toLayer(
    makeButtonWorkflowHandler({
      ...dispatchWorkflowRegistry.roomOrderPreviousButton,
    }),
  ),
  DispatchRoomOrderNextButtonWorkflow.toLayer(
    makeButtonWorkflowHandler({
      ...dispatchWorkflowRegistry.roomOrderNextButton,
    }),
  ),
  DispatchRoomOrderSendButtonWorkflow.toLayer(
    makeButtonWorkflowHandler({
      ...dispatchWorkflowRegistry.roomOrderSendButton,
    }),
  ),
  DispatchRoomOrderPinTentativeButtonWorkflow.toLayer(
    makeButtonWorkflowHandler({
      ...dispatchWorkflowRegistry.roomOrderPinTentativeButton,
    }),
  ),
  DispatchChannelListConfigWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.channelListConfig,
    }),
  ),
  DispatchChannelSetWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.channelSet,
    }),
  ),
  DispatchChannelUnsetWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.channelUnset,
    }),
  ),
  DispatchServerListConfigWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.serverListConfig,
    }),
  ),
  DispatchServerAddMonitorRoleWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.serverAddMonitorRole,
    }),
  ),
  DispatchServerRemoveMonitorRoleWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.serverRemoveMonitorRole,
    }),
  ),
  DispatchServerSetSheetWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.serverSetSheet,
    }),
  ),
  DispatchServerSetAutoCheckinWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.serverSetAutoCheckin,
    }),
  ),
  DispatchTeamListWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.teamList,
    }),
  ),
  DispatchScheduleListWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.scheduleList,
    }),
  ),
  DispatchScreenshotWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.screenshot,
    }),
  ),
);

export const dispatchWorkflowNames = DispatchWorkflows.map((workflow) => workflow.name);
