import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import {
  isTeamSubmissionAvailable,
  shouldReconnectSheetZero,
  shouldRefreshSheetZeroAuth,
} from "./sheetZero";

describe("SheetZeroClient team submission availability", () => {
  it("requires both a configured conversation and the feature flag", () => {
    expect(isTeamSubmissionAvailable(Option.some({}), Option.some({}))).toBe(true);
    expect(isTeamSubmissionAvailable(Option.none(), Option.some({}))).toBe(false);
    expect(isTeamSubmissionAvailable(Option.some({}), Option.none())).toBe(false);
  });
});

describe("shouldRefreshSheetZeroAuth", () => {
  const activeToken = {
    currentTokenExpiresAtEpochSeconds: 200,
    nowEpochSeconds: 100,
  };

  it("refreshes auth for structured authentication states", () => {
    expect(
      shouldRefreshSheetZeroAuth(
        {
          name: "needs-auth",
          reason: { type: "query", status: 401 },
        },
        activeToken,
      ),
    ).toBe(true);
    expect(
      shouldRefreshSheetZeroAuth(
        {
          name: "needs-auth",
          reason: { type: "mutate", status: 403 },
        },
        activeToken,
      ),
    ).toBe(true);
  });

  it("refreshes after expired-token revalidation but not an unrelated backend 500", () => {
    const backendFailure = {
      name: "error" as const,
      reason: "Fetch from API server returned non-OK status 500",
    };

    expect(
      shouldRefreshSheetZeroAuth(backendFailure, {
        currentTokenExpiresAtEpochSeconds: 100,
        nowEpochSeconds: 100,
      }),
    ).toBe(true);
    expect(shouldRefreshSheetZeroAuth(backendFailure, activeToken)).toBe(false);
  });

  it("does not refresh auth for ordinary disconnection", () => {
    expect(
      shouldRefreshSheetZeroAuth({ name: "disconnected", reason: "offline" }, activeToken),
    ).toBe(false);
  });
});

describe("shouldReconnectSheetZero", () => {
  it("reconnects terminal Zero connection states", () => {
    expect(
      shouldReconnectSheetZero({ name: "needs-auth", reason: { type: "query", status: 401 } }),
    ).toBe(true);
    expect(
      shouldReconnectSheetZero({
        name: "error",
        reason: "write CONNECTION_CLOSED zero-cache:4848",
      }),
    ).toBe(true);
    expect(
      shouldReconnectSheetZero({
        name: "error",
        reason: "Fetch from API server returned non-OK status 500",
      }),
    ).toBe(false);
  });

  it("does not reconnect non-terminal connection states", () => {
    expect(shouldReconnectSheetZero({ name: "connected" })).toBe(false);
    expect(shouldReconnectSheetZero({ name: "disconnected", reason: "offline" })).toBe(false);
  });
});
