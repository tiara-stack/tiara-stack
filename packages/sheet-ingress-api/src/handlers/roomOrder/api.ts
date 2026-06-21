import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { SchemaError, ArgumentError } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";
import { RoomOrderGenerateResult } from "../../schemas/roomOrder";
import { GoogleSheetsError } from "../../schemas/google";
import { ParserFieldError } from "../../schemas/sheet/error";
import { SheetConfigError } from "../../schemas/sheetConfig";

const RoomOrderGenerateError = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
  ArgumentError,
];

export class RoomOrderApi extends HttpApiGroup.make("roomOrder")
  .add(
    HttpApiEndpoint.post("generate", "/roomOrder/generate", {
      payload: Schema.Struct({
        workspaceId: Schema.String,
        conversationId: Schema.optional(Schema.String),
        conversationName: Schema.optional(Schema.String),
        hour: Schema.optional(Schema.Number),
        healNeeded: Schema.optional(Schema.Number),
      }),
      success: RoomOrderGenerateResult,
      error: RoomOrderGenerateError,
    }),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Room Order")
  .annotate(OpenApi.Description, "Room order generation endpoints") {}
