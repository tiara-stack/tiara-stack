import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "@effect/platform";
import { SheetAuthUser } from "@/schemas/middlewares/sheetAuthUser";
import { Unauthorized } from "@/schemas/middlewares/unauthorized";

export class SheetAuthTokenGuildMonitorAuthorization extends HttpApiMiddleware.Tag<SheetAuthTokenGuildMonitorAuthorization>()(
  "SheetAuthTokenGuildMonitorAuthorization",
  {
    provides: SheetAuthUser,
    failure: Unauthorized,
    security: {
      sheetAuthToken: HttpApiSecurity.bearer.pipe(
        HttpApiSecurity.annotate(OpenApi.Description, "Require sheet-auth token for authorization"),
      ),
    },
  },
) {}
