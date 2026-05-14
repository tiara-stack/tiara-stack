import { describe, expect, it } from "vitest";
import { SheetClusterApi } from "sheet-ingress-api/sheet-cluster";
import { SheetClusterRpcs } from "sheet-ingress-api/sheet-cluster-rpc";
import { DispatchRoomOrderButtonMethods } from "sheet-ingress-api/sheet-apis-rpc";

describe("SheetClusterRpcs", () => {
  it("serves dispatch and health contracts", () => {
    expect(SheetClusterApi.groups).toHaveProperty("dispatch");
    expect(SheetClusterApi.groups).toHaveProperty("health");
    expect(SheetClusterRpcs.requests.has("health.live")).toBe(true);
    expect(SheetClusterRpcs.requests.has("health.ready")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.checkin")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.checkinDiscard")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.checkinButton")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.checkinButtonDiscard")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.roomOrder")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.roomOrderDiscard")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.kickout")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.kickoutDiscard")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.slotButton")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.slotButtonDiscard")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.slotList")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.slotListDiscard")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.slotOpenButton")).toBe(true);
    expect(SheetClusterRpcs.requests.has("dispatch.slotOpenButtonDiscard")).toBe(true);

    for (const method of Object.values(DispatchRoomOrderButtonMethods)) {
      expect(SheetClusterRpcs.requests.has(method.rpcTag)).toBe(true);
      expect(SheetClusterRpcs.requests.has(`${method.rpcTag}Discard`)).toBe(true);
    }
  });
});
