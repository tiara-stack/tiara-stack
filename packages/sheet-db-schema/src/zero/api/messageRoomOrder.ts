import type { Schema as RocicorpSchema, Transaction } from "@rocicorp/zero";
import { Option, Predicate, Schema } from "effect";
import { ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import { zeroTableAccess } from "../accessors";
import {
  hasActiveSendClaim,
  hasActiveTentativePinClaim,
  hasActiveTentativeUpdateClaim,
  hasStaleUntrackedSendClaim,
  isActiveSendClaim,
} from "../claimHelpers";
import { activeRecord, preserveOmitted } from "../timestamps";
import { MessageKeyRequest } from "./requests";
import type { SheetZeroApiSuccessSchemas } from "./successSchemas";

const MessageRoomOrderEntryInput = Schema.Struct({
  rank: Schema.Number,
  position: Schema.Number,
  hour: Schema.Number,
  team: Schema.String,
  tags: Schema.Array(Schema.String),
  effectValue: Schema.Number,
});

const MessageRoomOrderDataInput = Schema.Struct({
  previousFills: Schema.Array(Schema.String),
  fills: Schema.Array(Schema.String),
  hour: Schema.Number,
  rank: Schema.Number,
  tentative: Schema.optional(Schema.Boolean),
  monitor: Schema.optional(Schema.NullOr(Schema.String)),
  workspaceId: Schema.NullOr(Schema.String),
  conversationId: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(Schema.String),
});

const MessageRoomOrderEntries = Schema.Array(MessageRoomOrderEntryInput).pipe(
  Schema.refine(
    (entries): entries is typeof entries =>
      new Set(entries.map((entry) => `${entry.rank}:${entry.position}`)).size === entries.length,
    { message: "Room-order entries must have unique rank and position pairs" },
  ),
);

type RoomOrderClaimState = {
  readonly rank: number;
  readonly sentMessageId?: string | null;
  readonly sendClaimId?: string | null;
  readonly sendClaimedAt?: Date | number | null;
  readonly tentativePinnedAt?: Date | number | null;
  readonly tentativePinClaimId?: string | null;
  readonly tentativePinClaimedAt?: Date | number | null;
  readonly tentativeUpdateClaimId?: string | null;
  readonly tentativeUpdateClaimedAt?: Date | number | null;
};

type RoomOrderTransaction = Transaction<RocicorpSchema, unknown>;
type RoomOrderKey = {
  readonly clientPlatform: string;
  readonly clientId: string;
  readonly messageId: string;
};

const findActiveMessageRoomOrder = (tx: RoomOrderTransaction, key: RoomOrderKey) =>
  tx.run(
    zeroTableAccess.messageRoomOrder.getActiveByPrimaryKey(
      zeroTableAccess.messageRoomOrder.table,
      key,
    ),
  );

const findMessageRoomOrder = (tx: RoomOrderTransaction, key: RoomOrderKey) =>
  tx.run(
    zeroTableAccess.messageRoomOrder.table
      .where("clientPlatform", "=", key.clientPlatform)
      .where("clientId", "=", key.clientId)
      .where("messageId", "=", key.messageId)
      .one(),
  );

const optionalField = <Value, Key extends keyof Value>(value: Value | null | undefined, key: Key) =>
  Option.map(Option.fromNullishOr(value), (record) => record[key]);

const upsertRoomOrderRecord = async (
  tx: RoomOrderTransaction,
  key: RoomOrderKey,
  data: typeof MessageRoomOrderDataInput.Type,
) => {
  const existing = await findMessageRoomOrder(tx, key);
  const activeExisting = activeRecord(existing);
  const tentative = Option.getOrElse(
    Option.fromNullishOr(
      preserveOmitted(
        data.tentative,
        Option.getOrUndefined(optionalField(activeExisting, "tentative")),
      ),
    ),
    () => false,
  );
  const monitor = preserveOmitted(
    data.monitor,
    Option.getOrUndefined(optionalField(activeExisting, "monitor")),
  );
  const rank = Option.getOrElse(optionalField(activeExisting, "rank"), () => data.rank);
  await tx.mutate.messageRoomOrder.upsert(
    zeroTableAccess.messageRoomOrder.upsertWithTimestamps(
      {
        clientPlatform: key.clientPlatform,
        clientId: key.clientId,
        messageId: key.messageId,
        previousFills: data.previousFills.slice(),
        fills: data.fills.slice(),
        hour: data.hour,
        rank,
        tentative,
        monitor,
        workspaceId: data.workspaceId,
        conversationId: data.conversationId,
        createdByUserId: data.createdByUserId,
        deletedAt: null,
      },
      activeExisting,
    ),
  );
};

const upsertRoomOrderEntries = async (
  tx: RoomOrderTransaction,
  key: RoomOrderKey,
  entries: typeof MessageRoomOrderEntries.Type,
) => {
  await Promise.all(
    entries.map(async (entry) => {
      const existing = await tx.run(
        zeroTableAccess.messageRoomOrderEntry.table
          .where("clientPlatform", "=", key.clientPlatform)
          .where("clientId", "=", key.clientId)
          .where("messageId", "=", key.messageId)
          .where("rank", "=", entry.rank)
          .where("position", "=", entry.position)
          .one(),
      );
      return tx.mutate.messageRoomOrderEntry.upsert(
        zeroTableAccess.messageRoomOrderEntry.upsertWithTimestamps(
          {
            clientPlatform: key.clientPlatform,
            clientId: key.clientId,
            messageId: key.messageId,
            rank: entry.rank,
            position: entry.position,
            hour: entry.hour,
            team: entry.team,
            tags: entry.tags.slice(),
            effectValue: entry.effectValue,
            deletedAt: null,
          },
          existing,
        ),
      );
    }),
  );
};

const hasExpectedRankMismatch = (
  messageRoomOrder: RoomOrderClaimState,
  expectedRank: number | undefined,
) => Predicate.isNotUndefined(expectedRank) && messageRoomOrder.rank !== expectedRank;

const hasForeignTentativeUpdateClaim = (
  messageRoomOrder: RoomOrderClaimState,
  now: number,
  tentativeUpdateClaimId: string | undefined,
) =>
  hasActiveTentativeUpdateClaim(messageRoomOrder, now) &&
  messageRoomOrder.tentativeUpdateClaimId !== tentativeUpdateClaimId;

const blocksRankChange = (
  messageRoomOrder: RoomOrderClaimState,
  now: number,
  expectedRank: number | undefined,
  tentativeUpdateClaimId: string | undefined,
) =>
  [
    Predicate.isNotNullish(messageRoomOrder.tentativePinnedAt),
    hasExpectedRankMismatch(messageRoomOrder, expectedRank),
    hasActiveSendClaim(messageRoomOrder, now),
    hasForeignTentativeUpdateClaim(messageRoomOrder, now, tentativeUpdateClaimId),
    hasActiveTentativePinClaim(messageRoomOrder, now),
  ].some(Predicate.isTruthy);

const blocksSendClaim = (messageRoomOrder: RoomOrderClaimState, now: number) =>
  [
    Predicate.isNotNullish(messageRoomOrder.sentMessageId),
    Predicate.isNotNullish(messageRoomOrder.tentativePinnedAt),
    isActiveSendClaim(messageRoomOrder.sendClaimId, messageRoomOrder.sendClaimedAt, now),
    hasActiveTentativeUpdateClaim(messageRoomOrder, now),
    hasActiveTentativePinClaim(messageRoomOrder, now),
  ].some(Predicate.isTruthy);

const blocksTentativeClaim = (messageRoomOrder: RoomOrderClaimState, now: number) =>
  [
    Predicate.isNotNullish(messageRoomOrder.tentativePinnedAt),
    hasStaleUntrackedSendClaim(messageRoomOrder, now),
    isActiveSendClaim(messageRoomOrder.sendClaimId, messageRoomOrder.sendClaimedAt, now),
    hasActiveTentativePinClaim(messageRoomOrder, now),
    hasActiveTentativeUpdateClaim(messageRoomOrder, now),
  ].some(Predicate.isTruthy);

export const makeMessageRoomOrderGroup = <const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
) =>
  ZeroApiGroup.make("messageRoomOrder").add(
    ZeroApiEndpoint.query("getMessageRoomOrder", {
      request: Schema.Struct(MessageKeyRequest),
      success: success.messageRoomOrder.getMessageRoomOrder,
      query: ({ args: { clientPlatform, clientId, messageId } }) =>
        zeroTableAccess.messageRoomOrder.getActiveByPrimaryKey(
          zeroTableAccess.messageRoomOrder.table,
          {
            clientPlatform,
            clientId,
            messageId,
          },
        ),
    }),
    ZeroApiEndpoint.query("getMessageRoomOrderEntry", {
      request: Schema.Struct({ ...MessageKeyRequest, rank: Schema.Number }),
      success: success.messageRoomOrder.getMessageRoomOrderEntry,
      query: ({ args: { clientPlatform, clientId, messageId, rank } }) =>
        zeroTableAccess.messageRoomOrderEntry
          .listActiveWhere(
            zeroTableAccess.messageRoomOrderEntry.table
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
          zeroTableAccess.messageRoomOrderEntry.table
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
        const messageRoomOrder = await findActiveMessageRoomOrder(tx, args);
        if (Predicate.isNullish(messageRoomOrder)) {
          return;
        }
        if (
          blocksRankChange(messageRoomOrder, now, args.expectedRank, args.tentativeUpdateClaimId)
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
        const messageRoomOrder = await findActiveMessageRoomOrder(tx, args);
        if (Predicate.isNullish(messageRoomOrder)) {
          return;
        }
        if (
          blocksRankChange(messageRoomOrder, now, args.expectedRank, args.tentativeUpdateClaimId)
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
        const messageRoomOrder = await findActiveMessageRoomOrder(tx, args);
        if (Predicate.isNullish(messageRoomOrder)) {
          return;
        }
        if (blocksSendClaim(messageRoomOrder, now)) {
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
        const messageRoomOrder = await findActiveMessageRoomOrder(tx, args);
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
        const messageRoomOrder = await findActiveMessageRoomOrder(tx, args);
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
        const messageRoomOrder = await findActiveMessageRoomOrder(tx, args);
        if (Predicate.isNullish(messageRoomOrder)) {
          return;
        }
        if (blocksTentativeClaim(messageRoomOrder, now)) {
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
        const messageRoomOrder = await findActiveMessageRoomOrder(tx, args);
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
        const messageRoomOrder = await findActiveMessageRoomOrder(tx, args);
        if (Predicate.isNullish(messageRoomOrder)) {
          return;
        }
        if (blocksTentativeClaim(messageRoomOrder, now)) {
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
        const messageRoomOrder = await findActiveMessageRoomOrder(tx, args);
        if (
          Predicate.isNullish(messageRoomOrder) ||
          Predicate.isNotNullish(messageRoomOrder.tentativePinnedAt) ||
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
        const messageRoomOrder = await findActiveMessageRoomOrder(tx, args);
        if (
          Predicate.isNullish(messageRoomOrder) ||
          Predicate.isNotNullish(messageRoomOrder.tentativePinnedAt) ||
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
        ...MessageRoomOrderDataInput.fields,
      }),
      mutator: async ({ tx, args }) => await upsertRoomOrderRecord(tx, args, args),
    }),
    ZeroApiEndpoint.mutator("persistMessageRoomOrder", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        data: MessageRoomOrderDataInput,
        entries: MessageRoomOrderEntries,
      }),
      mutator: async ({ tx, args }) => {
        const existingEntries = await tx.run(
          zeroTableAccess.messageRoomOrderEntry.table
            .where("clientPlatform", "=", args.clientPlatform)
            .where("clientId", "=", args.clientId)
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null),
        );
        await upsertRoomOrderRecord(tx, args, args.data);

        const suppliedEntryKeys = new Set(
          args.entries.map((entry) => `${entry.rank}:${entry.position}`),
        );
        await Promise.all(
          existingEntries
            .filter((entry) => !suppliedEntryKeys.has(`${entry.rank}:${entry.position}`))
            .map((entry) =>
              tx.mutate.messageRoomOrderEntry.update(
                zeroTableAccess.messageRoomOrderEntry.softDeleteByPrimaryKey({
                  clientPlatform: args.clientPlatform,
                  clientId: args.clientId,
                  messageId: args.messageId,
                  rank: entry.rank,
                  position: entry.position,
                }),
              ),
            ),
        );

        await upsertRoomOrderEntries(tx, args, args.entries);
      },
    }),
    ZeroApiEndpoint.mutator("upsertMessageRoomOrderEntry", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        entries: MessageRoomOrderEntries,
      }),
      mutator: async ({ tx, args }) => await upsertRoomOrderEntries(tx, args, args.entries),
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

export type MessageRoomOrderGroup<SuccessSchemas extends SheetZeroApiSuccessSchemas> = ReturnType<
  typeof makeMessageRoomOrderGroup<SuccessSchemas>
>;
