import type { ChildProcess } from "node:child_process";

export interface BrowserSmokeChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export declare const waitForChildExit: (
  child: ChildProcess,
  timeoutMillis: number,
) => Promise<BrowserSmokeChildExit>;
