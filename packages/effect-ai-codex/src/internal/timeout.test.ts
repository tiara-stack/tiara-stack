import { describe, expect, it } from "vitest";
import { CodexTimeout } from "../CodexError";
import { runWithAbortTimeout } from "./timeout";

describe("runWithAbortTimeout", () => {
  it("returns a run result that completes before the timeout", async () => {
    await expect(
      runWithAbortTimeout({
        runPromise: Promise.resolve("ok"),
        abort: () => undefined,
        timeoutMs: 100,
        timeoutError: () => new CodexTimeout({ timeoutMs: 100 }),
      }),
    ).resolves.toBe("ok");
  });

  it("aborts at the deadline and reports timeout after the run settles", async () => {
    let abortCount = 0;
    let resolveRun: (value: string) => void = () => undefined;
    const runPromise = new Promise<string>((resolve) => {
      resolveRun = resolve;
    });
    const result = runWithAbortTimeout({
      runPromise,
      abort: () => {
        abortCount += 1;
      },
      timeoutMs: 1,
      cleanupGraceMs: 100,
      timeoutError: () => new CodexTimeout({ timeoutMs: 1 }),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(abortCount).toBe(1);
    resolveRun("late success");

    await expect(result).rejects.toBeInstanceOf(CodexTimeout);
  });

  it("treats zero as an immediate timeout", async () => {
    let abortCount = 0;
    const result = runWithAbortTimeout({
      runPromise: new Promise<string>(() => undefined),
      abort: () => {
        abortCount += 1;
      },
      timeoutMs: 0,
      cleanupGraceMs: 1,
      timeoutError: () => new CodexTimeout({ timeoutMs: 0 }),
    });

    await expect(result).rejects.toBeInstanceOf(CodexTimeout);
    expect(abortCount).toBe(1);
  });

  it("reports timeout after a bounded grace when the aborted run never settles", async () => {
    let abortCount = 0;
    const result = runWithAbortTimeout({
      runPromise: new Promise<string>(() => undefined),
      abort: () => {
        abortCount += 1;
      },
      timeoutMs: 1,
      cleanupGraceMs: 1,
      timeoutError: () => new CodexTimeout({ timeoutMs: 1 }),
    });

    await expect(result).rejects.toBeInstanceOf(CodexTimeout);
    expect(abortCount).toBe(1);
  });
});
