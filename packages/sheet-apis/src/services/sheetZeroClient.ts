import { Context, Effect, Layer, Option, Schema } from "effect";
import { makeSheetZeroApi, mutators } from "sheet-db-schema/zero";
import { ZeroApiClient } from "typhoon-zero/zeroApi";
import { DefaultTaggedClass } from "typhoon-core/schema";
import { ClientPlatform } from "sheet-ingress-api/schemas/client";
import {
  WorkspaceConversationConfig,
  WorkspaceConfig,
  WorkspaceFeatureFlag,
  WorkspaceMonitorRole,
  WorkspaceTeamSubmissionChannel,
  WorkspaceUpdateAnnouncementDelivery,
  TeamSubmissionRemovedRowStrategy,
  TeamSubmissionWriteMode,
} from "sheet-ingress-api/schemas/workspaceConfig";
import { UserPlatformConfig } from "sheet-ingress-api/schemas/userConfig";
import { MessageCheckin, MessageCheckinMember } from "sheet-ingress-api/schemas/messageCheckin";
import {
  MessageRoomOrder,
  MessageRoomOrderEntry,
} from "sheet-ingress-api/schemas/messageRoomOrder";
import { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import {
  MessageTeamSubmission,
  ParsedTeamEntry,
  TeamSubmissionStatus,
  TeamSubmissionRollbackSnapshot,
  TeamSubmissionRowMapping,
} from "sheet-ingress-api/schemas/teamSubmission";
import { ZeroClient } from "./zeroClient";
import type { MessageKey } from "./messageKey";
import type { SheetTextPart } from "sheet-ingress-api/schemas/client";

const successSchemas = {
  userConfig: {
    getUserPlatformConfig: Schema.OptionFromNullishOr(DefaultTaggedClass(UserPlatformConfig)),
    getCheckinDmEnabledUserConfigs: Schema.Array(DefaultTaggedClass(UserPlatformConfig)),
    getMonitorDmEnabledUserConfigs: Schema.Array(DefaultTaggedClass(UserPlatformConfig)),
  },
  workspaceConfig: {
    getAutoCheckinWorkspaces: Schema.Array(DefaultTaggedClass(WorkspaceConfig)),
    getWorkspaceConfigByWorkspaceId: Schema.OptionFromNullishOr(
      DefaultTaggedClass(WorkspaceConfig),
    ),
    getWorkspaceMonitorRoles: Schema.Array(DefaultTaggedClass(WorkspaceMonitorRole)),
    getWorkspaceFeatureFlags: Schema.Array(DefaultTaggedClass(WorkspaceFeatureFlag)),
    getWorkspacesForFeatureFlag: Schema.Array(DefaultTaggedClass(WorkspaceFeatureFlag)),
    getWorkspaceFeatureFlag: Schema.OptionFromNullishOr(DefaultTaggedClass(WorkspaceFeatureFlag)),
    getWorkspaceUpdateAnnouncementDelivery: Schema.OptionFromNullishOr(
      DefaultTaggedClass(WorkspaceUpdateAnnouncementDelivery),
    ),
    getWorkspaceConversations: Schema.Array(DefaultTaggedClass(WorkspaceConversationConfig)),
    getWorkspaceConversationById: Schema.OptionFromNullishOr(
      DefaultTaggedClass(WorkspaceConversationConfig),
    ),
    getWorkspaceConversationByName: Schema.OptionFromNullishOr(
      DefaultTaggedClass(WorkspaceConversationConfig),
    ),
    getTeamSubmissionChannelByConversationId: Schema.OptionFromNullishOr(
      DefaultTaggedClass(WorkspaceTeamSubmissionChannel),
    ),
    getTeamSubmissionChannelsForWorkspace: Schema.Array(
      DefaultTaggedClass(WorkspaceTeamSubmissionChannel),
    ),
  },
  messageCheckin: {
    getMessageCheckinData: Schema.OptionFromNullishOr(DefaultTaggedClass(MessageCheckin)),
    getMessageCheckinMembers: Schema.Array(DefaultTaggedClass(MessageCheckinMember)),
  },
  messageRoomOrder: {
    getMessageRoomOrder: Schema.OptionFromNullishOr(DefaultTaggedClass(MessageRoomOrder)),
    getMessageRoomOrderEntry: Schema.Array(DefaultTaggedClass(MessageRoomOrderEntry)),
    getMessageRoomOrderRange: Schema.Array(DefaultTaggedClass(MessageRoomOrderEntry)),
  },
  messageSlot: {
    getMessageSlotData: Schema.OptionFromNullishOr(DefaultTaggedClass(MessageSlot)),
  },
  messageTeamSubmission: {
    getMessageTeamSubmission: Schema.OptionFromNullishOr(DefaultTaggedClass(MessageTeamSubmission)),
    getMessageTeamSubmissionByDiscordMessage: Schema.OptionFromNullishOr(
      DefaultTaggedClass(MessageTeamSubmission),
    ),
  },
} as const;

export const SheetZeroApi: ReturnType<typeof makeSheetZeroApi<typeof successSchemas>> =
  makeSheetZeroApi(successSchemas);

type QueryResult<A> = Effect.Effect<A, ZeroApiClient.QueryError, never>;

type MutatorResult<Args> = ZeroApiClient.MutatorClientMethod<Args>;

interface MessageRoomOrderEntryInput {
  readonly rank: number;
  readonly position: number;
  readonly hour: number;
  readonly team: string;
  readonly tags: readonly string[];
  readonly effectValue: number;
}

export interface SheetZeroClientApi {
  readonly userConfig: {
    readonly getUserPlatformConfig: (args: {
      readonly platform: string;
      readonly userId: string;
    }) => QueryResult<Option.Option<UserPlatformConfig>>;
    readonly getCheckinDmEnabledUserConfigs: (args: {
      readonly platform: string;
      readonly userIds: ReadonlyArray<string>;
    }) => QueryResult<UserPlatformConfig[]>;
    readonly getMonitorDmEnabledUserConfigs: (args: {
      readonly platform: string;
      readonly userIds: ReadonlyArray<string>;
    }) => QueryResult<UserPlatformConfig[]>;
    readonly upsertUserPlatformConfig: MutatorResult<{
      readonly platform: string;
      readonly userId: string;
      readonly checkinDmEnabled?: boolean | undefined;
      readonly monitorDmEnabled?: boolean | undefined;
      readonly defaultClientId?: string | null | undefined;
    }>;
  };
  readonly workspaceConfig: {
    readonly getAutoCheckinWorkspaces: (args: {}) => QueryResult<WorkspaceConfig[]>;
    readonly getWorkspaceConfigByWorkspaceId: (args: {
      readonly workspaceId: string;
    }) => QueryResult<Option.Option<WorkspaceConfig>>;
    readonly getWorkspaceMonitorRoles: (args: {
      readonly workspaceId: string;
    }) => QueryResult<WorkspaceMonitorRole[]>;
    readonly getWorkspaceFeatureFlags: (args: {
      readonly workspaceId: string;
    }) => QueryResult<WorkspaceFeatureFlag[]>;
    readonly getWorkspacesForFeatureFlag: (args: {
      readonly flagName: string;
    }) => QueryResult<WorkspaceFeatureFlag[]>;
    readonly getWorkspaceFeatureFlag: (args: {
      readonly workspaceId: string;
      readonly flagName: string;
    }) => QueryResult<Option.Option<WorkspaceFeatureFlag>>;
    readonly getWorkspaceUpdateAnnouncementDelivery: (args: {
      readonly workspaceId: string;
      readonly announcementId: string;
    }) => QueryResult<Option.Option<WorkspaceUpdateAnnouncementDelivery>>;
    readonly getWorkspaceConversations: (args: {
      readonly workspaceId: string;
      readonly running?: boolean | undefined;
    }) => QueryResult<WorkspaceConversationConfig[]>;
    readonly getWorkspaceConversationById: (args: {
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly running?: boolean | undefined;
    }) => QueryResult<Option.Option<WorkspaceConversationConfig>>;
    readonly getWorkspaceConversationByName: (args: {
      readonly workspaceId: string;
      readonly conversationName: string;
      readonly running?: boolean | undefined;
    }) => QueryResult<Option.Option<WorkspaceConversationConfig>>;
    readonly getTeamSubmissionChannelByConversationId: (args: {
      readonly workspaceId: string;
      readonly conversationId: string;
    }) => QueryResult<Option.Option<WorkspaceTeamSubmissionChannel>>;
    readonly getTeamSubmissionChannelsForWorkspace: (args: {
      readonly workspaceId: string;
    }) => QueryResult<WorkspaceTeamSubmissionChannel[]>;
    readonly upsertWorkspaceConfig: MutatorResult<{
      readonly workspaceId: string;
      readonly sheetId?: string | null | undefined;
      readonly autoCheckin?: boolean | null | undefined;
    }>;
    readonly addWorkspaceMonitorRole: MutatorResult<{
      readonly workspaceId: string;
      readonly roleId: string;
    }>;
    readonly removeWorkspaceMonitorRole: MutatorResult<{
      readonly workspaceId: string;
      readonly roleId: string;
    }>;
    readonly addWorkspaceFeatureFlag: MutatorResult<{
      readonly workspaceId: string;
      readonly flagName: string;
    }>;
    readonly removeWorkspaceFeatureFlag: MutatorResult<{
      readonly workspaceId: string;
      readonly flagName: string;
    }>;
    readonly recordWorkspaceUpdateAnnouncementDelivery: MutatorResult<{
      readonly workspaceId: string;
      readonly announcementId: string;
      readonly publishedAt: number;
      readonly deliveredAt: number;
      readonly conversationId: string;
      readonly messageId: string;
      readonly claimToken: string;
    }>;
    readonly claimWorkspaceUpdateAnnouncementDelivery: MutatorResult<{
      readonly workspaceId: string;
      readonly announcementId: string;
      readonly publishedAt: number;
      readonly claimToken: string;
    }>;
    readonly releaseWorkspaceUpdateAnnouncementDeliveryClaim: MutatorResult<{
      readonly workspaceId: string;
      readonly announcementId: string;
      readonly claimToken: string;
    }>;
    readonly upsertWorkspaceConversationConfig: MutatorResult<{
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly name?: string | null | undefined;
      readonly running?: boolean | null | undefined;
      readonly roleId?: string | null | undefined;
      readonly checkinConversationId?: string | null | undefined;
    }>;
    readonly upsertTeamSubmissionChannel: MutatorResult<{
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly destinationTeamConfigName?: string | null | undefined;
      readonly writeMode: Schema.Schema.Type<typeof TeamSubmissionWriteMode>;
      readonly removedRowStrategy: Schema.Schema.Type<typeof TeamSubmissionRemovedRowStrategy>;
      readonly requireValidOshi?: boolean | undefined;
    }>;
    readonly removeTeamSubmissionChannel: MutatorResult<{
      readonly workspaceId: string;
      readonly conversationId: string;
    }>;
  };
  readonly messageCheckin: {
    readonly getMessageCheckinData: (
      args: MessageKey,
    ) => QueryResult<Option.Option<MessageCheckin>>;
    readonly getMessageCheckinMembers: (args: MessageKey) => QueryResult<MessageCheckinMember[]>;
    readonly upsertMessageCheckinData: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly initialMessage: ReadonlyArray<SheetTextPart>;
      readonly hour: number;
      readonly runningConversationId: string;
      readonly roleId?: string | null | undefined;
      readonly workspaceId: string | null;
      readonly conversationId: string | null;
      readonly createdByUserId: string | null;
    }>;
    readonly addMessageCheckinMembers: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly memberIds: readonly string[];
    }>;
    readonly persistMessageCheckin: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly data: {
        readonly initialMessage: ReadonlyArray<SheetTextPart>;
        readonly hour: number;
        readonly runningConversationId: string;
        readonly roleId?: string | null | undefined;
        readonly workspaceId: string | null;
        readonly conversationId: string | null;
        readonly createdByUserId: string | null;
      };
      readonly memberIds: readonly string[];
    }>;
    readonly removeMessageCheckin: MutatorResult<MessageKey>;
    readonly setMessageCheckinMemberCheckinAt: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly memberId: string;
      readonly checkinAt: number;
      readonly checkinClaimId?: string | undefined;
    }>;
    readonly setMessageCheckinMemberCheckinAtIfUnset: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly memberId: string;
      readonly checkinAt: number;
      readonly checkinClaimId: string;
    }>;
    readonly removeMessageCheckinMember: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly memberId: string;
    }>;
  };
  readonly messageRoomOrder: {
    readonly getMessageRoomOrder: (
      args: MessageKey,
    ) => QueryResult<Option.Option<MessageRoomOrder>>;
    readonly getMessageRoomOrderEntry: (args: {
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly rank: number;
    }) => QueryResult<MessageRoomOrderEntry[]>;
    readonly getMessageRoomOrderRange: (args: MessageKey) => QueryResult<MessageRoomOrderEntry[]>;
    readonly decrementMessageRoomOrderRank: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly expectedRank?: number | undefined;
      readonly tentativeUpdateClaimId?: string | undefined;
    }>;
    readonly incrementMessageRoomOrderRank: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly expectedRank?: number | undefined;
      readonly tentativeUpdateClaimId?: string | undefined;
    }>;
    readonly claimMessageRoomOrderSend: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly claimId: string;
    }>;
    readonly completeMessageRoomOrderSend: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly claimId: string;
      readonly sentMessageId: string;
      readonly sentConversationId: string;
      readonly sentAt: number;
    }>;
    readonly releaseMessageRoomOrderSendClaim: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly claimId: string;
    }>;
    readonly claimMessageRoomOrderTentativeUpdate: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly claimId: string;
    }>;
    readonly releaseMessageRoomOrderTentativeUpdateClaim: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly claimId: string;
    }>;
    readonly claimMessageRoomOrderTentativePin: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly claimId: string;
    }>;
    readonly completeMessageRoomOrderTentativePin: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly claimId: string;
      readonly pinnedAt: number;
    }>;
    readonly releaseMessageRoomOrderTentativePinClaim: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly claimId: string;
    }>;
    readonly upsertMessageRoomOrder: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly previousFills: readonly string[];
      readonly fills: readonly string[];
      readonly hour: number;
      readonly rank: number;
      readonly tentative?: boolean | undefined;
      readonly monitor?: string | null | undefined;
      readonly workspaceId: string | null;
      readonly conversationId: string | null;
      readonly createdByUserId: string | null;
    }>;
    readonly persistMessageRoomOrder: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly data: {
        readonly previousFills: readonly string[];
        readonly fills: readonly string[];
        readonly hour: number;
        readonly rank: number;
        readonly tentative?: boolean | undefined;
        readonly monitor?: string | null | undefined;
        readonly workspaceId: string | null;
        readonly conversationId: string | null;
        readonly createdByUserId: string | null;
      };
      readonly entries: readonly MessageRoomOrderEntryInput[];
    }>;
    readonly upsertMessageRoomOrderEntry: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly entries: readonly MessageRoomOrderEntryInput[];
    }>;
    readonly removeMessageRoomOrderEntry: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly rank: number;
      readonly position: number;
    }>;
  };
  readonly messageSlot: {
    readonly getMessageSlotData: (args: MessageKey) => QueryResult<Option.Option<MessageSlot>>;
    readonly upsertMessageSlotData: MutatorResult<{
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
      readonly day: number;
      readonly workspaceId: string | null;
      readonly conversationId: string | null;
      readonly createdByUserId: string | null;
    }>;
  };
  readonly messageTeamSubmission: {
    readonly getMessageTeamSubmission: (args: {
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly messageId: string;
    }) => QueryResult<Option.Option<MessageTeamSubmission>>;
    readonly getMessageTeamSubmissionByDiscordMessage: (args: {
      readonly discordGuildId: string;
      readonly discordChannelId: string;
      readonly messageId: string;
    }) => QueryResult<Option.Option<MessageTeamSubmission>>;
    readonly upsertMessageTeamSubmission: MutatorResult<{
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly messageId: string;
      readonly clientPlatform: Schema.Schema.Type<typeof ClientPlatform>;
      readonly clientId: string;
      readonly discordGuildId: string;
      readonly discordChannelId: string;
      readonly discordAuthorId: string;
      readonly sheetId: string;
      readonly confirmationMessageId?: string | null | undefined;
      readonly parsedSubmission: ReadonlyArray<ParsedTeamEntry>;
      readonly rowMappings: ReadonlyArray<TeamSubmissionRowMapping>;
      readonly rollbackSnapshot?: TeamSubmissionRollbackSnapshot | null;
      readonly status: Schema.Schema.Type<typeof TeamSubmissionStatus>;
    }>;
    readonly setMessageTeamSubmissionConfirmation: MutatorResult<{
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly messageId: string;
      readonly confirmationMessageId: string;
    }>;
  };
}

export class SheetZeroClient extends Context.Service<SheetZeroClient>()("SheetZeroClient", {
  make: Effect.gen(function* () {
    const zeroClient = yield* ZeroClient;
    return yield* ZeroApiClient.makeWithService(SheetZeroApi, zeroClient, { mutators }).pipe(
      Effect.map((client) => client as unknown as SheetZeroClientApi),
    );
  }),
}) {
  static layer = Layer.effect(SheetZeroClient, this.make).pipe(Layer.provide(ZeroClient.layer));
}
