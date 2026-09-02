import { Effect, Predicate } from "effect";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import type { AuthorizedRoomOrderSendContext } from "../readOnly/authorization";
import {
  interactiveDeliveryRejected,
  interactiveExternalOperationRejected,
  mapDeliveryFailure,
} from "../shared/interactive";
import { providerCauseKind } from "../shared/providerFailure";

type RoomOrderMessageKeyContext = Pick<
  AuthorizedRoomOrderSendContext,
  "clientPlatform" | "clientId" | "messageId"
>;

export const roomOrderMessageKey = (context: RoomOrderMessageKeyContext) => ({
  clientPlatform: context.clientPlatform,
  clientId: context.clientId,
  messageId: context.messageId,
});

export type CanonicalRoomOrderContext = Pick<
  AuthorizedRoomOrderSendContext,
  | "clientPlatform"
  | "clientId"
  | "messageId"
  | "workspaceId"
  | "conversationId"
  | "previousFills"
  | "fills"
  | "hour"
  | "rank"
  | "tentative"
  | "monitor"
>;

export type CanonicalRoomOrderRow = {
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
};

export const canonicalRoomOrderViewMatches = (
  context: CanonicalRoomOrderContext,
  row: CanonicalRoomOrderRow,
): boolean =>
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

export type RoomOrderClaimState = {
  readonly sendClaimId: string | null;
  readonly sentMessageId: string | null;
  readonly sentConversationId: string | null;
  readonly tentativeUpdateClaimId: string | null;
  readonly tentativePinClaimId: string | null;
  readonly tentativePinnedAt: number | null;
};

export const roomOrderContextFromRow = (
  context: AuthorizedRoomOrderSendContext,
  row: RoomOrderClaimState,
): AuthorizedRoomOrderSendContext => ({
  ...context,
  sendClaimId: row.sendClaimId,
  sentMessageId: row.sentMessageId,
  sentConversationId: row.sentConversationId,
  tentativeUpdateClaimId: row.tentativeUpdateClaimId,
  tentativePinClaimId: row.tentativePinClaimId,
  tentativePinnedAt: row.tentativePinnedAt,
});

export const roomOrderBusyDetail = (
  row: {
    readonly sendClaimId: string | null;
    readonly tentativeUpdateClaimId: string | null;
    readonly tentativePinClaimId: string | null;
    readonly tentativePinnedAt: number | null;
  },
  callerClaimId?: string,
): string => {
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

export const rejectRoomOrderProvider = (
  error: { readonly operation: string; readonly cause: unknown },
  operation: string,
) =>
  Effect.logWarning("The room-order provider rejected the event configuration read").pipe(
    Effect.annotateLogs({
      providerOperation: error.operation,
      providerCauseKind: providerCauseKind(error.cause),
    }),
    Effect.andThen(
      Effect.fail(
        interactiveExternalOperationRejected(
          operation,
          "ProviderRejected",
          "The room-order provider rejected the event configuration read",
        ),
      ),
    ),
  );

export const makeRoomOrderDeliveryFailure =
  <E>(operationError: (operation: string, cause: unknown) => E) =>
  (
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
    return (error: unknown): InteractiveDeclaredFailure | E => {
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
