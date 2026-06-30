import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "effect/unstable/httpapi";
import { Unauthorized } from "typhoon-core/error";
import { SheetAuthUser } from "../../schemas/middlewares/sheetAuthUser";

export class SheetIngressServiceAuthorization extends HttpApiMiddleware.Service<
  SheetIngressServiceAuthorization,
  {
    provides: SheetAuthUser;
    requires: never;
    error: Unauthorized;
    requiredForClient: false;
    security: {
      sheetIngressServiceToken: HttpApiSecurity.Bearer;
    };
  }
>()("SheetIngressServiceAuthorization", {
  requiredForClient: false,
  error: Unauthorized,
  security: {
    sheetIngressServiceToken: HttpApiSecurity.bearer.pipe(
      HttpApiSecurity.annotate(
        OpenApi.Description,
        "Require an ingress delegation token for internal service-to-service calls",
      ),
    ),
  },
}) {}
