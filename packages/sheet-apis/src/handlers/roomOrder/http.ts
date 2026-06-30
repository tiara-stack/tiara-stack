import { Effect, Layer } from "effect";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { withCurrentWorkspaceAuthFromPayload } from "@/handlers/shared/workspaceAuthorization";
import { AuthorizationService, RoomOrderService } from "@/services";

export const roomOrderLayer = sheetApisGroupLayer(
  "roomOrder",
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const roomOrderService = yield* RoomOrderService;
    const withPayloadWorkspaceAuth = withCurrentWorkspaceAuthFromPayload(authorizationService);

    return {
      "roomOrder.generate": withPayloadWorkspaceAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireMonitorWorkspace(payload.workspaceId);
          return yield* roomOrderService.generate(payload);
        }),
      ),
    } satisfies HandlerMap<"roomOrder">;
  }),
).pipe(Layer.provide([AuthorizationService.layer, RoomOrderService.layer]));
