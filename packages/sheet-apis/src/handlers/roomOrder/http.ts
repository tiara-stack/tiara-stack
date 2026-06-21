import { Effect, Layer } from "effect";
import { RoomOrderRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { withCurrentWorkspaceAuthFromPayload } from "@/handlers/shared/workspaceAuthorization";
import { AuthorizationService, RoomOrderService } from "@/services";

export const roomOrderLayer = RoomOrderRpcs.toLayer(
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
    };
  }),
).pipe(Layer.provide([AuthorizationService.layer, RoomOrderService.layer]));
