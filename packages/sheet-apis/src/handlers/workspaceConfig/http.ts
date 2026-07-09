import { Effect, Layer, Option, Predicate } from "effect";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import {
  withCurrentWorkspaceAuthFromPayload,
  withCurrentWorkspaceAuthFromQuery,
} from "@/handlers/shared/workspaceAuthorization";
import { makeArgumentError } from "typhoon-core/error";
import { WorkspaceConfigService } from "@/services";
import { AuthorizationService } from "@/services";

const optionalRunningFilter = (running: boolean | undefined) =>
  Predicate.isUndefined(running) ? {} : { running };

const missingRunningFilterMessage = (
  running: boolean | undefined,
  messageWithoutRunning: string,
  messageWithRunning: string,
) => (Predicate.isUndefined(running) ? messageWithoutRunning : messageWithRunning);

export const workspaceConfigLayer = sheetApisGroupLayer(
  "workspaceConfig",
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const workspaceConfigService = yield* WorkspaceConfigService;
    const withQueryWorkspaceAuth = withCurrentWorkspaceAuthFromQuery(authorizationService);
    const withPayloadWorkspaceAuth = withCurrentWorkspaceAuthFromPayload(authorizationService);

    return {
      "workspaceConfig.getAutoCheckinWorkspaces": Effect.fnUntraced(function* () {
        yield* authorizationService.requireService();
        return yield* workspaceConfigService.getAutoCheckinWorkspaces();
      }),
      "workspaceConfig.getWorkspaceConfig": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          yield* authorizationService.requireManageWorkspace(query.workspaceId);
          const config = yield* workspaceConfigService.getWorkspaceConfig(query.workspaceId);

          if (Option.isNone(config)) {
            return yield* Effect.fail(
              makeArgumentError(
                "Cannot get workspace config, the workspace might not be registered",
              ),
            );
          }

          return config.value;
        }),
      ),
      "workspaceConfig.upsertWorkspaceConfig": withPayloadWorkspaceAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireManageWorkspace(payload.workspaceId);
          return yield* workspaceConfigService.upsertWorkspaceConfig(
            payload.workspaceId,
            payload.config,
          );
        }),
      ),
      "workspaceConfig.getWorkspaceMonitorRoles": Effect.fnUntraced(function* ({ query }) {
        yield* authorizationService.requireService();
        return yield* workspaceConfigService.getWorkspaceMonitorRoles(query.workspaceId);
      }),
      "workspaceConfig.getWorkspaceFeatureFlags": Effect.fnUntraced(function* ({ query }) {
        yield* authorizationService.requireService();
        return yield* workspaceConfigService.getWorkspaceFeatureFlags(query.workspaceId);
      }),
      "workspaceConfig.getWorkspaceUpdateAnnouncementDelivery": Effect.fnUntraced(function* ({
        query,
      }) {
        yield* authorizationService.requireService();
        return yield* workspaceConfigService.getWorkspaceUpdateAnnouncementDelivery(
          query.workspaceId,
          query.announcementId,
        );
      }),
      "workspaceConfig.getWorkspacesForFeatureFlag": Effect.fnUntraced(function* ({ query }) {
        yield* authorizationService.requireService();
        return yield* workspaceConfigService.getWorkspacesForFeatureFlag(query.flagName);
      }),
      "workspaceConfig.getWorkspaceConversations": Effect.fnUntraced(function* ({ query }) {
        yield* authorizationService.requireService();
        return yield* workspaceConfigService.getWorkspaceConversations({
          workspaceId: query.workspaceId,
          ...optionalRunningFilter(query.running),
        });
      }),
      "workspaceConfig.getTeamSubmissionChannelByConversationId": Effect.fnUntraced(function* ({
        query,
      }) {
        yield* authorizationService.requireService();
        const config = yield* workspaceConfigService.getTeamSubmissionChannelByConversationId({
          workspaceId: query.workspaceId,
          conversationId: query.conversationId,
        });

        if (Option.isNone(config)) {
          return yield* Effect.fail(
            makeArgumentError(
              "Cannot get team submission channel, the workspace or conversation might not be registered",
            ),
          );
        }

        return config.value;
      }),
      "workspaceConfig.getTeamSubmissionChannelsForWorkspace": Effect.fnUntraced(function* ({
        query,
      }) {
        yield* authorizationService.requireService();
        return yield* workspaceConfigService.getTeamSubmissionChannelsForWorkspace(
          query.workspaceId,
        );
      }),
      "workspaceConfig.addWorkspaceMonitorRole": withPayloadWorkspaceAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireManageWorkspace(payload.workspaceId);
          return yield* workspaceConfigService.addWorkspaceMonitorRole(
            payload.workspaceId,
            payload.roleId,
          );
        }),
      ),
      "workspaceConfig.removeWorkspaceMonitorRole": withPayloadWorkspaceAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireManageWorkspace(payload.workspaceId);
          return yield* workspaceConfigService.removeWorkspaceMonitorRole(
            payload.workspaceId,
            payload.roleId,
          );
        }),
      ),
      "workspaceConfig.addWorkspaceFeatureFlag": Effect.fnUntraced(function* ({ payload }) {
        yield* authorizationService.requireService();
        return yield* workspaceConfigService.addWorkspaceFeatureFlag(
          payload.workspaceId,
          payload.flagName,
        );
      }),
      "workspaceConfig.removeWorkspaceFeatureFlag": Effect.fnUntraced(function* ({ payload }) {
        yield* authorizationService.requireService();
        return yield* workspaceConfigService.removeWorkspaceFeatureFlag(
          payload.workspaceId,
          payload.flagName,
        );
      }),
      "workspaceConfig.recordWorkspaceUpdateAnnouncementDelivery": Effect.fnUntraced(function* ({
        payload,
      }) {
        yield* authorizationService.requireService();
        return yield* workspaceConfigService.recordWorkspaceUpdateAnnouncementDelivery(payload);
      }),
      "workspaceConfig.claimWorkspaceUpdateAnnouncementDelivery": Effect.fnUntraced(function* ({
        payload,
      }) {
        yield* authorizationService.requireService();
        return yield* workspaceConfigService.claimWorkspaceUpdateAnnouncementDelivery(payload);
      }),
      "workspaceConfig.releaseWorkspaceUpdateAnnouncementDeliveryClaim": Effect.fnUntraced(
        function* ({ payload }) {
          yield* authorizationService.requireService();
          return yield* workspaceConfigService.releaseWorkspaceUpdateAnnouncementDeliveryClaim(
            payload,
          );
        },
      ),
      "workspaceConfig.upsertWorkspaceConversationConfig": withPayloadWorkspaceAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireManageWorkspace(payload.workspaceId);
          return yield* workspaceConfigService.upsertWorkspaceConversationConfig(
            payload.workspaceId,
            payload.conversationId,
            payload.config,
          );
        }),
      ),
      "workspaceConfig.upsertTeamSubmissionChannel": withPayloadWorkspaceAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireManageWorkspace(payload.workspaceId);
          return yield* workspaceConfigService.upsertTeamSubmissionChannel(
            payload.workspaceId,
            payload.conversationId,
            payload.config,
          );
        }),
      ),
      "workspaceConfig.removeTeamSubmissionChannel": withPayloadWorkspaceAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireManageWorkspace(payload.workspaceId);
          return yield* workspaceConfigService.removeTeamSubmissionChannel(
            payload.workspaceId,
            payload.conversationId,
          );
        }),
      ),
      "workspaceConfig.getWorkspaceConversationById": Effect.fnUntraced(function* ({ query }) {
        yield* authorizationService.requireService();
        const config = yield* workspaceConfigService.getWorkspaceConversationById({
          workspaceId: query.workspaceId,
          conversationId: query.conversationId,
          running: query.running,
        });

        if (Option.isNone(config)) {
          return yield* Effect.fail(
            makeArgumentError(
              missingRunningFilterMessage(
                query.running,
                "Cannot get conversation by id, the workspace or the conversation id might not be registered",
                "Cannot get conversation by id, the workspace or the conversation id might not be registered or does not match the specified running status",
              ),
            ),
          );
        }

        return config.value;
      }),
      "workspaceConfig.getWorkspaceConversationByName": Effect.fnUntraced(function* ({ query }) {
        yield* authorizationService.requireService();
        const config = yield* workspaceConfigService.getWorkspaceConversationByName({
          workspaceId: query.workspaceId,
          conversationName: query.conversationName,
          running: query.running,
        });

        if (Option.isNone(config)) {
          return yield* Effect.fail(
            makeArgumentError(
              missingRunningFilterMessage(
                query.running,
                "Cannot get conversation by name, the workspace or the conversation name might not be registered",
                "Cannot get conversation by name, the workspace or the conversation name might not be registered or does not match the specified running status",
              ),
            ),
          );
        }

        return config.value;
      }),
    } satisfies HandlerMap<"workspaceConfig">;
  }),
).pipe(Layer.provide([AuthorizationService.layer, WorkspaceConfigService.layer]));
