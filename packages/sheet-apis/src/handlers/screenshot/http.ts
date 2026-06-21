import { Effect, Layer } from "effect";
import { ScreenshotRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { withCurrentWorkspaceAuthFromQuery } from "@/handlers/shared/workspaceAuthorization";
import { getSheetIdFromWorkspaceId } from "@/handlers/shared/workspaceConfig";
import { AuthorizationService, ScreenshotService, WorkspaceConfigService } from "@/services";

export const screenshotLayer = ScreenshotRpcs.toLayer(
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const screenshotService = yield* ScreenshotService;
    const workspaceConfigService = yield* WorkspaceConfigService;
    const withQueryWorkspaceAuth = withCurrentWorkspaceAuthFromQuery(authorizationService);

    return {
      "screenshot.getScreenshot": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          yield* authorizationService.requireMonitorWorkspace(query.workspaceId);
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          return yield* screenshotService.getScreenshot(sheetId, query.conversationName, query.day);
        }),
      ),
    };
  }),
).pipe(
  Layer.provide([
    AuthorizationService.layer,
    ScreenshotService.layer,
    WorkspaceConfigService.layer,
  ]),
);
