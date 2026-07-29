import { Effect, Layer, Option, Predicate } from "effect";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import {
  withCurrentWorkspaceAuthFromPayload,
  withCurrentWorkspaceAuthFromQuery,
} from "@/handlers/shared/workspaceAuthorization";
import { makeArgumentError } from "typhoon-core/error";
import {
  isLockdownRoleIdAllowed,
  lockdownEveryoneRoleErrorMessage,
  makeLockdownPermissionOverwrites,
} from "sheet-ingress-api/guild-config";
import type { WorkspaceConversationConfig } from "sheet-ingress-api/schemas/workspaceConfig";
import { AuthorizationService, IngressBotClient, WorkspaceConfigService } from "@/services";

const optionalRunningFilter = (running: boolean | undefined) =>
  Predicate.isUndefined(running) ? {} : { running };

const missingRunningFilterMessage = (
  running: boolean | undefined,
  messageWithoutRunning: string,
  messageWithRunning: string,
) => (Predicate.isUndefined(running) ? messageWithoutRunning : messageWithRunning);

type WorkspaceConversationLockdownPayload = {
  readonly workspaceId: string;
  readonly conversationId: string;
};

type ReplaceChannelPermissionOverwrites<E, Requirements> = (
  channelId: string,
  permissionOverwrites: ReturnType<typeof makeLockdownPermissionOverwrites>,
) => Effect.Effect<unknown, E, Requirements>;

type GuildChannelsClient<E, Requirements> = {
  readonly getGuildChannels: (
    workspaceId: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: string }>, E, Requirements>;
};

type LockdownBotClient<ChannelsError, ChannelsRequirements, ReplaceError, ReplaceRequirements> =
  GuildChannelsClient<ChannelsError, ChannelsRequirements> & {
    readonly replaceChannelPermissionOverwrites: ReplaceChannelPermissionOverwrites<
      ReplaceError,
      ReplaceRequirements
    >;
  };

const ensureChannelInWorkspace = Effect.fn("WorkspaceConfigHttp.ensureChannelInWorkspace")(
  function* <E, Requirements>(
    client: GuildChannelsClient<E, Requirements>,
    operation: "set up" | "undo",
    workspaceId: string,
    conversationId: string,
  ) {
    const channels = yield* client.getGuildChannels(workspaceId);
    if (!channels.some(({ id }) => id === conversationId)) {
      return yield* Effect.fail(
        makeArgumentError(
          `Cannot ${operation} lockdown permissions, conversation ${conversationId} is not in workspace ${workspaceId}`,
        ),
      );
    }
  },
);

export const setupWorkspaceConversationLockdown = Effect.fn(
  "WorkspaceConfigHttp.setupWorkspaceConversationLockdown",
)(function* <
  ConfigError,
  ConfigRequirements,
  MonitorRolesError,
  MonitorRolesRequirements,
  ChannelsError,
  ChannelsRequirements,
  ReplaceError,
  ReplaceRequirements,
>(
  payload: WorkspaceConversationLockdownPayload,
  workspaceConfigService: {
    readonly getWorkspaceConversationById: (query: {
      readonly workspaceId: string;
      readonly conversationId: string;
    }) => Effect.Effect<
      Option.Option<WorkspaceConversationConfig>,
      ConfigError,
      ConfigRequirements
    >;
    readonly getWorkspaceMonitorRoles: (
      workspaceId: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly roleId: string }>,
      MonitorRolesError,
      MonitorRolesRequirements
    >;
  },
  ingressBotClient: LockdownBotClient<
    ChannelsError,
    ChannelsRequirements,
    ReplaceError,
    ReplaceRequirements
  >,
) {
  const maybeConfig = yield* workspaceConfigService.getWorkspaceConversationById({
    workspaceId: payload.workspaceId,
    conversationId: payload.conversationId,
  });
  if (Option.isNone(maybeConfig)) {
    return yield* Effect.fail(
      makeArgumentError(
        `Cannot set up lockdown permissions, conversation ${payload.conversationId} is not configured`,
      ),
    );
  }
  if (Option.isNone(maybeConfig.value.roleId)) {
    return yield* Effect.fail(
      makeArgumentError(
        `Cannot set up lockdown permissions, conversation ${payload.conversationId} has no lockdown role`,
      ),
    );
  }
  if (!isLockdownRoleIdAllowed(payload.workspaceId, maybeConfig.value.roleId.value)) {
    return yield* Effect.fail(makeArgumentError(lockdownEveryoneRoleErrorMessage));
  }
  yield* ensureChannelInWorkspace(
    ingressBotClient,
    "set up",
    payload.workspaceId,
    payload.conversationId,
  );
  const monitorRoles = yield* workspaceConfigService.getWorkspaceMonitorRoles(payload.workspaceId);
  yield* ingressBotClient.replaceChannelPermissionOverwrites(
    payload.conversationId,
    makeLockdownPermissionOverwrites({
      workspaceId: payload.workspaceId,
      lockdownRoleId: maybeConfig.value.roleId.value,
      monitorRoleIds: monitorRoles.map(({ roleId }) => roleId),
    }),
  );
  return {
    workspaceId: payload.workspaceId,
    conversationId: payload.conversationId,
  };
});

export const undoWorkspaceConversationLockdown = Effect.fn(
  "WorkspaceConfigHttp.undoWorkspaceConversationLockdown",
)(function* <ChannelsError, ChannelsRequirements, ReplaceError, ReplaceRequirements>(
  payload: WorkspaceConversationLockdownPayload,
  ingressBotClient: LockdownBotClient<
    ChannelsError,
    ChannelsRequirements,
    ReplaceError,
    ReplaceRequirements
  >,
) {
  yield* ensureChannelInWorkspace(
    ingressBotClient,
    "undo",
    payload.workspaceId,
    payload.conversationId,
  );
  yield* ingressBotClient.replaceChannelPermissionOverwrites(payload.conversationId, []);
  return {
    workspaceId: payload.workspaceId,
    conversationId: payload.conversationId,
  };
});

export const workspaceConfigLayer = sheetApisGroupLayer(
  "workspaceConfig",
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const ingressBotClient = yield* IngressBotClient;
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
      "workspaceConfig.getWorkspaceMonitorRoles": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          yield* authorizationService.requireManageWorkspace(query.workspaceId);
          return yield* workspaceConfigService.getWorkspaceMonitorRoles(query.workspaceId);
        }),
      ),
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
      "workspaceConfig.getWorkspaceConversations": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          yield* authorizationService.requireManageWorkspace(query.workspaceId);
          return yield* workspaceConfigService.getWorkspaceConversations({
            workspaceId: query.workspaceId,
            ...optionalRunningFilter(query.running),
          });
        }),
      ),
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
      "workspaceConfig.setupWorkspaceConversationLockdown": withPayloadWorkspaceAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* Effect.annotateCurrentSpan({
            workspaceId: payload.workspaceId,
            conversationId: payload.conversationId,
          });
          yield* authorizationService.requireMonitorOrManageWorkspace(payload.workspaceId);
          return yield* setupWorkspaceConversationLockdown(
            payload,
            workspaceConfigService,
            ingressBotClient,
          );
        }),
      ),
      "workspaceConfig.undoWorkspaceConversationLockdown": withPayloadWorkspaceAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* Effect.annotateCurrentSpan({
            workspaceId: payload.workspaceId,
            conversationId: payload.conversationId,
          });
          yield* authorizationService.requireMonitorOrManageWorkspace(payload.workspaceId);
          return yield* undoWorkspaceConversationLockdown(payload, ingressBotClient);
        }),
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
).pipe(
  Layer.provide([AuthorizationService.layer, IngressBotClient.layer, WorkspaceConfigService.layer]),
);
