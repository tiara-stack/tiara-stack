// fallow-ignore-file complexity
import { Predicate, Schema } from "effect";
import { ReadonlyJSONValue } from "typhoon-zero/schema";
import { make, ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import { zeroTableAccess } from "./accessors";
import {
  hasActiveSendClaim,
  hasActiveTentativePinClaim,
  hasActiveTentativeUpdateClaim,
  hasStaleUntrackedSendClaim,
  isActiveSendClaim,
} from "./claimHelpers";
import { builder, type Schema as ZeroSchema } from "./schema";
import { preserveOmitted } from "./timestamps";

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    schema: ZeroSchema;
  }
}

export interface SheetZeroApiSuccessSchemas {
  readonly userConfig: {
    readonly getUserPlatformConfig: Schema.Top;
    readonly getCheckinDmEnabledUserConfigs: Schema.Top;
  };
  readonly workspaceConfig: {
    readonly getAutoCheckinWorkspaces: Schema.Top;
    readonly getWorkspaceConfigByWorkspaceId: Schema.Top;
    readonly getWorkspaceMonitorRoles: Schema.Top;
    readonly getWorkspaceFeatureFlags: Schema.Top;
    readonly getWorkspacesForFeatureFlag: Schema.Top;
    readonly getWorkspaceFeatureFlag: Schema.Top;
    readonly getWorkspaceUpdateAnnouncementDelivery: Schema.Top;
    readonly getWorkspaceConversations: Schema.Top;
    readonly getWorkspaceConversationById: Schema.Top;
    readonly getWorkspaceConversationByName: Schema.Top;
  };
  readonly messageCheckin: {
    readonly getMessageCheckinData: Schema.Top;
    readonly getMessageCheckinMembers: Schema.Top;
  };
  readonly messageRoomOrder: {
    readonly getMessageRoomOrder: Schema.Top;
    readonly getMessageRoomOrderEntry: Schema.Top;
    readonly getMessageRoomOrderRange: Schema.Top;
  };
  readonly messageSlot: {
    readonly getMessageSlotData: Schema.Top;
  };
}

const defaultSuccessSchemas = {
  userConfig: {
    getUserPlatformConfig: Schema.Any,
    getCheckinDmEnabledUserConfigs: Schema.Any,
  },
  workspaceConfig: {
    getAutoCheckinWorkspaces: Schema.Any,
    getWorkspaceConfigByWorkspaceId: Schema.Any,
    getWorkspaceMonitorRoles: Schema.Any,
    getWorkspaceFeatureFlags: Schema.Any,
    getWorkspacesForFeatureFlag: Schema.Any,
    getWorkspaceFeatureFlag: Schema.Any,
    getWorkspaceUpdateAnnouncementDelivery: Schema.Any,
    getWorkspaceConversations: Schema.Any,
    getWorkspaceConversationById: Schema.Any,
    getWorkspaceConversationByName: Schema.Any,
  },
  messageCheckin: {
    getMessageCheckinData: Schema.Any,
    getMessageCheckinMembers: Schema.Any,
  },
  messageRoomOrder: {
    getMessageRoomOrder: Schema.Any,
    getMessageRoomOrderEntry: Schema.Any,
    getMessageRoomOrderRange: Schema.Any,
  },
  messageSlot: {
    getMessageSlotData: Schema.Any,
  },
} satisfies SheetZeroApiSuccessSchemas;

const updateAnnouncementDeliveryPendingConversationId = "__pending_update_announcement_delivery__";

const MessageKeyRequest = {
  clientPlatform: Schema.String,
  clientId: Schema.String,
  messageId: Schema.String,
} as const;

const makeSheetZeroApiWithSuccess = <const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
) => {
  const UserConfigGroup = ZeroApiGroup.make("userConfig").add(
    ZeroApiEndpoint.query("getUserPlatformConfig", {
      request: Schema.Struct({
        platform: Schema.String,
        userId: Schema.String,
      }),
      success: success.userConfig.getUserPlatformConfig,
      query: ({ args: { platform, userId } }) =>
        zeroTableAccess.configUserPlatform.getActiveByPrimaryKey(builder.configUserPlatform, {
          platform,
          userId,
        }),
    }),
    ZeroApiEndpoint.query("getCheckinDmEnabledUserConfigs", {
      request: Schema.Struct({
        platform: Schema.String,
        userIds: Schema.Array(Schema.String),
      }),
      success: success.userConfig.getCheckinDmEnabledUserConfigs,
      query: ({ args: { platform, userIds } }) =>
        zeroTableAccess.configUserPlatform.listActiveWhere(
          builder.configUserPlatform
            .where("platform", "=", platform)
            .where("userId", "IN", userIds)
            .where("checkinDmEnabled", "=", true)
            .where("defaultClientId", "IS NOT", null),
        ),
    }),
    ZeroApiEndpoint.mutator("upsertUserPlatformConfig", {
      request: Schema.Struct({
        platform: Schema.String,
        userId: Schema.String,
        checkinDmEnabled: Schema.Boolean,
        defaultClientId: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      mutator: async ({ tx, args }) => {
        const existingConfig = await tx.run(
          builder.configUserPlatform
            .where("platform", "=", args.platform)
            .where("userId", "=", args.userId)
            .one(),
        );

        await tx.mutate.configUserPlatform.upsert(
          zeroTableAccess.configUserPlatform.upsertWithTimestamps(
            {
              platform: args.platform,
              userId: args.userId,
              checkinDmEnabled: args.checkinDmEnabled,
              defaultClientId: preserveOmitted(
                args.defaultClientId,
                existingConfig?.defaultClientId,
              ),
              deletedAt: null,
            },
            existingConfig,
          ),
        );
      },
    }),
  );

  const WorkspaceConfigGroup = ZeroApiGroup.make("workspaceConfig").add(
    ZeroApiEndpoint.query("getAutoCheckinWorkspaces", {
      request: Schema.Struct({}),
      success: success.workspaceConfig.getAutoCheckinWorkspaces,
      query: () =>
        zeroTableAccess.configWorkspace.listActiveWhere(
          builder.configWorkspace.where("autoCheckin", "=", true),
        ),
    }),
    ZeroApiEndpoint.query("getWorkspaceConfigByWorkspaceId", {
      request: Schema.Struct({ workspaceId: Schema.String }),
      success: success.workspaceConfig.getWorkspaceConfigByWorkspaceId,
      query: ({ args: { workspaceId } }) =>
        zeroTableAccess.configWorkspace.getActiveByPrimaryKey(builder.configWorkspace, {
          workspaceId,
        }),
    }),
    ZeroApiEndpoint.query("getWorkspaceMonitorRoles", {
      request: Schema.Struct({ workspaceId: Schema.String }),
      success: success.workspaceConfig.getWorkspaceMonitorRoles,
      query: ({ args: { workspaceId } }) =>
        zeroTableAccess.configWorkspaceMonitorRole.listActiveWhere(
          builder.configWorkspaceMonitorRole.where("workspaceId", "=", workspaceId),
        ),
    }),
    ZeroApiEndpoint.query("getWorkspaceFeatureFlags", {
      request: Schema.Struct({ workspaceId: Schema.String }),
      success: success.workspaceConfig.getWorkspaceFeatureFlags,
      query: ({ args: { workspaceId } }) =>
        zeroTableAccess.configWorkspaceFeatureFlag.listActiveWhere(
          builder.configWorkspaceFeatureFlag.where("workspaceId", "=", workspaceId),
        ),
    }),
    ZeroApiEndpoint.query("getWorkspacesForFeatureFlag", {
      request: Schema.Struct({ flagName: Schema.String }),
      success: success.workspaceConfig.getWorkspacesForFeatureFlag,
      query: ({ args: { flagName } }) =>
        zeroTableAccess.configWorkspaceFeatureFlag.listActiveWhere(
          builder.configWorkspaceFeatureFlag.where("flagName", "=", flagName),
        ),
    }),
    ZeroApiEndpoint.query("getWorkspaceFeatureFlag", {
      request: Schema.Struct({ workspaceId: Schema.String, flagName: Schema.String }),
      success: success.workspaceConfig.getWorkspaceFeatureFlag,
      query: ({ args: { workspaceId, flagName } }) =>
        zeroTableAccess.configWorkspaceFeatureFlag.getActiveByPrimaryKey(
          builder.configWorkspaceFeatureFlag,
          { workspaceId, flagName },
        ),
    }),
    ZeroApiEndpoint.query("getWorkspaceUpdateAnnouncementDelivery", {
      request: Schema.Struct({ workspaceId: Schema.String, announcementId: Schema.String }),
      success: success.workspaceConfig.getWorkspaceUpdateAnnouncementDelivery,
      query: ({ args: { workspaceId, announcementId } }) =>
        zeroTableAccess.configWorkspaceUpdateAnnouncementDelivery.getActiveByPrimaryKey(
          builder.configWorkspaceUpdateAnnouncementDelivery,
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
          builder.configWorkspaceConversation.where("workspaceId", "=", workspaceId),
        );

        return Predicate.isUndefined(running) ? query : query.where("running", "=", running);
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
          builder.configWorkspaceConversation
            .where("workspaceId", "=", workspaceId)
            .where("conversationId", "=", conversationId),
        );

        return (
          Predicate.isUndefined(running) ? query : query.where("running", "=", running)
        ).one();
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
          builder.configWorkspaceConversation
            .where("workspaceId", "=", workspaceId)
            .where("name", "=", conversationName),
        );

        return (
          Predicate.isUndefined(running) ? query : query.where("running", "=", running)
        ).one();
      },
    }),
    ZeroApiEndpoint.mutator("upsertWorkspaceConfig", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        sheetId: Schema.optional(Schema.NullOr(Schema.String)),
        autoCheckin: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
      mutator: async ({ tx, args }) => {
        const existingConfigWorkspace = await tx.run(
          builder.configWorkspace.where("workspaceId", "=", args.workspaceId).one(),
        );

        await tx.mutate.configWorkspace.upsert(
          zeroTableAccess.configWorkspace.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              sheetId: preserveOmitted(args.sheetId, existingConfigWorkspace?.sheetId),
              autoCheckin: preserveOmitted(args.autoCheckin, existingConfigWorkspace?.autoCheckin),
              deletedAt: null,
            },
            existingConfigWorkspace,
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
          builder.configWorkspaceMonitorRole
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
          builder.configWorkspaceFeatureFlag
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

        if (Predicate.isNotNullish(existingFlag?.deletedAt)) {
          await tx.mutate.configWorkspaceFeatureFlag.delete({
            workspaceId: args.workspaceId,
            flagName: args.flagName,
          });
          await tx.mutate.configWorkspaceFeatureFlag.insert(value);
          return;
        }

        await tx.mutate.configWorkspaceFeatureFlag.upsert(value);
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
      }),
      mutator: async ({ tx, args }) => {
        const existingDelivery = await tx.run(
          builder.configWorkspaceUpdateAnnouncementDelivery
            .where("workspaceId", "=", args.workspaceId)
            .where("announcementId", "=", args.announcementId)
            .one(),
        );

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
          builder.configWorkspaceUpdateAnnouncementDelivery
            .where("workspaceId", "=", args.workspaceId)
            .where("announcementId", "=", args.announcementId)
            .one(),
        );

        if (
          Predicate.isNotNullish(existingDelivery) &&
          Predicate.isNullish(existingDelivery.deletedAt)
        ) {
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

        if (Predicate.isNotNullish(existingDelivery?.deletedAt)) {
          await tx.mutate.configWorkspaceUpdateAnnouncementDelivery.delete({
            workspaceId: args.workspaceId,
            announcementId: args.announcementId,
          });
          await tx.mutate.configWorkspaceUpdateAnnouncementDelivery.insert(value);
          return;
        }

        await tx.mutate.configWorkspaceUpdateAnnouncementDelivery.insert(value);
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
          builder.configWorkspaceUpdateAnnouncementDelivery
            .where("workspaceId", "=", args.workspaceId)
            .where("announcementId", "=", args.announcementId)
            .one(),
        );

        if (
          Predicate.isNullish(existingDelivery?.deletedAt) &&
          existingDelivery?.conversationId === updateAnnouncementDeliveryPendingConversationId &&
          existingDelivery.messageId === args.claimToken
        ) {
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
          builder.configWorkspaceConversation
            .where("workspaceId", "=", args.workspaceId)
            .where("conversationId", "=", args.conversationId)
            .one(),
        );

        await tx.mutate.configWorkspaceConversation.upsert(
          zeroTableAccess.configWorkspaceConversation.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              conversationId: args.conversationId,
              name: preserveOmitted(args.name, existingConversation?.name),
              running: preserveOmitted(args.running, existingConversation?.running),
              roleId: preserveOmitted(args.roleId, existingConversation?.roleId),
              checkinConversationId: preserveOmitted(
                args.checkinConversationId,
                existingConversation?.checkinConversationId,
              ),
              deletedAt: null,
            },
            existingConversation,
          ),
        );
      },
    }),
  );

  const MessageCheckinGroup = ZeroApiGroup.make("messageCheckin").add(
    ZeroApiEndpoint.query("getMessageCheckinData", {
      request: Schema.Struct(MessageKeyRequest),
      success: success.messageCheckin.getMessageCheckinData,
      query: ({ args: { clientPlatform, clientId, messageId } }) =>
        zeroTableAccess.messageCheckin.getActiveByPrimaryKey(builder.messageCheckin, {
          clientPlatform,
          clientId,
          messageId,
        }),
    }),
    ZeroApiEndpoint.query("getMessageCheckinMembers", {
      request: Schema.Struct(MessageKeyRequest),
      success: success.messageCheckin.getMessageCheckinMembers,
      query: ({ args: { clientPlatform, clientId, messageId } }) =>
        zeroTableAccess.messageCheckinMember.listActiveWhere(
          builder.messageCheckinMember
            .where("clientPlatform", "=", clientPlatform)
            .where("clientId", "=", clientId)
            .where("messageId", "=", messageId),
        ),
    }),
    ZeroApiEndpoint.mutator("upsertMessageCheckinData", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        initialMessage: Schema.Array(ReadonlyJSONValue),
        hour: Schema.Number,
        runningConversationId: Schema.String,
        roleId: Schema.optional(Schema.NullOr(Schema.String)),
        workspaceId: Schema.NullOr(Schema.String),
        conversationId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        const existingCheckin = await tx.run(
          builder.messageCheckin
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .one(),
        );

        await tx.mutate.messageCheckin.upsert(
          zeroTableAccess.messageCheckin.upsertWithTimestamps(
            {
              clientPlatform: args.clientPlatform,
              clientId: args.clientId,
              messageId: args.messageId,
              initialMessage: args.initialMessage,
              hour: args.hour,
              runningConversationId: args.runningConversationId,
              roleId: args.roleId,
              workspaceId: args.workspaceId,
              conversationId: args.conversationId,
              createdByUserId: args.createdByUserId,
              deletedAt: null,
            },
            existingCheckin,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("addMessageCheckinMembers", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        memberIds: Schema.Array(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        await Promise.all(
          args.memberIds.map(async (memberId) => {
            const existingMember = await tx.run(
              builder.messageCheckinMember
                .where("clientPlatform", "=", args.clientPlatform)
                .where("clientId", "=", args.clientId)
                .where("messageId", "=", args.messageId)
                .where("memberId", "=", memberId)
                .one(),
            );

            return tx.mutate.messageCheckinMember.upsert(
              zeroTableAccess.messageCheckinMember.upsertWithTimestamps(
                {
                  clientPlatform: args.clientPlatform,
                  clientId: args.clientId,
                  messageId: args.messageId,
                  memberId,
                  checkinAt: null,
                  checkinClaimId: null,
                  deletedAt: null,
                },
                existingMember,
              ),
            );
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("persistMessageCheckin", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        data: Schema.Struct({
          initialMessage: Schema.Array(ReadonlyJSONValue),
          hour: Schema.Number,
          runningConversationId: Schema.String,
          roleId: Schema.optional(Schema.NullOr(Schema.String)),
          workspaceId: Schema.NullOr(Schema.String),
          conversationId: Schema.NullOr(Schema.String),
          createdByUserId: Schema.NullOr(Schema.String),
        }),
        memberIds: Schema.Array(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        const existingCheckin = await tx.run(
          builder.messageCheckin
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .one(),
        );

        await tx.mutate.messageCheckin.upsert(
          zeroTableAccess.messageCheckin.upsertWithTimestamps(
            {
              clientPlatform: args.clientPlatform,
              clientId: args.clientId,
              messageId: args.messageId,
              initialMessage: args.data.initialMessage,
              hour: args.data.hour,
              runningConversationId: args.data.runningConversationId,
              roleId: args.data.roleId,
              workspaceId: args.data.workspaceId,
              conversationId: args.data.conversationId,
              createdByUserId: args.data.createdByUserId,
              deletedAt: null,
            },
            existingCheckin,
          ),
        );

        await Promise.all(
          args.memberIds.map(async (memberId) => {
            const existingMember = await tx.run(
              builder.messageCheckinMember
                .where("clientPlatform", "=", args.clientPlatform)
                .where("clientId", "=", args.clientId)
                .where("messageId", "=", args.messageId)
                .where("memberId", "=", memberId)
                .one(),
            );

            return tx.mutate.messageCheckinMember.upsert(
              zeroTableAccess.messageCheckinMember.upsertWithTimestamps(
                {
                  clientPlatform: args.clientPlatform,
                  clientId: args.clientId,
                  messageId: args.messageId,
                  memberId,
                  checkinAt: null,
                  checkinClaimId: null,
                  deletedAt: null,
                },
                existingMember,
              ),
            );
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("setMessageCheckinMemberCheckinAt", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        memberId: Schema.String,
        checkinAt: Schema.Number,
        checkinClaimId: Schema.optional(Schema.String),
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageCheckinMember.update(
          zeroTableAccess.messageCheckinMember.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            memberId: args.memberId,
            checkinAt: args.checkinAt,
            checkinClaimId: args.checkinClaimId ?? null,
          }),
        ),
    }),
    ZeroApiEndpoint.mutator("setMessageCheckinMemberCheckinAtIfUnset", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        memberId: Schema.String,
        checkinAt: Schema.Number,
        checkinClaimId: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const member = await tx.run(
          zeroTableAccess.messageCheckinMember.getActiveByPrimaryKey(builder.messageCheckinMember, {
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            memberId: args.memberId,
          }),
        );
        if (Predicate.isNullish(member) || Predicate.isNotNull(member.checkinAt)) return;
        await tx.mutate.messageCheckinMember.update(
          zeroTableAccess.messageCheckinMember.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            memberId: args.memberId,
            checkinAt: args.checkinAt,
            checkinClaimId: args.checkinClaimId,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("removeMessageCheckinMember", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        memberId: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageCheckinMember.update(
          zeroTableAccess.messageCheckinMember.softDeleteByPrimaryKey({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            memberId: args.memberId,
          }),
        ),
    }),
  );

  const MessageRoomOrderGroup = ZeroApiGroup.make("messageRoomOrder").add(
    ZeroApiEndpoint.query("getMessageRoomOrder", {
      request: Schema.Struct(MessageKeyRequest),
      success: success.messageRoomOrder.getMessageRoomOrder,
      query: ({ args: { clientPlatform, clientId, messageId } }) =>
        zeroTableAccess.messageRoomOrder.getActiveByPrimaryKey(builder.messageRoomOrder, {
          clientPlatform,
          clientId,
          messageId,
        }),
    }),
    ZeroApiEndpoint.query("getMessageRoomOrderEntry", {
      request: Schema.Struct({ ...MessageKeyRequest, rank: Schema.Number }),
      success: success.messageRoomOrder.getMessageRoomOrderEntry,
      query: ({ args: { clientPlatform, clientId, messageId, rank } }) =>
        zeroTableAccess.messageRoomOrderEntry
          .listActiveWhere(
            builder.messageRoomOrderEntry
              .where("clientPlatform", "=", clientPlatform)
              .where("clientId", "=", clientId)
              .where("messageId", "=", messageId)
              .where("rank", "=", rank),
          )
          .orderBy("position", "asc"),
    }),
    ZeroApiEndpoint.query("getMessageRoomOrderRange", {
      request: Schema.Struct(MessageKeyRequest),
      success: success.messageRoomOrder.getMessageRoomOrderRange,
      query: ({ args: { clientPlatform, clientId, messageId } }) =>
        zeroTableAccess.messageRoomOrderEntry.listActiveWhere(
          builder.messageRoomOrderEntry
            .where("clientPlatform", "=", clientPlatform)
            .where("clientId", "=", clientId)
            .where("messageId", "=", messageId),
        ),
    }),
    ZeroApiEndpoint.mutator("decrementMessageRoomOrderRank", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        expectedRank: Schema.optional(Schema.Number),
        tentativeUpdateClaimId: Schema.optional(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        const now = Date.now();
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          Predicate.isNullish(messageRoomOrder) ||
          Predicate.isNotNull(messageRoomOrder.tentativePinnedAt) ||
          (args.expectedRank !== undefined && messageRoomOrder.rank !== args.expectedRank) ||
          hasActiveSendClaim(messageRoomOrder, now) ||
          (hasActiveTentativeUpdateClaim(messageRoomOrder, now) &&
            messageRoomOrder.tentativeUpdateClaimId !== args.tentativeUpdateClaimId) ||
          hasActiveTentativePinClaim(messageRoomOrder, now)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            rank: messageRoomOrder.rank - 1,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("incrementMessageRoomOrderRank", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        expectedRank: Schema.optional(Schema.Number),
        tentativeUpdateClaimId: Schema.optional(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        const now = Date.now();
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          Predicate.isNullish(messageRoomOrder) ||
          Predicate.isNotNull(messageRoomOrder.tentativePinnedAt) ||
          (args.expectedRank !== undefined && messageRoomOrder.rank !== args.expectedRank) ||
          hasActiveSendClaim(messageRoomOrder, now) ||
          (hasActiveTentativeUpdateClaim(messageRoomOrder, now) &&
            messageRoomOrder.tentativeUpdateClaimId !== args.tentativeUpdateClaimId) ||
          hasActiveTentativePinClaim(messageRoomOrder, now)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            rank: messageRoomOrder.rank + 1,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("claimMessageRoomOrderSend", {
      request: Schema.Struct({ ...MessageKeyRequest, claimId: Schema.String }),
      mutator: async ({ tx, args }) => {
        const now = Date.now();
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          Predicate.isNullish(messageRoomOrder) ||
          messageRoomOrder.sentMessageId ||
          Predicate.isNotNull(messageRoomOrder.tentativePinnedAt) ||
          isActiveSendClaim(messageRoomOrder.sendClaimId, messageRoomOrder.sendClaimedAt, now) ||
          hasActiveTentativeUpdateClaim(messageRoomOrder, now) ||
          hasActiveTentativePinClaim(messageRoomOrder, now)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            sendClaimId: args.claimId,
            sendClaimedAt: now,
            tentativeUpdateClaimId: null,
            tentativeUpdateClaimedAt: null,
            tentativePinClaimId: null,
            tentativePinClaimedAt: null,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("completeMessageRoomOrderSend", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        claimId: Schema.String,
        sentMessageId: Schema.String,
        sentConversationId: Schema.String,
        sentAt: Schema.Number,
      }),
      mutator: async ({ tx, args }) => {
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          Predicate.isNullish(messageRoomOrder) ||
          messageRoomOrder.sendClaimId !== args.claimId
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            sendClaimId: null,
            sendClaimedAt: null,
            sentMessageId: args.sentMessageId,
            sentConversationId: args.sentConversationId,
            sentAt: args.sentAt,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("releaseMessageRoomOrderSendClaim", {
      request: Schema.Struct({ ...MessageKeyRequest, claimId: Schema.String }),
      mutator: async ({ tx, args }) => {
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          Predicate.isNullish(messageRoomOrder) ||
          messageRoomOrder.sendClaimId !== args.claimId
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            sendClaimId: null,
            sendClaimedAt: null,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("claimMessageRoomOrderTentativeUpdate", {
      request: Schema.Struct({ ...MessageKeyRequest, claimId: Schema.String }),
      mutator: async ({ tx, args }) => {
        const now = Date.now();
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          Predicate.isNullish(messageRoomOrder) ||
          Predicate.isNotNull(messageRoomOrder.tentativePinnedAt) ||
          hasStaleUntrackedSendClaim(messageRoomOrder, now) ||
          isActiveSendClaim(messageRoomOrder.sendClaimId, messageRoomOrder.sendClaimedAt, now) ||
          hasActiveTentativePinClaim(messageRoomOrder, now) ||
          hasActiveTentativeUpdateClaim(messageRoomOrder, now)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            sendClaimId: null,
            sendClaimedAt: null,
            tentativeUpdateClaimId: args.claimId,
            tentativeUpdateClaimedAt: now,
            tentativePinClaimId: null,
            tentativePinClaimedAt: null,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("releaseMessageRoomOrderTentativeUpdateClaim", {
      request: Schema.Struct({ ...MessageKeyRequest, claimId: Schema.String }),
      mutator: async ({ tx, args }) => {
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          Predicate.isNullish(messageRoomOrder) ||
          messageRoomOrder.tentativeUpdateClaimId !== args.claimId
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            tentativeUpdateClaimId: null,
            tentativeUpdateClaimedAt: null,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("claimMessageRoomOrderTentativePin", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        claimId: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const now = Date.now();
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          Predicate.isNullish(messageRoomOrder) ||
          Predicate.isNotNull(messageRoomOrder.tentativePinnedAt) ||
          hasStaleUntrackedSendClaim(messageRoomOrder, now) ||
          isActiveSendClaim(messageRoomOrder.sendClaimId, messageRoomOrder.sendClaimedAt, now) ||
          hasActiveTentativePinClaim(messageRoomOrder, now) ||
          hasActiveTentativeUpdateClaim(messageRoomOrder, now)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            sendClaimId: null,
            sendClaimedAt: null,
            tentativePinClaimId: args.claimId,
            tentativePinClaimedAt: now,
            tentativeUpdateClaimId: null,
            tentativeUpdateClaimedAt: null,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("completeMessageRoomOrderTentativePin", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        claimId: Schema.String,
        pinnedAt: Schema.Number,
      }),
      mutator: async ({ tx, args }) => {
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          Predicate.isNullish(messageRoomOrder) ||
          Predicate.isNotNull(messageRoomOrder.tentativePinnedAt) ||
          messageRoomOrder.tentativePinClaimId !== args.claimId
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            tentativePinClaimId: null,
            tentativePinClaimedAt: null,
            tentativePinnedAt: args.pinnedAt,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("releaseMessageRoomOrderTentativePinClaim", {
      request: Schema.Struct({ ...MessageKeyRequest, claimId: Schema.String }),
      mutator: async ({ tx, args }) => {
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          Predicate.isNullish(messageRoomOrder) ||
          Predicate.isNotNull(messageRoomOrder.tentativePinnedAt) ||
          messageRoomOrder.tentativePinClaimId !== args.claimId
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            tentativePinClaimId: null,
            tentativePinClaimedAt: null,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("markMessageRoomOrderTentative", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        workspaceId: Schema.String,
        conversationId: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            tentative: true,
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
          }),
        ),
    }),
    ZeroApiEndpoint.mutator("upsertMessageRoomOrder", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        previousFills: Schema.Array(Schema.String),
        fills: Schema.Array(Schema.String),
        hour: Schema.Number,
        rank: Schema.Number,
        tentative: Schema.optional(Schema.Boolean),
        monitor: Schema.optional(Schema.NullOr(Schema.String)),
        workspaceId: Schema.NullOr(Schema.String),
        conversationId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        const existingMessageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .one(),
        );

        await tx.mutate.messageRoomOrder.upsert(
          zeroTableAccess.messageRoomOrder.upsertWithTimestamps(
            {
              clientPlatform: args.clientPlatform,
              clientId: args.clientId,
              messageId: args.messageId,
              previousFills: args.previousFills.slice(),
              fills: args.fills.slice(),
              hour: args.hour,
              rank: args.rank,
              tentative: args.tentative ?? existingMessageRoomOrder?.tentative ?? false,
              monitor: args.monitor,
              workspaceId: args.workspaceId,
              conversationId: args.conversationId,
              createdByUserId: args.createdByUserId,
              deletedAt: null,
            },
            existingMessageRoomOrder,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("persistMessageRoomOrder", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        data: Schema.Struct({
          previousFills: Schema.Array(Schema.String),
          fills: Schema.Array(Schema.String),
          hour: Schema.Number,
          rank: Schema.Number,
          tentative: Schema.optional(Schema.Boolean),
          monitor: Schema.optional(Schema.NullOr(Schema.String)),
          workspaceId: Schema.NullOr(Schema.String),
          conversationId: Schema.NullOr(Schema.String),
          createdByUserId: Schema.NullOr(Schema.String),
        }),
        entries: Schema.Array(
          Schema.Struct({
            rank: Schema.Number,
            position: Schema.Number,
            hour: Schema.Number,
            team: Schema.String,
            tags: Schema.Array(Schema.String),
            effectValue: Schema.Number,
          }),
        ),
      }),
      mutator: async ({ tx, args }) => {
        const existingMessageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .one(),
        );

        await tx.mutate.messageRoomOrder.upsert(
          zeroTableAccess.messageRoomOrder.upsertWithTimestamps(
            {
              clientPlatform: args.clientPlatform,
              clientId: args.clientId,
              messageId: args.messageId,
              previousFills: args.data.previousFills.slice(),
              fills: args.data.fills.slice(),
              hour: args.data.hour,
              rank: args.data.rank,
              tentative: args.data.tentative ?? existingMessageRoomOrder?.tentative ?? false,
              monitor: args.data.monitor,
              workspaceId: args.data.workspaceId,
              conversationId: args.data.conversationId,
              createdByUserId: args.data.createdByUserId,
              deletedAt: null,
            },
            existingMessageRoomOrder,
          ),
        );

        await Promise.all(
          args.entries.map(async (entry) => {
            const existingEntry = await tx.run(
              builder.messageRoomOrderEntry
                .where("clientPlatform", "=", args.clientPlatform)
                .where("clientId", "=", args.clientId)
                .where("messageId", "=", args.messageId)
                .where("rank", "=", entry.rank)
                .where("position", "=", entry.position)
                .one(),
            );

            return tx.mutate.messageRoomOrderEntry.upsert(
              zeroTableAccess.messageRoomOrderEntry.upsertWithTimestamps(
                {
                  clientPlatform: args.clientPlatform,
                  clientId: args.clientId,
                  messageId: args.messageId,
                  rank: entry.rank,
                  position: entry.position,
                  hour: entry.hour,
                  team: entry.team,
                  tags: entry.tags.slice(),
                  effectValue: entry.effectValue,
                  deletedAt: null,
                },
                existingEntry,
              ),
            );
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("upsertMessageRoomOrderEntry", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        entries: Schema.Array(
          Schema.Struct({
            rank: Schema.Number,
            position: Schema.Number,
            hour: Schema.Number,
            team: Schema.String,
            tags: Schema.Array(Schema.String),
            effectValue: Schema.Number,
          }),
        ),
      }),
      mutator: async ({ tx, args }) => {
        await Promise.all(
          args.entries.map(async (entry) => {
            const existingEntry = await tx.run(
              builder.messageRoomOrderEntry
                .where("clientPlatform", "=", args.clientPlatform)
                .where("clientId", "=", args.clientId)
                .where("messageId", "=", args.messageId)
                .where("rank", "=", entry.rank)
                .where("position", "=", entry.position)
                .one(),
            );

            return tx.mutate.messageRoomOrderEntry.upsert(
              zeroTableAccess.messageRoomOrderEntry.upsertWithTimestamps(
                {
                  clientPlatform: args.clientPlatform,
                  clientId: args.clientId,
                  messageId: args.messageId,
                  rank: entry.rank,
                  position: entry.position,
                  hour: entry.hour,
                  team: entry.team,
                  tags: entry.tags.slice(),
                  effectValue: entry.effectValue,
                  deletedAt: null,
                },
                existingEntry,
              ),
            );
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("removeMessageRoomOrderEntry", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        rank: Schema.Number,
        position: Schema.Number,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageRoomOrderEntry.update(
          zeroTableAccess.messageRoomOrderEntry.softDeleteByPrimaryKey({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            rank: args.rank,
            position: args.position,
          }),
        ),
    }),
  );

  const MessageSlotGroup = ZeroApiGroup.make("messageSlot").add(
    ZeroApiEndpoint.query("getMessageSlotData", {
      request: Schema.Struct(MessageKeyRequest),
      success: success.messageSlot.getMessageSlotData,
      query: ({ args: { clientPlatform, clientId, messageId } }) =>
        zeroTableAccess.messageSlot.getActiveByPrimaryKey(builder.messageSlot, {
          clientPlatform,
          clientId,
          messageId,
        }),
    }),
    ZeroApiEndpoint.mutator("upsertMessageSlotData", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        day: Schema.Number,
        workspaceId: Schema.NullOr(Schema.String),
        conversationId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        const existingSlot = await tx.run(
          builder.messageSlot
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .one(),
        );

        await tx.mutate.messageSlot.upsert(
          zeroTableAccess.messageSlot.upsertWithTimestamps(
            {
              clientPlatform: args.clientPlatform,
              clientId: args.clientId,
              messageId: args.messageId,
              day: args.day,
              workspaceId: args.workspaceId,
              conversationId: args.conversationId,
              createdByUserId: args.createdByUserId,
              deletedAt: null,
            },
            existingSlot,
          ),
        );
      },
    }),
  );

  return make("sheet")
    .add(UserConfigGroup)
    .add(WorkspaceConfigGroup)
    .add(MessageCheckinGroup)
    .add(MessageRoomOrderGroup)
    .add(MessageSlotGroup);
};

export function makeSheetZeroApi(): ReturnType<
  typeof makeSheetZeroApiWithSuccess<typeof defaultSuccessSchemas>
>;
export function makeSheetZeroApi<const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
): ReturnType<typeof makeSheetZeroApiWithSuccess<SuccessSchemas>>;
export function makeSheetZeroApi(success: SheetZeroApiSuccessSchemas = defaultSuccessSchemas) {
  return makeSheetZeroApiWithSuccess(success);
}

export const SheetZeroApi = makeSheetZeroApi();
