import { Effect, Layer } from "effect";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { withCurrentWorkspaceAuthFromQuery } from "@/handlers/shared/workspaceAuthorization";
import { getSheetIdFromWorkspaceId } from "@/handlers/shared/workspaceConfig";
import { AuthorizationService, ScreenshotService, WorkspaceConfigService } from "@/services";

export const screenshotLayer = sheetApisGroupLayer(
  "screenshot",
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
    } satisfies HandlerMap<"screenshot">;
  }),
).pipe(
  Layer.provide([
    AuthorizationService.layer,
    ScreenshotService.layer,
    WorkspaceConfigService.layer,
  ]),
);
