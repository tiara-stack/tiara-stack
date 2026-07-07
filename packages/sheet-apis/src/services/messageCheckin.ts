import { Array, Effect, Layer, Option, Context, Schema } from "effect";
import { mutators, queries } from "sheet-db-schema/zero";
import { makeArgumentError, makeDBQueryError } from "typhoon-core/error";
import { DefaultTaggedClass } from "typhoon-core/schema";
import { ZeroClient } from "./zeroClient";
import { MessageCheckin, MessageCheckinMember } from "sheet-ingress-api/schemas/messageCheckin";
import type { MessageKey } from "./messageKey";
import type { SheetTextPart } from "sheet-ingress-api/schemas/client";

export class MessageCheckinMemberNotRegisteredError extends Schema.TaggedErrorClass<MessageCheckinMemberNotRegisteredError>()(
  "MessageCheckinMemberNotRegisteredError",
  {
    message: Schema.String,
  },
) {}

const memberNotRegisteredError = () =>
  new MessageCheckinMemberNotRegisteredError({
    message: "Member is not registered for this check-in",
  });

export class MessageCheckinService extends Context.Service<MessageCheckinService>()(
  "MessageCheckinService",
  {
    make: Effect.gen(function* () {
      const zeroClient = yield* ZeroClient;

      const getMessageCheckinData = Effect.fn("MessageCheckinService.getMessageCheckinData")(
        function* (key: MessageKey) {
          const result = yield* zeroClient.run(queries.messageCheckin.getMessageCheckinData(key), {
            type: "complete",
          });

          return yield* Schema.decodeUnknownEffect(
            Schema.OptionFromNullishOr(DefaultTaggedClass(MessageCheckin)),
          )(result);
        },
      );

      const upsertMessageCheckinData = Effect.fn("MessageCheckinService.upsertMessageCheckinData")(
        function* (
          key: MessageKey,
          data: {
            initialMessage: ReadonlyArray<SheetTextPart>;
            hour: number;
            runningConversationId: string;
            roleId?: string | null | undefined;
            workspaceId: string | null;
            conversationId: string | null;
            createdByUserId: string | null;
          },
        ) {
          const mutation = yield* zeroClient.mutate(
            mutators.messageCheckin.upsertMessageCheckinData({
              ...key,
              initialMessage: data.initialMessage,
              hour: data.hour,
              runningConversationId: data.runningConversationId,
              roleId: data.roleId,
              workspaceId: data.workspaceId,
              conversationId: data.conversationId,
              createdByUserId: data.createdByUserId,
            }),
          );
          yield* mutation.server();

          const result = yield* zeroClient.run(queries.messageCheckin.getMessageCheckinData(key), {
            type: "complete",
          });
          const messageCheckin = yield* Schema.decodeUnknownEffect(
            Schema.OptionFromNullishOr(DefaultTaggedClass(MessageCheckin)),
          )(result);

          if (Option.isNone(messageCheckin)) {
            return yield* Effect.die(makeDBQueryError("Failed to upsert message check-in data"));
          }

          return messageCheckin.value;
        },
      );

      const getMessageCheckinMembers = Effect.fn("MessageCheckinService.getMessageCheckinMembers")(
        function* (key: MessageKey) {
          const result = yield* zeroClient.run(
            queries.messageCheckin.getMessageCheckinMembers(key),
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
        function* (key: MessageKey, memberIds: readonly string[]) {
          const mutation = yield* zeroClient.mutate(
            mutators.messageCheckin.addMessageCheckinMembers({ ...key, memberIds }),
          );
          yield* mutation.server();

          const result = yield* zeroClient.run(
            queries.messageCheckin.getMessageCheckinMembers(key),
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
          key: MessageKey,
          payload: {
            data: {
              initialMessage: ReadonlyArray<SheetTextPart>;
              hour: number;
              runningConversationId: string;
              roleId?: string | null | undefined;
              workspaceId: string | null;
              conversationId: string | null;
              createdByUserId: string | null;
            };
            memberIds: readonly string[];
          },
        ) {
          const mutation = yield* zeroClient.mutate(
            mutators.messageCheckin.persistMessageCheckin({
              ...key,
              data: payload.data,
              memberIds: payload.memberIds,
            }),
          );
          yield* mutation.server();

          const result = yield* zeroClient.run(queries.messageCheckin.getMessageCheckinData(key), {
            type: "complete",
          });
          const messageCheckin = yield* Schema.decodeUnknownEffect(
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
      )(function* (key: MessageKey, memberId: string, checkinAt: number, checkinClaimId?: string) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageCheckin.setMessageCheckinMemberCheckinAt({
            ...key,
            memberId,
            checkinAt,
            checkinClaimId,
          }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(queries.messageCheckin.getMessageCheckinMembers(key), {
          type: "complete",
        });
        const members = yield* Schema.decodeEffect(
          Schema.Array(DefaultTaggedClass(MessageCheckinMember)),
        )(result);
        const member = Array.findFirst(members, (item) => item.memberId === memberId);

        if (Option.isNone(member)) {
          return yield* Effect.fail(
            makeArgumentError("Member is not registered for this check-in"),
          );
        }

        return member.value;
      });

      const setMessageCheckinMemberCheckinAtIfUnset = Effect.fn(
        "MessageCheckinService.setMessageCheckinMemberCheckinAtIfUnset",
      )(function* (key: MessageKey, memberId: string, checkinAt: number, checkinClaimId: string) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageCheckin.setMessageCheckinMemberCheckinAtIfUnset({
            ...key,
            memberId,
            checkinAt,
            checkinClaimId,
          }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(queries.messageCheckin.getMessageCheckinMembers(key), {
          type: "complete",
        });
        const members = yield* Schema.decodeEffect(
          Schema.Array(DefaultTaggedClass(MessageCheckinMember)),
        )(result);
        const member = Array.findFirst(members, (item) => item.memberId === memberId);

        if (Option.isNone(member)) {
          return yield* memberNotRegisteredError();
        }

        return member.value;
      });

      const removeMessageCheckinMember = Effect.fn(
        "MessageCheckinService.removeMessageCheckinMember",
      )(function* (key: MessageKey, memberId: string) {
        const mutation = yield* zeroClient.mutate(
          mutators.messageCheckin.removeMessageCheckinMember({ ...key, memberId }),
        );
        yield* mutation.server();

        const result = yield* zeroClient.run(queries.messageCheckin.getMessageCheckinMembers(key), {
          type: "complete",
        });
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
