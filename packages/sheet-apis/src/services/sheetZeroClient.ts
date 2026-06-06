import { Context, Effect, Layer, Option, Schema } from "effect";
import { makeSheetZeroApi, mutators } from "sheet-db-schema/zero";
import { ZeroApiClient } from "typhoon-zero/zeroApi";
import { DefaultTaggedClass } from "typhoon-core/schema";
import {
  GuildChannelConfig,
  GuildConfig,
  GuildFeatureFlag,
  GuildConfigMonitorRole,
  GuildUpdateAnnouncementDelivery,
} from "sheet-ingress-api/schemas/guildConfig";
import { MessageCheckin, MessageCheckinMember } from "sheet-ingress-api/schemas/messageCheckin";
import {
  MessageRoomOrder,
  MessageRoomOrderEntry,
} from "sheet-ingress-api/schemas/messageRoomOrder";
import { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import { ZeroClient } from "./zeroClient";

const successSchemas = {
  guildConfig: {
    getAutoCheckinGuilds: Schema.Array(DefaultTaggedClass(GuildConfig)),
    getGuildConfigByGuildId: Schema.OptionFromNullishOr(DefaultTaggedClass(GuildConfig)),
    getGuildMonitorRoles: Schema.Array(DefaultTaggedClass(GuildConfigMonitorRole)),
    getGuildFeatureFlags: Schema.Array(DefaultTaggedClass(GuildFeatureFlag)),
    getGuildsForFeatureFlag: Schema.Array(DefaultTaggedClass(GuildFeatureFlag)),
    getGuildFeatureFlag: Schema.OptionFromNullishOr(DefaultTaggedClass(GuildFeatureFlag)),
    getGuildUpdateAnnouncementDelivery: Schema.OptionFromNullishOr(
      DefaultTaggedClass(GuildUpdateAnnouncementDelivery),
    ),
    getGuildChannels: Schema.Array(DefaultTaggedClass(GuildChannelConfig)),
    getGuildChannelById: Schema.OptionFromNullishOr(DefaultTaggedClass(GuildChannelConfig)),
    getGuildChannelByName: Schema.OptionFromNullishOr(DefaultTaggedClass(GuildChannelConfig)),
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
} as const;

export const SheetZeroApi = makeSheetZeroApi(successSchemas);

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
  readonly guildConfig: {
    readonly getAutoCheckinGuilds: (args: {}) => QueryResult<GuildConfig[]>;
    readonly getGuildConfigByGuildId: (args: {
      readonly guildId: string;
    }) => QueryResult<Option.Option<GuildConfig>>;
    readonly getGuildMonitorRoles: (args: {
      readonly guildId: string;
    }) => QueryResult<GuildConfigMonitorRole[]>;
    readonly getGuildFeatureFlags: (args: {
      readonly guildId: string;
    }) => QueryResult<GuildFeatureFlag[]>;
    readonly getGuildsForFeatureFlag: (args: {
      readonly flagName: string;
    }) => QueryResult<GuildFeatureFlag[]>;
    readonly getGuildFeatureFlag: (args: {
      readonly guildId: string;
      readonly flagName: string;
    }) => QueryResult<Option.Option<GuildFeatureFlag>>;
    readonly getGuildUpdateAnnouncementDelivery: (args: {
      readonly guildId: string;
      readonly announcementId: string;
    }) => QueryResult<Option.Option<GuildUpdateAnnouncementDelivery>>;
    readonly getGuildChannels: (args: {
      readonly guildId: string;
      readonly running?: boolean | undefined;
    }) => QueryResult<GuildChannelConfig[]>;
    readonly getGuildChannelById: (args: {
      readonly guildId: string;
      readonly channelId: string;
      readonly running?: boolean | undefined;
    }) => QueryResult<Option.Option<GuildChannelConfig>>;
    readonly getGuildChannelByName: (args: {
      readonly guildId: string;
      readonly channelName: string;
      readonly running?: boolean | undefined;
    }) => QueryResult<Option.Option<GuildChannelConfig>>;
    readonly upsertGuildConfig: MutatorResult<{
      readonly guildId: string;
      readonly sheetId?: string | null | undefined;
      readonly autoCheckin?: boolean | null | undefined;
    }>;
    readonly addGuildMonitorRole: MutatorResult<{
      readonly guildId: string;
      readonly roleId: string;
    }>;
    readonly removeGuildMonitorRole: MutatorResult<{
      readonly guildId: string;
      readonly roleId: string;
    }>;
    readonly addGuildFeatureFlag: MutatorResult<{
      readonly guildId: string;
      readonly flagName: string;
    }>;
    readonly removeGuildFeatureFlag: MutatorResult<{
      readonly guildId: string;
      readonly flagName: string;
    }>;
    readonly recordGuildUpdateAnnouncementDelivery: MutatorResult<{
      readonly guildId: string;
      readonly announcementId: string;
      readonly publishedAt: number;
      readonly deliveredAt: number;
      readonly channelId: string;
      readonly messageId: string;
    }>;
    readonly claimGuildUpdateAnnouncementDelivery: MutatorResult<{
      readonly guildId: string;
      readonly announcementId: string;
      readonly publishedAt: number;
      readonly claimToken: string;
    }>;
    readonly releaseGuildUpdateAnnouncementDeliveryClaim: MutatorResult<{
      readonly guildId: string;
      readonly announcementId: string;
      readonly claimToken: string;
    }>;
    readonly upsertGuildChannelConfig: MutatorResult<{
      readonly guildId: string;
      readonly channelId: string;
      readonly name?: string | null | undefined;
      readonly running?: boolean | null | undefined;
      readonly roleId?: string | null | undefined;
      readonly checkinChannelId?: string | null | undefined;
    }>;
  };
  readonly messageCheckin: {
    readonly getMessageCheckinData: (args: {
      readonly messageId: string;
    }) => QueryResult<Option.Option<MessageCheckin>>;
    readonly getMessageCheckinMembers: (args: {
      readonly messageId: string;
    }) => QueryResult<MessageCheckinMember[]>;
    readonly upsertMessageCheckinData: MutatorResult<{
      readonly messageId: string;
      readonly initialMessage: string;
      readonly hour: number;
      readonly channelId: string;
      readonly roleId?: string | null | undefined;
      readonly guildId: string | null;
      readonly messageChannelId: string | null;
      readonly createdByUserId: string | null;
    }>;
    readonly addMessageCheckinMembers: MutatorResult<{
      readonly messageId: string;
      readonly memberIds: readonly string[];
    }>;
    readonly persistMessageCheckin: MutatorResult<{
      readonly messageId: string;
      readonly data: {
        readonly initialMessage: string;
        readonly hour: number;
        readonly channelId: string;
        readonly roleId?: string | null | undefined;
        readonly guildId: string | null;
        readonly messageChannelId: string | null;
        readonly createdByUserId: string | null;
      };
      readonly memberIds: readonly string[];
    }>;
    readonly setMessageCheckinMemberCheckinAt: MutatorResult<{
      readonly messageId: string;
      readonly memberId: string;
      readonly checkinAt: number;
      readonly checkinClaimId?: string | undefined;
    }>;
    readonly setMessageCheckinMemberCheckinAtIfUnset: MutatorResult<{
      readonly messageId: string;
      readonly memberId: string;
      readonly checkinAt: number;
      readonly checkinClaimId: string;
    }>;
    readonly removeMessageCheckinMember: MutatorResult<{
      readonly messageId: string;
      readonly memberId: string;
    }>;
  };
  readonly messageRoomOrder: {
    readonly getMessageRoomOrder: (args: {
      readonly messageId: string;
    }) => QueryResult<Option.Option<MessageRoomOrder>>;
    readonly getMessageRoomOrderEntry: (args: {
      readonly messageId: string;
      readonly rank: number;
    }) => QueryResult<MessageRoomOrderEntry[]>;
    readonly getMessageRoomOrderRange: (args: {
      readonly messageId: string;
    }) => QueryResult<MessageRoomOrderEntry[]>;
    readonly decrementMessageRoomOrderRank: MutatorResult<{
      readonly messageId: string;
      readonly expectedRank?: number | undefined;
      readonly tentativeUpdateClaimId?: string | undefined;
    }>;
    readonly incrementMessageRoomOrderRank: MutatorResult<{
      readonly messageId: string;
      readonly expectedRank?: number | undefined;
      readonly tentativeUpdateClaimId?: string | undefined;
    }>;
    readonly claimMessageRoomOrderSend: MutatorResult<{
      readonly messageId: string;
      readonly claimId: string;
    }>;
    readonly completeMessageRoomOrderSend: MutatorResult<{
      readonly messageId: string;
      readonly claimId: string;
      readonly sentMessageId: string;
      readonly sentMessageChannelId: string;
      readonly sentAt: number;
    }>;
    readonly releaseMessageRoomOrderSendClaim: MutatorResult<{
      readonly messageId: string;
      readonly claimId: string;
    }>;
    readonly claimMessageRoomOrderTentativeUpdate: MutatorResult<{
      readonly messageId: string;
      readonly claimId: string;
    }>;
    readonly releaseMessageRoomOrderTentativeUpdateClaim: MutatorResult<{
      readonly messageId: string;
      readonly claimId: string;
    }>;
    readonly claimMessageRoomOrderTentativePin: MutatorResult<{
      readonly messageId: string;
      readonly claimId: string;
    }>;
    readonly completeMessageRoomOrderTentativePin: MutatorResult<{
      readonly messageId: string;
      readonly claimId: string;
      readonly pinnedAt: number;
    }>;
    readonly releaseMessageRoomOrderTentativePinClaim: MutatorResult<{
      readonly messageId: string;
      readonly claimId: string;
    }>;
    readonly upsertMessageRoomOrder: MutatorResult<{
      readonly messageId: string;
      readonly previousFills: readonly string[];
      readonly fills: readonly string[];
      readonly hour: number;
      readonly rank: number;
      readonly tentative?: boolean | undefined;
      readonly monitor?: string | null | undefined;
      readonly guildId: string | null;
      readonly messageChannelId: string | null;
      readonly createdByUserId: string | null;
    }>;
    readonly persistMessageRoomOrder: MutatorResult<{
      readonly messageId: string;
      readonly data: {
        readonly previousFills: readonly string[];
        readonly fills: readonly string[];
        readonly hour: number;
        readonly rank: number;
        readonly tentative?: boolean | undefined;
        readonly monitor?: string | null | undefined;
        readonly guildId: string | null;
        readonly messageChannelId: string | null;
        readonly createdByUserId: string | null;
      };
      readonly entries: readonly MessageRoomOrderEntryInput[];
    }>;
    readonly upsertMessageRoomOrderEntry: MutatorResult<{
      readonly messageId: string;
      readonly entries: readonly MessageRoomOrderEntryInput[];
    }>;
    readonly removeMessageRoomOrderEntry: MutatorResult<{
      readonly messageId: string;
      readonly rank: number;
      readonly position: number;
    }>;
  };
  readonly messageSlot: {
    readonly getMessageSlotData: (args: {
      readonly messageId: string;
    }) => QueryResult<Option.Option<MessageSlot>>;
    readonly upsertMessageSlotData: MutatorResult<{
      readonly messageId: string;
      readonly day: number;
      readonly guildId: string | null;
      readonly messageChannelId: string | null;
      readonly createdByUserId: string | null;
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
