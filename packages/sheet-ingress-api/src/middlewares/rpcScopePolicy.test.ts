import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { HttpApiEndpoint } from "effect/unstable/httpapi";
import { SheetWorkflowsInternalApi } from "../sheet-workflows-internal";
import {
  annotateSheetScopePolicy,
  getSheetScopePolicy,
  SheetScopePolicies,
} from "./rpcScopePolicy";

describe("rpcScopePolicy", () => {
  it("returns the policy annotation from an annotated HTTP API endpoint", () => {
    const endpoint = annotateSheetScopePolicy(
      HttpApiEndpoint.get("testRead", "/test/read", { success: Schema.Void }),
      SheetScopePolicies.oauth("sheet.read"),
    );

    expect(getSheetScopePolicy(endpoint)).toEqual({ _tag: "oauth", scope: "sheet.read" });
  });

  it("returns undefined for unannotated values", () => {
    expect(getSheetScopePolicy(HttpApiEndpoint.get("testUnannotated", "/test/unannotated"))).toBe(
      undefined,
    );
    expect(getSheetScopePolicy({ _tag: "test.unannotated" })).toBe(undefined);
  });

  it("keeps workflow dispatch endpoints annotated for OAuth dispatch", () => {
    const dispatchEndpoints = (
      SheetWorkflowsInternalApi.groups.dispatchWorkflows as {
        readonly endpoints: Record<string, unknown>;
      }
    ).endpoints;

    expect(getSheetScopePolicy(dispatchEndpoints["dispatch.checkin"])).toEqual({
      _tag: "oauth",
      scope: "workflow.dispatch",
    });
    expect(getSheetScopePolicy(dispatchEndpoints["dispatch.checkinDiscard"])).toEqual({
      _tag: "oauth",
      scope: "workflow.dispatch",
    });
    expect(getSheetScopePolicy(dispatchEndpoints["dispatch.checkinResume"])).toEqual({
      _tag: "oauth",
      scope: "workflow.dispatch",
    });
  });
});
