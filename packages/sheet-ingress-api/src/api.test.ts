import { describe, expect, it } from "vitest";
import { Api, SheetApisApi, SheetClusterApi } from "./api";
import { SheetClusterRpcs } from "./sheet-cluster-rpc";
import { DispatchRoomOrderButtonMethods, SheetApisRpcs } from "./sheet-apis-rpc";

const roomOrderButtonMethods = Object.values(DispatchRoomOrderButtonMethods);

describe("Api", () => {
  it("keeps sheet-apis health endpoints off ingress", () => {
    expect(SheetApisApi.groups).toHaveProperty("health");
    expect(Api.groups).not.toHaveProperty("health");
  });

  it("exposes every non-health sheet API group on ingress", () => {
    const sheetApiGroups = Object.keys(SheetApisApi.groups).filter((group) => group !== "health");

    for (const group of sheetApiGroups) {
      expect(Api.groups).toHaveProperty(group);
    }
  });

  it("keeps dispatch RPCs on sheet-cluster only", () => {
    expect(SheetApisRpcs.requests.has("dispatch.checkin")).toBe(false);
    expect(SheetApisRpcs.requests.has("dispatch.checkinButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("dispatch.roomOrder")).toBe(false);
    expect(SheetApisRpcs.requests.has("dispatch.kickout")).toBe(false);
    expect(SheetApisRpcs.requests.has("dispatch.slotButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("dispatch.slotList")).toBe(false);
    expect(SheetApisRpcs.requests.has("dispatch.slotOpenButton")).toBe(false);
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
    for (const method of roomOrderButtonMethods) {
      expect(SheetApisRpcs.requests.has(method.rpcTag)).toBe(false);
      expect(SheetClusterRpcs.requests.has(method.rpcTag)).toBe(true);
      expect(SheetClusterRpcs.requests.has(`${method.rpcTag}Discard`)).toBe(true);
    }
    expect(SheetApisRpcs.requests.has("checkin.dispatch")).toBe(false);
    expect(SheetApisRpcs.requests.has("checkin.handleButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("roomOrder.dispatch")).toBe(false);
    expect(SheetApisRpcs.requests.has("roomOrder.handleButton")).toBe(false);
  });

  it("keeps split room-order button HTTP endpoint paths aligned with RPC names", () => {
    expect(SheetApisApi.groups).not.toHaveProperty("dispatch");
    expect(SheetClusterApi.groups).toHaveProperty("dispatch");
    expect(Api.groups).toHaveProperty("dispatch");

    for (const method of roomOrderButtonMethods) {
      expect(SheetClusterRpcs.requests.has(method.rpcTag)).toBe(true);
      expect(SheetClusterApi.groups.dispatch.endpoints[method.endpointName]).toMatchObject({
        method: "POST",
        name: method.endpointName,
        path: method.path,
      });
      expect(Api.groups.dispatch.endpoints[method.endpointName]).toMatchObject({
        method: "POST",
        name: method.endpointName,
        path: method.path,
      });
    }

    expect(SheetClusterApi.groups.dispatch.endpoints.slotOpenButton).toMatchObject({
      method: "POST",
      name: "slotOpenButton",
      path: "/dispatch/slot/buttons/open",
    });
    expect(Api.groups.dispatch.endpoints.slotOpenButton).toMatchObject({
      method: "POST",
      name: "slotOpenButton",
      path: "/dispatch/slot/buttons/open",
    });

    expect(SheetApisApi.groups.checkin.endpoints).not.toHaveProperty("dispatch");
    expect(SheetApisApi.groups.checkin.endpoints).not.toHaveProperty("handleButton");
    expect(SheetApisApi.groups.roomOrder.endpoints).not.toHaveProperty("dispatch");
    expect(SheetApisApi.groups.roomOrder.endpoints).not.toHaveProperty("handleButton");
    expect(Api.groups.checkin.endpoints).not.toHaveProperty("dispatch");
    expect(Api.groups.checkin.endpoints).not.toHaveProperty("handleButton");
    expect(Api.groups.roomOrder.endpoints).not.toHaveProperty("dispatch");
    expect(Api.groups.roomOrder.endpoints).not.toHaveProperty("handleButton");
  });
});
