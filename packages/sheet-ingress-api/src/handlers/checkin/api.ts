import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { SchemaError, ArgumentError } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
import { GoogleSheetsError } from "../../schemas/google";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";
import { ParserFieldError } from "../../schemas/sheet/error";
import { SheetConfigError } from "../../schemas/sheetConfig";
import { CheckinGenerateResult } from "../../schemas/checkin";

const CheckinGenerateError = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
  ArgumentError,
];

export class CheckinApi extends HttpApiGroup.make("checkin")
  .add(
    HttpApiEndpoint.post("generate", "/checkin/generate", {
      payload: Schema.Struct({
        workspaceId: Schema.String,
        conversationId: Schema.optional(Schema.String),
        conversationName: Schema.optional(Schema.String),
        hour: Schema.optional(Schema.Number),
        template: Schema.optional(Schema.String),
      }),
      success: CheckinGenerateResult,
      error: CheckinGenerateError,
    }),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Check-in")
  .annotate(OpenApi.Description, "Check-in generation endpoints") {}
