import { Cause, Clock, DateTime, Effect, Exit, Layer, Option, Predicate } from "effect";
import { messageRefFrom } from "sheet-bot-api";
import { publishedRoomOrderMessage } from "sheet-message-content/roomOrderMessage";
import { buildRoomOrderContent } from "sheet-message-content/roomOrderContent";
import { fillParticipantFromName, hourWindowFor } from "sheet-message-content/rendering";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveAuthorizationRevoked,
  interactiveDeliveryRejected,
  interactiveExternalOperationRejected,
  mapDeliveryFailure,
} from "../shared/interactive";
import { providerCauseKind } from "../shared/providerFailure";
import type { AuthorizedRoomOrderPinTentativeContext } from "../readOnly/authorization";
import type {
  RoomOrderTentativePinCommit,
  RoomOrderTentativePinRecordDisposition,
} from "./pinTentativeSchema";
import {
  RoomOrderTentativePinOperations,
  RoomOrderTentativePinOperationsError,
} from "./pinTentativeService";
import { RoomOrderNavigationProvider, RoomOrderNavigationProviderError } from "./provider";

const operationError = (operation: string, cause: unknown) =>
  new RoomOrderTentativePinOperationsError({ operation, cause });

const operationCauseKind = (cause: Cause.Cause<RoomOrderTentativePinOperationsError>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => providerCauseKind(cause),
    onSome: (error) => providerCauseKind(error.cause),
  });

const messageKey = (context: {
  readonly clientPlatform: "discord";
  readonly clientId: string;
  readonly messageId: string;
}) => ({
  clientPlatform: context.clientPlatform,
  clientId: context.clientId,
  messageId: context.messageId,
});

const canonicalScalarFields = [
  "clientPlatform",
  "clientId",
  "messageId",
  "workspaceId",
  "conversationId",
  "hour",
  "rank",
  "tentative",
  "monitor",
] as const;

const canonicalViewMatches = (
  context: AuthorizedRoomOrderPinTentativeContext,
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
  canonicalScalarFields.every((field) => row[field] === context[field]) &&
  row.previousFills.length === context.previousFills.length &&
  row.previousFills.every((value, index) => value === context.previousFills[index]) &&
  row.fills.length === context.fills.length &&
  row.fills.every((value, index) => value === context.fills[index]) &&
  Predicate.isNull(row.deletedAt);

const contextFromRow = (
  context: AuthorizedRoomOrderPinTentativeContext,
  row: {
    readonly sendClaimId: string | null;
    readonly sentMessageId: string | null;
    readonly sentConversationId: string | null;
    readonly tentativeUpdateClaimId: string | null;
    readonly tentativePinClaimId: string | null;
    readonly tentativePinnedAt: number | null;
  },
): AuthorizedRoomOrderPinTentativeContext => ({
  ...context,
  sendClaimId: row.sendClaimId,
  sentMessageId: row.sentMessageId,
  sentConversationId: row.sentConversationId,
  tentativeUpdateClaimId: row.tentativeUpdateClaimId,
  tentativePinClaimId: row.tentativePinClaimId,
  tentativePinnedAt: row.tentativePinnedAt,
});

const busyDetail = (
  row: {
    readonly sendClaimId: string | null;
    readonly tentativeUpdateClaimId: string | null;
    readonly tentativePinClaimId: string | null;
  },
  claimId: string,
) => {
  if (Predicate.isNotNull(row.sendClaimId)) return "room order is already being sent.";
  if (Predicate.isNotNull(row.tentativeUpdateClaimId)) {
    return "tentative room order is already being updated.";
  }
  if (Predicate.isNotNull(row.tentativePinClaimId) && row.tentativePinClaimId !== claimId) {
    return "tentative room order is already being pinned.";
  }
  return "room order is temporarily unavailable.";
};

// Provider diagnostics intentionally use the established room-order audit shape.
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
          "roomOrders.pinTentative.loadTentativePinView",
          "ProviderRejected",
          "The room-order provider rejected the event configuration read",
        ),
      ),
    ),
  );

// The delivery failure boundary intentionally stays uniform across interactive room-order slices.
// fallow-ignore-next-line code-duplication
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

export const roomOrderTentativePinOperationsLayer = Layer.effect(
  RoomOrderTentativePinOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* RoomOrderNavigationProvider;
    const delivery = yield* SheetBotDeliveryClient;

    const loadCurrent = (context: AuthorizedRoomOrderPinTentativeContext, operation: string) =>
      persistence.roomOrderState.getMessageRoomOrder(messageKey(context)).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) => operationError(operation, cause)),
      );

    const requireCanonical = (
      context: AuthorizedRoomOrderPinTentativeContext,
      policy: string,
      operation: string,
    ) =>
      loadCurrent(context, operation).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(interactiveAuthorizationRevoked(policy)),
            onSome: Effect.succeed,
          }),
        ),
        Effect.filterOrFail(
          (current) => canonicalViewMatches(context, current),
          () => interactiveAuthorizationRevoked(policy),
        ),
      );

    const claim: typeof RoomOrderTentativePinOperations.Service.claim = (
      context,
      claimId,
      policy,
    ) =>
      Effect.gen(function* () {
        const initial = yield* requireCanonical(
          context,
          policy,
          "roomOrders.pinTentative.claimTentativePin.load",
        );
        const initialContext = contextFromRow(context, initial);
        if (!initial.tentative) {
          return {
            context: initialContext,
            claimId,
            status: "denied" as const,
            detail: "cannot pin a non-tentative room order.",
          };
        }
        if (Predicate.isNotNull(initial.tentativePinnedAt)) {
          return {
            context: initialContext,
            claimId,
            status: "already-pinned" as const,
            detail: null,
          };
        }
        if (initial.tentativePinClaimId === claimId) {
          return { context: initialContext, claimId, status: "claimed" as const, detail: null };
        }
        const mutation = persistence.roomOrderState
          .claimMessageRoomOrderTentativePin({ ...messageKey(context), claimId })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) =>
              operationError("roomOrders.pinTentative.claimTentativePin", cause),
            ),
          );
        yield* mutation.pipe(
          Effect.catchCause((mutationCause) =>
            Cause.hasInterrupts(mutationCause)
              ? Effect.failCause(mutationCause)
              : Effect.uninterruptible(
                  requireCanonical(
                    context,
                    policy,
                    "roomOrders.pinTentative.claimTentativePin.reconcile",
                  ).pipe(
                    Effect.flatMap((current) =>
                      current.tentativePinClaimId === claimId
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
          "roomOrders.pinTentative.claimTentativePin.loadResult",
        );
        const currentContext = contextFromRow(context, current);
        if (Predicate.isNotNull(current.tentativePinnedAt)) {
          return {
            context: currentContext,
            claimId,
            status: "already-pinned" as const,
            detail: null,
          };
        }
        return current.tentativePinClaimId === claimId
          ? { context: currentContext, claimId, status: "claimed" as const, detail: null }
          : {
              context: currentContext,
              claimId,
              status: "denied" as const,
              detail: busyDetail(current, claimId),
            };
      });

    const loadView: typeof RoomOrderTentativePinOperations.Service.loadView = (claimed, policy) =>
      Effect.gen(function* () {
        const current = yield* requireCanonical(
          claimed.context,
          policy,
          "roomOrders.pinTentative.loadTentativePinView",
        );
        const ownsClaim = current.tentativePinClaimId === claimed.claimId;
        const alreadyPinned = Predicate.isNotNull(current.tentativePinnedAt);
        if (
          (claimed.status === "claimed" && !ownsClaim) ||
          (claimed.status === "already-pinned" && !alreadyPinned)
        ) {
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
          Effect.mapError((cause) =>
            operationError("roomOrders.pinTentative.loadTentativePinView.persistence", cause),
          ),
        );
        const spreadsheetId = yield* Option.match(workspace, {
          onNone: () =>
            Effect.fail(
              operationError("roomOrders.pinTentative.loadTentativePinView", "Missing workspace"),
            ),
          onSome: ({ sheetId }) =>
            Predicate.isNull(sheetId)
              ? Effect.fail(
                  operationError(
                    "roomOrders.pinTentative.loadTentativePinView",
                    "Missing spreadsheet",
                  ),
                )
              : Effect.succeed(sheetId),
        });
        const eventStartEpochMs = yield* provider
          .loadEventStart(spreadsheetId)
          .pipe(Effect.catch(rejectProvider));
        const startTime = yield* Option.match(DateTime.make(eventStartEpochMs), {
          onNone: () =>
            Effect.fail(
              interactiveExternalOperationRejected(
                "roomOrders.pinTentative.loadTentativePinView",
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

    const pin: typeof RoomOrderTentativePinOperations.Service.pin = (view, deliveryKey, policy) =>
      requireCanonical(view.context, policy, "roomOrders.pinTentative.pinTentativeRoomOrder").pipe(
        Effect.filterOrFail(
          (current) =>
            current.tentativePinClaimId === view.claimId &&
            Predicate.isNull(current.tentativePinnedAt),
          () => interactiveAuthorizationRevoked(policy),
        ),
        Effect.flatMap(() =>
          delivery
            .get()
            .delivery.setMessagePinned({
              payload: {
                message: messageRefFrom(
                  { platform: view.context.clientPlatform, clientId: view.context.clientId },
                  view.context.workspaceId,
                  view.context.conversationId,
                  view.context.messageId,
                ),
                deliveryKey,
                present: true,
              },
            })
            .pipe(
              Effect.timeout("30 seconds"),
              Effect.flatMap((receipt) =>
                Clock.currentTimeMillis.pipe(
                  Effect.map((pinnedAt) => ({
                    view,
                    status: "pinned" as const,
                    pinnedAt,
                    receipt,
                  })),
                ),
              ),
              // Known bot rejection classification intentionally mirrors room-order send.
              // fallow-ignore-next-line code-duplication
              Effect.catch(
                (error): ReturnType<typeof RoomOrderTentativePinOperations.Service.pin> =>
                  // fallow-ignore-next-line code-duplication
                  Predicate.isTagged("BotUnauthenticated")(error) ||
                  Predicate.isTagged("BotAdmissionDenied")(error)
                    ? Effect.fail(interactiveAuthorizationRevoked(policy))
                    : Predicate.isTagged("BotResourceNotFound")(error) ||
                        Predicate.isTagged("BotResponseExpired")(error) ||
                        Predicate.isTagged("BotRequestRejected")(error)
                      ? Effect.succeed({
                          view,
                          status: "rejected" as const,
                          pinnedAt: null,
                          receipt: null,
                        })
                      : Effect.fail(
                          operationError("roomOrders.pinTentative.pinTentativeRoomOrder", error),
                        ),
              ),
            ),
        ),
      );

    const trackingDisposition = (
      commit: RoomOrderTentativePinCommit,
      current: {
        readonly tentativePinClaimId: string | null;
        readonly tentativePinnedAt: number | null;
      },
    ): RoomOrderTentativePinRecordDisposition => {
      if (
        current.tentativePinnedAt === commit.pinnedAt &&
        Predicate.isNull(current.tentativePinClaimId)
      ) {
        return {
          commit,
          status: commit.source === "already-pinned" ? "not-required" : "tracked",
          detail: null,
        };
      }
      if (current.tentativePinClaimId === commit.view.claimId) {
        return {
          commit,
          status: "recovery-required",
          detail: "pinned tentative room order, but tracking could not be confirmed.",
        };
      }
      return {
        commit,
        status: "inconsistent",
        detail: "pinned tentative room order, but failed to track it.",
      };
    };

    const record: typeof RoomOrderTentativePinOperations.Service.record = (commit, policy) =>
      Effect.gen(function* () {
        const before = yield* requireCanonical(
          commit.view.context,
          policy,
          "roomOrders.pinTentative.recordTentativePin.load",
        );
        const existing = trackingDisposition(commit, before);
        if (existing.status === "tracked" || existing.status === "not-required") return existing;
        if (before.tentativePinClaimId !== commit.view.claimId) return existing;

        const mutationExit = yield* Effect.exit(
          persistence.roomOrderState
            .completeMessageRoomOrderTentativePin({
              ...messageKey(commit.view.context),
              claimId: commit.view.claimId,
              pinnedAt: commit.pinnedAt,
            })
            .pipe(
              Effect.timeout("30 seconds"),
              Effect.mapError((cause) =>
                operationError("roomOrders.pinTentative.recordTentativePin", cause),
              ),
            ),
        );
        const mutationFailureKind = Exit.match(mutationExit, {
          onFailure: operationCauseKind,
          onSuccess: () => null,
        });
        const current = yield* requireCanonical(
          commit.view.context,
          policy,
          "roomOrders.pinTentative.recordTentativePin.reconcile",
        ).pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            Predicate.isTagged("AuthorizationRevoked")(error)
              ? Effect.fail(error)
              : Effect.succeedNone,
          ),
        );
        if (Option.isNone(current)) {
          yield* Effect.logWarning("Tentative room-order pin tracking requires recovery").pipe(
            Effect.annotateLogs({
              claimId: commit.view.claimId,
              messageId: commit.view.context.messageId,
              mutationConfirmed: false,
              mutationFailureKind,
            }),
          );
          return {
            commit,
            status: "recovery-required" as const,
            detail: "pinned tentative room order, but tracking could not be confirmed.",
          };
        }
        const disposition = trackingDisposition(commit, current.value);
        if (disposition.status !== "tracked" || Exit.isFailure(mutationExit)) {
          yield* Effect.logWarning("Tentative room-order pin tracking requires recovery").pipe(
            Effect.annotateLogs({
              claimId: commit.view.claimId,
              messageId: commit.view.context.messageId,
              trackingStatus: disposition.status,
              mutationFailureKind,
            }),
          );
        }
        return disposition;
      });

    const finalize: typeof RoomOrderTentativePinOperations.Service.finalize = (
      finalization,
      deliveryKey,
      policy,
    ) =>
      requireCanonical(
        finalization.view.context,
        policy,
        "roomOrders.pinTentative.finalizeTentativeRoomOrder",
      ).pipe(
        Effect.filterOrFail(
          (current) =>
            finalization.committed
              ? Predicate.isNotNull(current.tentativePinnedAt) ||
                current.tentativePinClaimId === finalization.view.claimId
              : Predicate.isNull(current.tentativePinnedAt) &&
                current.tentativePinClaimId === finalization.view.claimId,
          () => interactiveAuthorizationRevoked(policy),
        ),
        Effect.flatMap(() =>
          delivery
            .get()
            .delivery.editMessage({
              payload: {
                message: messageRefFrom(
                  {
                    platform: finalization.view.context.clientPlatform,
                    clientId: finalization.view.context.clientId,
                  },
                  finalization.view.context.workspaceId,
                  finalization.view.context.conversationId,
                  finalization.view.context.messageId,
                ),
                deliveryKey,
                content: finalization.view.message,
              },
            })
            .pipe(
              Effect.timeout("30 seconds"),
              Effect.mapError(
                deliveryFailure(
                  policy,
                  "roomOrders.pinTentative.finalizeTentativeRoomOrder",
                  "room-order message",
                  "The tentative room-order cleanup was rejected",
                  finalization.committed,
                  finalization.committed
                    ? (finalization.committedReference ?? undefined)
                    : undefined,
                ),
              ),
            ),
        ),
      );

    const respond: typeof RoomOrderTentativePinOperations.Service.respond = (
      response,
      responseReference,
      deliveryKey,
      policy,
    ) =>
      delivery
        .get()
        .delivery.respond({
          payload: { responseReference, deliveryKey, message: response.message },
        })
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError(
            deliveryFailure(
              policy,
              "roomOrders.pinTentative.respond",
              "response",
              "The tentative room-order response was rejected",
              Predicate.isNotNull(response.commit),
              response.commit?.view.context.messageId,
            ),
          ),
        );

    const release: typeof RoomOrderTentativePinOperations.Service.release = (claim) =>
      Effect.gen(function* () {
        const before = yield* loadCurrent(
          claim.context,
          "roomOrders.pinTentative.releaseTentativePinClaim.load",
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  operationError(
                    "roomOrders.pinTentative.releaseTentativePinClaim",
                    "Missing room-order record",
                  ),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        if (Predicate.isNotNull(before.tentativePinnedAt)) {
          return yield* Effect.fail(
            operationError(
              "roomOrders.pinTentative.releaseTentativePinClaim",
              "Committed pin claim cannot be released",
            ),
          );
        }
        if (before.tentativePinClaimId !== claim.claimId) return;
        yield* persistence.roomOrderState
          .releaseMessageRoomOrderTentativePinClaim({
            ...messageKey(claim.context),
            claimId: claim.claimId,
          })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) =>
              operationError("roomOrders.pinTentative.releaseTentativePinClaim", cause),
            ),
          );
        yield* loadCurrent(
          claim.context,
          "roomOrders.pinTentative.releaseTentativePinClaim.verify",
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  operationError(
                    "roomOrders.pinTentative.releaseTentativePinClaim",
                    "Missing room-order record",
                  ),
                ),
              onSome: Effect.succeed,
            }),
          ),
          Effect.filterOrFail(
            (current) =>
              Predicate.isNull(current.tentativePinnedAt) &&
              current.tentativePinClaimId !== claim.claimId,
            () =>
              operationError(
                "roomOrders.pinTentative.releaseTentativePinClaim",
                "Tentative pin claim verification failed",
              ),
          ),
          Effect.asVoid,
        );
      });

    return { claim, loadView, pin, record, finalize, respond, release };
  }),
);
