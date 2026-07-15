export const normalizeJwtIdentifier = (value: string) => value.replace(/\/$/, "");

export const encodeJwtSecret = (secret: string) => new TextEncoder().encode(secret);
