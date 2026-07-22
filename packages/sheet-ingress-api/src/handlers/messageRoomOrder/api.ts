import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { ArgumentError, SchemaError, Unauthorized } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import {
  MessageRoomOrder,
  MessageRoomOrderEntry,
  MessageRoomOrderRange,
} from "../../schemas/messageRoomOrder";
import { ClientPlatform } from "../../schemas/client";

const MessageKeyPayload = {
  clientPlatform: ClientPlatform,
  clientId: Schema.String,
  messageId: Schema.String,
} as const;

const MessageRoomOrderDataPayload = Schema.Struct({
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

const MessageRoomOrderEntryPayload = Schema.Struct({
  rank: Schema.Number,
  position: Schema.Number,
  hour: Schema.Number,
  team: Schema.String,
  tags: Schema.Array(Schema.String),
  effectValue: Schema.Number,
});

export class MessageRoomOrderApi extends HttpApiGroup.make("messageRoomOrder")
  .add(
    HttpApiEndpoint.get("getMessageRoomOrder", "/messageRoomOrder/getMessageRoomOrder", {
      query: Schema.Struct(MessageKeyPayload),
      success: MessageRoomOrder,
      error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.post("upsertMessageRoomOrder", "/messageRoomOrder/upsertMessageRoomOrder", {
      payload: Schema.Struct({
        ...MessageKeyPayload,
        data: MessageRoomOrderDataPayload,
      }),
      success: MessageRoomOrder,
      error: [SchemaError, QueryResultError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.post("persistMessageRoomOrder", "/messageRoomOrder/persistMessageRoomOrder", {
      payload: Schema.Struct({
        ...MessageKeyPayload,
        data: MessageRoomOrderDataPayload,
        entries: Schema.Array(MessageRoomOrderEntryPayload),
      }),
      success: MessageRoomOrder,
      error: [SchemaError, QueryResultError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "decrementMessageRoomOrderRank",
      "/messageRoomOrder/decrementMessageRoomOrderRank",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          expectedRank: Schema.optional(Schema.Number),
          tentativeUpdateClaimId: Schema.optional(Schema.String),
        }),
        success: MessageRoomOrder,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "incrementMessageRoomOrderRank",
      "/messageRoomOrder/incrementMessageRoomOrderRank",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          expectedRank: Schema.optional(Schema.Number),
          tentativeUpdateClaimId: Schema.optional(Schema.String),
        }),
        success: MessageRoomOrder,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.get("getMessageRoomOrderEntry", "/messageRoomOrder/getMessageRoomOrderEntry", {
      query: Schema.Struct({
        ...MessageKeyPayload,
        rank: Schema.NumberFromString,
      }),
      success: Schema.Array(MessageRoomOrderEntry),
      error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getMessageRoomOrderRange", "/messageRoomOrder/getMessageRoomOrderRange", {
      query: Schema.Struct(MessageKeyPayload),
      success: MessageRoomOrderRange,
      error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "upsertMessageRoomOrderEntry",
      "/messageRoomOrder/upsertMessageRoomOrderEntry",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          entries: Schema.Array(MessageRoomOrderEntryPayload),
        }),
        success: Schema.Array(MessageRoomOrderEntry),
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "removeMessageRoomOrderEntry",
      "/messageRoomOrder/removeMessageRoomOrderEntry",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
        }),
        success: Schema.Array(MessageRoomOrderEntry),
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "claimMessageRoomOrderSend",
      "/messageRoomOrder/claimMessageRoomOrderSend",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          claimId: Schema.String,
        }),
        success: MessageRoomOrder,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "completeMessageRoomOrderSend",
      "/messageRoomOrder/completeMessageRoomOrderSend",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          claimId: Schema.String,
          sentMessage: Schema.Struct({
            id: Schema.String,
            conversationId: Schema.String,
          }),
        }),
        success: MessageRoomOrder,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "releaseMessageRoomOrderSendClaim",
      "/messageRoomOrder/releaseMessageRoomOrderSendClaim",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          claimId: Schema.String,
        }),
        success: Schema.Void,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "claimMessageRoomOrderTentativeUpdate",
      "/messageRoomOrder/claimMessageRoomOrderTentativeUpdate",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          claimId: Schema.String,
        }),
        success: MessageRoomOrder,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "releaseMessageRoomOrderTentativeUpdateClaim",
      "/messageRoomOrder/releaseMessageRoomOrderTentativeUpdateClaim",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          claimId: Schema.String,
        }),
        success: Schema.Void,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "claimMessageRoomOrderTentativePin",
      "/messageRoomOrder/claimMessageRoomOrderTentativePin",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          claimId: Schema.String,
        }),
        success: MessageRoomOrder,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "completeMessageRoomOrderTentativePin",
      "/messageRoomOrder/completeMessageRoomOrderTentativePin",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          claimId: Schema.String,
        }),
        success: MessageRoomOrder,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "releaseMessageRoomOrderTentativePinClaim",
      "/messageRoomOrder/releaseMessageRoomOrderTentativePinClaim",
      {
        payload: Schema.Struct({
          ...MessageKeyPayload,
          claimId: Schema.String,
        }),
        success: Schema.Void,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "markMessageRoomOrderTentative",
      "/messageRoomOrder/markMessageRoomOrderTentative",
      {
        payload: Schema.Struct(MessageKeyPayload),
        success: MessageRoomOrder,
        error: [SchemaError, QueryResultError, ArgumentError, Unauthorized],
      },
    ),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Message Room Order")
  .annotate(OpenApi.Description, "Message room order endpoints") {}
