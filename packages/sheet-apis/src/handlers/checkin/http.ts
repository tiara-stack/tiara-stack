import { Effect, Layer } from "effect";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { withCurrentWorkspaceAuthFromPayload } from "@/handlers/shared/workspaceAuthorization";
import { AuthorizationService, CheckinService } from "@/services";

export const checkinLayer = sheetApisGroupLayer(
  "checkin",
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const checkinService = yield* CheckinService;
    const withPayloadWorkspaceAuth = withCurrentWorkspaceAuthFromPayload(authorizationService);

    return {
      "checkin.generate": withPayloadWorkspaceAuth(
        Effect.fnUntraced(function* ({ payload }) {
          yield* authorizationService.requireMonitorWorkspace(payload.workspaceId);
          return yield* checkinService.generate(payload);
        }),
      ),
    } satisfies HandlerMap<"checkin">;
  }),
).pipe(Layer.provide([AuthorizationService.layer, CheckinService.layer]));
