import type { ReadonlyJSONObject } from "@rocicorp/zero";

export type MessageKey = {
  readonly clientPlatform: string;
  readonly clientId: string;
  readonly messageId: string;
} & ReadonlyJSONObject;
