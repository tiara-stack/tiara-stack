import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { SchemaError, ArgumentError } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import { SheetApisServiceUserFallback } from "../../middlewares/sheetApisServiceUserFallback/tag";
import { CurrentUserPermissions } from "../../schemas/permissions";

export class PermissionsApi extends HttpApiGroup.make("permissions")
  .add(
    HttpApiEndpoint.get("getCurrentUserPermissions", "/permissions", {
      query: Schema.Struct({
        workspaceId: Schema.optional(Schema.String),
      }),
      success: CurrentUserPermissions,
      error: [SchemaError, QueryResultError, ArgumentError],
    }),
  )
  .middleware(SheetApisServiceUserFallback)
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Permissions")
  .annotate(OpenApi.Description, "Permission endpoints") {}
