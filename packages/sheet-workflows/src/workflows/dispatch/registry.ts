import { Effect } from "effect";
import type { DispatchRequester } from "sheet-ingress-api/sheet-workflows-workflows";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import type { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import { DispatchService } from "@/services";
import {
  DispatchAutoCheckinTestWorkflow,
  DispatchCheckinButtonWorkflow,
  DispatchCheckinWorkflow,
  DispatchConversationListConfigWorkflow,
  DispatchConversationSetWorkflow,
  DispatchConversationUnsetWorkflow,
  DispatchWorkspaceWelcomeWorkflow,
  DispatchKickoutWorkflow,
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
} from "../dispatchWorkflows";
import {
  requireAuthorizedWorkspace,
  requireCheckinButtonAccess,
  requireRegisteredRoomOrderButtonAccess,
  requireRoomOrderPinTentativeButtonAccess,
  requireSelfOrAuthorizedWorkspace,
  requireSlotOpenButtonAccess,
} from "./authorization";

type InteractionTokenRequest = {
  readonly payload: { readonly interactionResponseToken?: string | undefined };
};

const getInteractionToken = <TRequest extends InteractionTokenRequest>(request: TRequest) =>
  request.payload.interactionResponseToken;

type ManageWorkspaceRequest = {
  readonly authorization?: Parameters<typeof requireAuthorizedWorkspace>[0];
  readonly payload: { readonly workspaceId: string };
};

const authorizeManageWorkspace = <TRequest extends ManageWorkspaceRequest>() =>
  Effect.fn("DispatchWorkflow.authorizeManageWorkspace")(function* (request: TRequest) {
    yield* requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, "manage");
  });

const withDispatchService = <A, E, R>(
  operation: (service: typeof DispatchService.Service) => Effect.Effect<A, E, R>,
) => Effect.flatMap(DispatchService, operation);

export const dispatchWorkflowRegistry = {
  autoCheckinTest: {
    operation: "autoCheckinTest",
    workflow: DispatchAutoCheckinTestWorkflow,
    getInteractionToken,
    authorize: (request: typeof DispatchAutoCheckinTestWorkflow.payloadSchema.Type) =>
      requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, "monitor"),
    execute: (request: typeof DispatchAutoCheckinTestWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.autoCheckinTest(request.payload, request.requester)),
  },
  checkin: {
    operation: "checkin",
    workflow: DispatchCheckinWorkflow,
    getInteractionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchCheckinWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.checkin(request.payload, request.requester)),
  },
  roomOrder: {
    operation: "roomOrder",
    workflow: DispatchRoomOrderWorkflow,
    getInteractionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchRoomOrderWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.roomOrder(request.payload, request.requester)),
  },
  kickout: {
    operation: "kickout",
    workflow: DispatchKickoutWorkflow,
    getInteractionToken,
    authorize: authorizeManageWorkspace<typeof DispatchKickoutWorkflow.payloadSchema.Type>(),
    execute: (request: typeof DispatchKickoutWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.kickout(request.payload, request.requester)),
  },
  slotButton: {
    operation: "slotButton",
    workflow: DispatchSlotButtonWorkflow,
    getInteractionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchSlotButtonWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.slotButton(request.payload, request.requester)),
  },
  slotList: {
    operation: "slotList",
    workflow: DispatchSlotListWorkflow,
    getInteractionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchSlotListWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.slotList(request.payload)),
  },
  slotOpenButton: {
    operation: "slotOpenButton",
    workflow: DispatchSlotOpenButtonWorkflow,
    getInteractionToken,
    authorize: (request: typeof DispatchSlotOpenButtonWorkflow.payloadSchema.Type) =>
      requireSlotOpenButtonAccess(request.payload),
    execute: (
      request: typeof DispatchSlotOpenButtonWorkflow.payloadSchema.Type,
      messageSlot: MessageSlot,
    ) => withDispatchService((service) => service.slotOpenButton(request.payload, messageSlot)),
  },
  serviceStatus: {
    operation: "serviceStatus",
    workflow: DispatchServiceStatusWorkflow,
    getInteractionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchServiceStatusWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.serviceStatus(request.payload)),
  },
  preferenceDmStatus: {
    operation: "preferenceDmStatus",
    workflow: DispatchPreferenceDmStatusWorkflow,
    getInteractionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchPreferenceDmStatusWorkflow.payloadSchema.Type) =>
      withDispatchService((service) =>
        service.preferenceDmStatus(request.payload, request.requester),
      ),
  },
  preferenceDmEnable: {
    operation: "preferenceDmEnable",
    workflow: DispatchPreferenceDmEnableWorkflow,
    getInteractionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchPreferenceDmEnableWorkflow.payloadSchema.Type) =>
      withDispatchService((service) =>
        service.preferenceDmEnable(request.payload, request.requester),
      ),
  },
  preferenceDmDisable: {
    operation: "preferenceDmDisable",
    workflow: DispatchPreferenceDmDisableWorkflow,
    getInteractionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchPreferenceDmDisableWorkflow.payloadSchema.Type) =>
      withDispatchService((service) =>
        service.preferenceDmDisable(request.payload, request.requester),
      ),
  },
  preferenceDmSetClient: {
    operation: "preferenceDmSetClient",
    workflow: DispatchPreferenceDmSetClientWorkflow,
    getInteractionToken,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchPreferenceDmSetClientWorkflow.payloadSchema.Type) =>
      withDispatchService((service) =>
        service.preferenceDmSetClient(request.payload, request.requester),
      ),
  },
  workspaceWelcome: {
    operation: "workspaceWelcome",
    workflow: DispatchWorkspaceWelcomeWorkflow,
    getInteractionToken: () => undefined,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchWorkspaceWelcomeWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.workspaceWelcome(request.payload)),
  },
  updateAnnouncement: {
    operation: "updateAnnouncement",
    workflow: DispatchUpdateAnnouncementWorkflow,
    getInteractionToken: () => undefined,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchUpdateAnnouncementWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.updateAnnouncement(request.payload)),
  },
  serviceAddWorkspaceFeatureFlag: {
    operation: "serviceAddWorkspaceFeatureFlag",
    workflow: DispatchServiceAddWorkspaceFeatureFlagWorkflow,
    getInteractionToken: () => undefined,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchServiceAddWorkspaceFeatureFlagWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.serviceAddWorkspaceFeatureFlag(request.payload)),
  },
  serviceRemoveWorkspaceFeatureFlag: {
    operation: "serviceRemoveWorkspaceFeatureFlag",
    workflow: DispatchServiceRemoveWorkspaceFeatureFlagWorkflow,
    getInteractionToken: () => undefined,
    authorize: () => Effect.void,
    execute: (
      request: typeof DispatchServiceRemoveWorkspaceFeatureFlagWorkflow.payloadSchema.Type,
    ) =>
      withDispatchService((service) => service.serviceRemoveWorkspaceFeatureFlag(request.payload)),
  },
  checkinButton: {
    operation: "checkinButton",
    workflow: DispatchCheckinButtonWorkflow,
    getInteractionToken,
    authorize: (request: typeof DispatchCheckinButtonWorkflow.payloadSchema.Type) =>
      requireCheckinButtonAccess(request.payload, request.requester),
    execute: (request: typeof DispatchCheckinButtonWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.checkinButton(request.payload, request.requester)),
  },
  roomOrderPreviousButton: {
    operation: "roomOrderPreviousButton",
    workflow: DispatchRoomOrderPreviousButtonWorkflow,
    getInteractionToken,
    authorize: (request: typeof DispatchRoomOrderPreviousButtonWorkflow.payloadSchema.Type) =>
      requireRegisteredRoomOrderButtonAccess(request.payload),
    execute: (
      request: typeof DispatchRoomOrderPreviousButtonWorkflow.payloadSchema.Type,
      authorizedRoomOrder: MessageRoomOrder,
    ) =>
      withDispatchService((service) =>
        service.roomOrderPreviousButton(request.payload, authorizedRoomOrder),
      ),
  },
  roomOrderNextButton: {
    operation: "roomOrderNextButton",
    workflow: DispatchRoomOrderNextButtonWorkflow,
    getInteractionToken,
    authorize: (request: typeof DispatchRoomOrderNextButtonWorkflow.payloadSchema.Type) =>
      requireRegisteredRoomOrderButtonAccess(request.payload),
    execute: (
      request: typeof DispatchRoomOrderNextButtonWorkflow.payloadSchema.Type,
      authorizedRoomOrder: MessageRoomOrder,
    ) =>
      withDispatchService((service) =>
        service.roomOrderNextButton(request.payload, authorizedRoomOrder),
      ),
  },
  roomOrderSendButton: {
    operation: "roomOrderSendButton",
    workflow: DispatchRoomOrderSendButtonWorkflow,
    getInteractionToken,
    authorize: (request: typeof DispatchRoomOrderSendButtonWorkflow.payloadSchema.Type) =>
      requireRegisteredRoomOrderButtonAccess(request.payload),
    execute: (
      request: typeof DispatchRoomOrderSendButtonWorkflow.payloadSchema.Type,
      authorizedRoomOrder: MessageRoomOrder,
    ) =>
      withDispatchService((service) =>
        service.roomOrderSendButton(request.payload, authorizedRoomOrder),
      ),
  },
  roomOrderPinTentativeButton: {
    operation: "roomOrderPinTentativeButton",
    workflow: DispatchRoomOrderPinTentativeButtonWorkflow,
    getInteractionToken,
    authorize: (request: typeof DispatchRoomOrderPinTentativeButtonWorkflow.payloadSchema.Type) =>
      requireRoomOrderPinTentativeButtonAccess(request.payload),
    execute: (
      request: typeof DispatchRoomOrderPinTentativeButtonWorkflow.payloadSchema.Type,
      authorizedRoomOrder: MessageRoomOrder | null,
    ) =>
      withDispatchService((service) =>
        service.roomOrderPinTentativeButton(request.payload, authorizedRoomOrder),
      ),
  },
  conversationListConfig: {
    operation: "conversationListConfig",
    workflow: DispatchConversationListConfigWorkflow,
    getInteractionToken,
    authorize:
      authorizeManageWorkspace<typeof DispatchConversationListConfigWorkflow.payloadSchema.Type>(),
    execute: (request: typeof DispatchConversationListConfigWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.conversationListConfig(request.payload)),
  },
  conversationSet: {
    operation: "conversationSet",
    workflow: DispatchConversationSetWorkflow,
    getInteractionToken,
    authorize:
      authorizeManageWorkspace<typeof DispatchConversationSetWorkflow.payloadSchema.Type>(),
    execute: (request: typeof DispatchConversationSetWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.conversationSet(request.payload)),
  },
  conversationUnset: {
    operation: "conversationUnset",
    workflow: DispatchConversationUnsetWorkflow,
    getInteractionToken,
    authorize:
      authorizeManageWorkspace<typeof DispatchConversationUnsetWorkflow.payloadSchema.Type>(),
    execute: (request: typeof DispatchConversationUnsetWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.conversationUnset(request.payload)),
  },
  workspaceListConfig: {
    operation: "workspaceListConfig",
    workflow: DispatchWorkspaceListConfigWorkflow,
    getInteractionToken,
    authorize:
      authorizeManageWorkspace<typeof DispatchWorkspaceListConfigWorkflow.payloadSchema.Type>(),
    execute: (request: typeof DispatchWorkspaceListConfigWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.workspaceListConfig(request.payload)),
  },
  workspaceAddMonitorRole: {
    operation: "workspaceAddMonitorRole",
    workflow: DispatchWorkspaceAddMonitorRoleWorkflow,
    getInteractionToken,
    authorize:
      authorizeManageWorkspace<typeof DispatchWorkspaceAddMonitorRoleWorkflow.payloadSchema.Type>(),
    execute: (request: typeof DispatchWorkspaceAddMonitorRoleWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.workspaceAddMonitorRole(request.payload)),
  },
  workspaceRemoveMonitorRole: {
    operation: "workspaceRemoveMonitorRole",
    workflow: DispatchWorkspaceRemoveMonitorRoleWorkflow,
    getInteractionToken,
    authorize:
      authorizeManageWorkspace<
        typeof DispatchWorkspaceRemoveMonitorRoleWorkflow.payloadSchema.Type
      >(),
    execute: (request: typeof DispatchWorkspaceRemoveMonitorRoleWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.workspaceRemoveMonitorRole(request.payload)),
  },
  workspaceSetSheet: {
    operation: "workspaceSetSheet",
    workflow: DispatchWorkspaceSetSheetWorkflow,
    getInteractionToken,
    authorize:
      authorizeManageWorkspace<typeof DispatchWorkspaceSetSheetWorkflow.payloadSchema.Type>(),
    execute: (request: typeof DispatchWorkspaceSetSheetWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.workspaceSetSheet(request.payload)),
  },
  workspaceSetAutoCheckin: {
    operation: "workspaceSetAutoCheckin",
    workflow: DispatchWorkspaceSetAutoCheckinWorkflow,
    getInteractionToken,
    authorize:
      authorizeManageWorkspace<typeof DispatchWorkspaceSetAutoCheckinWorkflow.payloadSchema.Type>(),
    execute: (request: typeof DispatchWorkspaceSetAutoCheckinWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.workspaceSetAutoCheckin(request.payload)),
  },
  teamList: {
    operation: "teamList",
    workflow: DispatchTeamListWorkflow,
    getInteractionToken,
    authorize: (request: typeof DispatchTeamListWorkflow.payloadSchema.Type) =>
      requireSelfOrAuthorizedWorkspace(request, "monitor"),
    execute: (request: typeof DispatchTeamListWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.teamList(request.payload)),
  },
  teamSubmission: {
    operation: "teamSubmission",
    workflow: DispatchTeamSubmissionWorkflow,
    getInteractionToken: () => undefined,
    authorize: () => Effect.void,
    execute: (request: typeof DispatchTeamSubmissionWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.teamSubmission(request.payload)),
  },
  teamSubmissionConfirmButton: {
    operation: "teamSubmissionConfirmButton",
    workflow: DispatchTeamSubmissionConfirmButtonWorkflow,
    getInteractionToken,
    authorize: (request: typeof DispatchTeamSubmissionConfirmButtonWorkflow.payloadSchema.Type) =>
      Effect.succeed(request.requester),
    execute: (
      request: typeof DispatchTeamSubmissionConfirmButtonWorkflow.payloadSchema.Type,
      requester: DispatchRequester,
    ) =>
      withDispatchService((service) =>
        service.teamSubmissionConfirmButton(request.payload, requester),
      ),
  },
  teamSubmissionRejectButton: {
    operation: "teamSubmissionRejectButton",
    workflow: DispatchTeamSubmissionRejectButtonWorkflow,
    getInteractionToken,
    authorize: (request: typeof DispatchTeamSubmissionRejectButtonWorkflow.payloadSchema.Type) =>
      Effect.succeed(request.requester),
    execute: (
      request: typeof DispatchTeamSubmissionRejectButtonWorkflow.payloadSchema.Type,
      requester: DispatchRequester,
    ) =>
      withDispatchService((service) =>
        service.teamSubmissionRejectButton(request.payload, requester),
      ),
  },
  scheduleList: {
    operation: "scheduleList",
    workflow: DispatchScheduleListWorkflow,
    getInteractionToken,
    authorize: (request: typeof DispatchScheduleListWorkflow.payloadSchema.Type) =>
      requireSelfOrAuthorizedWorkspace(request, "monitor"),
    execute: (request: typeof DispatchScheduleListWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.scheduleList(request.payload)),
  },
  screenshot: {
    operation: "screenshot",
    workflow: DispatchScreenshotWorkflow,
    getInteractionToken,
    authorize: (request: typeof DispatchScreenshotWorkflow.payloadSchema.Type) =>
      requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, "monitor"),
    execute: (request: typeof DispatchScreenshotWorkflow.payloadSchema.Type) =>
      withDispatchService((service) => service.screenshot(request.payload)),
  },
} as const;
