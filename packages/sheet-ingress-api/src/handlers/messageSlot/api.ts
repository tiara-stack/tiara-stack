import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { SchemaError, ArgumentError } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
import { MessageSlot } from "../../schemas/messageSlot";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";
import { ClientPlatform } from "../../schemas/client";

const MessageKeyPayload = {
  clientPlatform: ClientPlatform,
  clientId: Schema.String,
  messageId: Schema.String,
} as const;

export class MessageSlotApi extends HttpApiGroup.make("messageSlot")
  .add(
    HttpApiEndpoint.get("getMessageSlotData", "/messageSlot/getMessageSlotData", {
      query: Schema.Struct(MessageKeyPayload),
      success: MessageSlot,
      error: [SchemaError, QueryResultError, ArgumentError],
    }),
  )
  .add(
    HttpApiEndpoint.post("upsertMessageSlotData", "/messageSlot/upsertMessageSlotData", {
      payload: Schema.Struct({
        ...MessageKeyPayload,
        data: Schema.Struct({
          day: Schema.Number,
          workspaceId: Schema.NullOr(Schema.String),
          conversationId: Schema.NullOr(Schema.String),
          createdByUserId: Schema.NullOr(Schema.String),
        }),
      }),
      success: MessageSlot,
      error: [SchemaError, QueryResultError],
    }),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Message Slot")
  .annotate(OpenApi.Description, "Message slot endpoints") {}
