import { describe, expect, it } from "vitest";
import { SheetApisRpcAuthorization } from "sheet-ingress-api/middlewares/sheetApisRpcAuthorization/tag";
import { SheetApisRpcs } from "sheet-ingress-api/sheet-apis-rpc";

describe("SheetApisRpcs", () => {
  it("defines internal sheet API RPC tags", () => {
    expect(SheetApisRpcs.requests.has("health.live")).toBe(true);
    expect(SheetApisRpcs.requests.has("messageSlot.getMessageSlotData")).toBe(true);
    expect(SheetApisRpcs.requests.has("calc.calcSheet")).toBe(true);
    expect(SheetApisRpcs.requests.has("checkin.dispatch")).toBe(true);
    expect(SheetApisRpcs.requests.has("checkin.handleButton")).toBe(true);
    expect(SheetApisRpcs.requests.has("roomOrder.dispatch")).toBe(true);
    expect(SheetApisRpcs.requests.has("roomOrder.handleButton")).toBe(true);
  });

  it("requires authorization middleware on clients", () => {
    expect(SheetApisRpcAuthorization.requiredForClient).toBe(true);
  });
});
