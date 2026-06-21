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
import type { ClientRef } from "sheet-ingress-api/schemas/client";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import type { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import { Unauthorized } from "typhoon-core/error";
import { normalizeDispatchError } from "@/handlers/shared/dispatchError";
import {
  isInteractionFailureHandled,
  unwrapInteractionFailure,
} from "@/handlers/shared/interactionFailure";
import {
  ClientDeliveryClient,
  ClientDeliveryClientRef,
  DispatchService,
  SheetApisClient,
} from "@/services";
import {
  DispatchAutoCheckinTestWorkflow,
  DispatchCheckinButtonWorkflow,
  DispatchCheckinWorkflow,
  DispatchConversationListConfigWorkflow,
  DispatchConversationSetWorkflow,
  DispatchConversationUnsetWorkflow,
  DispatchWorkspaceWelcomeWorkflow,
  DispatchKickoutWorkflow,
  DispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow,
  DispatchRoomOrderWorkflow,
  DispatchScheduleListWorkflow,
  DispatchServiceAddWorkspaceFeatureFlagWorkflow,
  DispatchServiceRemoveWorkspaceFeatureFlagWorkflow,
  DispatchServiceStatusWorkflow,
  DispatchWorkspaceAddMonitorRoleWorkflow,
  DispatchWorkspaceListConfigWorkflow,
  DispatchWorkspaceRemoveMonitorRoleWorkflow,
  DispatchWorkspaceSetAutoCheckinWorkflow,
  DispatchWorkspaceSetSheetWorkflow,
  DispatchScreenshotWorkflow,
  DispatchSlotButtonWorkflow,
  DispatchSlotListWorkflow,
  DispatchSlotOpenButtonWorkflow,
  DispatchTeamListWorkflow,
  DispatchUpdateAnnouncementWorkflow,
  DispatchWorkflows,
} from "./dispatchWorkflows";

const entityFailureMessage = "Dispatch failed. Please try again.";
const maxFailureDetailLength = 1_200;
const errorFileName = "error.txt";
const errorFileContentType = "text/plain";
const textEncoder = new TextEncoder();

const messageKeyForPayload = (payload: {
  readonly client: ClientRef;
  readonly messageId: string;
}) => {
  return {
    clientPlatform: payload.client.platform,
    clientId: payload.client.clientId,
    messageId: payload.messageId,
  };
};

const errorDetailLabels = {
  ArgumentError: "Request error",
  GoogleSheetsError: "Google Sheets error",
  ParserFieldError: "Invalid sheet data",
  QueryResultAppError: "Database error",
  QueryResultParseError: "Database error",
  SchemaError: "Data format error",
  SheetConfigError: "Sheet config error",
  Unauthorized: "Authorization error",
  UnknownError: "Unexpected error",
} as const;

const errorDetailLabelTags = new Set<string>(Object.keys(errorDetailLabels));

const isErrorDetailLabelTag = (tag: string): tag is keyof typeof errorDetailLabels =>
  errorDetailLabelTags.has(tag);

const errorMessage = (error: unknown): Option.Option<string> =>
  Predicate.hasProperty(error, "message") && typeof error.message === "string"
    ? Option.some(error.message)
    : Option.none();

const cleanFailureDetail = (message: string) => {
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > maxFailureDetailLength
    ? `${clean.slice(0, maxFailureDetailLength - 3)}...`
    : clean;
};

const errorDetailLabel = (error: unknown): Option.Option<string> => {
  if (!Predicate.hasProperty(error, "_tag") || typeof error._tag !== "string") {
    return error instanceof Error ? Option.some("Unexpected error") : Option.none();
  }

  return isErrorDetailLabelTag(error._tag)
    ? Option.some(errorDetailLabels[error._tag])
    : errorMessage(error).pipe(Option.as("Unexpected error"));
};

export const dispatchFailureMessage = (error: unknown): string => {
  const detail = Option.all({
    label: errorDetailLabel(error),
    message: errorMessage(error),
  }).pipe(
    Option.map(({ label, message }) => `${label}: ${cleanFailureDetail(message)}`),
    Option.getOrUndefined,
  );

  return detail ? `${entityFailureMessage}\n${detail}` : entityFailureMessage;
};

const dispatchFailureTrace = (error: unknown) => {
  const cause = Cause.isCause(error) ? error : Cause.fail(error);
  const trace = Cause.pretty(cause).trim();

  return trace.length > 0
    ? trace
    : errorMessage(error).pipe(Option.getOrElse(() => "Unknown error"));
};

export const dispatchFailureResponse = (error: unknown) => {
  const fullText = dispatchFailureTrace(error);

  return {
    payload: {
      content: `${dispatchFailureMessage(error)}\nFull error is attached.`,
      files: [
        {
          name: errorFileName,
          contentType: errorFileContentType,
          content: textEncoder.encode(fullText),
        },
      ],
    },
  };
};

const isMissingMessageRoomOrderError = (error: unknown) =>
  Predicate.isTagged("ArgumentError")(error) &&
  Predicate.hasProperty(error, "message") &&
  error.message === MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE;

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
  typeof interactionResponseToken === "string"
    ? Effect.gen(function* () {
        const botClient = yield* ClientDeliveryClient;
        const response = dispatchFailureResponse(unwrapInteractionFailure(error));
        yield* botClient
          .updateOriginalInteractionResponse(interactionResponseToken, response.payload)
          .pipe(Effect.catch(() => Effect.void));
      }).pipe((effect) => withRequestClientRef(effect, clientRef))
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

const requireCheckinButtonAccess = (
  payload: { readonly client: ClientRef; readonly messageId: string },
  requester: DispatchRequester,
) =>
  Effect.gen(function* () {
    const sheetApis = (yield* SheetApisClient).get();
    const members = yield* sheetApis.messageCheckin
      .getMessageCheckinMembers({
        query: messageKeyForPayload(payload),
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
    if (Option.isNone(roomOrder.workspaceId) || Option.isNone(roomOrder.conversationId)) {
      return yield* Effect.fail(
        new Unauthorized({ message: "Legacy message room order records are no longer accessible" }),
      );
    }

    if (
      roomOrder.workspaceId.value !== payload.workspaceId ||
      roomOrder.conversationId.value !== payload.messageConversationId
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
        query: messageKeyForPayload(payload),
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
        query: messageKeyForPayload(payload),
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

const requireSlotOpenButtonAccess = (payload: {
  readonly client: ClientRef;
  readonly messageId: string;
}) =>
  Effect.gen(function* () {
    const sheetApis = (yield* SheetApisClient).get();
    const messageSlot = yield* sheetApis.messageSlot
      .getMessageSlotData({
        query: messageKeyForPayload(payload),
      })
      .pipe(Effect.mapError(normalizeDispatchError("Failed to verify slot button access")));

    if (Option.isNone(messageSlot.workspaceId) || Option.isNone(messageSlot.conversationId)) {
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

const requireAuthorizedWorkspace = (
  authorization: DispatchAuthorizationSnapshot | undefined,
  workspaceId: string,
  scope: DispatchAuthorizationSnapshot["scope"],
) =>
  Effect.gen(function* () {
    if (
      authorization?.workspaceId === workspaceId &&
      scopeRank[authorization.scope] >= scopeRank[scope]
    ) {
      return;
    }

    return yield* Effect.fail(
      new Unauthorized({
        message: `Dispatch requester is not authorized to ${scope} workspace ${workspaceId}`,
      }),
    );
  });

const requireSelfOrAuthorizedWorkspace = (
  request: {
    readonly requester: DispatchRequester;
    readonly authorization?: DispatchAuthorizationSnapshot | undefined;
    readonly payload: {
      readonly workspaceId: string;
      readonly targetUserId: string;
    };
  },
  scope: DispatchAuthorizationSnapshot["scope"],
) =>
  request.requester.accountId === request.payload.targetUserId
    ? Effect.void
    : requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, scope);

export const makeWorkflowHandler =
  <TWorkflow extends DispatchWorkflow, TAuthorization, RAuthorize, RExecute>(
    options: DispatchWorkflowHandlerOptions<TWorkflow, TAuthorization, RAuthorize, RExecute>,
  ): DispatchWorkflowHandler<TWorkflow, RAuthorize | RExecute | ClientDeliveryClient> =>
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
      RAuthorize | RExecute | ClientDeliveryClient
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

const clusterPersistenceErrorNames = new Set(["~effect/cluster/ClusterError/PersistenceError"]);

const isClusterPersistenceDefect = (defect: unknown): boolean =>
  Predicate.isTagged("PersistenceError")(defect) ||
  (Predicate.hasProperty(defect, "name") &&
    Predicate.isString(defect.name) &&
    clusterPersistenceErrorNames.has(defect.name));

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
  const clientRef = requestClientRef(request);
  return options.authorize(request).pipe(
    Effect.withSpan("DispatchWorkflow.authorize", { attributes }),
    Effect.flatMap((authorization) =>
      withRequestClientRef(options.execute(request, authorization), clientRef).pipe(
        Effect.withSpan("DispatchWorkflow.execute", { attributes }),
      ),
    ),
    Effect.tapError((error) =>
      isInteractionFailureHandled(error)
        ? Effect.void
        : notifyInteractionFailure(clientRef, options.getInteractionToken(request), error).pipe(
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
      request.payload.interactionResponseToken,
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
      request.payload.interactionResponseToken,
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
      request.payload.interactionResponseToken,
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
      request.payload.interactionResponseToken,
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
      request.payload.interactionResponseToken,
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
      request.payload.interactionResponseToken,
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
      request.payload.interactionResponseToken,
    authorize: (request: typeof DispatchSlotOpenButtonWorkflow.payloadSchema.Type) =>
      requireSlotOpenButtonAccess(request.payload),
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
      request.payload.interactionResponseToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchServiceStatusWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.serviceStatus(request.payload);
      }),
  },
  workspaceWelcome: {
    operation: "workspaceWelcome",
    workflow: DispatchWorkspaceWelcomeWorkflow,
    getInteractionToken: () => undefined,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchWorkspaceWelcomeWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.workspaceWelcome(request.payload);
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
  serviceAddWorkspaceFeatureFlag: {
    operation: "serviceAddWorkspaceFeatureFlag",
    workflow: DispatchServiceAddWorkspaceFeatureFlagWorkflow,
    getInteractionToken: () => undefined,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchServiceAddWorkspaceFeatureFlagWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.serviceAddWorkspaceFeatureFlag(request.payload);
      }),
  },
  serviceRemoveWorkspaceFeatureFlag: {
    operation: "serviceRemoveWorkspaceFeatureFlag",
    workflow: DispatchServiceRemoveWorkspaceFeatureFlagWorkflow,
    getInteractionToken: () => undefined,
    authorize: () => Effect.void,
    execute: (
      request: typeof DispatchServiceRemoveWorkspaceFeatureFlagWorkflow.payloadSchema.Type,
    ) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.serviceRemoveWorkspaceFeatureFlag(request.payload);
      }),
  },
  checkinButton: {
    operation: "checkinButton",
    workflow: DispatchCheckinButtonWorkflow,
    getInteractionToken: (request: typeof DispatchCheckinButtonWorkflow.payloadSchema.Type) =>
      request.payload.interactionResponseToken,
    authorize: (request: typeof DispatchCheckinButtonWorkflow.payloadSchema.Type) =>
      requireCheckinButtonAccess(request.payload, request.requester),
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
    ) => request.payload.interactionResponseToken,
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
      request.payload.interactionResponseToken,
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
      request.payload.interactionResponseToken,
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
    ) => request.payload.interactionResponseToken,
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
  conversationListConfig: {
    operation: "conversationListConfig",
    workflow: DispatchConversationListConfigWorkflow,
    getInteractionToken: (
      request: typeof DispatchConversationListConfigWorkflow.payloadSchema.Type,
    ) => request.payload.interactionResponseToken,
    authorize: (request: typeof DispatchConversationListConfigWorkflow.payloadSchema.Type) =>
      requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, "manage"),
    execute: (request: typeof DispatchConversationListConfigWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.conversationListConfig(request.payload);
      }),
  },
  conversationSet: {
    operation: "conversationSet",
    workflow: DispatchConversationSetWorkflow,
    getInteractionToken: (request: typeof DispatchConversationSetWorkflow.payloadSchema.Type) =>
      request.payload.interactionResponseToken,
    authorize: (request: typeof DispatchConversationSetWorkflow.payloadSchema.Type) =>
      requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, "manage"),
    execute: (request: typeof DispatchConversationSetWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.conversationSet(request.payload);
      }),
  },
  conversationUnset: {
    operation: "conversationUnset",
    workflow: DispatchConversationUnsetWorkflow,
    getInteractionToken: (request: typeof DispatchConversationUnsetWorkflow.payloadSchema.Type) =>
      request.payload.interactionResponseToken,
    authorize: (request: typeof DispatchConversationUnsetWorkflow.payloadSchema.Type) =>
      requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, "manage"),
    execute: (request: typeof DispatchConversationUnsetWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.conversationUnset(request.payload);
      }),
  },
  workspaceListConfig: {
    operation: "workspaceListConfig",
    workflow: DispatchWorkspaceListConfigWorkflow,
    getInteractionToken: (request: typeof DispatchWorkspaceListConfigWorkflow.payloadSchema.Type) =>
      request.payload.interactionResponseToken,
    authorize: (request: typeof DispatchWorkspaceListConfigWorkflow.payloadSchema.Type) =>
      requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, "manage"),
    execute: (request: typeof DispatchWorkspaceListConfigWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.workspaceListConfig(request.payload);
      }),
  },
  workspaceAddMonitorRole: {
    operation: "workspaceAddMonitorRole",
    workflow: DispatchWorkspaceAddMonitorRoleWorkflow,
    getInteractionToken: (
      request: typeof DispatchWorkspaceAddMonitorRoleWorkflow.payloadSchema.Type,
    ) => request.payload.interactionResponseToken,
    authorize: (request: typeof DispatchWorkspaceAddMonitorRoleWorkflow.payloadSchema.Type) =>
      requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, "manage"),
    execute: (request: typeof DispatchWorkspaceAddMonitorRoleWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.workspaceAddMonitorRole(request.payload);
      }),
  },
  workspaceRemoveMonitorRole: {
    operation: "workspaceRemoveMonitorRole",
    workflow: DispatchWorkspaceRemoveMonitorRoleWorkflow,
    getInteractionToken: (
      request: typeof DispatchWorkspaceRemoveMonitorRoleWorkflow.payloadSchema.Type,
    ) => request.payload.interactionResponseToken,
    authorize: (request: typeof DispatchWorkspaceRemoveMonitorRoleWorkflow.payloadSchema.Type) =>
      requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, "manage"),
    execute: (request: typeof DispatchWorkspaceRemoveMonitorRoleWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.workspaceRemoveMonitorRole(request.payload);
      }),
  },
  workspaceSetSheet: {
    operation: "workspaceSetSheet",
    workflow: DispatchWorkspaceSetSheetWorkflow,
    getInteractionToken: (request: typeof DispatchWorkspaceSetSheetWorkflow.payloadSchema.Type) =>
      request.payload.interactionResponseToken,
    authorize: (request: typeof DispatchWorkspaceSetSheetWorkflow.payloadSchema.Type) =>
      requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, "manage"),
    execute: (request: typeof DispatchWorkspaceSetSheetWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.workspaceSetSheet(request.payload);
      }),
  },
  workspaceSetAutoCheckin: {
    operation: "workspaceSetAutoCheckin",
    workflow: DispatchWorkspaceSetAutoCheckinWorkflow,
    getInteractionToken: (
      request: typeof DispatchWorkspaceSetAutoCheckinWorkflow.payloadSchema.Type,
    ) => request.payload.interactionResponseToken,
    authorize: (request: typeof DispatchWorkspaceSetAutoCheckinWorkflow.payloadSchema.Type) =>
      requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, "manage"),
    execute: (request: typeof DispatchWorkspaceSetAutoCheckinWorkflow.payloadSchema.Type) =>
      Effect.gen(function* () {
        const service = yield* DispatchService;
        return yield* service.workspaceSetAutoCheckin(request.payload);
      }),
  },
  teamList: {
    operation: "teamList",
    workflow: DispatchTeamListWorkflow,
    getInteractionToken: (request: typeof DispatchTeamListWorkflow.payloadSchema.Type) =>
      request.payload.interactionResponseToken,
    authorize: (request: typeof DispatchTeamListWorkflow.payloadSchema.Type) =>
      requireSelfOrAuthorizedWorkspace(request, "monitor"),
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
      request.payload.interactionResponseToken,
    authorize: (request: typeof DispatchScheduleListWorkflow.payloadSchema.Type) =>
      requireSelfOrAuthorizedWorkspace(request, "monitor"),
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
      request.payload.interactionResponseToken,
    authorize: (request: typeof DispatchScreenshotWorkflow.payloadSchema.Type) =>
      requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, "monitor"),
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
  DispatchWorkspaceWelcomeWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.workspaceWelcome,
    }),
  ),
  DispatchUpdateAnnouncementWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.updateAnnouncement,
    }),
  ),
  DispatchServiceAddWorkspaceFeatureFlagWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.serviceAddWorkspaceFeatureFlag,
    }),
  ),
  DispatchServiceRemoveWorkspaceFeatureFlagWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.serviceRemoveWorkspaceFeatureFlag,
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
  DispatchConversationListConfigWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.conversationListConfig,
    }),
  ),
  DispatchConversationSetWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.conversationSet,
    }),
  ),
  DispatchConversationUnsetWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.conversationUnset,
    }),
  ),
  DispatchWorkspaceListConfigWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.workspaceListConfig,
    }),
  ),
  DispatchWorkspaceAddMonitorRoleWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.workspaceAddMonitorRole,
    }),
  ),
  DispatchWorkspaceRemoveMonitorRoleWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.workspaceRemoveMonitorRole,
    }),
  ),
  DispatchWorkspaceSetSheetWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.workspaceSetSheet,
    }),
  ),
  DispatchWorkspaceSetAutoCheckinWorkflow.toLayer(
    makeWorkflowHandler({
      ...dispatchWorkflowRegistry.workspaceSetAutoCheckin,
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
