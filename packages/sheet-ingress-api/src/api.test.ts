import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { Unauthorized } from "typhoon-core/error";
import { Api, SheetApisApi, SheetWorkflowsApi } from "./api";
import {
  BotCommandDispatchError,
  DispatchAcceptedResult,
  ServiceStatusDispatchError,
} from "./handlers/dispatch/schema";
import { SheetWorkflowsRpcs } from "./sheet-workflows-rpc";
import { DispatchRoomOrderButtonMethods, SheetApisRpcs } from "./sheet-apis-rpc";

const roomOrderButtonMethods = Object.values(DispatchRoomOrderButtonMethods);
const dispatchRpcNames = [
  "dispatch.autoCheckinTest",
  "dispatch.checkin",
  "dispatch.checkinButton",
  "dispatch.roomOrder",
  "dispatch.kick",
  "dispatch.slotButton",
  "dispatch.slotList",
  "dispatch.slotOpenButton",
  "dispatch.workspaceWelcome",
  "dispatch.updateAnnouncement",
] as const;

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

  it("keeps dispatch RPCs on sheet-workflows only", () => {
    for (const rpcName of dispatchRpcNames) {
      expect(SheetApisRpcs.requests.has(rpcName)).toBe(false);
      expect(SheetWorkflowsRpcs.requests.has(rpcName)).toBe(true);
      expect(SheetWorkflowsRpcs.requests.has(`${rpcName}Discard`)).toBe(true);
    }
    expect(SheetWorkflowsRpcs.requests.has("dispatch.serviceStatus")).toBe(true);
    expect(SheetWorkflowsRpcs.requests.has("dispatch.serviceStatusDiscard")).toBe(true);
    expect(SheetApisRpcs.requests.has("status.getServices")).toBe(true);
    for (const method of roomOrderButtonMethods) {
      expect(SheetApisRpcs.requests.has(method.rpcTag)).toBe(false);
      expect(SheetWorkflowsRpcs.requests.has(method.rpcTag)).toBe(true);
      expect(SheetWorkflowsRpcs.requests.has(`${method.rpcTag}Discard`)).toBe(true);
    }
    expect(SheetApisRpcs.requests.has("checkin.dispatch")).toBe(false);
    expect(SheetApisRpcs.requests.has("checkin.handleButton")).toBe(false);
    expect(SheetApisRpcs.requests.has("roomOrder.dispatch")).toBe(false);
    expect(SheetApisRpcs.requests.has("roomOrder.handleButton")).toBe(false);
  });

  it("keeps split room-order button HTTP endpoint paths aligned with RPC names", () => {
    expect(SheetApisApi.groups).not.toHaveProperty("dispatch");
    expect(SheetWorkflowsApi.groups).toHaveProperty("dispatch");
    expect(Api.groups).toHaveProperty("dispatch");

    for (const method of roomOrderButtonMethods) {
      expect(SheetWorkflowsRpcs.requests.has(method.rpcTag)).toBe(true);
      expect(SheetWorkflowsApi.groups.dispatch!.endpoints[method.endpointName]).toMatchObject({
        method: "POST",
        name: method.endpointName,
        path: method.path,
      });
      expect(Api.groups.dispatch!.endpoints[method.endpointName]).toMatchObject({
        method: "POST",
        name: method.endpointName,
        path: method.path,
      });
    }

    expect(SheetWorkflowsApi.groups.dispatch!.endpoints.slotOpenButton).toMatchObject({
      method: "POST",
      name: "slotOpenButton",
      path: "/dispatch/slot/buttons/open",
    });
    expect(SheetWorkflowsApi.groups.dispatch!.endpoints.autoCheckinTest).toMatchObject({
      method: "POST",
      name: "autoCheckinTest",
      path: "/dispatch/auto-checkin/test",
    });
    expect(SheetWorkflowsApi.groups.dispatch!.endpoints.serviceStatus).toMatchObject({
      method: "POST",
      name: "serviceStatus",
      path: "/dispatch/status/services",
    });
    expect(SheetWorkflowsApi.groups.dispatch!.endpoints.workspaceWelcome).toMatchObject({
      method: "POST",
      name: "workspaceWelcome",
      path: "/dispatch/workspace/welcome",
    });
    expect(SheetWorkflowsApi.groups.dispatch!.endpoints.updateAnnouncement).toMatchObject({
      method: "POST",
      name: "updateAnnouncement",
      path: "/dispatch/update-announcement",
    });
    expect(Api.groups.dispatch!.endpoints.slotOpenButton).toMatchObject({
      method: "POST",
      name: "slotOpenButton",
      path: "/dispatch/slot/buttons/open",
    });
    expect(Api.groups.dispatch!.endpoints.autoCheckinTest).toMatchObject({
      method: "POST",
      name: "autoCheckinTest",
      path: "/dispatch/auto-checkin/test",
    });
    expect(Api.groups.dispatch!.endpoints.serviceStatus).toMatchObject({
      method: "POST",
      name: "serviceStatus",
      path: "/dispatch/status/services",
    });
    expect(Api.groups.dispatch!.endpoints.workspaceWelcome).toMatchObject({
      method: "POST",
      name: "workspaceWelcome",
      path: "/dispatch/workspace/welcome",
    });
    expect(Api.groups.dispatch!.endpoints.updateAnnouncement).toMatchObject({
      method: "POST",
      name: "updateAnnouncement",
      path: "/dispatch/update-announcement",
    });

    expect(SheetApisApi.groups.checkin!.endpoints).not.toHaveProperty("dispatch");
    expect(SheetApisApi.groups.checkin!.endpoints).not.toHaveProperty("handleButton");
    expect(SheetApisApi.groups.roomOrder!.endpoints).not.toHaveProperty("dispatch");
    expect(SheetApisApi.groups.roomOrder!.endpoints).not.toHaveProperty("handleButton");
    expect(Api.groups.checkin!.endpoints).not.toHaveProperty("dispatch");
    expect(Api.groups.checkin!.endpoints).not.toHaveProperty("handleButton");
    expect(Api.groups.roomOrder!.endpoints).not.toHaveProperty("dispatch");
    expect(Api.groups.roomOrder!.endpoints).not.toHaveProperty("handleButton");
  });

  it("declares workflow discard RPCs as returning execution ids", () => {
    const discardRpc = SheetWorkflowsRpcs.requests.get("dispatch.serviceStatusDiscard");

    expect(discardRpc).toBeDefined();
    expect(Schema.decodeUnknownSync(discardRpc!.successSchema)("execution-id")).toBe(
      "execution-id",
    );
    expect(() => Schema.decodeUnknownSync(discardRpc!.successSchema)(undefined)).toThrow();
  });

  it("accepts workflow dispatch results", () => {
    expect(
      Schema.decodeUnknownSync(DispatchAcceptedResult)({
        executionId: "auto-checkin-test-execution",
        operation: "autoCheckinTest",
        status: "accepted",
      }),
    ).toEqual({
      executionId: "auto-checkin-test-execution",
      operation: "autoCheckinTest",
      status: "accepted",
    });
    expect(
      Schema.decodeUnknownSync(DispatchAcceptedResult)({
        executionId: "workspace-welcome-execution",
        operation: "workspaceWelcome",
        status: "accepted",
      }),
    ).toEqual({
      executionId: "workspace-welcome-execution",
      operation: "workspaceWelcome",
      status: "accepted",
    });
  });

  it("keeps long interaction tokens out of ingress bot paths", () => {
    expect(Api.groups.ingressBot!.endpoints.updateOriginalInteractionResponse).toMatchObject({
      method: "PATCH",
      name: "updateOriginalInteractionResponse",
      path: "/bot/interactions/original-response",
    });
    expect(
      Api.groups.ingressBot!.endpoints.updateOriginalInteractionResponseWithFiles,
    ).toMatchObject({
      method: "PATCH",
      name: "updateOriginalInteractionResponseWithFiles",
      path: "/bot/interactions/original-response/files",
    });
  });

  it("declares authorization failures emitted by dispatch workflows", () => {
    const error = new Unauthorized({ message: "Invalid ingress delegation" });

    expect(Schema.encodeUnknownSync(ServiceStatusDispatchError)(error)).toMatchObject({
      _tag: "Unauthorized",
      message: "Invalid ingress delegation",
    });
    expect(Schema.encodeUnknownSync(BotCommandDispatchError)(error)).toMatchObject({
      _tag: "Unauthorized",
      message: "Invalid ingress delegation",
    });
  });
});
