const interactionResponseTokenLifetimeMs = 15 * 60 * 1_000;
const interactionResponseTokenExpirySafetyMarginMs = 30 * 1_000;

const discordEpochMs = 1_420_070_400_000n;

export const interactionDeadlineEpochMs = (interactionId: string): number => {
  const createdAtMs = Number((BigInt(interactionId) >> 22n) + discordEpochMs);
  return (
    createdAtMs + interactionResponseTokenLifetimeMs - interactionResponseTokenExpirySafetyMarginMs
  );
};
