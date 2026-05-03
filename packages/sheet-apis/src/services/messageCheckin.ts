import { Array, Effect, Layer, Option, Context, Schema } from "effect";
import { mutators, queries } from "sheet-db-schema/zero";
import { makeDBQueryError } from "typhoon-core/error";
import { DefaultTaggedClass } from "typhoon-core/schema";
import { ZeroClient } from "./zeroClient";
import { MessageCheckin, MessageCheckinMember } from "sheet-ingress-api/schemas/messageCheckin";

export class MessageCheckinService extends Context.Service<MessageCheckinService>()(
  "MessageCheckinService",
  {
    make: Effect.gen(function* () {
      const zeroClient = yield* ZeroClient;

      const getMessageCheckinData = Effect.fn("MessageCheckinService.getMessageCheckinData")(
        function* (messageId: string) {
          const result = yield* zeroClient.run(
            queries.messageCheckin.getMessageCheckinData({ messageId }),
            {
              type: "complete",
            },
          );

          return yield* Schema.decodeEffect(
            Schema.OptionFromNullishOr(DefaultTaggedClass(MessageCheckin)),
          )(result);
        },
      );

      const upsertMessageCheckinData = Effect.fn("MessageCheckinService.upsertMessageCheckinData")(
        function* (
          messageId: string,
          data: {
            initialMessage: string;
            hour: number;
            channelId: string;
            roleId?: string | null | undefined;
            guildId: string | null;
            messageChannelId: string | null;
            createdByUserId: string | null;
          },
        ) {
          const mutation = yield* zeroClient.mutate(
            mutators.messageCheckin.upsertMessageCheckinData({
              messageId,
              initialMessage: data.initialMessage,
              hour: data.hour,
              channelId: data.channelId,
              roleId: data.roleId,
              guildId: data.guildId,
              messageChannelId: data.messageChannelId,
              createdByUserId: data.createdByUserId,
            }),
          );
          yield* mutation.server();

          const result = yield* zeroClient.run(
            queries.messageCheckin.getMessageCheckinData({ messageId }),
            {
              type: "complete",
            },
          );
          const messageCheckin = yield* Schema.decodeEffect(
            Schema.OptionFromNullishOr(DefaultTaggedClass(MessageCheckin)),
          )(result);

          if (Option.isNone(messageCheckin)) {
            return yield* Effect.die(makeDBQueryError("Failed to upsert message check-in data"));
          }

          return messageCheckin.value;
        },
      );

      const getMessageCheckinMembers = Effect.fn("MessageCheckinService.getMessageCheckinMembers")(
        function* (messageId: string) {
          const result = yield* zeroClient.run(
            queries.messageCheckin.getMessageCheckinMembers({ messageId }),
            {
              type: "complete",
            },
          );

          return yield* Schema.decodeEffect(Schema.Array(DefaultTaggedClass(MessageCheckinMember)))(
            result,
          );
        },
      );

      const addMessageCheckinMembers = Effect.fn("MessageCheckinService.addMessageCheckinMembers")(
        function* (messageId: string, memberIds: readonly string[]) {
          const mutation = yield* zeroClient.mutate(
            mutators.messageCheckin.addMessageCheckinMembers({ messageId, memberIds }),
          );
          yield* mutation.server();

          const result = yield* zeroClient.run(
            queries.messageCheckin.getMessageCheckinMembers({ messageId }),
            {
              type: "complete",
            },
          );

          return yield* Schema.decodeEffect(Schema.Array(DefaultTaggedClass(MessageCheckinMember)))(
            result,
          );
        },
      );

      const persistMessageCheckin = Effect.fn("MessageCheckinService.persistMessageCheckin")(
        function* (
          messageId: string,
          payload: {
            data: {
              initialMessage: string;
              hour: number;
              channelId: string;
              roleId?: string | null | undefined;
              guildId: string | null;
              messageChannelId: string | null;
              createdByUserId: string | null;
            };
            memberIds: readonly string[];
          },
        ) {
          const mutation = yield* zeroClient.mutate(
            mutators.messageCheckin.persistMessageCheckin({
              messageId,
              data: payload.data,
              memberIds: payload.memberIds,
            }),
          );
          yield* mutation.server();

          const result = yield* zeroClient.run(
            queries.messageCheckin.getMessageCheckinData({ messageId }),
            {
              type: "complete",
            },
          );
          const messageCheckin = yield* Schema.decodeEffect(
            Schema.OptionFromNullishOr(DefaultTaggedClass(MessageCheckin)),
          )(result);

          if (Option.isNone(messageCheckin)) {
            return yield* Effect.die(makeDBQueryError("Failed to persist message check-in data"));
          }

          return messageCheckin.value;
        },
      );

      const setMessageCheckinMemberCheckinAt = Effect.fn(
        "MessageCheckinService.setMessageCheckinMemberCheckinAt",
      )(function* (messageId: string, memberId: string, checkinAt: number) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageCheckin.setMessageCheckinMemberCheckinAt({
            messageId,
            memberId,
            checkinAt,
          }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(
          queries.messageCheckin.getMessageCheckinMembers({ messageId }),
          {
            type: "complete",
          },
        );
        const members = yield* Schema.decodeEffect(
          Schema.Array(DefaultTaggedClass(MessageCheckinMember)),
        )(result);
        const member = Array.findFirst(members, (item) => item.memberId === memberId);

        if (Option.isNone(member)) {
          return yield* Effect.die(makeDBQueryError("Failed to set check-in timestamp"));
        }

        return member.value;
      });

      const setMessageCheckinMemberCheckinAtIfUnset = Effect.fn(
        "MessageCheckinService.setMessageCheckinMemberCheckinAtIfUnset",
      )(function* (messageId: string, memberId: string, checkinAt: number) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageCheckin.setMessageCheckinMemberCheckinAtIfUnset({
            messageId,
            memberId,
            checkinAt,
          }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(
          queries.messageCheckin.getMessageCheckinMembers({ messageId }),
          {
            type: "complete",
          },
        );
        const members = yield* Schema.decodeEffect(
          Schema.Array(DefaultTaggedClass(MessageCheckinMember)),
        )(result);
        const member = Array.findFirst(members, (item) => item.memberId === memberId);

        if (Option.isNone(member)) {
          return yield* Effect.die(makeDBQueryError("Failed to set check-in timestamp"));
        }

        return member.value;
      });

      const removeMessageCheckinMember = Effect.fn(
        "MessageCheckinService.removeMessageCheckinMember",
      )(function* (messageId: string, memberId: string) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageCheckin.removeMessageCheckinMember({ messageId, memberId }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(
          queries.messageCheckin.getMessageCheckinMembers({ messageId }),
          {
            type: "complete",
          },
        );
        const members = yield* Schema.decodeEffect(
          Schema.Array(DefaultTaggedClass(MessageCheckinMember)),
        )(result);
        const member = Array.findFirst(members, (item) => item.memberId === memberId);

        if (Option.isNone(member)) {
          return yield* Effect.die(makeDBQueryError("Failed to remove check-in member"));
        }

        return member.value;
      });

      return {
        getMessageCheckinData,
        upsertMessageCheckinData,
        getMessageCheckinMembers,
        addMessageCheckinMembers,
        persistMessageCheckin,
        setMessageCheckinMemberCheckinAt,
        setMessageCheckinMemberCheckinAtIfUnset,
        removeMessageCheckinMember,
      };
    }),
  },
) {
  static layer = Layer.effect(MessageCheckinService, this.make).pipe(
    Layer.provide(ZeroClient.layer),
  );
}
