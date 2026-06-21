import { Array, Effect, HashMap, Layer } from "effect";
import { MonitorRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { withCurrentWorkspaceAuthFromQuery } from "@/handlers/shared/workspaceAuthorization";
import { getSheetIdFromWorkspaceId } from "@/handlers/shared/workspaceConfig";
import { AuthorizationService, WorkspaceConfigService, MonitorService } from "@/services";

export const monitorLayer = MonitorRpcs.toLayer(
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const monitorService = yield* MonitorService;
    const workspaceConfigService = yield* WorkspaceConfigService;
    const withQueryWorkspaceAuth = withCurrentWorkspaceAuthFromQuery(authorizationService);

    return {
      "monitor.getMonitorMaps": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          yield* authorizationService.requireMonitorWorkspace(query.workspaceId);
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          const monitorMaps = yield* monitorService.getMonitorMaps(sheetId);

          return {
            idToMonitor: Array.fromIterable(HashMap.entries(monitorMaps.idToMonitor)).map(
              ([key, value]) => ({
                key,
                value: Array.fromIterable(value),
              }),
            ),
            nameToMonitor: Array.fromIterable(HashMap.entries(monitorMaps.nameToMonitor)).map(
              ([key, value]) => ({
                key,
                value: { name: value.name, monitors: Array.fromIterable(value.monitors) },
              }),
            ),
          };
        }),
      ),
      "monitor.getByIds": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          yield* authorizationService.requireMonitorWorkspace(query.workspaceId);
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          return yield* monitorService.getByIds(sheetId, query.ids);
        }),
      ),
      "monitor.getByNames": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          yield* authorizationService.requireMonitorWorkspace(query.workspaceId);
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          return yield* monitorService.getByNames(sheetId, query.names);
        }),
      ),
    };
  }),
).pipe(
  Layer.provide([AuthorizationService.layer, MonitorService.layer, WorkspaceConfigService.layer]),
);
