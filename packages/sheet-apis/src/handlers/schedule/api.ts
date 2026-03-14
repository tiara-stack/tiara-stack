import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";
import { ValidationError, QueryResultError } from "typhoon-core/error";
import { GoogleSheetsError } from "@/schemas/google";
import { ParserFieldError } from "@/schemas/sheet/error";
import { SheetConfigError } from "@/schemas/sheetConfig";
import { PopulatedScheduleResult } from "@/schemas/sheet";
import { SheetAuthTokenAuthorization } from "@/middlewares/sheetAuthTokenAuthorization/tag";
import { SheetAuthTokenGuildMonitorAuthorization } from "@/middlewares/sheetAuthTokenGuildMonitorAuthorization/tag";
import { Unauthorized } from "@/schemas/middlewares/unauthorized";

const ScheduleError = Schema.Union(
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  ValidationError,
  QueryResultError,
);

const ScheduleManagerError = Schema.Union(
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  ValidationError,
  QueryResultError,
  Unauthorized,
);

export class ScheduleApi extends HttpApiGroup.make("schedule")
  .add(
    HttpApiEndpoint.get(
      "getAllPopulatedFillerSchedules",
      "/schedule/getAllPopulatedFillerSchedules",
    )
      .setUrlParams(Schema.Struct({ guildId: Schema.String }))
      .addSuccess(Schema.Array(PopulatedScheduleResult))
      .addError(ScheduleError),
  )
  .add(
    HttpApiEndpoint.get(
      "getDayPopulatedFillerSchedules",
      "/schedule/getDayPopulatedFillerSchedules",
    )
      .setUrlParams(Schema.Struct({ guildId: Schema.String, day: Schema.NumberFromString }))
      .addSuccess(Schema.Array(PopulatedScheduleResult))
      .addError(ScheduleError),
  )
  .add(
    HttpApiEndpoint.get(
      "getChannelPopulatedFillerSchedules",
      "/schedule/getChannelPopulatedFillerSchedules",
    )
      .setUrlParams(Schema.Struct({ guildId: Schema.String, channel: Schema.String }))
      .addSuccess(Schema.Array(PopulatedScheduleResult))
      .addError(ScheduleError),
  )
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Schedule")
  .annotate(OpenApi.Description, "Populated schedule data endpoints") {}

export class ScheduleManagerApi extends HttpApiGroup.make("scheduleManager")
  .add(
    HttpApiEndpoint.get(
      "getAllPopulatedManagerSchedules",
      "/schedule/getAllPopulatedManagerSchedules",
    )
      .setUrlParams(Schema.Struct({ guildId: Schema.String }))
      .addSuccess(Schema.Array(PopulatedScheduleResult))
      .addError(ScheduleManagerError),
  )
  .add(
    HttpApiEndpoint.get(
      "getDayPopulatedManagerSchedules",
      "/schedule/getDayPopulatedManagerSchedules",
    )
      .setUrlParams(Schema.Struct({ guildId: Schema.String, day: Schema.NumberFromString }))
      .addSuccess(Schema.Array(PopulatedScheduleResult))
      .addError(ScheduleManagerError),
  )
  .add(
    HttpApiEndpoint.get(
      "getChannelPopulatedManagerSchedules",
      "/schedule/getChannelPopulatedManagerSchedules",
    )
      .setUrlParams(Schema.Struct({ guildId: Schema.String, channel: Schema.String }))
      .addSuccess(Schema.Array(PopulatedScheduleResult))
      .addError(ScheduleManagerError),
  )
  .middleware(SheetAuthTokenGuildMonitorAuthorization)
  .annotate(OpenApi.Title, "Schedule Manager")
  .annotate(OpenApi.Description, "Manager-only populated schedule data endpoints") {}
