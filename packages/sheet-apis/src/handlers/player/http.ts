import { Array, Effect, HashMap, Layer } from "effect";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { withCurrentWorkspaceAuthFromQuery } from "@/handlers/shared/workspaceAuthorization";
import { getSheetIdFromWorkspaceId } from "@/handlers/shared/workspaceConfig";
import { AuthorizationService, PlayerService, WorkspaceConfigService } from "@/services";

export const playerLayer = sheetApisGroupLayer(
  "player",
  Effect.gen(function* () {
    const authorizationService = yield* AuthorizationService;
    const playerService = yield* PlayerService;
    const workspaceConfigService = yield* WorkspaceConfigService;
    const withQueryWorkspaceAuth = withCurrentWorkspaceAuthFromQuery(authorizationService);

    return {
      "player.getPlayerMaps": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          yield* authorizationService.requireMonitorWorkspace(query.workspaceId);
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          const playerMaps = yield* playerService.getPlayerMaps(sheetId);

          return {
            nameToPlayer: Array.fromIterable(HashMap.entries(playerMaps.nameToPlayer)).map(
              ([key, value]) => ({
                key,
                value: { name: value.name, players: Array.fromIterable(value.players) },
              }),
            ),
            idToPlayer: Array.fromIterable(HashMap.entries(playerMaps.idToPlayer)).map(
              ([key, value]) => ({
                key,
                value: Array.fromIterable(value),
              }),
            ),
          };
        }),
      ),
      "player.getByIds": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const auth =
            query.ids.length === 1
              ? authorizationService.requireDiscordAccountIdOrMonitorGuild(
                  query.workspaceId,
                  query.ids[0]!,
                )
              : authorizationService.requireMonitorWorkspace(query.workspaceId);

          yield* auth;
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          return yield* playerService.getByIds(sheetId, query.ids);
        }),
      ),
      "player.getByNames": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          yield* authorizationService.requireMonitorWorkspace(query.workspaceId);
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          return yield* playerService.getByNames(sheetId, query.names);
        }),
      ),
      "player.getTeamsByIds": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          const auth =
            query.ids.length === 1
              ? authorizationService.requireDiscordAccountIdOrMonitorGuild(
                  query.workspaceId,
                  query.ids[0]!,
                )
              : authorizationService.requireMonitorWorkspace(query.workspaceId);

          yield* auth;
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          const teams = yield* playerService.getTeamsByIds(sheetId, query.ids);
          return [teams] as const;
        }),
      ),
      "player.getTeamsByNames": withQueryWorkspaceAuth(
        Effect.fnUntraced(function* ({ query }) {
          yield* authorizationService.requireMonitorWorkspace(query.workspaceId);
          const sheetId = yield* getSheetIdFromWorkspaceId(
            query.workspaceId,
            workspaceConfigService,
          );
          const teams = yield* playerService.getTeamsByNames(sheetId, query.names);
          return [teams] as const;
        }),
      ),
    } satisfies HandlerMap<"player">;
  }),
).pipe(
  Layer.provide([AuthorizationService.layer, PlayerService.layer, WorkspaceConfigService.layer]),
);
