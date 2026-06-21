import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { SchemaError } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
import { GoogleSheetsError } from "../../schemas/google";
import { ParserFieldError } from "../../schemas/sheet/error";
import { SheetConfigError } from "../../schemas/sheetConfig";
import { Player, PartialIdPlayer, PartialNamePlayer, Team } from "../../schemas/sheet";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";

const PlayerError = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
];

export class PlayerApi extends HttpApiGroup.make("player")
  .add(
    HttpApiEndpoint.get("getPlayerMaps", "/player/getPlayerMaps", {
      query: Schema.Struct({ workspaceId: Schema.String }),
      success: Schema.Struct({
        nameToPlayer: Schema.Array(
          Schema.Struct({
            key: Schema.String,
            value: Schema.Struct({
              name: Schema.String,
              players: Schema.Array(Player),
            }),
          }),
        ),
        idToPlayer: Schema.Array(
          Schema.Struct({
            key: Schema.String,
            value: Schema.Array(Player),
          }),
        ),
      }),
      error: PlayerError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getByIds", "/player/getByIds", {
      query: Schema.Struct({ workspaceId: Schema.String, ids: Schema.Array(Schema.String) }),
      success: Schema.Array(Schema.Array(Schema.Union([Player, PartialIdPlayer]))),
      error: PlayerError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getByNames", "/player/getByNames", {
      query: Schema.Struct({ workspaceId: Schema.String, names: Schema.Array(Schema.String) }),
      success: Schema.Array(Schema.Array(Schema.Union([Player, PartialNamePlayer]))),
      error: PlayerError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getTeamsByIds", "/player/getTeamsByIds", {
      query: Schema.Struct({ workspaceId: Schema.String, ids: Schema.Array(Schema.String) }),
      success: Schema.Array(Schema.Array(Team)),
      error: PlayerError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getTeamsByNames", "/player/getTeamsByNames", {
      query: Schema.Struct({ workspaceId: Schema.String, names: Schema.Array(Schema.String) }),
      success: Schema.Array(Schema.Array(Team)),
      error: PlayerError,
    }),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Player")
  .annotate(OpenApi.Description, "Player data endpoints") {}
