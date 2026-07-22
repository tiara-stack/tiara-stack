import { ClusterSchema } from "effect/unstable/cluster";
import {
  DispatchAutoCheckinTestWorkflow as BaseDispatchAutoCheckinTestWorkflow,
  DispatchCheckinButtonWorkflow as BaseDispatchCheckinButtonWorkflow,
  DispatchCheckinWorkflow as BaseDispatchCheckinWorkflow,
  DispatchConversationListConfigWorkflow as BaseDispatchConversationListConfigWorkflow,
  DispatchConversationLockdownSetupWorkflow as BaseDispatchConversationLockdownSetupWorkflow,
  DispatchConversationLockdownUndoWorkflow as BaseDispatchConversationLockdownUndoWorkflow,
  DispatchConversationSetWorkflow as BaseDispatchConversationSetWorkflow,
  DispatchConversationUnsetWorkflow as BaseDispatchConversationUnsetWorkflow,
  DispatchWorkspaceWelcomeWorkflow as BaseDispatchWorkspaceWelcomeWorkflow,
  DispatchKickWorkflow as BaseDispatchKickWorkflow,
  DispatchPreferenceDmDisableWorkflow as BaseDispatchPreferenceDmDisableWorkflow,
  DispatchPreferenceDmEnableWorkflow as BaseDispatchPreferenceDmEnableWorkflow,
  DispatchPreferenceDmSetClientWorkflow as BaseDispatchPreferenceDmSetClientWorkflow,
  DispatchPreferenceDmStatusWorkflow as BaseDispatchPreferenceDmStatusWorkflow,
  DispatchRoomOrderNextButtonWorkflow as BaseDispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow as BaseDispatchRoomOrderPinTentativeButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow as BaseDispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow as BaseDispatchRoomOrderSendButtonWorkflow,
  DispatchRoomOrderWorkflow as BaseDispatchRoomOrderWorkflow,
  DispatchScheduleListWorkflow as BaseDispatchScheduleListWorkflow,
  DispatchServiceAddWorkspaceFeatureFlagWorkflow as BaseDispatchServiceAddWorkspaceFeatureFlagWorkflow,
  DispatchServiceRemoveWorkspaceFeatureFlagWorkflow as BaseDispatchServiceRemoveWorkspaceFeatureFlagWorkflow,
  DispatchServiceStatusWorkflow as BaseDispatchServiceStatusWorkflow,
  DispatchWorkspaceAddMonitorRoleWorkflow as BaseDispatchWorkspaceAddMonitorRoleWorkflow,
  DispatchWorkspaceListConfigWorkflow as BaseDispatchWorkspaceListConfigWorkflow,
  DispatchWorkspaceRemoveMonitorRoleWorkflow as BaseDispatchWorkspaceRemoveMonitorRoleWorkflow,
  DispatchWorkspaceSetAutoCheckinWorkflow as BaseDispatchWorkspaceSetAutoCheckinWorkflow,
  DispatchWorkspaceSetSheetWorkflow as BaseDispatchWorkspaceSetSheetWorkflow,
  DispatchScreenshotWorkflow as BaseDispatchScreenshotWorkflow,
  DispatchSlotButtonWorkflow as BaseDispatchSlotButtonWorkflow,
  DispatchSlotListWorkflow as BaseDispatchSlotListWorkflow,
  DispatchSlotOpenButtonWorkflow as BaseDispatchSlotOpenButtonWorkflow,
  DispatchTeamListWorkflow as BaseDispatchTeamListWorkflow,
  DispatchTeamSubmissionConfirmButtonWorkflow as BaseDispatchTeamSubmissionConfirmButtonWorkflow,
  DispatchTeamSubmissionRejectButtonWorkflow as BaseDispatchTeamSubmissionRejectButtonWorkflow,
  DispatchTeamSubmissionWorkflow as BaseDispatchTeamSubmissionWorkflow,
  DispatchUpdateAnnouncementWorkflow as BaseDispatchUpdateAnnouncementWorkflow,
} from "sheet-ingress-api/internal";

const dispatchShardGroup = () => "dispatch";

const DispatchAutoCheckinTestWorkflow = BaseDispatchAutoCheckinTestWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchCheckinWorkflow = BaseDispatchCheckinWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchRoomOrderWorkflow = BaseDispatchRoomOrderWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchKickWorkflow = BaseDispatchKickWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchSlotButtonWorkflow = BaseDispatchSlotButtonWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchSlotListWorkflow = BaseDispatchSlotListWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchSlotOpenButtonWorkflow = BaseDispatchSlotOpenButtonWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchServiceStatusWorkflow = BaseDispatchServiceStatusWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchPreferenceDmStatusWorkflow = BaseDispatchPreferenceDmStatusWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchPreferenceDmEnableWorkflow = BaseDispatchPreferenceDmEnableWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchPreferenceDmDisableWorkflow = BaseDispatchPreferenceDmDisableWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchPreferenceDmSetClientWorkflow = BaseDispatchPreferenceDmSetClientWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchWorkspaceWelcomeWorkflow = BaseDispatchWorkspaceWelcomeWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchUpdateAnnouncementWorkflow = BaseDispatchUpdateAnnouncementWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchServiceAddWorkspaceFeatureFlagWorkflow =
  BaseDispatchServiceAddWorkspaceFeatureFlagWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

const DispatchServiceRemoveWorkspaceFeatureFlagWorkflow =
  BaseDispatchServiceRemoveWorkspaceFeatureFlagWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

const DispatchCheckinButtonWorkflow = BaseDispatchCheckinButtonWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchRoomOrderPreviousButtonWorkflow =
  BaseDispatchRoomOrderPreviousButtonWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

const DispatchRoomOrderNextButtonWorkflow = BaseDispatchRoomOrderNextButtonWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchRoomOrderSendButtonWorkflow = BaseDispatchRoomOrderSendButtonWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchRoomOrderPinTentativeButtonWorkflow =
  BaseDispatchRoomOrderPinTentativeButtonWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

const DispatchConversationListConfigWorkflow = BaseDispatchConversationListConfigWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchConversationSetWorkflow = BaseDispatchConversationSetWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchConversationUnsetWorkflow = BaseDispatchConversationUnsetWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchConversationLockdownSetupWorkflow =
  BaseDispatchConversationLockdownSetupWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

const DispatchConversationLockdownUndoWorkflow =
  BaseDispatchConversationLockdownUndoWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

const DispatchWorkspaceListConfigWorkflow = BaseDispatchWorkspaceListConfigWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchWorkspaceAddMonitorRoleWorkflow =
  BaseDispatchWorkspaceAddMonitorRoleWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

const DispatchWorkspaceRemoveMonitorRoleWorkflow =
  BaseDispatchWorkspaceRemoveMonitorRoleWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

const DispatchWorkspaceSetSheetWorkflow = BaseDispatchWorkspaceSetSheetWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchWorkspaceSetAutoCheckinWorkflow =
  BaseDispatchWorkspaceSetAutoCheckinWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

const DispatchTeamListWorkflow = BaseDispatchTeamListWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchTeamSubmissionWorkflow = BaseDispatchTeamSubmissionWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchTeamSubmissionConfirmButtonWorkflow =
  BaseDispatchTeamSubmissionConfirmButtonWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

const DispatchTeamSubmissionRejectButtonWorkflow =
  BaseDispatchTeamSubmissionRejectButtonWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

const DispatchScheduleListWorkflow = BaseDispatchScheduleListWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchScreenshotWorkflow = BaseDispatchScreenshotWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

const DispatchWorkflows = [
  DispatchAutoCheckinTestWorkflow,
  DispatchCheckinWorkflow,
  DispatchRoomOrderWorkflow,
  DispatchKickWorkflow,
  DispatchSlotButtonWorkflow,
  DispatchSlotListWorkflow,
  DispatchSlotOpenButtonWorkflow,
  DispatchServiceStatusWorkflow,
  DispatchPreferenceDmStatusWorkflow,
  DispatchPreferenceDmEnableWorkflow,
  DispatchPreferenceDmDisableWorkflow,
  DispatchPreferenceDmSetClientWorkflow,
  DispatchWorkspaceWelcomeWorkflow,
  DispatchUpdateAnnouncementWorkflow,
  DispatchServiceAddWorkspaceFeatureFlagWorkflow,
  DispatchServiceRemoveWorkspaceFeatureFlagWorkflow,
  DispatchCheckinButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow,
  DispatchConversationListConfigWorkflow,
  DispatchConversationSetWorkflow,
  DispatchConversationUnsetWorkflow,
  DispatchConversationLockdownSetupWorkflow,
  DispatchConversationLockdownUndoWorkflow,
  DispatchWorkspaceListConfigWorkflow,
  DispatchWorkspaceAddMonitorRoleWorkflow,
  DispatchWorkspaceRemoveMonitorRoleWorkflow,
  DispatchWorkspaceSetSheetWorkflow,
  DispatchWorkspaceSetAutoCheckinWorkflow,
  DispatchTeamListWorkflow,
  DispatchTeamSubmissionWorkflow,
  DispatchTeamSubmissionConfirmButtonWorkflow,
  DispatchTeamSubmissionRejectButtonWorkflow,
  DispatchScheduleListWorkflow,
  DispatchScreenshotWorkflow,
] as const;

/** Cluster-annotated workflow definitions used by the sheet-workflows runtime. */
export const DispatchClusterWorkflows = {
  DispatchAutoCheckinTestWorkflow,
  DispatchCheckinWorkflow,
  DispatchRoomOrderWorkflow,
  DispatchKickWorkflow,
  DispatchSlotButtonWorkflow,
  DispatchSlotListWorkflow,
  DispatchSlotOpenButtonWorkflow,
  DispatchServiceStatusWorkflow,
  DispatchPreferenceDmStatusWorkflow,
  DispatchPreferenceDmEnableWorkflow,
  DispatchPreferenceDmDisableWorkflow,
  DispatchPreferenceDmSetClientWorkflow,
  DispatchWorkspaceWelcomeWorkflow,
  DispatchUpdateAnnouncementWorkflow,
  DispatchServiceAddWorkspaceFeatureFlagWorkflow,
  DispatchServiceRemoveWorkspaceFeatureFlagWorkflow,
  DispatchCheckinButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow,
  DispatchConversationListConfigWorkflow,
  DispatchConversationSetWorkflow,
  DispatchConversationUnsetWorkflow,
  DispatchConversationLockdownSetupWorkflow,
  DispatchConversationLockdownUndoWorkflow,
  DispatchWorkspaceListConfigWorkflow,
  DispatchWorkspaceAddMonitorRoleWorkflow,
  DispatchWorkspaceRemoveMonitorRoleWorkflow,
  DispatchWorkspaceSetSheetWorkflow,
  DispatchWorkspaceSetAutoCheckinWorkflow,
  DispatchTeamListWorkflow,
  DispatchTeamSubmissionWorkflow,
  DispatchTeamSubmissionConfirmButtonWorkflow,
  DispatchTeamSubmissionRejectButtonWorkflow,
  DispatchScheduleListWorkflow,
  DispatchScreenshotWorkflow,
  all: DispatchWorkflows,
} as const;
