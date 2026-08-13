import { Cause, Clock, DateTime, Effect, Exit, Layer, Option, Predicate } from "effect";
import { conversationRefFrom, type SetMessagePinnedReceipt } from "sheet-bot-api";
import { publishedRoomOrderMessage } from "sheet-message-content/roomOrderMessage";
import { buildRoomOrderContent } from "sheet-message-content/roomOrderContent";
import { fillParticipantFromName, hourWindowFor } from "sheet-message-content/rendering";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import type { AuthorizedRoomOrderSendContext } from "../readOnly/authorization";
import {
  interactiveAuthorizationRevoked,
  interactiveDeliveryRejected,
  interactiveExternalOperationRejected,
  mapDeliveryFailure,
} from "../shared/interactive";
import { providerCauseKind } from "../shared/providerFailure";
import { RoomOrderNavigationProvider, RoomOrderNavigationProviderError } from "./provider";
import type { RoomOrderSendCommit, RoomOrderSendRecordDisposition } from "./sendSchema";
import { RoomOrderSendOperations, RoomOrderSendOperationsError } from "./sendService";

const operationError = (operation: string, cause: unknown) =>
  new RoomOrderSendOperationsError({ operation, cause });

const messageKey = (context: AuthorizedRoomOrderSendContext) => ({
  clientPlatform: context.clientPlatform,
  clientId: context.clientId,
  messageId: context.messageId,
});

// fallow-ignore-next-line complexity
const canonicalViewMatches = (
  context: AuthorizedRoomOrderSendContext,
  row: {
    readonly clientPlatform: string;
    readonly clientId: string;
    readonly messageId: string;
    readonly workspaceId: string | null;
    readonly conversationId: string | null;
    readonly previousFills: ReadonlyArray<string>;
    readonly fills: ReadonlyArray<string>;
    readonly hour: number;
    readonly rank: number;
    readonly tentative: boolean;
    readonly monitor: string | null;
    readonly deletedAt: number | null;
  },
) =>
  row.clientPlatform === context.clientPlatform &&
  row.clientId === context.clientId &&
  row.messageId === context.messageId &&
  row.workspaceId === context.workspaceId &&
  row.conversationId === context.conversationId &&
  row.hour === context.hour &&
  row.rank === context.rank &&
  row.tentative === context.tentative &&
  row.monitor === context.monitor &&
  row.previousFills.length === context.previousFills.length &&
  row.previousFills.every((value, index) => value === context.previousFills[index]) &&
  row.fills.length === context.fills.length &&
  row.fills.every((value, index) => value === context.fills[index]) &&
  Predicate.isNull(row.deletedAt);

const contextFromRow = (
  context: AuthorizedRoomOrderSendContext,
  row: {
    readonly sendClaimId: string | null;
    readonly sentMessageId: string | null;
    readonly sentConversationId: string | null;
    readonly tentativeUpdateClaimId: string | null;
    readonly tentativePinClaimId: string | null;
    readonly tentativePinnedAt: number | null;
  },
): AuthorizedRoomOrderSendContext => ({
  ...context,
  sendClaimId: row.sendClaimId,
  sentMessageId: row.sentMessageId,
  sentConversationId: row.sentConversationId,
  tentativeUpdateClaimId: row.tentativeUpdateClaimId,
  tentativePinClaimId: row.tentativePinClaimId,
  tentativePinnedAt: row.tentativePinnedAt,
});

const busyDetail = (row: {
  readonly sendClaimId: string | null;
  readonly tentativeUpdateClaimId: string | null;
  readonly tentativePinClaimId: string | null;
  readonly tentativePinnedAt: number | null;
}) => {
  if (Predicate.isNotNull(row.sendClaimId)) return "room order is already being sent.";
  if (Predicate.isNotNull(row.tentativeUpdateClaimId)) {
    return "tentative room order is already being updated.";
  }
  if (Predicate.isNotNull(row.tentativePinnedAt)) {
    return "tentative room order is already pinned.";
  }
  if (Predicate.isNotNull(row.tentativePinClaimId)) {
    return "tentative room order is already being pinned.";
  }
  return "room order is temporarily unavailable.";
};

// This log shape intentionally mirrors room-order navigation provider diagnostics.
// fallow-ignore-next-line code-duplication
const rejectProvider = (error: RoomOrderNavigationProviderError) =>
  Effect.logWarning("The room-order provider rejected the event configuration read").pipe(
    Effect.annotateLogs({
      providerOperation: error.operation,
      providerCauseKind: providerCauseKind(error.cause),
    }),
    Effect.andThen(
      Effect.fail(
        interactiveExternalOperationRejected(
          "roomOrders.send.loadSendView",
          "ProviderRejected",
          "The room-order provider rejected the event configuration read",
        ),
      ),
    ),
  );

const deliveryFailure = (
  policy: string,
  operation: string,
  resource: string,
  rejectedMessage: string,
  recoveryRequired: boolean,
  committedReference?: string,
) => {
  const mapFailure = mapDeliveryFailure(
    policy,
    operation,
    resource,
    recoveryRequired,
    rejectedMessage,
    operationError,
    committedReference,
  );
  return (error: unknown) => {
    const mapped = mapFailure(error);
    return Predicate.isTagged("ResourceNotFound")(mapped)
      ? interactiveDeliveryRejected(
          operation,
          rejectedMessage,
          recoveryRequired,
          committedReference,
        )
      : mapped;
  };
};

const sentBindingMatches = (
  row: { readonly sentMessageId: string | null; readonly sentConversationId: string | null },
  commit: RoomOrderSendCommit,
) =>
  row.sentMessageId === commit.sentMessage.messageId &&
  row.sentConversationId === commit.sentMessage.conversation.conversationId;

const rejectPin =
  (commit: RoomOrderSendCommit, policy: string) =>
  (
    error: unknown,
  ): Effect.Effect<
    {
      readonly commit: RoomOrderSendCommit;
      readonly status: "rejected";
      readonly receipt: null;
    },
    InteractiveDeclaredFailure | RoomOrderSendOperationsError
  > =>
    Predicate.isTagged("BotUnauthenticated")(error) ||
    Predicate.isTagged("BotAdmissionDenied")(error)
      ? Effect.fail(interactiveAuthorizationRevoked(policy))
      : Predicate.isTagged("BotResourceNotFound")(error) ||
          Predicate.isTagged("BotResponseExpired")(error) ||
          Predicate.isTagged("BotRequestRejected")(error)
        ? Effect.succeed({ commit, status: "rejected", receipt: null })
        : Effect.fail(operationError("roomOrders.send.pinSentRoomOrder", error));

export const roomOrderSendOperationsLayer = Layer.effect(
  RoomOrderSendOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* RoomOrderNavigationProvider;
    const delivery = yield* SheetBotDeliveryClient;

    const loadCurrent = (context: AuthorizedRoomOrderSendContext, operation: string) =>
      persistence.roomOrderState.getMessageRoomOrder(messageKey(context)).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) => operationError(operation, cause)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(operationError(operation, "Missing room-order record")),
            onSome: Effect.succeed,
          }),
        ),
      );

    const requireCanonical = (
      context: AuthorizedRoomOrderSendContext,
      policy: string,
      operation: string,
    ) =>
      loadCurrent(context, operation).pipe(
        Effect.filterOrFail(
          (current) => canonicalViewMatches(context, current),
          () => interactiveAuthorizationRevoked(policy),
        ),
      );

    const claim: typeof RoomOrderSendOperations.Service.claim = (context, claimId, policy) =>
      Effect.gen(function* () {
        const initial = yield* requireCanonical(context, policy, "roomOrders.send.claimSend.load");
        const initialContext = contextFromRow(context, initial);
        if (initial.tentative) {
          return {
            context: initialContext,
            claimId,
            status: "denied" as const,
            detail: "cannot send a tentative room order.",
          };
        }
        if (
          Predicate.isNotNull(initial.sentMessageId) &&
          Predicate.isNotNull(initial.sentConversationId)
        ) {
          return {
            context: initialContext,
            claimId,
            status: "already-sent" as const,
            detail: null,
          };
        }
        if (Predicate.isNotNull(initial.tentativePinnedAt)) {
          return {
            context: initialContext,
            claimId,
            status: "denied" as const,
            detail: "tentative room order is already pinned.",
          };
        }
        if (initial.sendClaimId === claimId) {
          return { context: initialContext, claimId, status: "claimed" as const, detail: null };
        }
        const mutation = persistence.roomOrderState
          .claimMessageRoomOrderSend({ ...messageKey(context), claimId })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) => operationError("roomOrders.send.claimSend", cause)),
          );
        yield* mutation.pipe(
          Effect.catchCause((mutationCause) =>
            Cause.hasInterrupts(mutationCause)
              ? Effect.failCause(mutationCause)
              : Effect.uninterruptible(
                  requireCanonical(context, policy, "roomOrders.send.claimSend.reconcile").pipe(
                    Effect.flatMap((current) =>
                      current.sendClaimId === claimId
                        ? Effect.void
                        : Effect.failCause(mutationCause),
                    ),
                  ),
                ),
          ),
        );
        const current = yield* requireCanonical(
          context,
          policy,
          "roomOrders.send.claimSend.loadResult",
        );
        const currentContext = contextFromRow(context, current);
        if (
          Predicate.isNotNull(current.sentMessageId) &&
          Predicate.isNotNull(current.sentConversationId)
        ) {
          return {
            context: currentContext,
            claimId,
            status: "already-sent" as const,
            detail: null,
          };
        }
        return current.sendClaimId === claimId
          ? { context: currentContext, claimId, status: "claimed" as const, detail: null }
          : {
              context: currentContext,
              claimId,
              status: "denied" as const,
              detail: busyDetail(current),
            };
      });

    const loadView: typeof RoomOrderSendOperations.Service.loadView = (claimed, policy) =>
      Effect.gen(function* () {
        const current = yield* requireCanonical(
          claimed.context,
          policy,
          "roomOrders.send.loadSendView",
        );
        if (current.sendClaimId !== claimed.claimId) {
          return yield* Effect.fail(interactiveAuthorizationRevoked(policy));
        }
        const { entries, workspace } = yield* Effect.all(
          {
            entries: persistence.roomOrderState.getMessageRoomOrderEntry({
              ...messageKey(claimed.context),
              rank: current.rank,
            }),
            workspace: persistence.workspaces.getWorkspaceConfigByWorkspaceId({
              workspaceId: claimed.context.workspaceId,
            }),
          },
          { concurrency: "unbounded" },
        ).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) => operationError("roomOrders.send.loadSendView", cause)),
        );
        const spreadsheetId = yield* Option.match(workspace, {
          onNone: () =>
            Effect.fail(operationError("roomOrders.send.loadSendView", "Missing workspace")),
          onSome: ({ sheetId }) =>
            Predicate.isNull(sheetId)
              ? Effect.fail(operationError("roomOrders.send.loadSendView", "Missing spreadsheet"))
              : Effect.succeed(sheetId),
        });
        const eventStartEpochMs = yield* provider
          .loadEventStart(spreadsheetId)
          .pipe(Effect.catch(rejectProvider));
        const startTime = yield* Option.match(DateTime.make(eventStartEpochMs), {
          onNone: () =>
            Effect.fail(
              interactiveExternalOperationRejected(
                "roomOrders.send.loadSendView",
                "InvalidProviderResponse",
                "The room-order provider returned an invalid event start time",
              ),
            ),
          onSome: Effect.succeed,
        });
        const { start, end } = hourWindowFor({ startTime }, current.hour);
        return {
          context: contextFromRow(claimed.context, current),
          claimId: claimed.claimId,
          message: publishedRoomOrderMessage(
            buildRoomOrderContent(
              current.hour,
              start,
              end,
              current.monitor,
              current.previousFills.map(fillParticipantFromName),
              current.fills.map(fillParticipantFromName),
              entries,
            ),
          ),
        };
      });

    const send: typeof RoomOrderSendOperations.Service.send = (view, deliveryKey, policy) =>
      requireCanonical(view.context, policy, "roomOrders.send.sendRoomOrderMessage").pipe(
        Effect.filterOrFail(
          (current) => current.sendClaimId === view.claimId,
          () => interactiveAuthorizationRevoked(policy),
        ),
        Effect.flatMap(() =>
          delivery
            .get()
            .delivery.sendMessage({
              payload: {
                conversation: conversationRefFrom(
                  { platform: view.context.clientPlatform, clientId: view.context.clientId },
                  view.context.workspaceId,
                  view.context.conversationId,
                ),
                deliveryKey,
                message: view.message,
              },
            })
            .pipe(
              Effect.timeout("30 seconds"),
              Effect.mapError(
                deliveryFailure(
                  policy,
                  "roomOrders.send.sendRoomOrderMessage",
                  "room-order conversation",
                  "The room-order message delivery was rejected",
                  false,
                ),
              ),
            ),
        ),
        Effect.map((sendReceipt) => ({
          context: view.context,
          claimId: view.claimId,
          source: "sent" as const,
          sentMessage: sendReceipt.target.message,
          sendReceipt,
        })),
      );

    const trackingDisposition = (
      commit: RoomOrderSendCommit,
      current: {
        readonly sendClaimId: string | null;
        readonly sentMessageId: string | null;
        readonly sentConversationId: string | null;
      },
    ): RoomOrderSendRecordDisposition => {
      if (sentBindingMatches(current, commit) && Predicate.isNull(current.sendClaimId)) {
        return { commit, status: "tracked", detail: null };
      }
      if (current.sendClaimId === commit.claimId) {
        return {
          commit,
          status: "recovery-required",
          detail: "sent room order, but tracking could not be confirmed; the claim was preserved.",
        };
      }
      return {
        commit,
        status: "inconsistent",
        detail: "sent room order, but failed to track it.",
      };
    };

    const record: typeof RoomOrderSendOperations.Service.record = (commit, policy) =>
      Effect.gen(function* () {
        if (commit.source === "already-sent") {
          return { commit, status: "not-required" as const, detail: null };
        }
        const before = yield* requireCanonical(
          commit.context,
          policy,
          "roomOrders.send.recordRoomOrderSend.load",
        );
        if (sentBindingMatches(before, commit) && Predicate.isNull(before.sendClaimId)) {
          return { commit, status: "tracked" as const, detail: null };
        }
        if (before.sendClaimId !== commit.claimId) {
          return trackingDisposition(commit, before);
        }
        const sentAt = yield* Clock.currentTimeMillis;
        const mutation = persistence.roomOrderState.completeMessageRoomOrderSend({
          ...messageKey(commit.context),
          claimId: commit.claimId,
          sentMessageId: commit.sentMessage.messageId,
          sentConversationId: commit.sentMessage.conversation.conversationId,
          sentAt,
        });
        const mutationExit = yield* Effect.exit(
          mutation.pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) =>
              operationError("roomOrders.send.recordRoomOrderSend", cause),
            ),
          ),
        );
        const mutationFailure = Exit.match(mutationExit, {
          onFailure: Cause.pretty,
          onSuccess: () => null,
        });
        const current = yield* requireCanonical(
          commit.context,
          policy,
          "roomOrders.send.recordRoomOrderSend.reconcile",
        ).pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            Predicate.isTagged("AuthorizationRevoked")(error)
              ? Effect.fail(error)
              : Effect.succeedNone,
          ),
        );
        if (Option.isNone(current)) {
          yield* Effect.logWarning("Room-order send tracking requires recovery").pipe(
            Effect.annotateLogs({
              claimId: commit.claimId,
              sentMessageId: commit.sentMessage.messageId,
              mutationConfirmed: false,
              mutationFailure,
            }),
          );
          return {
            commit,
            status: "recovery-required" as const,
            detail:
              "sent room order, but tracking could not be confirmed; the claim was preserved.",
          };
        }
        const disposition = trackingDisposition(commit, current.value);
        if (disposition.status !== "tracked" || Exit.isFailure(mutationExit)) {
          yield* Effect.logWarning("Room-order send tracking requires recovery").pipe(
            Effect.annotateLogs({
              claimId: commit.claimId,
              sentMessageId: commit.sentMessage.messageId,
              trackingStatus: disposition.status,
              mutationFailure,
            }),
          );
        }
        return disposition;
      });

    const pin: typeof RoomOrderSendOperations.Service.pin = (commit, deliveryKey, policy) =>
      requireCanonical(commit.context, policy, "roomOrders.send.pinSentRoomOrder").pipe(
        Effect.filterOrFail(
          (current) =>
            current.sendClaimId === commit.claimId || sentBindingMatches(current, commit),
          () => interactiveAuthorizationRevoked(policy),
        ),
        Effect.flatMap(() =>
          delivery
            .get()
            .delivery.setMessagePinned({
              payload: {
                message: commit.sentMessage,
                deliveryKey,
                present: true,
              },
            })
            .pipe(
              Effect.timeout("30 seconds"),
              Effect.map(
                (
                  receipt,
                ): {
                  readonly commit: RoomOrderSendCommit;
                  readonly status: "pinned";
                  readonly receipt: SetMessagePinnedReceipt;
                } => ({ commit, status: "pinned", receipt }),
              ),
              Effect.catch(rejectPin(commit, policy)),
            ),
        ),
      );

    const respond: typeof RoomOrderSendOperations.Service.respond = (
      response,
      responseReference,
      deliveryKey,
      policy,
    ) => {
      const recoveryRequired = Predicate.isNotNull(response.commit);
      const committedReference = response.commit?.sentMessage.messageId;
      return delivery
        .get()
        .delivery.respond({
          payload: { responseReference, deliveryKey, message: response.message },
        })
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError(
            deliveryFailure(
              policy,
              "roomOrders.send.respond",
              "response",
              "The room-order response was rejected",
              recoveryRequired,
              committedReference,
            ),
          ),
        );
    };

    const release: typeof RoomOrderSendOperations.Service.release = (claim) =>
      loadCurrent(claim.context, "roomOrders.send.releaseSendClaim.load").pipe(
        Effect.flatMap((current) =>
          current.sendClaimId !== claim.claimId
            ? Effect.void
            : persistence.roomOrderState.releaseMessageRoomOrderSendClaim({
                ...messageKey(claim.context),
                claimId: claim.claimId,
              }),
        ),
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) => operationError("roomOrders.send.releaseSendClaim", cause)),
        Effect.andThen(
          loadCurrent(claim.context, "roomOrders.send.releaseSendClaim.verify").pipe(
            Effect.filterOrFail(
              (current) => current.sendClaimId !== claim.claimId,
              () => operationError("roomOrders.send.releaseSendClaim", "Claim remains owned"),
            ),
            Effect.asVoid,
          ),
        ),
      );

    return { claim, loadView, send, record, pin, respond, release };
  }),
);
