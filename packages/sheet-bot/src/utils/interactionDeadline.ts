import {
  interactionResponseTokenExpirySafetyMarginMs,
  interactionResponseTokenLifetimeMs,
} from "sheet-ingress-api/sheet-apis-rpc";

const discordEpochMs = 1_420_070_400_000n;

export const interactionDeadlineEpochMs = (interactionId: string): number => {
  const createdAtMs = Number((BigInt(interactionId) >> 22n) + discordEpochMs);
  return (
    createdAtMs + interactionResponseTokenLifetimeMs - interactionResponseTokenExpirySafetyMarginMs
  );
};
