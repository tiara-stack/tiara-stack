import { Context, Effect, Layer } from "effect";
import { DispatchWorkflowOperations } from "sheet-ingress-api/internal";
import { SheetWorkflowsHttpClient } from "./sheetWorkflowsHttpClient";

type DispatchWorkflowOperation =
  (typeof DispatchWorkflowOperations)[keyof typeof DispatchWorkflowOperations];

export class SheetWorkflowsForwardingClient extends Context.Service<SheetWorkflowsForwardingClient>()(
  "SheetWorkflowsForwardingClient",
  {
    make: Effect.gen(function* () {
      const httpClient = yield* SheetWorkflowsHttpClient;

      const accept =
        <const TOperation extends DispatchWorkflowOperation, E, R>(
          operation: TOperation,
          fn: (
            args: TOperation["workflow"]["payloadSchema"]["~type.make.in"],
          ) => Effect.Effect<unknown, E, R>,
        ) =>
        (args: TOperation["workflow"]["payloadSchema"]["~type.make.in"]) =>
          Effect.gen(function* () {
            const executionIdFor = operation.workflow.executionId as (
              payload: TOperation["workflow"]["payloadSchema"]["~type.make.in"],
            ) => Effect.Effect<string>;
            const fallbackExecutionId = yield* executionIdFor(args);
            yield* fn(args);
            return {
              executionId: fallbackExecutionId,
              operation: operation.operation,
              status: "accepted" as const,
            };
          });
      return {
        dispatch: {
          autoCheckinTest: accept(DispatchWorkflowOperations.autoCheckinTest, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.autoCheckinTest.rpcTag]({
              payload: args,
            }),
          ),
          checkin: accept(DispatchWorkflowOperations.checkin, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.checkin.rpcTag]({
              payload: args,
            }),
          ),
          checkinButton: accept(DispatchWorkflowOperations.checkinButton, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.checkinButton.rpcTag]({
              payload: args,
            }),
          ),
          roomOrder: accept(DispatchWorkflowOperations.roomOrder, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.roomOrder.rpcTag]({
              payload: args,
            }),
          ),
          kick: accept(DispatchWorkflowOperations.kick, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.kick.rpcTag]({
              payload: args,
            }),
          ),
          slotButton: accept(DispatchWorkflowOperations.slotButton, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.slotButton.rpcTag]({
              payload: args,
            }),
          ),
          slotList: accept(DispatchWorkflowOperations.slotList, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.slotList.rpcTag]({
              payload: args,
            }),
          ),
          slotOpenButton: accept(DispatchWorkflowOperations.slotOpenButton, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.slotOpenButton.rpcTag]({
              payload: args,
            }),
          ),
          serviceStatus: accept(DispatchWorkflowOperations.serviceStatus, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.serviceStatus.rpcTag]({
              payload: args,
            }),
          ),
          preferenceDmStatus: accept(DispatchWorkflowOperations.preferenceDmStatus, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.preferenceDmStatus.rpcTag]({
              payload: args,
            }),
          ),
          preferenceDmEnable: accept(DispatchWorkflowOperations.preferenceDmEnable, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.preferenceDmEnable.rpcTag]({
              payload: args,
            }),
          ),
          preferenceDmDisable: accept(DispatchWorkflowOperations.preferenceDmDisable, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.preferenceDmDisable.rpcTag]({
              payload: args,
            }),
          ),
          preferenceDmSetClient: accept(DispatchWorkflowOperations.preferenceDmSetClient, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.preferenceDmSetClient.rpcTag]({
              payload: args,
            }),
          ),
          workspaceWelcome: accept(DispatchWorkflowOperations.workspaceWelcome, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.workspaceWelcome.rpcTag]({
              payload: args,
            }),
          ),
          updateAnnouncement: accept(DispatchWorkflowOperations.updateAnnouncement, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.updateAnnouncement.rpcTag]({
              payload: args,
            }),
          ),
          serviceAddWorkspaceFeatureFlag: accept(
            DispatchWorkflowOperations.serviceAddWorkspaceFeatureFlag,
            (args) =>
              httpClient.dispatchWorkflows[
                DispatchWorkflowOperations.serviceAddWorkspaceFeatureFlag.rpcTag
              ]({ payload: args }),
          ),
          serviceRemoveWorkspaceFeatureFlag: accept(
            DispatchWorkflowOperations.serviceRemoveWorkspaceFeatureFlag,
            (args) =>
              httpClient.dispatchWorkflows[
                DispatchWorkflowOperations.serviceRemoveWorkspaceFeatureFlag.rpcTag
              ]({ payload: args }),
          ),
          [DispatchWorkflowOperations.roomOrderPreviousButton.endpointName]: accept(
            DispatchWorkflowOperations.roomOrderPreviousButton,
            (args) =>
              httpClient.dispatchWorkflows[
                DispatchWorkflowOperations.roomOrderPreviousButton.rpcTag
              ]({ payload: args }),
          ),
          [DispatchWorkflowOperations.roomOrderNextButton.endpointName]: accept(
            DispatchWorkflowOperations.roomOrderNextButton,
            (args) =>
              httpClient.dispatchWorkflows[DispatchWorkflowOperations.roomOrderNextButton.rpcTag]({
                payload: args,
              }),
          ),
          [DispatchWorkflowOperations.roomOrderSendButton.endpointName]: accept(
            DispatchWorkflowOperations.roomOrderSendButton,
            (args) =>
              httpClient.dispatchWorkflows[DispatchWorkflowOperations.roomOrderSendButton.rpcTag]({
                payload: args,
              }),
          ),
          [DispatchWorkflowOperations.roomOrderPinTentativeButton.endpointName]: accept(
            DispatchWorkflowOperations.roomOrderPinTentativeButton,
            (args) =>
              httpClient.dispatchWorkflows[
                DispatchWorkflowOperations.roomOrderPinTentativeButton.rpcTag
              ]({ payload: args }),
          ),
          conversationListConfig: accept(
            DispatchWorkflowOperations.conversationListConfig,
            (args) =>
              httpClient.dispatchWorkflows[
                DispatchWorkflowOperations.conversationListConfig.rpcTag
              ]({ payload: args }),
          ),
          conversationSet: accept(DispatchWorkflowOperations.conversationSet, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.conversationSet.rpcTag]({
              payload: args,
            }),
          ),
          conversationUnset: accept(DispatchWorkflowOperations.conversationUnset, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.conversationUnset.rpcTag]({
              payload: args,
            }),
          ),
          conversationLockdownSetup: accept(
            DispatchWorkflowOperations.conversationLockdownSetup,
            (args) =>
              httpClient.dispatchWorkflows[
                DispatchWorkflowOperations.conversationLockdownSetup.rpcTag
              ]({ payload: args }),
          ),
          conversationLockdownUndo: accept(
            DispatchWorkflowOperations.conversationLockdownUndo,
            (args) =>
              httpClient.dispatchWorkflows[
                DispatchWorkflowOperations.conversationLockdownUndo.rpcTag
              ]({ payload: args }),
          ),
          workspaceListConfig: accept(DispatchWorkflowOperations.workspaceListConfig, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.workspaceListConfig.rpcTag]({
              payload: args,
            }),
          ),
          workspaceAddMonitorRole: accept(
            DispatchWorkflowOperations.workspaceAddMonitorRole,
            (args) =>
              httpClient.dispatchWorkflows[
                DispatchWorkflowOperations.workspaceAddMonitorRole.rpcTag
              ]({ payload: args }),
          ),
          workspaceRemoveMonitorRole: accept(
            DispatchWorkflowOperations.workspaceRemoveMonitorRole,
            (args) =>
              httpClient.dispatchWorkflows[
                DispatchWorkflowOperations.workspaceRemoveMonitorRole.rpcTag
              ]({ payload: args }),
          ),
          workspaceSetSheet: accept(DispatchWorkflowOperations.workspaceSetSheet, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.workspaceSetSheet.rpcTag]({
              payload: args,
            }),
          ),
          workspaceSetAutoCheckin: accept(
            DispatchWorkflowOperations.workspaceSetAutoCheckin,
            (args) =>
              httpClient.dispatchWorkflows[
                DispatchWorkflowOperations.workspaceSetAutoCheckin.rpcTag
              ]({ payload: args }),
          ),
          teamList: accept(DispatchWorkflowOperations.teamList, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.teamList.rpcTag]({
              payload: args,
            }),
          ),
          teamSubmission: accept(DispatchWorkflowOperations.teamSubmission, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.teamSubmission.rpcTag]({
              payload: args,
            }),
          ),
          teamSubmissionConfirmButton: accept(
            DispatchWorkflowOperations.teamSubmissionConfirmButton,
            (args) =>
              httpClient.dispatchWorkflows[
                DispatchWorkflowOperations.teamSubmissionConfirmButton.rpcTag
              ]({ payload: args }),
          ),
          teamSubmissionRejectButton: accept(
            DispatchWorkflowOperations.teamSubmissionRejectButton,
            (args) =>
              httpClient.dispatchWorkflows[
                DispatchWorkflowOperations.teamSubmissionRejectButton.rpcTag
              ]({ payload: args }),
          ),
          scheduleList: accept(DispatchWorkflowOperations.scheduleList, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.scheduleList.rpcTag]({
              payload: args,
            }),
          ),
          screenshot: accept(DispatchWorkflowOperations.screenshot, (args) =>
            httpClient.dispatchWorkflows[DispatchWorkflowOperations.screenshot.rpcTag]({
              payload: args,
            }),
          ),
        },
      };
    }),
  },
) {
  static layer = Layer.effect(SheetWorkflowsForwardingClient, this.make).pipe(
    Layer.provide(SheetWorkflowsHttpClient.layer),
  );
}
