// fallow-ignore-file duplicate-export
import { ClusterSchema } from "effect/unstable/cluster";
import {
  DispatchAutoCheckinTestWorkflow as BaseDispatchAutoCheckinTestWorkflow,
  DispatchCheckinButtonWorkflow as BaseDispatchCheckinButtonWorkflow,
  DispatchCheckinWorkflow as BaseDispatchCheckinWorkflow,
  DispatchConversationListConfigWorkflow as BaseDispatchConversationListConfigWorkflow,
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

export const DispatchAutoCheckinTestWorkflow = BaseDispatchAutoCheckinTestWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchCheckinWorkflow = BaseDispatchCheckinWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchRoomOrderWorkflow = BaseDispatchRoomOrderWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchKickWorkflow = BaseDispatchKickWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchSlotButtonWorkflow = BaseDispatchSlotButtonWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchSlotListWorkflow = BaseDispatchSlotListWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchSlotOpenButtonWorkflow = BaseDispatchSlotOpenButtonWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchServiceStatusWorkflow = BaseDispatchServiceStatusWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchPreferenceDmStatusWorkflow = BaseDispatchPreferenceDmStatusWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchPreferenceDmEnableWorkflow = BaseDispatchPreferenceDmEnableWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchPreferenceDmDisableWorkflow = BaseDispatchPreferenceDmDisableWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchPreferenceDmSetClientWorkflow =
  BaseDispatchPreferenceDmSetClientWorkflow.annotate(ClusterSchema.ShardGroup, dispatchShardGroup);

export const DispatchWorkspaceWelcomeWorkflow = BaseDispatchWorkspaceWelcomeWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchUpdateAnnouncementWorkflow = BaseDispatchUpdateAnnouncementWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchServiceAddWorkspaceFeatureFlagWorkflow =
  BaseDispatchServiceAddWorkspaceFeatureFlagWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

export const DispatchServiceRemoveWorkspaceFeatureFlagWorkflow =
  BaseDispatchServiceRemoveWorkspaceFeatureFlagWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

export const DispatchCheckinButtonWorkflow = BaseDispatchCheckinButtonWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchRoomOrderPreviousButtonWorkflow =
  BaseDispatchRoomOrderPreviousButtonWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

export const DispatchRoomOrderNextButtonWorkflow = BaseDispatchRoomOrderNextButtonWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchRoomOrderSendButtonWorkflow = BaseDispatchRoomOrderSendButtonWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchRoomOrderPinTentativeButtonWorkflow =
  BaseDispatchRoomOrderPinTentativeButtonWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

export const DispatchConversationListConfigWorkflow =
  BaseDispatchConversationListConfigWorkflow.annotate(ClusterSchema.ShardGroup, dispatchShardGroup);

export const DispatchConversationSetWorkflow = BaseDispatchConversationSetWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchConversationUnsetWorkflow = BaseDispatchConversationUnsetWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchWorkspaceListConfigWorkflow = BaseDispatchWorkspaceListConfigWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchWorkspaceAddMonitorRoleWorkflow =
  BaseDispatchWorkspaceAddMonitorRoleWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

export const DispatchWorkspaceRemoveMonitorRoleWorkflow =
  BaseDispatchWorkspaceRemoveMonitorRoleWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

export const DispatchWorkspaceSetSheetWorkflow = BaseDispatchWorkspaceSetSheetWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchWorkspaceSetAutoCheckinWorkflow =
  BaseDispatchWorkspaceSetAutoCheckinWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

export const DispatchTeamListWorkflow = BaseDispatchTeamListWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchTeamSubmissionWorkflow = BaseDispatchTeamSubmissionWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchTeamSubmissionConfirmButtonWorkflow =
  BaseDispatchTeamSubmissionConfirmButtonWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

export const DispatchTeamSubmissionRejectButtonWorkflow =
  BaseDispatchTeamSubmissionRejectButtonWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

export const DispatchScheduleListWorkflow = BaseDispatchScheduleListWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchScreenshotWorkflow = BaseDispatchScreenshotWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchWorkflows = [
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
