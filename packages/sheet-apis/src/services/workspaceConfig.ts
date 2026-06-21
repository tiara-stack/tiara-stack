import { Array, DateTime, Effect, Layer, Option, Context, Predicate } from "effect";
import { makeArgumentError, makeDBQueryError } from "typhoon-core/error";
import { SheetZeroClient } from "./sheetZeroClient";

const updateAnnouncementDeliveryPendingConversationId = "__pending_update_announcement_delivery__";

const optionalRunningFilter = (running: boolean | undefined) =>
  Predicate.isUndefined(running) ? {} : { running };

const normalizeFeatureFlagName = (flagName: string) => {
  const normalized = flagName.trim();
  return normalized.length > 0
    ? Effect.succeed(normalized)
    : Effect.fail(makeArgumentError("Feature flag name cannot be empty"));
};

export class WorkspaceConfigService extends Context.Service<WorkspaceConfigService>()(
  "WorkspaceConfigService",
  {
    make: Effect.gen(function* () {
      const zero = yield* SheetZeroClient;

      return {
        getAutoCheckinWorkspaces: Effect.fn("WorkspaceConfigService.getAutoCheckinWorkspaces")(
          function* () {
            return yield* zero.workspaceConfig.getAutoCheckinWorkspaces({});
          },
        ),
        getWorkspaceConfig: Effect.fn("WorkspaceConfigService.getWorkspaceConfig")(function* (
          workspaceId: string,
        ) {
          return yield* zero.workspaceConfig.getWorkspaceConfigByWorkspaceId({ workspaceId });
        }),
        upsertWorkspaceConfig: Effect.fn("WorkspaceConfigService.upsertWorkspaceConfig")(function* (
          workspaceId: string,
          config: {
            sheetId?: string | null | undefined;
            autoCheckin?: boolean | null | undefined;
          },
        ) {
          yield* zero.workspaceConfig.upsertWorkspaceConfig({ workspaceId, ...config });
          const workspaceConfig = yield* zero.workspaceConfig.getWorkspaceConfigByWorkspaceId({
            workspaceId,
          });

          if (Option.isNone(workspaceConfig)) {
            return yield* Effect.die(makeDBQueryError("Failed to upsert workspace config"));
          }

          return workspaceConfig.value;
        }),
        getWorkspaceMonitorRoles: Effect.fn("WorkspaceConfigService.getWorkspaceMonitorRoles")(
          function* (workspaceId: string) {
            return yield* zero.workspaceConfig.getWorkspaceMonitorRoles({ workspaceId });
          },
        ),
        getWorkspaceFeatureFlags: Effect.fn("WorkspaceConfigService.getWorkspaceFeatureFlags")(
          function* (workspaceId: string) {
            return yield* zero.workspaceConfig.getWorkspaceFeatureFlags({ workspaceId });
          },
        ),
        getWorkspacesForFeatureFlag: Effect.fn(
          "WorkspaceConfigService.getWorkspacesForFeatureFlag",
        )(function* (flagName: string) {
          const normalizedFlagName = yield* normalizeFeatureFlagName(flagName);
          return yield* zero.workspaceConfig.getWorkspacesForFeatureFlag({
            flagName: normalizedFlagName,
          });
        }),
        getWorkspaceFeatureFlag: Effect.fn("WorkspaceConfigService.getWorkspaceFeatureFlag")(
          function* (workspaceId: string, flagName: string) {
            const normalizedFlagName = yield* normalizeFeatureFlagName(flagName);
            return yield* zero.workspaceConfig.getWorkspaceFeatureFlag({
              workspaceId,
              flagName: normalizedFlagName,
            });
          },
        ),
        getWorkspaceUpdateAnnouncementDelivery: Effect.fn(
          "WorkspaceConfigService.getWorkspaceUpdateAnnouncementDelivery",
        )(function* (workspaceId: string, announcementId: string) {
          return yield* zero.workspaceConfig.getWorkspaceUpdateAnnouncementDelivery({
            workspaceId,
            announcementId,
          });
        }),
        getWorkspaceConversations: Effect.fn("WorkspaceConfigService.getWorkspaceConversations")(
          function* (params: { workspaceId: string; running?: boolean | undefined }) {
            return yield* zero.workspaceConfig.getWorkspaceConversations({
              workspaceId: params.workspaceId,
              ...optionalRunningFilter(params.running),
            });
          },
        ),
        addWorkspaceMonitorRole: Effect.fn("WorkspaceConfigService.addWorkspaceMonitorRole")(
          function* (workspaceId: string, roleId: string) {
            yield* zero.workspaceConfig.addWorkspaceMonitorRole({ workspaceId, roleId });
            const roles = yield* zero.workspaceConfig.getWorkspaceMonitorRoles({ workspaceId });
            const role = Array.findFirst(roles, (item) => item.roleId === roleId);

            if (Option.isNone(role)) {
              return yield* Effect.die(makeDBQueryError("Failed to add workspace monitor role"));
            }

            return role.value;
          },
        ),
        removeWorkspaceMonitorRole: Effect.fn("WorkspaceConfigService.removeWorkspaceMonitorRole")(
          function* (workspaceId: string, roleId: string) {
            const roles = yield* zero.workspaceConfig.getWorkspaceMonitorRoles({ workspaceId });
            const role = Array.findFirst(roles, (item) => item.roleId === roleId);

            if (Option.isNone(role)) {
              return yield* Effect.fail(
                makeArgumentError(
                  `Monitor role "${roleId}" is not enabled for workspace ${workspaceId}`,
                ),
              );
            }

            yield* zero.workspaceConfig.removeWorkspaceMonitorRole({ workspaceId, roleId });
            return role.value;
          },
        ),
        addWorkspaceFeatureFlag: Effect.fn("WorkspaceConfigService.addWorkspaceFeatureFlag")(
          function* (workspaceId: string, flagName: string) {
            const normalizedFlagName = yield* normalizeFeatureFlagName(flagName);
            yield* zero.workspaceConfig.addWorkspaceFeatureFlag({
              workspaceId,
              flagName: normalizedFlagName,
            });
            const flag = yield* zero.workspaceConfig.getWorkspaceFeatureFlag({
              workspaceId,
              flagName: normalizedFlagName,
            });

            if (Option.isNone(flag)) {
              return yield* Effect.die(makeDBQueryError("Failed to add workspace feature flag"));
            }

            return flag.value;
          },
        ),
        removeWorkspaceFeatureFlag: Effect.fn("WorkspaceConfigService.removeWorkspaceFeatureFlag")(
          function* (workspaceId: string, flagName: string) {
            const normalizedFlagName = yield* normalizeFeatureFlagName(flagName);
            const flag = yield* zero.workspaceConfig.getWorkspaceFeatureFlag({
              workspaceId,
              flagName: normalizedFlagName,
            });

            if (Option.isNone(flag)) {
              return yield* Effect.fail(
                makeArgumentError(
                  `Feature flag "${flagName}" (normalized: "${normalizedFlagName}") is not enabled for workspace ${workspaceId}`,
                ),
              );
            }

            yield* zero.workspaceConfig.removeWorkspaceFeatureFlag({
              workspaceId,
              flagName: normalizedFlagName,
            });

            return flag.value;
          },
        ),
        recordWorkspaceUpdateAnnouncementDelivery: Effect.fn(
          "WorkspaceConfigService.recordWorkspaceUpdateAnnouncementDelivery",
        )(function* (delivery: {
          readonly workspaceId: string;
          readonly announcementId: string;
          readonly publishedAt: DateTime.Utc;
          readonly deliveredAt: DateTime.Utc;
          readonly conversationId: string;
          readonly messageId: string;
        }) {
          yield* zero.workspaceConfig.recordWorkspaceUpdateAnnouncementDelivery({
            ...delivery,
            publishedAt: DateTime.toEpochMillis(delivery.publishedAt),
            deliveredAt: DateTime.toEpochMillis(delivery.deliveredAt),
          });
          const recordedDelivery =
            yield* zero.workspaceConfig.getWorkspaceUpdateAnnouncementDelivery({
              workspaceId: delivery.workspaceId,
              announcementId: delivery.announcementId,
            });

          if (Option.isNone(recordedDelivery)) {
            return yield* Effect.die(
              makeDBQueryError("Failed to record workspace update announcement delivery"),
            );
          }

          return recordedDelivery.value;
        }),
        claimWorkspaceUpdateAnnouncementDelivery: Effect.fn(
          "WorkspaceConfigService.claimWorkspaceUpdateAnnouncementDelivery",
        )(function* (claim: {
          readonly workspaceId: string;
          readonly announcementId: string;
          readonly publishedAt: DateTime.Utc;
          readonly claimToken: string;
        }) {
          yield* zero.workspaceConfig.claimWorkspaceUpdateAnnouncementDelivery({
            ...claim,
            publishedAt: DateTime.toEpochMillis(claim.publishedAt),
          });

          const delivery = yield* zero.workspaceConfig.getWorkspaceUpdateAnnouncementDelivery({
            workspaceId: claim.workspaceId,
            announcementId: claim.announcementId,
          });

          if (Option.isNone(delivery)) {
            return yield* Effect.die(
              makeDBQueryError("Failed to claim workspace update announcement delivery"),
            );
          }

          if (delivery.value.conversationId === updateAnnouncementDeliveryPendingConversationId) {
            return {
              status: delivery.value.messageId === claim.claimToken ? "claimed" : "already_claimed",
              delivery,
            } as const;
          }

          return {
            status: "already_delivered",
            delivery,
          } as const;
        }),
        releaseWorkspaceUpdateAnnouncementDeliveryClaim: Effect.fn(
          "WorkspaceConfigService.releaseWorkspaceUpdateAnnouncementDeliveryClaim",
        )(function* (claim: {
          readonly workspaceId: string;
          readonly announcementId: string;
          readonly claimToken: string;
        }) {
          return yield* zero.workspaceConfig.releaseWorkspaceUpdateAnnouncementDeliveryClaim(claim);
        }),
        upsertWorkspaceConversationConfig: Effect.fn(
          "WorkspaceConfigService.upsertWorkspaceConversationConfig",
        )(function* (
          workspaceId: string,
          conversationId: string,
          config: {
            name?: string | null | undefined;
            running?: boolean | null | undefined;
            roleId?: string | null | undefined;
            checkinConversationId?: string | null | undefined;
          },
        ) {
          yield* zero.workspaceConfig.upsertWorkspaceConversationConfig({
            workspaceId,
            conversationId,
            name: config.name,
            running: config.running,
            roleId: config.roleId,
            checkinConversationId: config.checkinConversationId,
          });
          const conversation = yield* zero.workspaceConfig.getWorkspaceConversationById({
            workspaceId,
            conversationId,
          });

          if (Option.isNone(conversation)) {
            return yield* Effect.die(
              makeDBQueryError("Failed to upsert workspace conversation config"),
            );
          }

          return conversation.value;
        }),
        getWorkspaceConversationById: Effect.fn(
          "WorkspaceConfigService.getWorkspaceConversationById",
        )(function* (params: {
          workspaceId: string;
          conversationId: string;
          running?: boolean | undefined;
        }) {
          return yield* zero.workspaceConfig.getWorkspaceConversationById({
            workspaceId: params.workspaceId,
            conversationId: params.conversationId,
            ...optionalRunningFilter(params.running),
          });
        }),
        getWorkspaceConversationByName: Effect.fn(
          "WorkspaceConfigService.getWorkspaceConversationByName",
        )(function* (params: {
          workspaceId: string;
          conversationName: string;
          running?: boolean | undefined;
        }) {
          return yield* zero.workspaceConfig.getWorkspaceConversationByName({
            workspaceId: params.workspaceId,
            conversationName: params.conversationName,
            ...optionalRunningFilter(params.running),
          });
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(WorkspaceConfigService, this.make).pipe(
    Layer.provide(SheetZeroClient.layer),
  );
}
