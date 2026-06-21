import { Effect, Layer } from "effect";
import { CheckinRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { withCurrentWorkspaceAuthFromPayload } from "@/handlers/shared/workspaceAuthorization";
import { AuthorizationService, CheckinService } from "@/services";

export const checkinLayer = CheckinRpcs.toLayer(
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
    };
  }),
).pipe(Layer.provide([AuthorizationService.layer, CheckinService.layer]));
