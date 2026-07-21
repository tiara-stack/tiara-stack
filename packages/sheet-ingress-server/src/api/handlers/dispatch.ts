import { Effect, Match } from "effect";
import { SheetAuthUser } from "sheet-ingress-api/internal";
import { DispatchRoomOrderButtonMethods } from "sheet-ingress-api/sheet-apis-rpc";
import { roomOrderButtonProxyAuthorizers } from "../../services/roomOrderButtonAuthorization";
import {
  requireGuild,
  requireGuildSnapshot,
  requireMessageCheckinParticipantMutation,
  requireMessageSlotRead,
  requireNonService,
  requireSelfOrMonitorSnapshot,
  requireService,
} from "../authorization";
import type { IngressHandlerTable } from "../types";
import { authorizedSheetWorkflowsDispatch } from "../workflowProxy";

const requireMonitorWorkspace = ({
  payload,
}: {
  readonly payload: { readonly workspaceId: string };
}) => requireGuild("monitor", payload.workspaceId);

const requireMonitorWorkspaceSnapshot = ({
  payload,
}: {
  readonly payload: { readonly workspaceId: string };
}) => requireGuildSnapshot("monitor", payload.workspaceId);

const requireManageWorkspaceSnapshot = ({
  payload,
}: {
  readonly payload: { readonly workspaceId: string };
}) => requireGuildSnapshot("manage", payload.workspaceId);

const requireMonitorOrManageWorkspaceSnapshot = ({
  payload,
}: {
  readonly payload: { readonly workspaceId: string };
}) =>
  requireGuildSnapshot("monitor", payload.workspaceId).pipe(
    Effect.catch(() => requireGuildSnapshot("manage", payload.workspaceId)),
  );

export const dispatchHandlers = {
  dispatch: (handlers) =>
    handlers
      .handle("checkin", authorizedSheetWorkflowsDispatch("checkin", requireMonitorWorkspace))
      .handle(
        "autoCheckinTest",
        authorizedSheetWorkflowsDispatch("autoCheckinTest", requireMonitorWorkspaceSnapshot),
      )
      .handle(
        "checkinButton",
        authorizedSheetWorkflowsDispatch("checkinButton", ({ payload }) =>
          Effect.gen(function* () {
            const user = yield* SheetAuthUser;
            yield* requireMessageCheckinParticipantMutation(payload.messageId, user.accountId);
          }),
        ),
      )
      .handle("roomOrder", authorizedSheetWorkflowsDispatch("roomOrder", requireMonitorWorkspace))
      .handle("kick", authorizedSheetWorkflowsDispatch("kick", requireMonitorWorkspace))
      .handle("slotButton", authorizedSheetWorkflowsDispatch("slotButton", requireMonitorWorkspace))
      .handle(
        "slotList",
        authorizedSheetWorkflowsDispatch("slotList", ({ payload }) =>
          Match.value(payload.messageType).pipe(
            Match.when("persistent", () => requireGuild("monitor", payload.workspaceId)),
            Match.orElse(() => Effect.void),
          ),
        ),
      )
      .handle(
        "slotOpenButton",
        authorizedSheetWorkflowsDispatch("slotOpenButton", ({ payload }) =>
          requireMessageSlotRead(payload.messageId),
        ),
      )
      .handle("serviceStatus", authorizedSheetWorkflowsDispatch("serviceStatus", requireNonService))
      .handle(
        "preferenceDmStatus",
        authorizedSheetWorkflowsDispatch("preferenceDmStatus", requireNonService),
      )
      .handle(
        "preferenceDmEnable",
        authorizedSheetWorkflowsDispatch("preferenceDmEnable", requireNonService),
      )
      .handle(
        "preferenceDmDisable",
        authorizedSheetWorkflowsDispatch("preferenceDmDisable", requireNonService),
      )
      .handle(
        "preferenceDmSetClient",
        authorizedSheetWorkflowsDispatch("preferenceDmSetClient", requireNonService),
      )
      .handle(
        "workspaceWelcome",
        authorizedSheetWorkflowsDispatch("workspaceWelcome", requireService),
      )
      .handle(
        "updateAnnouncement",
        authorizedSheetWorkflowsDispatch("updateAnnouncement", requireService),
      )
      .handle(
        "serviceAddWorkspaceFeatureFlag",
        authorizedSheetWorkflowsDispatch("serviceAddWorkspaceFeatureFlag", requireService),
      )
      .handle(
        "serviceRemoveWorkspaceFeatureFlag",
        authorizedSheetWorkflowsDispatch("serviceRemoveWorkspaceFeatureFlag", requireService),
      )
      .handle(
        "conversationListConfig",
        authorizedSheetWorkflowsDispatch("conversationListConfig", requireManageWorkspaceSnapshot),
      )
      .handle(
        "conversationSet",
        authorizedSheetWorkflowsDispatch("conversationSet", requireManageWorkspaceSnapshot),
      )
      .handle(
        "conversationUnset",
        authorizedSheetWorkflowsDispatch("conversationUnset", requireManageWorkspaceSnapshot),
      )
      .handle(
        "conversationLockdownSetup",
        authorizedSheetWorkflowsDispatch(
          "conversationLockdownSetup",
          requireMonitorOrManageWorkspaceSnapshot,
        ),
      )
      .handle(
        "conversationLockdownUndo",
        authorizedSheetWorkflowsDispatch(
          "conversationLockdownUndo",
          requireMonitorOrManageWorkspaceSnapshot,
        ),
      )
      .handle(
        "workspaceListConfig",
        authorizedSheetWorkflowsDispatch("workspaceListConfig", requireManageWorkspaceSnapshot),
      )
      .handle(
        "workspaceAddMonitorRole",
        authorizedSheetWorkflowsDispatch("workspaceAddMonitorRole", requireManageWorkspaceSnapshot),
      )
      .handle(
        "workspaceRemoveMonitorRole",
        authorizedSheetWorkflowsDispatch(
          "workspaceRemoveMonitorRole",
          requireManageWorkspaceSnapshot,
        ),
      )
      .handle(
        "workspaceSetSheet",
        authorizedSheetWorkflowsDispatch("workspaceSetSheet", requireManageWorkspaceSnapshot),
      )
      .handle(
        "workspaceSetAutoCheckin",
        authorizedSheetWorkflowsDispatch("workspaceSetAutoCheckin", requireManageWorkspaceSnapshot),
      )
      .handle(
        "teamList",
        authorizedSheetWorkflowsDispatch("teamList", ({ payload }) =>
          requireSelfOrMonitorSnapshot(payload.workspaceId, payload.targetUserId),
        ),
      )
      .handle("teamSubmission", authorizedSheetWorkflowsDispatch("teamSubmission", requireService))
      .handle(
        "teamSubmissionConfirmButton",
        authorizedSheetWorkflowsDispatch("teamSubmissionConfirmButton", requireNonService),
      )
      .handle(
        "teamSubmissionRejectButton",
        authorizedSheetWorkflowsDispatch("teamSubmissionRejectButton", requireNonService),
      )
      .handle(
        "scheduleList",
        authorizedSheetWorkflowsDispatch("scheduleList", ({ payload }) =>
          requireSelfOrMonitorSnapshot(payload.workspaceId, payload.targetUserId),
        ),
      )
      .handle(
        "screenshot",
        authorizedSheetWorkflowsDispatch("screenshot", ({ payload }) =>
          requireGuildSnapshot("monitor", payload.workspaceId),
        ),
      )
      .handle(
        DispatchRoomOrderButtonMethods.previous.endpointName,
        authorizedSheetWorkflowsDispatch(
          DispatchRoomOrderButtonMethods.previous.endpointName,
          ({ payload }) =>
            roomOrderButtonProxyAuthorizers[DispatchRoomOrderButtonMethods.previous.endpointName](
              { messageId: payload.messageId },
              payload.client,
            ),
        ),
      )
      .handle(
        DispatchRoomOrderButtonMethods.next.endpointName,
        authorizedSheetWorkflowsDispatch(
          DispatchRoomOrderButtonMethods.next.endpointName,
          ({ payload }) =>
            roomOrderButtonProxyAuthorizers[DispatchRoomOrderButtonMethods.next.endpointName](
              { messageId: payload.messageId },
              payload.client,
            ),
        ),
      )
      .handle(
        DispatchRoomOrderButtonMethods.send.endpointName,
        authorizedSheetWorkflowsDispatch(
          DispatchRoomOrderButtonMethods.send.endpointName,
          ({ payload }) =>
            roomOrderButtonProxyAuthorizers[DispatchRoomOrderButtonMethods.send.endpointName](
              { messageId: payload.messageId },
              payload.client,
            ),
        ),
      )
      .handle(
        DispatchRoomOrderButtonMethods.pinTentative.endpointName,
        authorizedSheetWorkflowsDispatch(
          DispatchRoomOrderButtonMethods.pinTentative.endpointName,
          ({ payload }) =>
            roomOrderButtonProxyAuthorizers[
              DispatchRoomOrderButtonMethods.pinTentative.endpointName
            ]({ workspaceId: payload.workspaceId, messageId: payload.messageId }, payload.client),
        ),
      ),
} satisfies Pick<IngressHandlerTable, "dispatch">;
