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
          guildWelcome: accept(DispatchWorkflowOperations.guildWelcome, (args) =>
            rpcClient[DispatchWorkflowOperations.guildWelcome.discardRpcTag](args),
          ),
          updateAnnouncement: accept(DispatchWorkflowOperations.updateAnnouncement, (args) =>
            rpcClient[DispatchWorkflowOperations.updateAnnouncement.discardRpcTag](args),
          ),
          serviceAddGuildFeatureFlag: accept(
            DispatchWorkflowOperations.serviceAddGuildFeatureFlag,
            (args) =>
              rpcClient[DispatchWorkflowOperations.serviceAddGuildFeatureFlag.discardRpcTag](args),
          ),
          serviceRemoveGuildFeatureFlag: accept(
            DispatchWorkflowOperations.serviceRemoveGuildFeatureFlag,
            (args) =>
              rpcClient[DispatchWorkflowOperations.serviceRemoveGuildFeatureFlag.discardRpcTag](
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
          channelListConfig: accept(DispatchWorkflowOperations.channelListConfig, (args) =>
            rpcClient[DispatchWorkflowOperations.channelListConfig.discardRpcTag](args),
          ),
          channelSet: accept(DispatchWorkflowOperations.channelSet, (args) =>
            rpcClient[DispatchWorkflowOperations.channelSet.discardRpcTag](args),
          ),
          channelUnset: accept(DispatchWorkflowOperations.channelUnset, (args) =>
            rpcClient[DispatchWorkflowOperations.channelUnset.discardRpcTag](args),
          ),
          serverListConfig: accept(DispatchWorkflowOperations.serverListConfig, (args) =>
            rpcClient[DispatchWorkflowOperations.serverListConfig.discardRpcTag](args),
          ),
          serverAddMonitorRole: accept(DispatchWorkflowOperations.serverAddMonitorRole, (args) =>
            rpcClient[DispatchWorkflowOperations.serverAddMonitorRole.discardRpcTag](args),
          ),
          serverRemoveMonitorRole: accept(
            DispatchWorkflowOperations.serverRemoveMonitorRole,
            (args) =>
              rpcClient[DispatchWorkflowOperations.serverRemoveMonitorRole.discardRpcTag](args),
          ),
          serverSetSheet: accept(DispatchWorkflowOperations.serverSetSheet, (args) =>
            rpcClient[DispatchWorkflowOperations.serverSetSheet.discardRpcTag](args),
          ),
          serverSetAutoCheckin: accept(DispatchWorkflowOperations.serverSetAutoCheckin, (args) =>
            rpcClient[DispatchWorkflowOperations.serverSetAutoCheckin.discardRpcTag](args),
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
