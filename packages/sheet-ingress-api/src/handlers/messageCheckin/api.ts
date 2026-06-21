// fallow-ignore-file code-duplication
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { SchemaError, ArgumentError, Unauthorized } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
import { MessageCheckin, MessageCheckinMember } from "../../schemas/messageCheckin";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";
import { ClientPlatform, SheetTextPart } from "../../schemas/client";

const MessageCheckinDataPayload = Schema.Struct({
  initialMessage: Schema.Array(SheetTextPart),
  hour: Schema.Number,
  runningConversationId: Schema.String,
  roleId: Schema.optional(Schema.NullOr(Schema.String)),
  workspaceId: Schema.NullOr(Schema.String),
  conversationId: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(Schema.String),
});

const MessageKeyPayload = {
  clientPlatform: ClientPlatform,
  clientId: Schema.String,
  messageId: Schema.String,
} as const;

export class MessageCheckinApi extends HttpApiGroup.make("messageCheckin")
  .add(
    HttpApiEndpoint.get("getMessageCheckinData", "/messageCheckin/getMessageCheckinData", {
      query: Schema.Struct(MessageKeyPayload),
      success: MessageCheckin,
      error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.post("upsertMessageCheckinData", "/messageCheckin/upsertMessageCheckinData", {
      payload: Schema.Struct({
        ...MessageKeyPayload,
        data: MessageCheckinDataPayload,
      }),
      success: MessageCheckin,
      error: [SchemaError, QueryResultError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getMessageCheckinMembers", "/messageCheckin/getMessageCheckinMembers", {
      query: Schema.Struct(MessageKeyPayload),
      success: Schema.Array(MessageCheckinMember),
      error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.post("addMessageCheckinMembers", "/messageCheckin/addMessageCheckinMembers", {
      payload: Schema.Struct({
        ...MessageKeyPayload,
        memberIds: Schema.Array(Schema.String),
      }),
      success: Schema.Array(MessageCheckinMember),
      error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.post("persistMessageCheckin", "/messageCheckin/persistMessageCheckin", {
      payload: Schema.Struct({
        ...MessageKeyPayload,
        data: MessageCheckinDataPayload,
        memberIds: Schema.Array(Schema.String),
      }),
      success: MessageCheckin,
      error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "setMessageCheckinMemberCheckinAt",
      "/messageCheckin/setMessageCheckinMemberCheckinAt",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          memberId: Schema.String,
          checkinAt: Schema.Number,
        }),
        success: MessageCheckinMember,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "setMessageCheckinMemberCheckinAtIfUnset",
      "/messageCheckin/setMessageCheckinMemberCheckinAtIfUnset",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          memberId: Schema.String,
          checkinAt: Schema.Number,
          checkinClaimId: Schema.String,
        }),
        success: MessageCheckinMember,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "removeMessageCheckinMember",
      "/messageCheckin/removeMessageCheckinMember",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          memberId: Schema.String,
        }),
        success: MessageCheckinMember,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Message Checkin")
  .annotate(OpenApi.Description, "Message check-in endpoints") {}
