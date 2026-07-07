import type { Duration, Redacted } from "effect";

export interface TokenCacheEntry {
  readonly token: Redacted.Redacted<string> | undefined;
  readonly timeToLive: Duration.Duration;
  readonly failed: boolean;
}
