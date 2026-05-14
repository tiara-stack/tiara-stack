import { describe, expect, it } from "vitest";
import { SheetApisRpcAuthorization } from "sheet-ingress-api/middlewares/sheetApisRpcAuthorization/tag";
import { SheetApisRpcs } from "sheet-ingress-api/sheet-apis-rpc";

describe("SheetApisRpcs", () => {
  it("defines internal sheet API RPC tags", () => {
    expect(SheetApisRpcs.requests.has("health.live")).toBe(true);
    expect(SheetApisRpcs.requests.has("messageSlot.getMessageSlotData")).toBe(true);
    expect(SheetApisRpcs.requests.has("calc.calcSheet")).toBe(true);
    expect(SheetApisRpcs.requests.has("dispatch.checkin")).toBe(false);
    expect(SheetApisRpcs.requests.has("dispatch.checkinButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("dispatch.roomOrder")).toBe(false);
    expect(SheetApisRpcs.requests.has("dispatch.roomOrderPreviousButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("dispatch.roomOrderNextButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("dispatch.roomOrderSendButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("dispatch.roomOrderPinTentativeButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("dispatch.slotOpenButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("checkin.dispatch")).toBe(false);
    expect(SheetApisRpcs.requests.has("checkin.handleButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("roomOrder.dispatch")).toBe(false);
    expect(SheetApisRpcs.requests.has("roomOrder.previousButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("roomOrder.nextButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("roomOrder.sendButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("roomOrder.pinTentativeButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("roomOrder.handleButton")).toBe(false);
  });

  it("requires authorization middleware on clients", () => {
    expect(SheetApisRpcAuthorization.requiredForClient).toBe(true);
  });
});
