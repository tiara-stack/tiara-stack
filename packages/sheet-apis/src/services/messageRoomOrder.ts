import { Array, Effect, Layer, Option, Context, pipe, Schema } from "effect";
import { mutators, queries } from "sheet-db-schema/zero";
import { makeDBQueryError } from "typhoon-core/error";
import { DefaultTaggedClass } from "typhoon-core/schema";
import { ZeroClient } from "./zeroClient";
import {
  MessageRoomOrder,
  MessageRoomOrderEntry,
  MessageRoomOrderRange,
} from "sheet-ingress-api/schemas/messageRoomOrder";
import type { MessageKey } from "./messageKey";

export class MessageRoomOrderService extends Context.Service<MessageRoomOrderService>()(
  "MessageRoomOrderService",
  {
    make: Effect.gen(function* () {
      const zeroClient = yield* ZeroClient;

      const getMessageRoomOrder = Effect.fn("MessageRoomOrderService.getMessageRoomOrder")(
        function* (key: MessageKey) {
          const result = yield* zeroClient.run(queries.messageRoomOrder.getMessageRoomOrder(key), {
            type: "complete",
          });

          return yield* Schema.decodeUnknownEffect(
            Schema.OptionFromNullishOr(DefaultTaggedClass(MessageRoomOrder)),
          )(result);
        },
      );

      const decrementMessageRoomOrderRank = Effect.fn(
        "MessageRoomOrderService.decrementMessageRoomOrderRank",
      )(function* (
        key: MessageKey,
        options: {
          readonly expectedRank?: number | undefined;
          readonly tentativeUpdateClaimId?: string | undefined;
        } = {},
      ) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageRoomOrder.decrementMessageRoomOrderRank({ ...key, ...options }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(queries.messageRoomOrder.getMessageRoomOrder(key), {
          type: "complete",
        });
        const roomOrder = yield* Schema.decodeUnknownEffect(
          Schema.OptionFromNullishOr(DefaultTaggedClass(MessageRoomOrder)),
        )(result);

        if (Option.isNone(roomOrder)) {
          return yield* Effect.die(makeDBQueryError("Failed to decrement room order rank"));
        }

        return roomOrder.value;
      });

      const incrementMessageRoomOrderRank = Effect.fn(
        "MessageRoomOrderService.incrementMessageRoomOrderRank",
      )(function* (
        key: MessageKey,
        options: {
          readonly expectedRank?: number | undefined;
          readonly tentativeUpdateClaimId?: string | undefined;
        } = {},
      ) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageRoomOrder.incrementMessageRoomOrderRank({ ...key, ...options }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(queries.messageRoomOrder.getMessageRoomOrder(key), {
          type: "complete",
        });
        const roomOrder = yield* Schema.decodeUnknownEffect(
          Schema.OptionFromNullishOr(DefaultTaggedClass(MessageRoomOrder)),
        )(result);

        if (Option.isNone(roomOrder)) {
          return yield* Effect.die(makeDBQueryError("Failed to increment room order rank"));
        }

        return roomOrder.value;
      });

      const claimMessageRoomOrderSend = Effect.fn(
        "MessageRoomOrderService.claimMessageRoomOrderSend",
      )(function* (key: MessageKey, claimId: string) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageRoomOrder.claimMessageRoomOrderSend({ ...key, claimId }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(queries.messageRoomOrder.getMessageRoomOrder(key), {
          type: "complete",
        });
        const roomOrder = yield* Schema.decodeUnknownEffect(
          Schema.OptionFromNullishOr(DefaultTaggedClass(MessageRoomOrder)),
        )(result);

        if (Option.isNone(roomOrder)) {
          return yield* Effect.die(makeDBQueryError("Failed to claim room order send"));
        }

        return roomOrder.value;
      });

      const completeMessageRoomOrderSend = Effect.fn(
        "MessageRoomOrderService.completeMessageRoomOrderSend",
      )(function* (
        key: MessageKey,
        claimId: string,
        sentMessage: { readonly id: string; readonly conversationId: string },
      ) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageRoomOrder.completeMessageRoomOrderSend({
            ...key,
            claimId,
            sentMessageId: sentMessage.id,
            sentConversationId: sentMessage.conversationId,
            sentAt: Date.now(),
          }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(queries.messageRoomOrder.getMessageRoomOrder(key), {
          type: "complete",
        });
        const roomOrder = yield* Schema.decodeUnknownEffect(
          Schema.OptionFromNullishOr(DefaultTaggedClass(MessageRoomOrder)),
        )(result);

        if (Option.isNone(roomOrder)) {
          return yield* Effect.die(makeDBQueryError("Failed to complete room order send"));
        }

        return roomOrder.value;
      });

      const releaseMessageRoomOrderSendClaim = Effect.fn(
        "MessageRoomOrderService.releaseMessageRoomOrderSendClaim",
      )(function* (key: MessageKey, claimId: string) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageRoomOrder.releaseMessageRoomOrderSendClaim({ ...key, claimId }),
        );
        yield* mutation.server();
      });

      const claimMessageRoomOrderTentativeUpdate = Effect.fn(
        "MessageRoomOrderService.claimMessageRoomOrderTentativeUpdate",
      )(function* (key: MessageKey, claimId: string) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageRoomOrder.claimMessageRoomOrderTentativeUpdate({
            ...key,
            claimId,
          }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(queries.messageRoomOrder.getMessageRoomOrder(key), {
          type: "complete",
        });
        const roomOrder = yield* Schema.decodeUnknownEffect(
          Schema.OptionFromNullishOr(DefaultTaggedClass(MessageRoomOrder)),
        )(result);

        if (Option.isNone(roomOrder)) {
          return yield* Effect.die(makeDBQueryError("Failed to claim tentative room order update"));
        }

        return roomOrder.value;
      });

      const releaseMessageRoomOrderTentativeUpdateClaim = Effect.fn(
        "MessageRoomOrderService.releaseMessageRoomOrderTentativeUpdateClaim",
      )(function* (key: MessageKey, claimId: string) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageRoomOrder.releaseMessageRoomOrderTentativeUpdateClaim({
            ...key,
            claimId,
          }),
        );
        yield* mutation.server();
      });

      const claimMessageRoomOrderTentativePin = Effect.fn(
        "MessageRoomOrderService.claimMessageRoomOrderTentativePin",
      )(function* (key: MessageKey, claimId: string) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageRoomOrder.claimMessageRoomOrderTentativePin({
            ...key,
            claimId,
          }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(queries.messageRoomOrder.getMessageRoomOrder(key), {
          type: "complete",
        });
        const roomOrder = yield* Schema.decodeUnknownEffect(
          Schema.OptionFromNullishOr(DefaultTaggedClass(MessageRoomOrder)),
        )(result);

        if (Option.isNone(roomOrder)) {
          return yield* Effect.die(makeDBQueryError("Failed to claim tentative room order pin"));
        }

        return roomOrder.value;
      });

      const completeMessageRoomOrderTentativePin = Effect.fn(
        "MessageRoomOrderService.completeMessageRoomOrderTentativePin",
      )(function* (key: MessageKey, claimId: string) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageRoomOrder.completeMessageRoomOrderTentativePin({
            ...key,
            claimId,
            pinnedAt: Date.now(),
          }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(queries.messageRoomOrder.getMessageRoomOrder(key), {
          type: "complete",
        });
        const roomOrder = yield* Schema.decodeUnknownEffect(
          Schema.OptionFromNullishOr(DefaultTaggedClass(MessageRoomOrder)),
        )(result);

        if (Option.isNone(roomOrder)) {
          return yield* Effect.die(makeDBQueryError("Failed to complete tentative room order pin"));
        }

        return roomOrder.value;
      });

      const releaseMessageRoomOrderTentativePinClaim = Effect.fn(
        "MessageRoomOrderService.releaseMessageRoomOrderTentativePinClaim",
      )(function* (key: MessageKey, claimId: string) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageRoomOrder.releaseMessageRoomOrderTentativePinClaim({
            ...key,
            claimId,
          }),
        );
        yield* mutation.server();
      });

      const upsertMessageRoomOrder = Effect.fn("MessageRoomOrderService.upsertMessageRoomOrder")(
        function* (
          key: MessageKey,
          data: {
            previousFills: readonly string[];
            fills: readonly string[];
            hour: number;
            rank: number;
            tentative?: boolean | undefined;
            monitor?: string | null | undefined;
            workspaceId: string | null;
            conversationId: string | null;
            createdByUserId: string | null;
          },
        ) {
          const mutation = yield* zeroClient.mutate(
            mutators.messageRoomOrder.upsertMessageRoomOrder({
              ...key,
              previousFills: data.previousFills,
              fills: data.fills,
              hour: data.hour,
              rank: data.rank,
              tentative: data.tentative,
              monitor: data.monitor,
              workspaceId: data.workspaceId,
              conversationId: data.conversationId,
              createdByUserId: data.createdByUserId,
            }),
          );
          yield* mutation.server();

          const result = yield* zeroClient.run(queries.messageRoomOrder.getMessageRoomOrder(key), {
            type: "complete",
          });
          const roomOrder = yield* Schema.decodeUnknownEffect(
            Schema.OptionFromNullishOr(DefaultTaggedClass(MessageRoomOrder)),
          )(result);

          if (Option.isNone(roomOrder)) {
            return yield* Effect.die(makeDBQueryError("Failed to upsert message room order"));
          }

          return roomOrder.value;
        },
      );

      const markMessageRoomOrderTentative = Effect.fn(
        "MessageRoomOrderService.markMessageRoomOrderTentative",
      )(function* (
        key: MessageKey,
        data: {
          readonly workspaceId: string;
          readonly conversationId: string;
        },
      ) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageRoomOrder.markMessageRoomOrderTentative({
            ...key,
            workspaceId: data.workspaceId,
            conversationId: data.conversationId,
          }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(queries.messageRoomOrder.getMessageRoomOrder(key), {
          type: "complete",
        });
        const roomOrder = yield* Schema.decodeUnknownEffect(
          Schema.OptionFromNullishOr(DefaultTaggedClass(MessageRoomOrder)),
        )(result);

        if (Option.isNone(roomOrder)) {
          return yield* Effect.die(makeDBQueryError("Failed to mark message room order tentative"));
        }

        return roomOrder.value;
      });

      const persistMessageRoomOrder = Effect.fn("MessageRoomOrderService.persistMessageRoomOrder")(
        function* (
          key: MessageKey,
          payload: {
            data: {
              previousFills: readonly string[];
              fills: readonly string[];
              hour: number;
              rank: number;
              tentative?: boolean | undefined;
              monitor?: string | null | undefined;
              workspaceId: string | null;
              conversationId: string | null;
              createdByUserId: string | null;
            };
            entries: readonly {
              rank: number;
              position: number;
              hour: number;
              team: string;
              tags: readonly string[];
              effectValue: number;
            }[];
          },
        ) {
          const mutation = yield* zeroClient.mutate(
            mutators.messageRoomOrder.persistMessageRoomOrder({
              ...key,
              data: payload.data,
              entries: payload.entries,
            }),
          );
          yield* mutation.server();

          const result = yield* zeroClient.run(queries.messageRoomOrder.getMessageRoomOrder(key), {
            type: "complete",
          });
          const roomOrder = yield* Schema.decodeUnknownEffect(
            Schema.OptionFromNullishOr(DefaultTaggedClass(MessageRoomOrder)),
          )(result);

          if (Option.isNone(roomOrder)) {
            return yield* Effect.die(makeDBQueryError("Failed to persist message room order"));
          }

          return roomOrder.value;
        },
      );

      const getMessageRoomOrderEntry = Effect.fn(
        "MessageRoomOrderService.getMessageRoomOrderEntry",
      )(function* (key: MessageKey, rank: number) {
        const result = yield* zeroClient.run(
          queries.messageRoomOrder.getMessageRoomOrderEntry({ ...key, rank }),
          { type: "complete" },
        );

        return yield* Schema.decodeEffect(Schema.Array(DefaultTaggedClass(MessageRoomOrderEntry)))(
          result,
        );
      });

      const getMessageRoomOrderRange = Effect.fn(
        "MessageRoomOrderService.getMessageRoomOrderRange",
      )(function* (key: MessageKey) {
        const result = yield* zeroClient.run(
          queries.messageRoomOrder.getMessageRoomOrderRange(key),
          { type: "complete" },
        );
        const entries = yield* Schema.decodeEffect(
          Schema.Array(DefaultTaggedClass(MessageRoomOrderEntry)),
        )(result);

        return Array.match(entries, {
          onEmpty: () => Option.none<MessageRoomOrderRange>(),
          onNonEmpty: ([head, ...tail]) => {
            const { minRank, maxRank } = pipe(
              tail,
              Array.reduce(
                {
                  minRank: head.rank,
                  maxRank: head.rank,
                },
                (acc, entry) => ({
                  minRank: Math.min(acc.minRank, entry.rank),
                  maxRank: Math.max(acc.maxRank, entry.rank),
                }),
              ),
            );
            return Option.some(new MessageRoomOrderRange({ minRank, maxRank }));
          },
        });
      });

      const upsertMessageRoomOrderEntry = Effect.fn(
        "MessageRoomOrderService.upsertMessageRoomOrderEntry",
      )(function* (
        key: MessageKey,
        entries: readonly {
          rank: number;
          position: number;
          hour: number;
          team: string;
          tags: readonly string[];
          effectValue: number;
        }[],
      ) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageRoomOrder.upsertMessageRoomOrderEntry({ ...key, entries }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(
          queries.messageRoomOrder.getMessageRoomOrderRange(key),
          { type: "complete" },
        );
        const updatedEntries = yield* Schema.decodeEffect(
          Schema.Array(DefaultTaggedClass(MessageRoomOrderEntry)),
        )(result);

        return updatedEntries.map(
          (entry) =>
            new MessageRoomOrderEntry({
              clientPlatform: entry.clientPlatform,
              clientId: entry.clientId,
              messageId: entry.messageId,
              rank: entry.rank,
              position: entry.position,
              team: entry.team,
              tags: entry.tags,
              effectValue: entry.effectValue,
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
              deletedAt: entry.deletedAt,
            }),
        );
      });

      const removeMessageRoomOrderEntry = Effect.fn(
        "MessageRoomOrderService.removeMessageRoomOrderEntry",
      )(function* (key: MessageKey) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageRoomOrder.removeMessageRoomOrderEntry({
            ...key,
            // Message-level cleanup removes the sentinel range entry stored at rank/position 0.
            rank: 0,
            position: 0,
          }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(
          queries.messageRoomOrder.getMessageRoomOrderRange(key),
          { type: "complete" },
        );
        const updatedEntries = yield* Schema.decodeEffect(
          Schema.Array(DefaultTaggedClass(MessageRoomOrderEntry)),
        )(result);

        return updatedEntries.map(
          (entry) =>
            new MessageRoomOrderEntry({
              clientPlatform: entry.clientPlatform,
              clientId: entry.clientId,
              messageId: entry.messageId,
              rank: entry.rank,
              position: entry.position,
              team: entry.team,
              tags: entry.tags,
              effectValue: entry.effectValue,
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
              deletedAt: entry.deletedAt,
            }),
        );
      });

      return {
        getMessageRoomOrder,
        decrementMessageRoomOrderRank,
        incrementMessageRoomOrderRank,
        claimMessageRoomOrderSend,
        completeMessageRoomOrderSend,
        releaseMessageRoomOrderSendClaim,
        claimMessageRoomOrderTentativeUpdate,
        releaseMessageRoomOrderTentativeUpdateClaim,
        claimMessageRoomOrderTentativePin,
        completeMessageRoomOrderTentativePin,
        releaseMessageRoomOrderTentativePinClaim,
        markMessageRoomOrderTentative,
        upsertMessageRoomOrder,
        persistMessageRoomOrder,
        getMessageRoomOrderEntry,
        getMessageRoomOrderRange,
        upsertMessageRoomOrderEntry,
        removeMessageRoomOrderEntry,
      };
    }),
  },
) {
  static layer = Layer.effect(MessageRoomOrderService, this.make).pipe(
    Layer.provide(ZeroClient.layer),
  );
}
