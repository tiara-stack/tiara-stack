import { Effect, Layer, Predicate } from "effect";
import { PermissionsRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { AuthorizationService } from "@/services";

export const permissionsLayer = PermissionsRpcs.toLayer(
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;

    return {
      "permissions.getCurrentUserPermissions": Effect.fnUntraced(function* ({ query }) {
        const resolvedUser = Predicate.isString(query.workspaceId)
          ? yield* authorizationService.resolveCurrentWorkspaceUser(query.workspaceId)
          : yield* SheetAuthUser;
        return {
          permissions: resolvedUser.permissions,
        };
      }),
    };
  }),
).pipe(Layer.provide([AuthorizationService.layer]));
