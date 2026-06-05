import { Predicate } from "effect";

const CLAIM_STALE_MS = 10 * 60 * 1000;

type ClaimTimestamp = Date | number | null | undefined;

const toEpochMillis = (claimedAt: ClaimTimestamp) =>
  claimedAt instanceof Date ? claimedAt.getTime() : claimedAt;

export const isActiveSendClaim = (
  claimId: string | null | undefined,
  claimedAt: ClaimTimestamp,
  now: number,
) => Predicate.isNotNullish(claimId) && isActiveTimestampClaim(claimedAt, now);

const isActiveTimestampClaim = (claimedAt: ClaimTimestamp, now: number) => {
  const claimedAtMillis = toEpochMillis(claimedAt);
  return (
    Predicate.isNotNullish(claimedAtMillis) &&
    Number.isFinite(claimedAtMillis) &&
    now - claimedAtMillis <= CLAIM_STALE_MS
  );
};

export const hasActiveTentativePinClaim = (
  messageRoomOrder: {
    readonly tentativePinClaimId?: string | null;
    readonly tentativePinClaimedAt?: Date | number | null;
  },
  now: number,
) =>
  Predicate.isNotNullish(messageRoomOrder.tentativePinClaimId) &&
  isActiveTimestampClaim(messageRoomOrder.tentativePinClaimedAt, now);

export const hasActiveTentativeUpdateClaim = (
  messageRoomOrder: {
    readonly tentativeUpdateClaimId?: string | null;
    readonly tentativeUpdateClaimedAt?: Date | number | null;
  },
  now: number,
) =>
  Predicate.isNotNullish(messageRoomOrder.tentativeUpdateClaimId) &&
  isActiveTimestampClaim(messageRoomOrder.tentativeUpdateClaimedAt, now);

export const hasActiveSendClaim = (
  messageRoomOrder: {
    readonly sendClaimId?: string | null;
    readonly sendClaimedAt?: Date | number | null;
  },
  now: number,
) => isActiveSendClaim(messageRoomOrder.sendClaimId, messageRoomOrder.sendClaimedAt, now);

export const hasStaleUntrackedSendClaim = (
  messageRoomOrder: {
    readonly sendClaimId?: string | null;
    readonly sendClaimedAt?: Date | number | null;
    readonly sentMessageId?: string | null;
  },
  now: number,
) =>
  Predicate.isNotNullish(messageRoomOrder.sendClaimId) &&
  messageRoomOrder.sentMessageId === null &&
  !isActiveSendClaim(messageRoomOrder.sendClaimId, messageRoomOrder.sendClaimedAt, now);
