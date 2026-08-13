import { Cause, DateTime, Effect, Layer, Option, Predicate } from "effect";
import { messageRefFrom } from "sheet-bot-api";
import { roomOrderActionRow, tentativeRoomOrderActionRow } from "sheet-message-content/components";
import { buildRoomOrderContent } from "sheet-message-content/roomOrderContent";
import { tentativeRoomOrderContent } from "sheet-message-content/roomOrderMessage";
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
import { RoomOrderNavigationProvider, RoomOrderNavigationProviderError } from "./provider";
import { RoomOrderNavigationOperations, RoomOrderNavigationOperationsError } from "./service";

const operationError = (operation: string, cause: unknown) =>
  new RoomOrderNavigationOperationsError({ operation, cause });

const messageKey = (context: {
  readonly clientPlatform: "discord";
  readonly clientId: string;
  readonly messageId: string;
}) => ({
  clientPlatform: context.clientPlatform,
  clientId: context.clientId,
  messageId: context.messageId,
});

const claimOwnedBy = (row: { readonly tentativeUpdateClaimId: string | null }, claimId: string) =>
  row.tentativeUpdateClaimId === claimId;

const contextMatchesRow = (
  context: Parameters<typeof messageKey>[0] & {
    readonly workspaceId: string;
    readonly conversationId: string;
  },
  row: {
    readonly clientPlatform: string;
    readonly clientId: string;
    readonly messageId: string;
    readonly workspaceId: string | null;
    readonly conversationId: string | null;
  },
) =>
  row.clientPlatform === context.clientPlatform &&
  row.clientId === context.clientId &&
  row.messageId === context.messageId &&
  row.workspaceId === context.workspaceId &&
  row.conversationId === context.conversationId;

const busyDetail = (
  row: {
    readonly sendClaimId: string | null;
    readonly tentativeUpdateClaimId: string | null;
    readonly tentativePinClaimId: string | null;
    readonly tentativePinnedAt: number | null;
  },
  callerClaimId?: string,
) => {
  if (Predicate.isNotNull(row.sendClaimId)) return "room order is already being sent.";
  if (
    Predicate.isNotNull(row.tentativeUpdateClaimId) &&
    row.tentativeUpdateClaimId !== callerClaimId
  ) {
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

const rejectProvider = (error: RoomOrderNavigationProviderError) =>
  // The pinned operation shell intentionally matches the established interactive workflow shape.
  // fallow-ignore-next-line code-duplication
  Effect.logWarning("The room-order provider rejected the event configuration read").pipe(
    Effect.annotateLogs({
      providerOperation: error.operation,
      providerCauseKind: providerCauseKind(error.cause),
    }),
    Effect.andThen(
      Effect.fail(
        interactiveExternalOperationRejected(
          "roomOrders.navigate.loadNavigationView",
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

export const roomOrderNavigationOperationsLayer = Layer.effect(
  RoomOrderNavigationOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* RoomOrderNavigationProvider;
    const delivery = yield* SheetBotDeliveryClient;

    const loadCurrent = (context: Parameters<typeof messageKey>[0], operation: string) =>
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

    const claim: typeof RoomOrderNavigationOperations.Service.claim = (context, claimId, policy) =>
      Effect.gen(function* () {
        const mutation = persistence.roomOrderState
          .claimMessageRoomOrderTentativeUpdate({ ...messageKey(context), claimId })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) =>
              operationError("roomOrders.navigate.claimNavigation", cause),
            ),
          );
        yield* mutation.pipe(
          Effect.catchCause((mutationCause) =>
            Cause.hasInterrupts(mutationCause)
              ? Effect.failCause(mutationCause)
              : Effect.uninterruptible(
                  loadCurrent(context, "roomOrders.navigate.claimNavigation.reconcile").pipe(
                    Effect.flatMap((current) =>
                      claimOwnedBy(current, claimId)
                        ? Effect.void
                        : Effect.failCause(mutationCause),
                    ),
                  ),
                ),
          ),
        );
        const current = yield* loadCurrent(
          context,
          "roomOrders.navigate.claimNavigation.loadResult",
        );
        if (!contextMatchesRow(context, current)) {
          return yield* Effect.fail(interactiveAuthorizationRevoked(policy));
        }
        return claimOwnedBy(current, claimId)
          ? { context, claimId, status: "claimed" as const, detail: null }
          : {
              context,
              claimId,
              status: "denied" as const,
              detail: busyDetail(current),
            };
      });

    const loadView: typeof RoomOrderNavigationOperations.Service.loadView = (
      claimed,
      direction,
      policy,
    ) =>
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const current = yield* loadCurrent(
          claimed.context,
          "roomOrders.navigate.loadNavigationView",
        );
        if (
          !contextMatchesRow(claimed.context, current) ||
          !claimOwnedBy(current, claimed.claimId)
        ) {
          return yield* Effect.fail(interactiveAuthorizationRevoked(policy));
        }
        if (current.rank !== claimed.context.rank) {
          const detail = "room order could not be updated.";
          return {
            context: claimed.context,
            claimId: claimed.claimId,
            direction,
            targetRank: claimed.context.rank,
            range: { minRank: claimed.context.rank, maxRank: claimed.context.rank },
            status: "denied" as const,
            detail,
            message: { content: detail, visibility: "ephemeral" as const },
          };
        }
        const targetRank = current.rank + (direction === "previous" ? -1 : 1);
        const rangeEntries = yield* persistence.roomOrderState
          .getMessageRoomOrderRange(messageKey(claimed.context))
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) =>
              operationError("roomOrders.navigate.loadNavigationView.range", cause),
            ),
          );
        const ranks = rangeEntries.map(({ rank }) => rank);
        const minRank = Math.min(...ranks);
        const maxRank = Math.max(...ranks);
        if (
          ranks.length === 0 ||
          targetRank < minRank ||
          targetRank > maxRank ||
          !ranks.includes(targetRank)
        ) {
          const detail = "room order is already at the requested boundary.";
          return {
            context: claimed.context,
            claimId: claimed.claimId,
            direction,
            targetRank,
            range: {
              minRank: ranks.length === 0 ? current.rank : minRank,
              maxRank: ranks.length === 0 ? current.rank : maxRank,
            },
            status: "denied" as const,
            detail,
            message: { content: detail, visibility: "ephemeral" as const },
          };
        }
        const { entries, workspace } = yield* Effect.all(
          {
            entries: persistence.roomOrderState.getMessageRoomOrderEntry({
              ...messageKey(claimed.context),
              rank: targetRank,
            }),
            workspace: persistence.workspaces.getWorkspaceConfigByWorkspaceId({
              workspaceId: claimed.context.workspaceId,
            }),
          },
          { concurrency: "unbounded" },
        ).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) =>
            operationError("roomOrders.navigate.loadNavigationView.persistence", cause),
          ),
        );
        const spreadsheetId = yield* Option.match(workspace, {
          onNone: () =>
            Effect.fail(
              operationError("roomOrders.navigate.loadNavigationView", "Missing workspace"),
            ),
          onSome: ({ sheetId }) =>
            Predicate.isNull(sheetId)
              ? Effect.fail(
                  operationError("roomOrders.navigate.loadNavigationView", "Missing spreadsheet"),
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
                "roomOrders.navigate.loadNavigationView",
                "InvalidProviderResponse",
                "The room-order provider returned an invalid event start time",
              ),
            ),
          onSome: Effect.succeed,
        });
        const range = { minRank, maxRank };
        const { start, end } = hourWindowFor({ startTime }, current.hour);
        const content = buildRoomOrderContent(
          current.hour,
          start,
          end,
          current.monitor,
          current.previousFills.map(fillParticipantFromName),
          current.fills.map(fillParticipantFromName),
          entries,
        );
        const message = current.tentative
          ? {
              content: tentativeRoomOrderContent(content),
              components: [tentativeRoomOrderActionRow(range, targetRank)],
            }
          : { content, components: [roomOrderActionRow(range, targetRank)] };
        return {
          context: claimed.context,
          claimId: claimed.claimId,
          direction,
          targetRank,
          range,
          status: "ready" as const,
          detail: null,
          message,
        };
      });

    const commit: typeof RoomOrderNavigationOperations.Service.commit = (view, policy) =>
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        if (view.status === "denied") {
          return {
            context: view.context,
            claimId: view.claimId,
            targetRank: view.context.rank,
            status: "denied" as const,
            detail: view.detail,
            message: view.message,
          };
        }
        if (view.targetRank < view.range.minRank || view.targetRank > view.range.maxRank) {
          return yield* Effect.fail(
            operationError("roomOrders.navigate.commitNavigation", "Out-of-range navigation"),
          );
        }
        const mutation =
          view.direction === "previous"
            ? persistence.roomOrderState.decrementMessageRoomOrderRank
            : persistence.roomOrderState.incrementMessageRoomOrderRank;
        const update = mutation({
          ...messageKey(view.context),
          expectedRank: view.context.rank,
          tentativeUpdateClaimId: view.claimId,
        }).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) => operationError("roomOrders.navigate.commitNavigation", cause)),
        );
        yield* update.pipe(
          Effect.catchCause((mutationCause) =>
            Cause.hasInterrupts(mutationCause)
              ? Effect.failCause(mutationCause)
              : Effect.uninterruptible(
                  loadCurrent(view.context, "roomOrders.navigate.commitNavigation.reconcile").pipe(
                    Effect.flatMap((current) =>
                      claimOwnedBy(current, view.claimId) && current.rank === view.targetRank
                        ? Effect.void
                        : Effect.failCause(mutationCause),
                    ),
                  ),
                ),
          ),
        );
        const current = yield* loadCurrent(
          view.context,
          "roomOrders.navigate.commitNavigation.loadResult",
        );
        if (!contextMatchesRow(view.context, current)) {
          return yield* Effect.fail(interactiveAuthorizationRevoked(policy));
        }
        if (!claimOwnedBy(current, view.claimId) || current.rank !== view.targetRank) {
          if (claimOwnedBy(current, view.claimId) && current.rank === view.context.rank) {
            const detail = busyDetail(current, view.claimId);
            return {
              context: view.context,
              claimId: view.claimId,
              targetRank: view.context.rank,
              status: "denied" as const,
              detail,
              message: { content: detail, visibility: "ephemeral" as const },
            };
          }
          return yield* Effect.fail(
            operationError("roomOrders.navigate.commitNavigation", {
              expectedRank: view.targetRank,
              actualRank: current.rank,
              claimId: current.tentativeUpdateClaimId,
            }),
          );
        }
        return {
          context: view.context,
          claimId: view.claimId,
          targetRank: view.targetRank,
          status: "updated" as const,
          detail: null,
          message: view.message,
        };
      });

    const deliver = <A>(
      effect: Effect.Effect<A, unknown>,
      committed: Parameters<typeof RoomOrderNavigationOperations.Service.respond>[0],
      policy: string,
      operation: string,
      resource: string,
      rejectedMessage: string,
    ) =>
      effect.pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError(
          deliveryFailure(
            policy,
            operation,
            resource,
            rejectedMessage,
            committed.status === "updated",
            committed.status === "updated" ? committed.context.messageId : undefined,
          ),
        ),
      );

    const respond: typeof RoomOrderNavigationOperations.Service.respond = (
      committed,
      responseReference,
      deliveryKey,
      policy,
    ) =>
      deliver(
        delivery.get().delivery.respond({
          payload: {
            responseReference,
            deliveryKey,
            message:
              committed.status === "denied"
                ? committed.message
                : committed.context.tentative
                  ? { content: "updated tentative room order.", visibility: "ephemeral" }
                  : committed.message,
          },
        }),
        committed,
        policy,
        "roomOrders.navigate.respond",
        "response",
        "The room-order response was rejected",
      );

    const editRoomOrderMessage: typeof RoomOrderNavigationOperations.Service.editRoomOrderMessage =
      (committed, deliveryKey, policy) =>
        deliver(
          delivery.get().delivery.editMessage({
            payload: {
              message: messageRefFrom(
                {
                  platform: committed.context.clientPlatform,
                  clientId: committed.context.clientId,
                },
                committed.context.workspaceId,
                committed.context.conversationId,
                committed.context.messageId,
              ),
              deliveryKey,
              content: committed.message,
            },
          }),
          committed,
          policy,
          "roomOrders.navigate.editRoomOrderMessage",
          "room-order message",
          "The room-order message update was rejected",
        );

    const release: typeof RoomOrderNavigationOperations.Service.release = (committed) =>
      Effect.gen(function* () {
        yield* persistence.roomOrderState
          .releaseMessageRoomOrderTentativeUpdateClaim({
            ...messageKey(committed.context),
            claimId: committed.claimId,
          })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) =>
              operationError("roomOrders.navigate.releaseNavigationClaim", cause),
            ),
          );
        yield* loadCurrent(
          committed.context,
          "roomOrders.navigate.releaseNavigationClaim.verify",
        ).pipe(
          Effect.filterOrFail(
            (current) =>
              contextMatchesRow(committed.context, current) &&
              !claimOwnedBy(current, committed.claimId),
            () =>
              operationError(
                "roomOrders.navigate.releaseNavigationClaim",
                "Navigation claim verification failed",
              ),
          ),
          Effect.asVoid,
          Effect.catch((error) =>
            Effect.logWarning("Room-order navigation claim release was not confirmed").pipe(
              Effect.annotateLogs({
                messageId: committed.context.messageId,
                claimId: committed.claimId,
                failureOperation: error.operation,
              }),
            ),
          ),
        );
      });

    return { claim, loadView, commit, respond, editRoomOrderMessage, release };
  }),
);
