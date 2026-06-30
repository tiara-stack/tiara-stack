import { Effect, Layer, Option, Predicate } from "effect";
import { getModernMessageWorkspaceId } from "@/handlers/message/shared";
import { AuthorizationService, MessageSlotService } from "@/services";
import type { MessageKey } from "@/services/messageKey";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import { SheetAuthWorkspaceUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthWorkspaceUser";
import { makeArgumentError, Unauthorized } from "typhoon-core/error";

const missingMessageSlotError = () =>
  makeArgumentError("Cannot get message slot data, the message might not be registered");

export const LEGACY_MESSAGE_SLOT_ACCESS_ERROR =
  "Legacy message slot records are no longer accessible";

const denyLegacyMessageSlotAccess = () =>
  Effect.fail(new Unauthorized({ message: LEGACY_MESSAGE_SLOT_ACCESS_ERROR }));

type MessageSlotAccessService = Pick<typeof MessageSlotService.Service, "getMessageSlotData">;

type MessageSlotAuthContext = {
  readonly record: MessageSlot;
  readonly workspaceId: string | null;
  readonly isLegacy: boolean;
};

const loadRequiredMessageSlotRecord = Effect.fn("messageSlot.loadRequiredMessageSlotRecord")(
  function* (messageSlotService: MessageSlotAccessService, key: MessageKey) {
    const record = yield* messageSlotService.getMessageSlotData(key);

    if (Option.isNone(record)) {
      return yield* Effect.fail(missingMessageSlotError());
    }

    return record.value;
  },
);

const resolveMessageSlotAuthContext = (record: MessageSlot): MessageSlotAuthContext => {
  const workspaceId = Option.getOrElse(getModernMessageWorkspaceId(record), () => null);

  return {
    record,
    workspaceId,
    isLegacy: Predicate.isNull(workspaceId),
  };
};

const getRequiredMessageSlotWorkspaceId = Effect.fn(
  "messageSlot.getRequiredMessageSlotWorkspaceId",
)(function* (authContext: MessageSlotAuthContext) {
  if (authContext.isLegacy || Predicate.isNull(authContext.workspaceId)) {
    return yield* denyLegacyMessageSlotAccess();
  }

  return authContext.workspaceId;
});

const resolveMessageSlotUpsertWorkspaceId = Effect.fn(
  "messageSlot.resolveMessageSlotUpsertWorkspaceId",
)(function* (messageSlotService: MessageSlotAccessService, key: MessageKey, workspaceId?: string) {
  const existingRecord = yield* messageSlotService.getMessageSlotData(key);

  if (Option.isNone(existingRecord)) {
    if (Predicate.isString(workspaceId)) {
      return workspaceId;
    }

    return yield* denyLegacyMessageSlotAccess();
  }

  return yield* getRequiredMessageSlotWorkspaceId(
    resolveMessageSlotAuthContext(existingRecord.value),
  );
});

const withResolvedMessageSlotWorkspaceUser = <A, E, R>(
  authorizationService: typeof AuthorizationService.Service,
  authContext: MessageSlotAuthContext,
  effect: Effect.Effect<A, E, R>,
) =>
  (Predicate.isNull(authContext.workspaceId)
    ? effect
    : authorizationService.provideCurrentWorkspaceUser(
        authContext.workspaceId,
        effect,
      )) as Effect.Effect<A, E, Exclude<R, SheetAuthWorkspaceUser>>;

const requireMessageSlotReadPermission = Effect.fn("messageSlot.requireMessageSlotReadPermission")(
  function* (
    authorizationService: typeof AuthorizationService.Service,
    authContext: MessageSlotAuthContext,
  ) {
    const workspaceId = yield* getRequiredMessageSlotWorkspaceId(authContext);

    return yield* withResolvedMessageSlotWorkspaceUser(
      authorizationService,
      authContext,
      authorizationService.requireWorkspaceMember(workspaceId),
    );
  },
);

export const requireMessageSlotUpsertAccess = Effect.fn(
  "messageSlot.requireMessageSlotUpsertAccess",
)(function* (
  authorizationService: typeof AuthorizationService.Service,
  messageSlotService: MessageSlotAccessService,
  key: MessageKey,
  workspaceId?: string,
) {
  const resolvedWorkspaceId = yield* resolveMessageSlotUpsertWorkspaceId(
    messageSlotService,
    key,
    workspaceId,
  );

  return yield* authorizationService.provideCurrentWorkspaceUser(
    resolvedWorkspaceId,
    authorizationService.requireMonitorWorkspace(resolvedWorkspaceId),
  );
});

export const requireMessageSlotReadAccess = Effect.fn("messageSlot.requireMessageSlotReadAccess")(
  function* (
    authorizationService: typeof AuthorizationService.Service,
    messageSlotService: MessageSlotAccessService,
    key: MessageKey,
  ) {
    const record = yield* loadRequiredMessageSlotRecord(messageSlotService, key);
    const authContext = resolveMessageSlotAuthContext(record);

    yield* requireMessageSlotReadPermission(authorizationService, authContext);

    return authContext.record;
  },
);

export const messageSlotLayer = sheetApisGroupLayer(
  "messageSlot",
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const messageSlotService = yield* MessageSlotService;

    return {
      "messageSlot.getMessageSlotData": Effect.fnUntraced(function* ({ query }) {
        return yield* requireMessageSlotReadAccess(authorizationService, messageSlotService, query);
      }),
      "messageSlot.upsertMessageSlotData": Effect.fnUntraced(function* ({ payload }) {
        yield* requireMessageSlotUpsertAccess(
          authorizationService,
          messageSlotService,
          payload,
          Predicate.isString(payload.data.workspaceId) ? payload.data.workspaceId : undefined,
        );

        return yield* messageSlotService.upsertMessageSlotData(payload, payload.data);
      }),
    } satisfies HandlerMap<"messageSlot">;
  }),
).pipe(Layer.provide([AuthorizationService.layer, MessageSlotService.layer]));
