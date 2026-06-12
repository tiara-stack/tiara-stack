import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { SheetApisRpcs } from "../sheet-apis-rpc";
import {
  annotateRpcScopePolicy,
  getRpcScopePolicy,
  SheetRpcScopePolicies,
  type SheetRpcOAuthScopeForTag,
} from "./rpcScopePolicy";

type ScheduleReadScope = SheetRpcOAuthScopeForTag<
  typeof SheetApisRpcs,
  "schedule.getAllPopulatedSchedules"
>;
type CurrentPermissionsScope = SheetRpcOAuthScopeForTag<
  typeof SheetApisRpcs,
  "permissions.getCurrentUserPermissions"
>;

const scheduleReadScope = "sheet.read" satisfies ScheduleReadScope;
const currentPermissionsScope = "sheet.read" satisfies CurrentPermissionsScope;

describe("rpcScopePolicy", () => {
  it("returns the policy annotation from an annotated RPC", () => {
    const rpc = annotateRpcScopePolicy(
      Rpc.make("test.read", { success: Schema.Void }),
      SheetRpcScopePolicies.oauth("sheet.read"),
    );

    expect(getRpcScopePolicy(rpc)).toEqual({ _tag: "oauth", scope: "sheet.read" });
  });

  it("returns undefined for unannotated values", () => {
    expect(getRpcScopePolicy(Rpc.make("test.unannotated", { success: Schema.Void }))).toBe(
      undefined,
    );
    expect(getRpcScopePolicy({ _tag: "test.unannotated" })).toBe(undefined);
  });

  it("exposes literal OAuth scopes at the type level", () => {
    expect(scheduleReadScope).toBe("sheet.read");
    expect(currentPermissionsScope).toBe("sheet.read");
  });
});
