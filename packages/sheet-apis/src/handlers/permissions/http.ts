import { Effect, Layer, Predicate } from "effect";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { AuthorizationService } from "@/services";

export const permissionsLayer = sheetApisGroupLayer(
  "permissions",
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
    } satisfies HandlerMap<"permissions">;
  }),
).pipe(Layer.provide([AuthorizationService.layer]));
