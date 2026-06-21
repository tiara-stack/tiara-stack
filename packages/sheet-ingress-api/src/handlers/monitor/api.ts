import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { SchemaError } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
import { GoogleSheetsError } from "../../schemas/google";
import { ParserFieldError } from "../../schemas/sheet/error";
import { SheetConfigError } from "../../schemas/sheetConfig";
import { Monitor, PartialIdMonitor, PartialNameMonitor } from "../../schemas/sheet";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";

const MonitorError = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
];

export class MonitorApi extends HttpApiGroup.make("monitor")
  .add(
    HttpApiEndpoint.get("getMonitorMaps", "/monitor/getMonitorMaps", {
      query: Schema.Struct({ workspaceId: Schema.String }),
      success: Schema.Struct({
        idToMonitor: Schema.Array(
          Schema.Struct({
            key: Schema.String,
            value: Schema.Array(Monitor),
          }),
        ),
        nameToMonitor: Schema.Array(
          Schema.Struct({
            key: Schema.String,
            value: Schema.Struct({
              name: Schema.String,
              monitors: Schema.Array(Monitor),
            }),
          }),
        ),
      }),
      error: MonitorError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getByIds", "/monitor/getByIds", {
      query: Schema.Struct({ workspaceId: Schema.String, ids: Schema.Array(Schema.String) }),
      success: Schema.Array(Schema.Array(Schema.Union([Monitor, PartialIdMonitor]))),
      error: MonitorError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getByNames", "/monitor/getByNames", {
      query: Schema.Struct({ workspaceId: Schema.String, names: Schema.Array(Schema.String) }),
      success: Schema.Array(Schema.Array(Schema.Union([Monitor, PartialNameMonitor]))),
      error: MonitorError,
    }),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Monitor")
  .annotate(OpenApi.Description, "Monitor data endpoints") {}
