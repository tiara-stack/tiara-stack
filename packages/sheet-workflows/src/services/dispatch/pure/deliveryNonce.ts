import { createHash } from "node:crypto";

const discordNonceLimit = 25;

export const makeDeliveryNonce = (source: string): string =>
  source.length <= discordNonceLimit
    ? source
    : createHash("sha256").update(source).digest("base64url").slice(0, discordNonceLimit);
