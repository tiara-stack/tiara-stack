import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { SchemaError, ArgumentError, UnknownError } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";
import { RoomOrderGenerateResult } from "../../schemas/roomOrder";
import { GoogleSheetsError } from "../../schemas/google";
import { ParserFieldError } from "../../schemas/sheet/error";
import { SheetConfigError } from "../../schemas/sheetConfig";
import {
  RoomOrderDispatchPayload,
  RoomOrderDispatchResult,
  RoomOrderHandleButtonPayload,
  RoomOrderHandleButtonResult,
} from "../../sheet-apis-rpc";

const RoomOrderGenerateError = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
  ArgumentError,
];

const RoomOrderDispatchError = [...RoomOrderGenerateError, UnknownError];
const RoomOrderHandleButtonError = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
  ArgumentError,
  UnknownError,
];

export class RoomOrderApi extends HttpApiGroup.make("roomOrder")
  .add(
    HttpApiEndpoint.post("generate", "/roomOrder/generate", {
      payload: Schema.Struct({
        guildId: Schema.String,
        channelId: Schema.optional(Schema.String),
        channelName: Schema.optional(Schema.String),
        hour: Schema.optional(Schema.Number),
        healNeeded: Schema.optional(Schema.Number),
      }),
      success: RoomOrderGenerateResult,
      error: RoomOrderGenerateError,
    }),
  )
  .add(
    HttpApiEndpoint.post("dispatch", "/roomOrder/dispatch", {
      payload: RoomOrderDispatchPayload,
      success: RoomOrderDispatchResult,
      error: RoomOrderDispatchError,
    }),
  )
  .add(
    HttpApiEndpoint.post("handleButton", "/roomOrder/buttons/handle", {
      payload: RoomOrderHandleButtonPayload,
      success: RoomOrderHandleButtonResult,
      error: RoomOrderHandleButtonError,
    }),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Room Order")
  .annotate(OpenApi.Description, "Room order generation endpoints") {}
