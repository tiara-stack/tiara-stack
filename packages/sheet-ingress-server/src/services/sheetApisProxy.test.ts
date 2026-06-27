import { describe, expect, it } from "@effect/vitest";
import { sheetApisRpcArgsFromHttpArgs } from "./sheetApisProxy";

describe("sheetApisRpcArgsFromHttpArgs", () => {
  it("maps params-only HTTP requests to RPC query input", () => {
    expect(
      sheetApisRpcArgsFromHttpArgs({
        params: { platform: "discord" },
        request: {},
      }),
    ).toEqual({ query: { platform: "discord" } });
  });

  it("preserves existing query input", () => {
    expect(
      sheetApisRpcArgsFromHttpArgs({
        query: { workspaceId: "guild-1" },
        request: {},
      }),
    ).toEqual({ query: { workspaceId: "guild-1" } });
  });

  it("preserves payload input", () => {
    expect(
      sheetApisRpcArgsFromHttpArgs({
        payload: { workspaceId: "guild-1" },
        request: {},
      }),
    ).toEqual({ payload: { workspaceId: "guild-1" } });
  });
});
