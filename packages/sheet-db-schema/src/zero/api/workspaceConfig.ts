import { Option, Predicate, Schema } from "effect";
import { ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import {
  TeamSubmissionRemovedRowStrategy,
  TeamSubmissionWriteMode,
} from "../../teamSubmissionChannelConfig";
import { zeroTableAccess } from "../accessors";
import { activeRecord, preserveOmitted } from "../timestamps";
import type { SheetZeroApiSuccessSchemas } from "./successSchemas";

const updateAnnouncementDeliveryPendingConversationId = "__pending_update_announcement_delivery__";
const updateAnnouncementDeliveryClaimLeaseMs = 5 * 60 * 1000;

const hasActiveDelivery = <
  T extends {
    readonly deletedAt: unknown;
    readonly conversationId: string;
    readonly deliveredAt: Date | number;
  },
>(
  delivery: T | null | undefined,
  now: number,
) =>
  Option.match(Option.fromNullishOr(delivery), {
    onNone: () => false,
    onSome: (value) =>
      Predicate.isNullish(value.deletedAt) &&
      (value.conversationId !== updateAnnouncementDeliveryPendingConversationId ||
        new Date(value.deliveredAt).getTime() + updateAnnouncementDeliveryClaimLeaseMs > now),
  });

const hasDeletedDelivery = <T extends { readonly deletedAt: unknown }>(
  delivery: T | null | undefined,
) =>
  Option.match(Option.fromNullishOr(delivery), {
    onNone: () => false,
    onSome: (value) => Predicate.isNotNullish(value.deletedAt),
  });

const matchesPendingDeliveryClaim = <
  T extends {
    readonly deletedAt: unknown;
    readonly conversationId: string;
    readonly messageId: string;
  },
>(
  delivery: T | null | undefined,
  claimToken: string,
) =>
  Option.match(Option.fromNullishOr(delivery), {
    onNone: () => false,
    onSome: (value) =>
      [
        Predicate.isNullish(value.deletedAt),
        value.conversationId === updateAnnouncementDeliveryPendingConversationId,
        value.messageId === claimToken,
      ].every(Predicate.isTruthy),
  });

const withRunningFilter = <
  Query extends {
    where: (column: "running", operator: "=", value: boolean) => Query;
  },
>(
  query: Query,
  running: boolean | undefined,
) => (Predicate.isUndefined(running) ? query : query.where("running", "=", running));

const upsertRevivingSoftDeleted = async <Value>({
  insert,
  isDeleted,
  remove,
  upsert,
  value,
}: {
  readonly isDeleted: boolean;
  readonly remove: () => Promise<unknown>;
  readonly insert: (value: Value) => Promise<unknown>;
  readonly upsert: (value: Value) => Promise<unknown>;
  readonly value: Value;
}) => {
  if (isDeleted) {
    await remove();
    await insert(value);
    return;
  }
  await upsert(value);
};

export const makeWorkspaceConfigGroup = <const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
) =>
  ZeroApiGroup.make("workspaceConfig").add(
    ZeroApiEndpoint.query("getAutoCheckinWorkspaces", {
      request: Schema.Struct({}),
      success: success.workspaceConfig.getAutoCheckinWorkspaces,
      query: () =>
        zeroTableAccess.configWorkspace.listActiveWhere(
          zeroTableAccess.configWorkspace.table.where("autoCheckin", "=", true),
        ),
    }),
    ZeroApiEndpoint.query("getWorkspaceConfigByWorkspaceId", {
      request: Schema.Struct({ workspaceId: Schema.String }),
      success: success.workspaceConfig.getWorkspaceConfigByWorkspaceId,
      query: ({ args: { workspaceId } }) =>
        zeroTableAccess.configWorkspace.getActiveByPrimaryKey(
          zeroTableAccess.configWorkspace.table,
          {
            workspaceId,
          },
        ),
    }),
    ZeroApiEndpoint.query("getWorkspaceMonitorRoles", {
      request: Schema.Struct({ workspaceId: Schema.String }),
      success: success.workspaceConfig.getWorkspaceMonitorRoles,
      query: ({ args: { workspaceId } }) =>
        zeroTableAccess.configWorkspaceMonitorRole.listActiveWhere(
          zeroTableAccess.configWorkspaceMonitorRole.table.where("workspaceId", "=", workspaceId),
        ),
    }),
    ZeroApiEndpoint.query("getWorkspaceFeatureFlags", {
      request: Schema.Struct({ workspaceId: Schema.String }),
      success: success.workspaceConfig.getWorkspaceFeatureFlags,
      query: ({ args: { workspaceId } }) =>
        zeroTableAccess.configWorkspaceFeatureFlag.listActiveWhere(
          zeroTableAccess.configWorkspaceFeatureFlag.table.where("workspaceId", "=", workspaceId),
        ),
    }),
    ZeroApiEndpoint.query("getWorkspacesForFeatureFlag", {
      request: Schema.Struct({ flagName: Schema.String }),
      success: success.workspaceConfig.getWorkspacesForFeatureFlag,
      query: ({ args: { flagName } }) =>
        zeroTableAccess.configWorkspaceFeatureFlag.listActiveWhere(
          zeroTableAccess.configWorkspaceFeatureFlag.table.where("flagName", "=", flagName),
        ),
    }),
    ZeroApiEndpoint.query("getWorkspaceFeatureFlag", {
      request: Schema.Struct({ workspaceId: Schema.String, flagName: Schema.String }),
      success: success.workspaceConfig.getWorkspaceFeatureFlag,
      query: ({ args: { workspaceId, flagName } }) =>
        zeroTableAccess.configWorkspaceFeatureFlag.getActiveByPrimaryKey(
          zeroTableAccess.configWorkspaceFeatureFlag.table,
          { workspaceId, flagName },
        ),
    }),
    ZeroApiEndpoint.query("getWorkspaceUpdateAnnouncementDelivery", {
      request: Schema.Struct({ workspaceId: Schema.String, announcementId: Schema.String }),
      success: success.workspaceConfig.getWorkspaceUpdateAnnouncementDelivery,
      query: ({ args: { workspaceId, announcementId } }) =>
        zeroTableAccess.configWorkspaceUpdateAnnouncementDelivery.getActiveByPrimaryKey(
          zeroTableAccess.configWorkspaceUpdateAnnouncementDelivery.table,
          { workspaceId, announcementId },
        ),
    }),
    ZeroApiEndpoint.query("getWorkspaceConversations", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        running: Schema.optional(Schema.Boolean),
      }),
      success: success.workspaceConfig.getWorkspaceConversations,
      query: ({ args: { workspaceId, running } }) => {
        const query = zeroTableAccess.configWorkspaceConversation.listActiveWhere(
          zeroTableAccess.configWorkspaceConversation.table.where("workspaceId", "=", workspaceId),
        );

        return withRunningFilter(query, running);
      },
    }),
    ZeroApiEndpoint.query("getWorkspaceConversationById", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        conversationId: Schema.String,
        running: Schema.optional(Schema.Boolean),
      }),
      success: success.workspaceConfig.getWorkspaceConversationById,
      query: ({ args: { workspaceId, conversationId, running } }) => {
        const query = zeroTableAccess.configWorkspaceConversation.listActiveWhere(
          zeroTableAccess.configWorkspaceConversation.table
            .where("workspaceId", "=", workspaceId)
            .where("conversationId", "=", conversationId),
        );

        return withRunningFilter(query, running).one();
      },
    }),
    ZeroApiEndpoint.query("getWorkspaceConversationByName", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        conversationName: Schema.String,
        running: Schema.optional(Schema.Boolean),
      }),
      success: success.workspaceConfig.getWorkspaceConversationByName,
      query: ({ args: { workspaceId, conversationName, running } }) => {
        const query = zeroTableAccess.configWorkspaceConversation.listActiveWhere(
          zeroTableAccess.configWorkspaceConversation.table
            .where("workspaceId", "=", workspaceId)
            .where("name", "=", conversationName),
        );

        return withRunningFilter(query, running).one();
      },
    }),
    ZeroApiEndpoint.query("getTeamSubmissionChannelByConversationId", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        conversationId: Schema.String,
      }),
      success: success.workspaceConfig.getTeamSubmissionChannelByConversationId,
      query: ({ args: { workspaceId, conversationId } }) =>
        zeroTableAccess.configWorkspaceTeamSubmissionChannel.getActiveByPrimaryKey(
          zeroTableAccess.configWorkspaceTeamSubmissionChannel.table,
          { workspaceId, conversationId },
        ),
    }),
    ZeroApiEndpoint.query("getTeamSubmissionChannelsForWorkspace", {
      request: Schema.Struct({ workspaceId: Schema.String }),
      success: success.workspaceConfig.getTeamSubmissionChannelsForWorkspace,
      query: ({ args: { workspaceId } }) =>
        zeroTableAccess.configWorkspaceTeamSubmissionChannel.listActiveWhere(
          zeroTableAccess.configWorkspaceTeamSubmissionChannel.table.where(
            "workspaceId",
            "=",
            workspaceId,
          ),
        ),
    }),
    ZeroApiEndpoint.mutator("upsertWorkspaceConfig", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        sheetId: Schema.optional(Schema.NullOr(Schema.String)),
        autoCheckin: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
      mutator: async ({ tx, args }) => {
        const existingConfigWorkspace = await tx.run(
          zeroTableAccess.configWorkspace.table.where("workspaceId", "=", args.workspaceId).one(),
        );
        const activeExistingConfigWorkspace = activeRecord(existingConfigWorkspace);

        await tx.mutate.configWorkspace.upsert(
          zeroTableAccess.configWorkspace.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              sheetId: preserveOmitted(args.sheetId, activeExistingConfigWorkspace?.sheetId),
              autoCheckin: preserveOmitted(
                args.autoCheckin,
                activeExistingConfigWorkspace?.autoCheckin,
              ),
              deletedAt: null,
            },
            activeExistingConfigWorkspace,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("addWorkspaceMonitorRole", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        roleId: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const existingRole = await tx.run(
          zeroTableAccess.configWorkspaceMonitorRole.table
            .where("workspaceId", "=", args.workspaceId)
            .where("roleId", "=", args.roleId)
            .one(),
        );

        await tx.mutate.configWorkspaceMonitorRole.upsert(
          zeroTableAccess.configWorkspaceMonitorRole.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              roleId: args.roleId,
              deletedAt: null,
            },
            existingRole,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("removeWorkspaceMonitorRole", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        roleId: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.configWorkspaceMonitorRole.update(
          zeroTableAccess.configWorkspaceMonitorRole.softDeleteByPrimaryKey({
            workspaceId: args.workspaceId,
            roleId: args.roleId,
          }),
        ),
    }),
    ZeroApiEndpoint.mutator("addWorkspaceFeatureFlag", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        flagName: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const existingFlag = await tx.run(
          zeroTableAccess.configWorkspaceFeatureFlag.table
            .where("workspaceId", "=", args.workspaceId)
            .where("flagName", "=", args.flagName)
            .one(),
        );

        const value = zeroTableAccess.configWorkspaceFeatureFlag.upsertWithTimestamps(
          {
            workspaceId: args.workspaceId,
            flagName: args.flagName,
          },
          existingFlag,
        );

        await upsertRevivingSoftDeleted({
          isDeleted: Predicate.isNotNullish(existingFlag?.deletedAt),
          remove: () =>
            tx.mutate.configWorkspaceFeatureFlag.delete({
              workspaceId: args.workspaceId,
              flagName: args.flagName,
            }),
          insert: tx.mutate.configWorkspaceFeatureFlag.insert,
          upsert: tx.mutate.configWorkspaceFeatureFlag.upsert,
          value,
        });
      },
    }),
    ZeroApiEndpoint.mutator("removeWorkspaceFeatureFlag", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        flagName: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.configWorkspaceFeatureFlag.update(
          zeroTableAccess.configWorkspaceFeatureFlag.softDeleteByPrimaryKey({
            workspaceId: args.workspaceId,
            flagName: args.flagName,
          }),
        ),
    }),
    ZeroApiEndpoint.mutator("recordWorkspaceUpdateAnnouncementDelivery", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        announcementId: Schema.String,
        publishedAt: Schema.Number,
        deliveredAt: Schema.Number,
        conversationId: Schema.String,
        messageId: Schema.String,
        claimToken: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const existingDelivery = await tx.run(
          zeroTableAccess.configWorkspaceUpdateAnnouncementDelivery.table
            .where("workspaceId", "=", args.workspaceId)
            .where("announcementId", "=", args.announcementId)
            .one(),
        );

        if (!matchesPendingDeliveryClaim(existingDelivery, args.claimToken)) {
          return undefined;
        }

        await tx.mutate.configWorkspaceUpdateAnnouncementDelivery.upsert(
          zeroTableAccess.configWorkspaceUpdateAnnouncementDelivery.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              announcementId: args.announcementId,
              publishedAt: args.publishedAt,
              deliveredAt: args.deliveredAt,
              conversationId: args.conversationId,
              messageId: args.messageId,
              deletedAt: null,
            },
            existingDelivery,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("claimWorkspaceUpdateAnnouncementDelivery", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        announcementId: Schema.String,
        publishedAt: Schema.Number,
        claimToken: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const existingDelivery = await tx.run(
          zeroTableAccess.configWorkspaceUpdateAnnouncementDelivery.table
            .where("workspaceId", "=", args.workspaceId)
            .where("announcementId", "=", args.announcementId)
            .one(),
        );

        if (hasActiveDelivery(existingDelivery, Date.now())) {
          return;
        }

        const value =
          zeroTableAccess.configWorkspaceUpdateAnnouncementDelivery.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              announcementId: args.announcementId,
              publishedAt: args.publishedAt,
              deliveredAt: Date.now(),
              conversationId: updateAnnouncementDeliveryPendingConversationId,
              messageId: args.claimToken,
              deletedAt: null,
            },
            existingDelivery,
          );

        await upsertRevivingSoftDeleted({
          isDeleted: hasDeletedDelivery(existingDelivery),
          remove: () =>
            tx.mutate.configWorkspaceUpdateAnnouncementDelivery.delete({
              workspaceId: args.workspaceId,
              announcementId: args.announcementId,
            }),
          insert: tx.mutate.configWorkspaceUpdateAnnouncementDelivery.insert,
          upsert: tx.mutate.configWorkspaceUpdateAnnouncementDelivery.upsert,
          value,
        });
      },
    }),
    ZeroApiEndpoint.mutator("releaseWorkspaceUpdateAnnouncementDeliveryClaim", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        announcementId: Schema.String,
        claimToken: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const existingDelivery = await tx.run(
          zeroTableAccess.configWorkspaceUpdateAnnouncementDelivery.table
            .where("workspaceId", "=", args.workspaceId)
            .where("announcementId", "=", args.announcementId)
            .one(),
        );

        if (matchesPendingDeliveryClaim(existingDelivery, args.claimToken)) {
          await tx.mutate.configWorkspaceUpdateAnnouncementDelivery.update(
            zeroTableAccess.configWorkspaceUpdateAnnouncementDelivery.softDeleteByPrimaryKey({
              workspaceId: args.workspaceId,
              announcementId: args.announcementId,
            }),
          );
        }
      },
    }),
    ZeroApiEndpoint.mutator("upsertWorkspaceConversationConfig", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        conversationId: Schema.String,
        name: Schema.optional(Schema.NullOr(Schema.String)),
        running: Schema.optional(Schema.NullOr(Schema.Boolean)),
        roleId: Schema.optional(Schema.NullOr(Schema.String)),
        checkinConversationId: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      mutator: async ({ tx, args }) => {
        const existingConversation = await tx.run(
          zeroTableAccess.configWorkspaceConversation.table
            .where("workspaceId", "=", args.workspaceId)
            .where("conversationId", "=", args.conversationId)
            .one(),
        );
        const activeExistingConversation = activeRecord(existingConversation);
        const existingValues = activeExistingConversation ?? {
          name: undefined,
          running: undefined,
          roleId: undefined,
          checkinConversationId: undefined,
        };

        await tx.mutate.configWorkspaceConversation.upsert(
          zeroTableAccess.configWorkspaceConversation.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              conversationId: args.conversationId,
              name: preserveOmitted(args.name, existingValues.name),
              running: preserveOmitted(args.running, existingValues.running),
              roleId: preserveOmitted(args.roleId, existingValues.roleId),
              checkinConversationId: preserveOmitted(
                args.checkinConversationId,
                existingValues.checkinConversationId,
              ),
              deletedAt: null,
            },
            activeExistingConversation,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("upsertTeamSubmissionChannel", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        conversationId: Schema.String,
        destinationTeamConfigName: Schema.optional(Schema.NullOr(Schema.String)),
        writeMode: TeamSubmissionWriteMode,
        removedRowStrategy: TeamSubmissionRemovedRowStrategy,
        requireValidOshi: Schema.optional(Schema.Boolean),
      }),
      mutator: async ({ tx, args }) => {
        const existingChannel = await tx.run(
          zeroTableAccess.configWorkspaceTeamSubmissionChannel.table
            .where("workspaceId", "=", args.workspaceId)
            .where("conversationId", "=", args.conversationId)
            .one(),
        );
        const activeExistingChannel = activeRecord(existingChannel);

        await tx.mutate.configWorkspaceTeamSubmissionChannel.upsert(
          zeroTableAccess.configWorkspaceTeamSubmissionChannel.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              conversationId: args.conversationId,
              destinationTeamConfigName: preserveOmitted(
                args.destinationTeamConfigName,
                activeExistingChannel?.destinationTeamConfigName,
              ),
              writeMode: args.writeMode,
              removedRowStrategy: args.removedRowStrategy,
              requireValidOshi:
                preserveOmitted(args.requireValidOshi, activeExistingChannel?.requireValidOshi) ??
                false,
              deletedAt: null,
            },
            activeExistingChannel,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("removeTeamSubmissionChannel", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        conversationId: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.configWorkspaceTeamSubmissionChannel.update(
          zeroTableAccess.configWorkspaceTeamSubmissionChannel.softDeleteByPrimaryKey({
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
          }),
        ),
    }),
  );

export type WorkspaceConfigGroup<SuccessSchemas extends SheetZeroApiSuccessSchemas> = ReturnType<
  typeof makeWorkspaceConfigGroup<SuccessSchemas>
>;
