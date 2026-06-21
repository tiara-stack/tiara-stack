import { Context, Effect, Layer } from "effect";
import { DispatchWorkflowOperations } from "sheet-ingress-api/sheet-workflows-workflows";
import { SheetWorkflowsRpcClient } from "./sheetWorkflowsRpcClient";

type DispatchWorkflowOperation =
  (typeof DispatchWorkflowOperations)[keyof typeof DispatchWorkflowOperations];

export class SheetWorkflowsForwardingClient extends Context.Service<SheetWorkflowsForwardingClient>()(
  "SheetWorkflowsForwardingClient",
  {
    make: Effect.gen(function* () {
      const rpcClient = yield* SheetWorkflowsRpcClient;

      const accept =
        <const TOperation extends DispatchWorkflowOperation, E, R>(
          operation: TOperation,
          fn: (
            args: TOperation["workflow"]["payloadSchema"]["~type.make.in"],
          ) => Effect.Effect<string | void, E, R>,
        ) =>
        (args: TOperation["workflow"]["payloadSchema"]["~type.make.in"]) =>
          Effect.gen(function* () {
            const executionIdFor = operation.workflow.executionId as (
              payload: TOperation["workflow"]["payloadSchema"]["~type.make.in"],
            ) => Effect.Effect<string>;
            const fallbackExecutionId = yield* executionIdFor(args);
            const dispatchedExecutionId = yield* fn(args);
            return {
              executionId: dispatchedExecutionId ?? fallbackExecutionId,
              operation: operation.operation,
              status: "accepted" as const,
            };
          });

      return {
        dispatch: {
          autoCheckinTest: accept(DispatchWorkflowOperations.autoCheckinTest, (args) =>
            rpcClient[DispatchWorkflowOperations.autoCheckinTest.discardRpcTag](args),
          ),
          checkin: accept(DispatchWorkflowOperations.checkin, (args) =>
            rpcClient[DispatchWorkflowOperations.checkin.discardRpcTag](args),
          ),
          checkinButton: accept(DispatchWorkflowOperations.checkinButton, (args) =>
            rpcClient[DispatchWorkflowOperations.checkinButton.discardRpcTag](args),
          ),
          roomOrder: accept(DispatchWorkflowOperations.roomOrder, (args) =>
            rpcClient[DispatchWorkflowOperations.roomOrder.discardRpcTag](args),
          ),
          kickout: accept(DispatchWorkflowOperations.kickout, (args) =>
            rpcClient[DispatchWorkflowOperations.kickout.discardRpcTag](args),
          ),
          slotButton: accept(DispatchWorkflowOperations.slotButton, (args) =>
            rpcClient[DispatchWorkflowOperations.slotButton.discardRpcTag](args),
          ),
          slotList: accept(DispatchWorkflowOperations.slotList, (args) =>
            rpcClient[DispatchWorkflowOperations.slotList.discardRpcTag](args),
          ),
          slotOpenButton: accept(DispatchWorkflowOperations.slotOpenButton, (args) =>
            rpcClient[DispatchWorkflowOperations.slotOpenButton.discardRpcTag](args),
          ),
          serviceStatus: accept(DispatchWorkflowOperations.serviceStatus, (args) =>
            rpcClient[DispatchWorkflowOperations.serviceStatus.discardRpcTag](args),
          ),
          workspaceWelcome: accept(DispatchWorkflowOperations.workspaceWelcome, (args) =>
            rpcClient[DispatchWorkflowOperations.workspaceWelcome.discardRpcTag](args),
          ),
          updateAnnouncement: accept(DispatchWorkflowOperations.updateAnnouncement, (args) =>
            rpcClient[DispatchWorkflowOperations.updateAnnouncement.discardRpcTag](args),
          ),
          serviceAddWorkspaceFeatureFlag: accept(
            DispatchWorkflowOperations.serviceAddWorkspaceFeatureFlag,
            (args) =>
              rpcClient[DispatchWorkflowOperations.serviceAddWorkspaceFeatureFlag.discardRpcTag](
                args,
              ),
          ),
          serviceRemoveWorkspaceFeatureFlag: accept(
            DispatchWorkflowOperations.serviceRemoveWorkspaceFeatureFlag,
            (args) =>
              rpcClient[DispatchWorkflowOperations.serviceRemoveWorkspaceFeatureFlag.discardRpcTag](
                args,
              ),
          ),
          [DispatchWorkflowOperations.roomOrderPreviousButton.endpointName]: accept(
            DispatchWorkflowOperations.roomOrderPreviousButton,
            (args) =>
              rpcClient[DispatchWorkflowOperations.roomOrderPreviousButton.discardRpcTag](args),
          ),
          [DispatchWorkflowOperations.roomOrderNextButton.endpointName]: accept(
            DispatchWorkflowOperations.roomOrderNextButton,
            (args) => rpcClient[DispatchWorkflowOperations.roomOrderNextButton.discardRpcTag](args),
          ),
          [DispatchWorkflowOperations.roomOrderSendButton.endpointName]: accept(
            DispatchWorkflowOperations.roomOrderSendButton,
            (args) => rpcClient[DispatchWorkflowOperations.roomOrderSendButton.discardRpcTag](args),
          ),
          [DispatchWorkflowOperations.roomOrderPinTentativeButton.endpointName]: accept(
            DispatchWorkflowOperations.roomOrderPinTentativeButton,
            (args) =>
              rpcClient[DispatchWorkflowOperations.roomOrderPinTentativeButton.discardRpcTag](args),
          ),
          conversationListConfig: accept(
            DispatchWorkflowOperations.conversationListConfig,
            (args) =>
              rpcClient[DispatchWorkflowOperations.conversationListConfig.discardRpcTag](args),
          ),
          conversationSet: accept(DispatchWorkflowOperations.conversationSet, (args) =>
            rpcClient[DispatchWorkflowOperations.conversationSet.discardRpcTag](args),
          ),
          conversationUnset: accept(DispatchWorkflowOperations.conversationUnset, (args) =>
            rpcClient[DispatchWorkflowOperations.conversationUnset.discardRpcTag](args),
          ),
          workspaceListConfig: accept(DispatchWorkflowOperations.workspaceListConfig, (args) =>
            rpcClient[DispatchWorkflowOperations.workspaceListConfig.discardRpcTag](args),
          ),
          workspaceAddMonitorRole: accept(
            DispatchWorkflowOperations.workspaceAddMonitorRole,
            (args) =>
              rpcClient[DispatchWorkflowOperations.workspaceAddMonitorRole.discardRpcTag](args),
          ),
          workspaceRemoveMonitorRole: accept(
            DispatchWorkflowOperations.workspaceRemoveMonitorRole,
            (args) =>
              rpcClient[DispatchWorkflowOperations.workspaceRemoveMonitorRole.discardRpcTag](args),
          ),
          workspaceSetSheet: accept(DispatchWorkflowOperations.workspaceSetSheet, (args) =>
            rpcClient[DispatchWorkflowOperations.workspaceSetSheet.discardRpcTag](args),
          ),
          workspaceSetAutoCheckin: accept(
            DispatchWorkflowOperations.workspaceSetAutoCheckin,
            (args) =>
              rpcClient[DispatchWorkflowOperations.workspaceSetAutoCheckin.discardRpcTag](args),
          ),
          teamList: accept(DispatchWorkflowOperations.teamList, (args) =>
            rpcClient[DispatchWorkflowOperations.teamList.discardRpcTag](args),
          ),
          scheduleList: accept(DispatchWorkflowOperations.scheduleList, (args) =>
            rpcClient[DispatchWorkflowOperations.scheduleList.discardRpcTag](args),
          ),
          screenshot: accept(DispatchWorkflowOperations.screenshot, (args) =>
            rpcClient[DispatchWorkflowOperations.screenshot.discardRpcTag](args),
          ),
        },
      };
    }),
  },
) {
  static layer = Layer.effect(SheetWorkflowsForwardingClient, this.make).pipe(
    Layer.provide(SheetWorkflowsRpcClient.layer),
  );
}
