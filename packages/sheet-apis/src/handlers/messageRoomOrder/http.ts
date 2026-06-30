import { Effect, Layer, Option, Predicate } from "effect";
import { getModernMessageWorkspaceId } from "@/handlers/message/shared";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { AuthorizationService, MessageRoomOrderService } from "@/services";
import type { MessageKey } from "@/services/messageKey";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import { SheetAuthWorkspaceUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthWorkspaceUser";
import { makeArgumentError, Unauthorized } from "typhoon-core/error";

export const MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE =
  "Cannot get message room order, the message might not be registered";

const missingMessageRoomOrderError = () =>
  makeArgumentError(MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE);

export const LEGACY_MESSAGE_ROOM_ORDER_ACCESS_ERROR =
  "Legacy message room order records are no longer accessible";

const denyLegacyMessageRoomOrderAccess = () =>
  Effect.fail(new Unauthorized({ message: LEGACY_MESSAGE_ROOM_ORDER_ACCESS_ERROR }));

type MessageRoomOrderAccessService = Pick<
  typeof MessageRoomOrderService.Service,
  "getMessageRoomOrder"
>;

type MessageRoomOrderAuthContext = {
  readonly record: MessageRoomOrder;
  readonly workspaceId: string | null;
  readonly isLegacy: boolean;
};

const loadRequiredMessageRoomOrderRecord = Effect.fn(
  "messageRoomOrder.loadRequiredMessageRoomOrderRecord",
)(function* (messageRoomOrderService: MessageRoomOrderAccessService, key: MessageKey) {
  const record = yield* messageRoomOrderService.getMessageRoomOrder(key);

  if (Option.isNone(record)) {
    return yield* Effect.fail(missingMessageRoomOrderError());
  }

  return record.value;
});

const resolveMessageRoomOrderAuthContext = (
  record: MessageRoomOrder,
): MessageRoomOrderAuthContext => {
  const workspaceId = Option.getOrElse(getModernMessageWorkspaceId(record), () => null);

  return {
    record,
    workspaceId,
    isLegacy: Predicate.isNull(workspaceId),
  };
};

const getRequiredMessageRoomOrderWorkspaceId = Effect.fn(
  "messageRoomOrder.getRequiredMessageRoomOrderWorkspaceId",
)(function* (authContext: MessageRoomOrderAuthContext) {
  if (authContext.isLegacy || Predicate.isNull(authContext.workspaceId)) {
    return yield* denyLegacyMessageRoomOrderAccess();
  }

  return authContext.workspaceId;
});

const resolveMessageRoomOrderUpsertWorkspaceId = Effect.fn(
  "messageRoomOrder.resolveMessageRoomOrderUpsertWorkspaceId",
)(function* (
  messageRoomOrderService: MessageRoomOrderAccessService,
  key: MessageKey,
  workspaceId?: string,
) {
  const existingRecord = yield* messageRoomOrderService.getMessageRoomOrder(key);

  if (Option.isNone(existingRecord)) {
    if (Predicate.isString(workspaceId)) {
      return workspaceId;
    }

    return yield* denyLegacyMessageRoomOrderAccess();
  }

  return yield* getRequiredMessageRoomOrderWorkspaceId(
    resolveMessageRoomOrderAuthContext(existingRecord.value),
  );
});

const withResolvedMessageRoomOrderWorkspaceUser = <A, E, R>(
  authorizationService: typeof AuthorizationService.Service,
  authContext: MessageRoomOrderAuthContext,
  effect: Effect.Effect<A, E, R>,
) =>
  (Predicate.isNull(authContext.workspaceId)
    ? effect
    : authorizationService.provideCurrentWorkspaceUser(
        authContext.workspaceId,
        effect,
      )) as Effect.Effect<A, E, Exclude<R, SheetAuthWorkspaceUser>>;

const requireMessageRoomOrderMonitorPermission = Effect.fn(
  "messageRoomOrder.requireMessageRoomOrderMonitorPermission",
)(function* (
  authorizationService: typeof AuthorizationService.Service,
  authContext: MessageRoomOrderAuthContext,
) {
  const workspaceId = yield* getRequiredMessageRoomOrderWorkspaceId(authContext);

  return yield* withResolvedMessageRoomOrderWorkspaceUser(
    authorizationService,
    authContext,
    authorizationService.requireMonitorWorkspace(workspaceId),
  );
});

export const requireRoomOrderMonitorAccess = Effect.fn(
  "messageRoomOrder.requireRoomOrderMonitorAccess",
)(function* (authorizationService: typeof AuthorizationService.Service, record: MessageRoomOrder) {
  return yield* requireMessageRoomOrderMonitorPermission(
    authorizationService,
    resolveMessageRoomOrderAuthContext(record),
  );
});

export const requireRoomOrderUpsertAccess = Effect.fn(
  "messageRoomOrder.requireRoomOrderUpsertAccess",
)(function* (
  authorizationService: typeof AuthorizationService.Service,
  messageRoomOrderService: MessageRoomOrderAccessService,
  key: MessageKey,
  workspaceId?: string,
) {
  const resolvedWorkspaceId = yield* resolveMessageRoomOrderUpsertWorkspaceId(
    messageRoomOrderService,
    key,
    workspaceId,
  );

  return yield* authorizationService.provideCurrentWorkspaceUser(
    resolvedWorkspaceId,
    authorizationService.requireMonitorWorkspace(resolvedWorkspaceId),
  );
});

const requireRoomOrderMonitorMutationAccess = Effect.fn(
  "messageRoomOrder.requireRoomOrderMonitorMutationAccess",
)(function* (
  authorizationService: typeof AuthorizationService.Service,
  messageRoomOrderService: MessageRoomOrderAccessService,
  key: MessageKey,
) {
  const record = yield* loadRequiredMessageRoomOrderRecord(messageRoomOrderService, key);
  const authContext = resolveMessageRoomOrderAuthContext(record);

  yield* requireMessageRoomOrderMonitorPermission(authorizationService, authContext);

  return authContext.record;
});

export const messageRoomOrderLayer = sheetApisGroupLayer(
  "messageRoomOrder",
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const messageRoomOrderService = yield* MessageRoomOrderService;

    return {
      "messageRoomOrder.getMessageRoomOrder": Effect.fnUntraced(function* ({ query }) {
        const record = yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          query,
        );

        return record;
      }),
      "messageRoomOrder.upsertMessageRoomOrder": Effect.fnUntraced(function* ({ payload }) {
        yield* requireRoomOrderUpsertAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
          Predicate.isString(payload.data.workspaceId) ? payload.data.workspaceId : undefined,
        );

        return yield* messageRoomOrderService.upsertMessageRoomOrder(payload, payload.data);
      }),
      "messageRoomOrder.persistMessageRoomOrder": Effect.fnUntraced(function* ({ payload }) {
        yield* requireRoomOrderUpsertAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
          Predicate.isString(payload.data.workspaceId) ? payload.data.workspaceId : undefined,
        );

        return yield* messageRoomOrderService.persistMessageRoomOrder(payload, {
          data: payload.data,
          entries: payload.entries,
        });
      }),
      "messageRoomOrder.decrementMessageRoomOrderRank": Effect.fnUntraced(function* ({ payload }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
        );

        return yield* messageRoomOrderService.decrementMessageRoomOrderRank(payload, {
          expectedRank: payload.expectedRank,
          tentativeUpdateClaimId: payload.tentativeUpdateClaimId,
        });
      }),
      "messageRoomOrder.incrementMessageRoomOrderRank": Effect.fnUntraced(function* ({ payload }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
        );

        return yield* messageRoomOrderService.incrementMessageRoomOrderRank(payload, {
          expectedRank: payload.expectedRank,
          tentativeUpdateClaimId: payload.tentativeUpdateClaimId,
        });
      }),
      "messageRoomOrder.getMessageRoomOrderEntry": Effect.fnUntraced(function* ({ query }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          query,
        );

        return yield* messageRoomOrderService.getMessageRoomOrderEntry(query, query.rank);
      }),
      "messageRoomOrder.getMessageRoomOrderRange": Effect.fnUntraced(function* ({ query }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          query,
        );

        const range = yield* messageRoomOrderService.getMessageRoomOrderRange(query);
        if (Option.isNone(range)) {
          return yield* Effect.fail(
            makeArgumentError(
              "Cannot get message room order range, the message might not be registered",
            ),
          );
        }

        return range.value;
      }),
      "messageRoomOrder.upsertMessageRoomOrderEntry": Effect.fnUntraced(function* ({ payload }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
        );

        return yield* messageRoomOrderService.upsertMessageRoomOrderEntry(payload, payload.entries);
      }),
      "messageRoomOrder.removeMessageRoomOrderEntry": Effect.fnUntraced(function* ({ payload }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
        );

        return yield* messageRoomOrderService.removeMessageRoomOrderEntry(payload);
      }),
      "messageRoomOrder.claimMessageRoomOrderSend": Effect.fnUntraced(function* ({ payload }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
        );

        return yield* messageRoomOrderService.claimMessageRoomOrderSend(payload, payload.claimId);
      }),
      "messageRoomOrder.completeMessageRoomOrderSend": Effect.fnUntraced(function* ({ payload }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
        );

        return yield* messageRoomOrderService.completeMessageRoomOrderSend(
          payload,
          payload.claimId,
          payload.sentMessage,
        );
      }),
      "messageRoomOrder.releaseMessageRoomOrderSendClaim": Effect.fnUntraced(function* ({
        payload,
      }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
        );

        return yield* messageRoomOrderService.releaseMessageRoomOrderSendClaim(
          payload,
          payload.claimId,
        );
      }),
      "messageRoomOrder.claimMessageRoomOrderTentativeUpdate": Effect.fnUntraced(function* ({
        payload,
      }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
        );

        return yield* messageRoomOrderService.claimMessageRoomOrderTentativeUpdate(
          payload,
          payload.claimId,
        );
      }),
      "messageRoomOrder.releaseMessageRoomOrderTentativeUpdateClaim": Effect.fnUntraced(function* ({
        payload,
      }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
        );

        return yield* messageRoomOrderService.releaseMessageRoomOrderTentativeUpdateClaim(
          payload,
          payload.claimId,
        );
      }),
      "messageRoomOrder.claimMessageRoomOrderTentativePin": Effect.fnUntraced(function* ({
        payload,
      }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
        );

        return yield* messageRoomOrderService.claimMessageRoomOrderTentativePin(
          payload,
          payload.claimId,
        );
      }),
      "messageRoomOrder.completeMessageRoomOrderTentativePin": Effect.fnUntraced(function* ({
        payload,
      }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
        );

        return yield* messageRoomOrderService.completeMessageRoomOrderTentativePin(
          payload,
          payload.claimId,
        );
      }),
      "messageRoomOrder.releaseMessageRoomOrderTentativePinClaim": Effect.fnUntraced(function* ({
        payload,
      }) {
        yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
        );

        return yield* messageRoomOrderService.releaseMessageRoomOrderTentativePinClaim(
          payload,
          payload.claimId,
        );
      }),
      "messageRoomOrder.markMessageRoomOrderTentative": Effect.fnUntraced(function* ({ payload }) {
        const record = yield* requireRoomOrderMonitorMutationAccess(
          authorizationService,
          messageRoomOrderService,
          payload,
        );
        const workspaceId = yield* Option.match(record.workspaceId, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              makeArgumentError("Cannot mark tentative room order, workspace is missing"),
            ),
        });
        const conversationId = yield* Option.match(record.conversationId, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              makeArgumentError("Cannot mark tentative room order, conversation is missing"),
            ),
        });

        return yield* messageRoomOrderService.markMessageRoomOrderTentative(payload, {
          workspaceId,
          conversationId,
        });
      }),
    } satisfies HandlerMap<"messageRoomOrder">;
  }),
).pipe(Layer.provide([AuthorizationService.layer, MessageRoomOrderService.layer]));
