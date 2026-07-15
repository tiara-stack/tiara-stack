import { Cause, Duration, Effect, Option, Predicate } from "effect";
import type { SheetOutboundMessage } from "sheet-ingress-api/schemas/client";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { recoverNonInterruptCause } from "../pure/failure";

export type DeliveredMessage = {
  readonly id: string;
  readonly conversation_id: string;
};

type DispatchMessageSink = {
  readonly sendPrimary: (
    payload: SheetOutboundMessage,
  ) => Effect.Effect<DeliveredMessage, unknown, never>;
  readonly updatePrimary: (
    message: DeliveredMessage,
    payload: SheetOutboundMessage,
  ) => Effect.Effect<DeliveredMessage, unknown, never>;
};

const deliveryReconciliationTimeout = Duration.seconds(10);

const boundExternalOperation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.interruptible, Effect.timeout(deliveryReconciliationTimeout));

export const logEnableFailure = (message: string) => (error: unknown) =>
  Effect.logWarning(message).pipe(
    Effect.annotateLogs({
      cause: Cause.isCause(error) ? Cause.pretty(error) : globalThis.String(error),
    }),
  );

const logByLevel = {
  error: { cause: Effect.logError, message: Effect.logError },
  warning: { cause: Effect.logDebug, message: Effect.logWarning },
} as const;

export const logNonInterruptFailure = <A, E, R>(
  message: string,
  annotations: Readonly<Record<string, unknown>>,
  afterLog: Effect.Effect<A, E, R> | ((cause: Cause.Cause<unknown>) => Effect.Effect<A, E, R>),
  level: "error" | "warning" = "error",
) => {
  const { cause: logCause, message: logMessage } = logByLevel[level];
  return Effect.catchCause((cause) =>
    recoverNonInterruptCause(cause, () =>
      logMessage(message).pipe(
        Effect.andThen(logCause(Cause.pretty(cause))),
        Effect.andThen(Predicate.isFunction(afterLog) ? afterLog(cause) : afterLog),
        Effect.annotateLogs(annotations),
      ),
    ),
  );
};

export const compensateDeliveryFailure = <A, E, R>(
  cause: Cause.Cause<unknown>,
  cleanup: Effect.Effect<A, E, R>,
) =>
  Effect.uninterruptible(boundExternalOperation(cleanup)).pipe(
    Effect.catchCause((cleanupCause) =>
      Cause.hasInterrupts(cleanupCause)
        ? Effect.failCause(Cause.combine(cause, cleanupCause))
        : Effect.logError("Failed to compensate for message delivery failure").pipe(
            Effect.annotateLogs({ cleanupCause: Cause.pretty(cleanupCause) }),
          ),
    ),
    Effect.andThen(Effect.failCause(cause)),
  );

export const reconcileDeliveryPersistence = ({
  cause,
  cleanup,
  lookup,
  lookupFailureAnnotations,
  lookupFailureMessage,
}: {
  readonly cause: Cause.Cause<unknown>;
  readonly cleanup: Effect.Effect<unknown, unknown, never>;
  readonly lookup: Effect.Effect<Option.Option<unknown>, unknown, never>;
  readonly lookupFailureAnnotations: Record<string, unknown>;
  readonly lookupFailureMessage: string;
}) => {
  if (!Cause.hasInterrupts(cause)) {
    return compensateDeliveryFailure(cause, cleanup);
  }
  return Effect.uninterruptible(
    lookup.pipe(
      boundExternalOperation,
      logNonInterruptFailure(lookupFailureMessage, lookupFailureAnnotations, (lookupCause) =>
        Effect.failCause(Cause.combine(cause, lookupCause)),
      ),
      Effect.flatMap(
        Option.match({
          onSome: () => Effect.failCause(cause),
          onNone: () => compensateDeliveryFailure(cause, cleanup),
        }),
      ),
    ),
  );
};

export const reconcileRoomOrderPersistence = ({
  botClient,
  cause,
  message,
  messageRoomOrderService,
}: {
  readonly botClient: Pick<typeof ClientDeliveryClient.Service, "deleteMessage">;
  readonly cause: Cause.Cause<unknown>;
  readonly message: DeliveredMessage;
  readonly messageRoomOrderService: {
    readonly getMessageRoomOrder: (
      messageId: string,
    ) => Effect.Effect<Option.Option<unknown>, unknown>;
  };
}) => {
  // Reconciliation may preserve a delivered message, but an original interrupt
  // must always be re-failed so cancellation is never converted into success.
  const interrupted = Cause.hasInterrupts(cause);
  const reconciliation = messageRoomOrderService.getMessageRoomOrder(message.id).pipe(
    boundExternalOperation,
    logNonInterruptFailure(
      "Failed to reconcile room-order persistence; delivered message preserved",
      {
        conversationId: message.conversation_id,
        messageId: message.id,
      },
      interrupted
        ? (reconciliationCause) => Effect.failCause(Cause.combine(cause, reconciliationCause))
        : Effect.failCause(cause),
    ),
    Effect.flatMap(
      Option.match({
        onSome: () =>
          interrupted
            ? Effect.failCause(cause)
            : Effect.logWarning(
                "Room-order persistence reconciliation found an existing record; preserving the delivered message",
              ).pipe(
                Effect.annotateLogs({
                  cause: Cause.pretty(cause),
                  conversationId: message.conversation_id,
                  messageId: message.id,
                }),
              ),
        onNone: () =>
          interrupted
            ? botClient.deleteMessage(message.conversation_id, message.id).pipe(
                boundExternalOperation,
                logNonInterruptFailure(
                  "Failed to compensate for interrupted room-order persistence",
                  {
                    conversationId: message.conversation_id,
                    messageId: message.id,
                  },
                  (cleanupCause) => Effect.failCause(Cause.combine(cause, cleanupCause)),
                ),
                Effect.andThen(Effect.failCause(cause)),
              )
            : compensateDeliveryFailure(
                cause,
                botClient.deleteMessage(message.conversation_id, message.id),
              ),
      }),
    ),
  );
  return Effect.uninterruptible(reconciliation);
};

const makeInteractionMessageSink = (
  botClient: typeof ClientDeliveryClient.Service,
  interactionResponseToken: string,
): DispatchMessageSink => ({
  sendPrimary: (payload) =>
    botClient.updateOriginalInteractionResponse(interactionResponseToken, payload),
  updatePrimary: (_message, payload) =>
    botClient.updateOriginalInteractionResponse(interactionResponseToken, payload),
});

const makeConversationMessageSink = (
  botClient: typeof ClientDeliveryClient.Service,
  conversationId: string,
): DispatchMessageSink => ({
  sendPrimary: (payload) => botClient.sendMessage(conversationId, payload),
  updatePrimary: (message, payload) =>
    botClient.updateMessage(message.conversation_id, message.id, payload),
});

export const makeMessageSink = (
  botClient: typeof ClientDeliveryClient.Service,
  conversationId: string,
  interactionResponseToken: string | undefined,
): DispatchMessageSink =>
  Predicate.isString(interactionResponseToken) && interactionResponseToken.length > 0
    ? makeInteractionMessageSink(botClient, interactionResponseToken)
    : makeConversationMessageSink(botClient, conversationId);
