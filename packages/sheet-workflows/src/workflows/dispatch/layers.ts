import { Layer } from "effect";
import { makeDispatchButtonEntityLayer } from "@/entities/dispatchButton";
import {
  DispatchAutoCheckinTestWorkflow,
  DispatchCheckinButtonWorkflow,
  DispatchCheckinWorkflow,
  DispatchConversationListConfigWorkflow,
  DispatchConversationLockdownSetupWorkflow,
  DispatchConversationLockdownUndoWorkflow,
  DispatchConversationSetWorkflow,
  DispatchConversationUnsetWorkflow,
  DispatchWorkspaceWelcomeWorkflow,
  DispatchKickWorkflow,
  DispatchPreferenceDmDisableWorkflow,
  DispatchPreferenceDmEnableWorkflow,
  DispatchPreferenceDmSetClientWorkflow,
  DispatchPreferenceDmStatusWorkflow,
  DispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow,
  DispatchRoomOrderWorkflow,
  DispatchScheduleListWorkflow,
  DispatchServiceAddWorkspaceFeatureFlagWorkflow,
  DispatchServiceRemoveWorkspaceFeatureFlagWorkflow,
  DispatchServiceStatusWorkflow,
  DispatchWorkspaceAddMonitorRoleWorkflow,
  DispatchWorkspaceListConfigWorkflow,
  DispatchWorkspaceRemoveMonitorRoleWorkflow,
  DispatchWorkspaceSetAutoCheckinWorkflow,
  DispatchWorkspaceSetSheetWorkflow,
  DispatchScreenshotWorkflow,
  DispatchSlotButtonWorkflow,
  DispatchSlotListWorkflow,
  DispatchSlotOpenButtonWorkflow,
  DispatchTeamListWorkflow,
  DispatchTeamSubmissionConfirmButtonWorkflow,
  DispatchTeamSubmissionRejectButtonWorkflow,
  DispatchTeamSubmissionWorkflow,
  DispatchUpdateAnnouncementWorkflow,
  DispatchWorkflows,
} from "../dispatchWorkflows";
import {
  makeButtonWorkflowHandler,
  makeWorkflowHandler,
  runDispatchWorkflowOperation,
} from "./activityBoundary";
import { dispatchWorkflowRegistry } from "./registry";

export const dispatchButtonEntityLayer = makeDispatchButtonEntityLayer({
  slotOpenButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.slotOpenButton,
      payload.request,
      payload.executionId,
    ),
  checkinButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.checkinButton,
      payload.request,
      payload.executionId,
    ),
  roomOrderPreviousButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.roomOrderPreviousButton,
      payload.request,
      payload.executionId,
    ),
  roomOrderNextButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.roomOrderNextButton,
      payload.request,
      payload.executionId,
    ),
  roomOrderSendButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.roomOrderSendButton,
      payload.request,
      payload.executionId,
    ),
  roomOrderPinTentativeButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.roomOrderPinTentativeButton,
      payload.request,
      payload.executionId,
    ),
  teamSubmissionConfirmButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.teamSubmissionConfirmButton,
      payload.request,
      payload.executionId,
    ),
  teamSubmissionRejectButton: ({ payload }) =>
    runDispatchWorkflowOperation(
      dispatchWorkflowRegistry.teamSubmissionRejectButton,
      payload.request,
      payload.executionId,
    ),
});

const dispatchWorkflowLayers = [
  DispatchAutoCheckinTestWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.autoCheckinTest),
  ),
  DispatchCheckinWorkflow.toLayer(makeWorkflowHandler(dispatchWorkflowRegistry.checkin)),
  DispatchRoomOrderWorkflow.toLayer(makeWorkflowHandler(dispatchWorkflowRegistry.roomOrder)),
  DispatchKickWorkflow.toLayer(makeWorkflowHandler(dispatchWorkflowRegistry.kick)),
  DispatchSlotButtonWorkflow.toLayer(makeWorkflowHandler(dispatchWorkflowRegistry.slotButton)),
  DispatchSlotListWorkflow.toLayer(makeWorkflowHandler(dispatchWorkflowRegistry.slotList)),
  DispatchSlotOpenButtonWorkflow.toLayer(
    makeButtonWorkflowHandler(dispatchWorkflowRegistry.slotOpenButton),
  ),
  DispatchServiceStatusWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.serviceStatus),
  ),
  DispatchPreferenceDmStatusWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.preferenceDmStatus),
  ),
  DispatchPreferenceDmEnableWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.preferenceDmEnable),
  ),
  DispatchPreferenceDmDisableWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.preferenceDmDisable),
  ),
  DispatchPreferenceDmSetClientWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.preferenceDmSetClient),
  ),
  DispatchWorkspaceWelcomeWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.workspaceWelcome),
  ),
  DispatchUpdateAnnouncementWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.updateAnnouncement),
  ),
  DispatchServiceAddWorkspaceFeatureFlagWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.serviceAddWorkspaceFeatureFlag),
  ),
  DispatchServiceRemoveWorkspaceFeatureFlagWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.serviceRemoveWorkspaceFeatureFlag),
  ),
  DispatchCheckinButtonWorkflow.toLayer(
    makeButtonWorkflowHandler(dispatchWorkflowRegistry.checkinButton),
  ),
  DispatchRoomOrderPreviousButtonWorkflow.toLayer(
    makeButtonWorkflowHandler(dispatchWorkflowRegistry.roomOrderPreviousButton),
  ),
  DispatchRoomOrderNextButtonWorkflow.toLayer(
    makeButtonWorkflowHandler(dispatchWorkflowRegistry.roomOrderNextButton),
  ),
  DispatchRoomOrderSendButtonWorkflow.toLayer(
    makeButtonWorkflowHandler(dispatchWorkflowRegistry.roomOrderSendButton),
  ),
  DispatchRoomOrderPinTentativeButtonWorkflow.toLayer(
    makeButtonWorkflowHandler(dispatchWorkflowRegistry.roomOrderPinTentativeButton),
  ),
  DispatchConversationListConfigWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.conversationListConfig),
  ),
  DispatchConversationSetWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.conversationSet),
  ),
  DispatchConversationUnsetWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.conversationUnset),
  ),
  DispatchConversationLockdownSetupWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.conversationLockdownSetup),
  ),
  DispatchConversationLockdownUndoWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.conversationLockdownUndo),
  ),
  DispatchWorkspaceListConfigWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.workspaceListConfig),
  ),
  DispatchWorkspaceAddMonitorRoleWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.workspaceAddMonitorRole),
  ),
  DispatchWorkspaceRemoveMonitorRoleWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.workspaceRemoveMonitorRole),
  ),
  DispatchWorkspaceSetSheetWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.workspaceSetSheet),
  ),
  DispatchWorkspaceSetAutoCheckinWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.workspaceSetAutoCheckin),
  ),
  DispatchTeamListWorkflow.toLayer(makeWorkflowHandler(dispatchWorkflowRegistry.teamList)),
  DispatchTeamSubmissionWorkflow.toLayer(
    makeWorkflowHandler(dispatchWorkflowRegistry.teamSubmission),
  ),
  DispatchTeamSubmissionConfirmButtonWorkflow.toLayer(
    makeButtonWorkflowHandler(dispatchWorkflowRegistry.teamSubmissionConfirmButton),
  ),
  DispatchTeamSubmissionRejectButtonWorkflow.toLayer(
    makeButtonWorkflowHandler(dispatchWorkflowRegistry.teamSubmissionRejectButton),
  ),
  DispatchScheduleListWorkflow.toLayer(makeWorkflowHandler(dispatchWorkflowRegistry.scheduleList)),
  DispatchScreenshotWorkflow.toLayer(makeWorkflowHandler(dispatchWorkflowRegistry.screenshot)),
] as const;

export const dispatchWorkflowLayer = Layer.mergeAll(...dispatchWorkflowLayers);

export const dispatchWorkflowNames = DispatchWorkflows.map((workflow) => workflow.name);
