import { ClusterSchema } from "effect/unstable/cluster";
import {
  DispatchAutoCheckinTestWorkflow as BaseDispatchAutoCheckinTestWorkflow,
  DispatchCheckinButtonWorkflow as BaseDispatchCheckinButtonWorkflow,
  DispatchCheckinWorkflow as BaseDispatchCheckinWorkflow,
  DispatchChannelListConfigWorkflow as BaseDispatchChannelListConfigWorkflow,
  DispatchChannelSetWorkflow as BaseDispatchChannelSetWorkflow,
  DispatchChannelUnsetWorkflow as BaseDispatchChannelUnsetWorkflow,
  DispatchGuildWelcomeWorkflow as BaseDispatchGuildWelcomeWorkflow,
  DispatchKickoutWorkflow as BaseDispatchKickoutWorkflow,
  DispatchRoomOrderNextButtonWorkflow as BaseDispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow as BaseDispatchRoomOrderPinTentativeButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow as BaseDispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow as BaseDispatchRoomOrderSendButtonWorkflow,
  DispatchRoomOrderWorkflow as BaseDispatchRoomOrderWorkflow,
  DispatchScheduleListWorkflow as BaseDispatchScheduleListWorkflow,
  DispatchServiceAddGuildFeatureFlagWorkflow as BaseDispatchServiceAddGuildFeatureFlagWorkflow,
  DispatchServiceRemoveGuildFeatureFlagWorkflow as BaseDispatchServiceRemoveGuildFeatureFlagWorkflow,
  DispatchServiceStatusWorkflow as BaseDispatchServiceStatusWorkflow,
  DispatchServerAddMonitorRoleWorkflow as BaseDispatchServerAddMonitorRoleWorkflow,
  DispatchServerListConfigWorkflow as BaseDispatchServerListConfigWorkflow,
  DispatchServerRemoveMonitorRoleWorkflow as BaseDispatchServerRemoveMonitorRoleWorkflow,
  DispatchServerSetAutoCheckinWorkflow as BaseDispatchServerSetAutoCheckinWorkflow,
  DispatchServerSetSheetWorkflow as BaseDispatchServerSetSheetWorkflow,
  DispatchScreenshotWorkflow as BaseDispatchScreenshotWorkflow,
  DispatchSlotButtonWorkflow as BaseDispatchSlotButtonWorkflow,
  DispatchSlotListWorkflow as BaseDispatchSlotListWorkflow,
  DispatchSlotOpenButtonWorkflow as BaseDispatchSlotOpenButtonWorkflow,
  DispatchTeamListWorkflow as BaseDispatchTeamListWorkflow,
  DispatchUpdateAnnouncementWorkflow as BaseDispatchUpdateAnnouncementWorkflow,
} from "sheet-ingress-api/sheet-workflows-workflows";

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

export const DispatchKickoutWorkflow = BaseDispatchKickoutWorkflow.annotate(
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

export const DispatchGuildWelcomeWorkflow = BaseDispatchGuildWelcomeWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchUpdateAnnouncementWorkflow = BaseDispatchUpdateAnnouncementWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchServiceAddGuildFeatureFlagWorkflow =
  BaseDispatchServiceAddGuildFeatureFlagWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

export const DispatchServiceRemoveGuildFeatureFlagWorkflow =
  BaseDispatchServiceRemoveGuildFeatureFlagWorkflow.annotate(
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

export const DispatchChannelListConfigWorkflow = BaseDispatchChannelListConfigWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchChannelSetWorkflow = BaseDispatchChannelSetWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchChannelUnsetWorkflow = BaseDispatchChannelUnsetWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchServerListConfigWorkflow = BaseDispatchServerListConfigWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchServerAddMonitorRoleWorkflow =
  BaseDispatchServerAddMonitorRoleWorkflow.annotate(ClusterSchema.ShardGroup, dispatchShardGroup);

export const DispatchServerRemoveMonitorRoleWorkflow =
  BaseDispatchServerRemoveMonitorRoleWorkflow.annotate(
    ClusterSchema.ShardGroup,
    dispatchShardGroup,
  );

export const DispatchServerSetSheetWorkflow = BaseDispatchServerSetSheetWorkflow.annotate(
  ClusterSchema.ShardGroup,
  dispatchShardGroup,
);

export const DispatchServerSetAutoCheckinWorkflow =
  BaseDispatchServerSetAutoCheckinWorkflow.annotate(ClusterSchema.ShardGroup, dispatchShardGroup);

export const DispatchTeamListWorkflow = BaseDispatchTeamListWorkflow.annotate(
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
  DispatchKickoutWorkflow,
  DispatchSlotButtonWorkflow,
  DispatchSlotListWorkflow,
  DispatchSlotOpenButtonWorkflow,
  DispatchServiceStatusWorkflow,
  DispatchGuildWelcomeWorkflow,
  DispatchUpdateAnnouncementWorkflow,
  DispatchServiceAddGuildFeatureFlagWorkflow,
  DispatchServiceRemoveGuildFeatureFlagWorkflow,
  DispatchCheckinButtonWorkflow,
  DispatchRoomOrderPreviousButtonWorkflow,
  DispatchRoomOrderNextButtonWorkflow,
  DispatchRoomOrderSendButtonWorkflow,
  DispatchRoomOrderPinTentativeButtonWorkflow,
  DispatchChannelListConfigWorkflow,
  DispatchChannelSetWorkflow,
  DispatchChannelUnsetWorkflow,
  DispatchServerListConfigWorkflow,
  DispatchServerAddMonitorRoleWorkflow,
  DispatchServerRemoveMonitorRoleWorkflow,
  DispatchServerSetSheetWorkflow,
  DispatchServerSetAutoCheckinWorkflow,
  DispatchTeamListWorkflow,
  DispatchScheduleListWorkflow,
  DispatchScreenshotWorkflow,
] as const;
