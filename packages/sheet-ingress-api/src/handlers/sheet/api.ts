import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { SchemaError } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
import { GoogleSheetsError } from "../../schemas/google";
import { ParserFieldError } from "../../schemas/sheet/error";
import { SheetConfigError } from "../../schemas/sheetConfig";
import {
  EventConfig,
  RangesConfig,
  RunnerConfig,
  ScheduleConfig,
  TeamConfig,
} from "../../schemas/sheetConfig";
import { RawPlayer, RawMonitor, Team, ScheduleResponse, ScheduleView } from "../../schemas/sheet";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";

const SheetError = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
];

const ScheduleViewUrlParam = Schema.optional(ScheduleView);

export class SheetApi extends HttpApiGroup.make("sheet")
  .add(
    HttpApiEndpoint.get("getPlayers", "/sheet/getPlayers", {
      query: Schema.Struct({ workspaceId: Schema.String }),
      success: Schema.Array(RawPlayer),
      error: SheetError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getMonitors", "/sheet/getMonitors", {
      query: Schema.Struct({ workspaceId: Schema.String }),
      success: Schema.Array(RawMonitor),
      error: SheetError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getTeams", "/sheet/getTeams", {
      query: Schema.Struct({ workspaceId: Schema.String }),
      success: Schema.Array(Team),
      error: SheetError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getAllSchedules", "/sheet/getAllSchedules", {
      query: Schema.Struct({ workspaceId: Schema.String, view: ScheduleViewUrlParam }),
      success: ScheduleResponse,
      error: SheetError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getDaySchedules", "/sheet/getDaySchedules", {
      query: Schema.Struct({
        workspaceId: Schema.String,
        day: Schema.NumberFromString,
        view: ScheduleViewUrlParam,
      }),
      success: ScheduleResponse,
      error: SheetError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getConversationSchedules", "/sheet/getConversationSchedules", {
      query: Schema.Struct({
        workspaceId: Schema.String,
        conversationName: Schema.String,
        view: ScheduleViewUrlParam,
      }),
      success: ScheduleResponse,
      error: SheetError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getRangesConfig", "/sheet/getRangesConfig", {
      query: Schema.Struct({ workspaceId: Schema.String }),
      success: RangesConfig,
      error: SheetError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getTeamConfig", "/sheet/getTeamConfig", {
      query: Schema.Struct({ workspaceId: Schema.String }),
      success: Schema.Array(TeamConfig),
      error: SheetError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getEventConfig", "/sheet/getEventConfig", {
      query: Schema.Struct({ workspaceId: Schema.String }),
      success: EventConfig,
      error: SheetError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getScheduleConfig", "/sheet/getScheduleConfig", {
      query: Schema.Struct({ workspaceId: Schema.String }),
      success: Schema.Array(ScheduleConfig),
      error: SheetError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getRunnerConfig", "/sheet/getRunnerConfig", {
      query: Schema.Struct({ workspaceId: Schema.String }),
      success: Schema.Array(RunnerConfig),
      error: SheetError,
    }),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Sheet")
  .annotate(OpenApi.Description, "Sheet data endpoints") {}
