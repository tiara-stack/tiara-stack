import { Array, Data, Effect, Function, HashMap, Option, pipe } from "effect";
import { upperFirst } from "scule";
import { Array as ArrayUtils } from "typhoon-core/utils";
import { SheetService } from "./sheet";
import { Player, PartialIdPlayer, PartialNamePlayer, Team } from "@/schemas/sheet";
import { ScopedCache } from "typhoon-core/utils";

const attachPlayerId = (playerId: string) => (team: Team) =>
  Team.make({
    // eslint-disable-next-line @typescript-eslint/no-misused-spread
    ...team,
    playerId: Option.some(playerId),
  });

export class PlayerService extends Effect.Service<PlayerService>()("PlayerService", {
  scoped: pipe(
    Effect.Do,
    Effect.bind("sheetService", () => SheetService),
    Effect.let(
      "getPlayerMaps",
      ({ sheetService }) =>
        (sheetId: string) =>
          pipe(
            sheetService.getPlayers(sheetId),
            Effect.map(
              Array.map(({ index, id, name }) =>
                Option.isSome(id) && Option.isSome(name)
                  ? Option.some(
                      new Player({
                        index,
                        id: id.value,
                        name: name.value,
                      }),
                    )
                  : Option.none(),
              ),
            ),
            Effect.map(Array.getSomes),
            Effect.map((players) => ({
              privateNameToPlayer: pipe(players, ArrayUtils.Collect.toHashMapByKey("name")),
              idToPlayer: pipe(players, ArrayUtils.Collect.toArrayHashMapByKey("id")),
            })),
            Effect.map(({ privateNameToPlayer, idToPlayer }) => ({
              nameToPlayer: pipe(
                privateNameToPlayer,
                HashMap.map((player) => ({
                  name: player.name,
                  players: pipe(idToPlayer, HashMap.get(player.id)),
                })),
                HashMap.filterMap((a, _) =>
                  pipe(
                    a.players,
                    Option.map((players) => ({ name: a.name, players })),
                  ),
                ),
              ),
              idToPlayer,
            })),
            Effect.withSpan("PlayerService.getPlayerMaps", {
              captureStackTrace: true,
            }),
          ),
    ),
    Effect.map(({ sheetService, getPlayerMaps }) => ({
      getPlayerMaps,
      getByNames: (sheetId: string, names: readonly string[]) =>
        pipe(
          Effect.Do,
          Effect.bind("playerMaps", () => getPlayerMaps(sheetId)),
          Effect.map(({ playerMaps: { nameToPlayer } }) =>
            Array.map(names, (name) =>
              pipe(
                nameToPlayer,
                HashMap.get(upperFirst(name)),
                Option.map(
                  ({ players }) => players as Array.NonEmptyArray<Player | PartialNamePlayer>,
                ),
                Option.getOrElse(() =>
                  Array.make<Array.NonEmptyArray<Player | PartialNamePlayer>>(
                    new PartialNamePlayer({ name: upperFirst(name) }),
                  ),
                ),
              ),
            ),
          ),
          Effect.withSpan("PlayerService.getByNames", {
            captureStackTrace: true,
          }),
        ),
      getByIds: (sheetId: string, ids: readonly string[]) =>
        pipe(
          Effect.Do,
          Effect.bind("playerMaps", () => getPlayerMaps(sheetId)),
          Effect.map(({ playerMaps: { idToPlayer } }) =>
            Array.map(ids, (id) =>
              pipe(
                idToPlayer,
                HashMap.get(id),
                Option.getOrElse(() => Array.make(new PartialIdPlayer({ id }))),
                Array.map(Function.identity),
              ),
            ),
          ),
          Effect.withSpan("PlayerService.getByIds", {
            captureStackTrace: true,
          }),
        ),
      getTeamsByNames: (sheetId: string, names: readonly string[]) =>
        pipe(
          Effect.Do,
          Effect.bind("teams", () => sheetService.getTeams(sheetId)),
          Effect.bind("playerMaps", () => getPlayerMaps(sheetId)),
          Effect.map(({ teams, playerMaps: { nameToPlayer } }) =>
            pipe(
              names,
              Array.map((name) =>
                pipe(
                  nameToPlayer,
                  HashMap.get(upperFirst(name)),
                  Option.map(({ players }) =>
                    pipe(
                      players,
                      Array.map((player) =>
                        pipe(
                          teams,
                          Array.filter((team) =>
                            Option.exists(team.playerName, (pn) => pn === player.name),
                          ),
                          Array.map(attachPlayerId(player.id)),
                        ),
                      ),
                      Array.flatten,
                    ),
                  ),
                  Option.getOrElse(() => []),
                ),
              ),
              Array.flatten,
            ),
          ),
          Effect.withSpan("PlayerService.getTeamsByName", {
            captureStackTrace: true,
          }),
        ),
      getTeamsByIds: (sheetId: string, ids: readonly string[]) =>
        pipe(
          Effect.Do,
          Effect.bind("teams", () => sheetService.getTeams(sheetId)),
          Effect.bind("playerMaps", () => getPlayerMaps(sheetId)),
          Effect.map(({ teams, playerMaps: { idToPlayer } }) =>
            pipe(
              ids,
              Array.map((id) =>
                pipe(
                  idToPlayer,
                  HashMap.get(id),
                  Option.map((players) =>
                    pipe(
                      players,
                      Array.map((player) =>
                        pipe(
                          teams,
                          Array.filter((team) =>
                            Option.exists(team.playerName, (pn) => pn === player.name),
                          ),
                          Array.map(attachPlayerId(player.id)),
                        ),
                      ),
                      Array.flatten,
                    ),
                  ),
                  Option.getOrElse(() => []),
                ),
              ),
              Array.flatten,
            ),
          ),
          Effect.withSpan("PlayerService.getTeamsById", {
            captureStackTrace: true,
          }),
        ),
    })),
    Effect.flatMap((playerMethods) =>
      Effect.all({
        getPlayerMapsCache: ScopedCache.make({
          lookup: playerMethods.getPlayerMaps,
        }),
        getByIdsCache: ScopedCache.make({
          lookup: ({ sheetId, ids }: { sheetId: string; ids: readonly string[] }) =>
            playerMethods.getByIds(sheetId, ids),
        }),
        getByNamesCache: ScopedCache.make({
          lookup: ({ sheetId, names }: { sheetId: string; names: readonly string[] }) =>
            playerMethods.getByNames(sheetId, names),
        }),
        getTeamsByIdsCache: ScopedCache.make({
          lookup: ({ sheetId, ids }: { sheetId: string; ids: readonly string[] }) =>
            playerMethods.getTeamsByIds(sheetId, ids),
        }),
        getTeamsByNamesCache: ScopedCache.make({
          lookup: ({ sheetId, names }: { sheetId: string; names: readonly string[] }) =>
            playerMethods.getTeamsByNames(sheetId, names),
        }),
      }),
    ),
    Effect.map(
      ({
        getPlayerMapsCache,
        getByIdsCache,
        getByNamesCache,
        getTeamsByIdsCache,
        getTeamsByNamesCache,
      }) => ({
        getPlayerMaps: (sheetId: string) => getPlayerMapsCache.get(sheetId),
        getByIds: (sheetId: string, ids: readonly string[]) =>
          getByIdsCache.get(Data.struct({ sheetId, ids })),
        getByNames: (sheetId: string, names: readonly string[]) =>
          getByNamesCache.get(Data.struct({ sheetId, names })),
        getTeamsByIds: (sheetId: string, ids: readonly string[]) =>
          getTeamsByIdsCache.get(Data.struct({ sheetId, ids })),
        getTeamsByNames: (sheetId: string, names: readonly string[]) =>
          getTeamsByNamesCache.get(Data.struct({ sheetId, names })),
      }),
    ),
  ),
  dependencies: [SheetService.Default],
  accessors: true,
}) {}
