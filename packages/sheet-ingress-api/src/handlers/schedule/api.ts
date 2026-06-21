import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { SchemaError } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
import { GoogleSheetsError } from "../../schemas/google";
import { ParserFieldError } from "../../schemas/sheet/error";
import { SheetConfigError } from "../../schemas/sheetConfig";
import {
  PlayerDayScheduleResponse,
  PopulatedScheduleResponse,
  ScheduleView,
} from "../../schemas/sheet";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";

const ScheduleError = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
];

const ScheduleViewUrlParam = Schema.optional(ScheduleView);

export class ScheduleApi extends HttpApiGroup.make("schedule")
  .add(
    HttpApiEndpoint.get("getAllPopulatedSchedules", "/schedule/getAllPopulatedSchedules", {
      query: Schema.Struct({ workspaceId: Schema.String, view: ScheduleViewUrlParam }),
      success: PopulatedScheduleResponse,
      error: ScheduleError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getDayPopulatedSchedules", "/schedule/getDayPopulatedSchedules", {
      query: Schema.Struct({
        workspaceId: Schema.String,
        day: Schema.NumberFromString,
        view: ScheduleViewUrlParam,
      }),
      success: PopulatedScheduleResponse,
      error: ScheduleError,
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "getConversationPopulatedSchedules",
      "/schedule/getConversationPopulatedSchedules",
      {
        query: Schema.Struct({
          workspaceId: Schema.String,
          conversationName: Schema.String,
          view: ScheduleViewUrlParam,
        }),
        success: PopulatedScheduleResponse,
        error: ScheduleError,
      },
    ),
  )
  .add(
    HttpApiEndpoint.get("getDayPlayerSchedule", "/schedule/getDayPlayerSchedule", {
      query: Schema.Struct({
        workspaceId: Schema.String,
        day: Schema.NumberFromString,
        accountId: Schema.String,
        view: ScheduleViewUrlParam,
      }),
      success: PlayerDayScheduleResponse,
      error: ScheduleError,
    }),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Schedule")
  .annotate(OpenApi.Description, "Populated schedule data endpoints") {}
