import { afterEach, describe, expect, it, vi } from "vitest";
import { isTrustedClient } from "./clients/trusted-client";

const options = {
  issuer: "https://auth.example.com",
  validAudiences: ["sheet-apis"],
};

describe("isTrustedClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caches adapter trust lookups for a short TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const adapter = {
      findOne: vi.fn().mockResolvedValue({ metadata: { trusted: true } }),
    };
    const ctx = { context: { adapter } };

    await expect(isTrustedClient(ctx, "sheet-bot", options)).resolves.toBe(true);
    await expect(isTrustedClient(ctx, "sheet-bot", options)).resolves.toBe(true);
    expect(adapter.findOne).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(30_001);
    await expect(isTrustedClient(ctx, "sheet-bot", options)).resolves.toBe(true);
    expect(adapter.findOne).toHaveBeenCalledTimes(2);
  });

  it("uses configured trusted client IDs without an adapter lookup", async () => {
    const adapter = { findOne: vi.fn() };
    const ctx = { context: { adapter } };

    await expect(
      isTrustedClient(ctx, "sheet-bot", {
        ...options,
        trustedClientIds: new Set(["sheet-bot"]),
      }),
    ).resolves.toBe(true);
    expect(adapter.findOne).not.toHaveBeenCalled();
  });

  it("rejects clients without trusted metadata", async () => {
    const adapter = { findOne: vi.fn().mockResolvedValue({ metadata: undefined }) };
    const ctx = { context: { adapter } };

    await expect(isTrustedClient(ctx, "unknown-client", options)).resolves.toBe(false);
  });

  it("rejects a missing client ID without an adapter lookup", async () => {
    const adapter = { findOne: vi.fn() };
    const ctx = { context: { adapter } };

    await expect(isTrustedClient(ctx, undefined, options)).resolves.toBe(false);
    expect(adapter.findOne).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent adapter lookups", async () => {
    const adapter = {
      findOne: vi.fn().mockResolvedValue({ metadata: JSON.stringify({ trusted: true }) }),
    };
    const ctx = { context: { adapter } };

    await expect(
      Promise.all([
        isTrustedClient(ctx, "concurrent-client", options),
        isTrustedClient(ctx, "concurrent-client", options),
      ]),
    ).resolves.toEqual([true, true]);
    expect(adapter.findOne).toHaveBeenCalledOnce();
  });
});
