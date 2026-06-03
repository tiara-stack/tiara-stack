import { describe, expect, it } from "vitest";
import { SheetWorkflowsApi } from "sheet-ingress-api/sheet-workflows";
import { SheetWorkflowsRpcs } from "sheet-ingress-api/sheet-workflows-rpc";
import { DispatchRoomOrderButtonMethods } from "sheet-ingress-api/sheet-apis-rpc";

describe("SheetWorkflowsRpcs", () => {
  it("serves dispatch and health contracts", () => {
    expect(SheetWorkflowsApi.groups).toHaveProperty("dispatch");
    expect(SheetWorkflowsApi.groups).toHaveProperty("health");
    expect(SheetWorkflowsRpcs.requests.has("health.live")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("health.ready")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.checkin")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.checkinDiscard")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.checkinButton")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.checkinButtonDiscard")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.roomOrder")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.roomOrderDiscard")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.kickout")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.kickoutDiscard")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.slotButton")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.slotButtonDiscard")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.slotList")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.slotListDiscard")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.slotOpenButton")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.slotOpenButtonDiscard")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.serviceStatus")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.serviceStatusDiscard")).toBe(true);

    for (const method of Object.values(DispatchRoomOrderButtonMethods)) {
      expect(SheetWorkflowsRpcs.requests.has(method.rpcTag)).toBe(true);
      expect(SheetWorkflowsRpcs.requests.has(`${method.rpcTag}Discard`)).toBe(true);
    }
  });
});
