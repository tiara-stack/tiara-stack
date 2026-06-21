import { Effect, HashMap, Layer, Option, Context, pipe } from "effect";
import { upperFirst } from "scule";
import { SheetService } from "./sheet";
import { Player, PartialIdPlayer, PartialNamePlayer, Team } from "sheet-ingress-api/schemas/sheet";
import { ScopedCache } from "typhoon-core/utils";

const attachPlayerId = (playerId: string) => (team: Team) =>
  new Team({
    type: team.type,
    playerId: Option.some(playerId),
    playerName: team.playerName,
    teamName: team.teamName,
    tags: team.tags,
    lead: team.lead,
    backline: team.backline,
    talent: team.talent,
  });

type PlayerMaps = {
  nameToPlayer: HashMap.HashMap<string, { name: string; players: [Player, ...Player[]] }>;
  idToPlayer: HashMap.HashMap<string, [Player, ...Player[]]>;
};

export class PlayerService extends Context.Service<PlayerService>()("PlayerService", {
  make: Effect.gen(function* () {
    const sheetService = yield* SheetService;

    const getPlayerMaps = Effect.fn("PlayerService.getPlayerMaps")(function* (sheetId: string) {
      const rawPlayers = yield* sheetService.getPlayers(sheetId);
      const players: Player[] = [];

      for (const player of rawPlayers) {
        if (Option.isSome(player.id) && Option.isSome(player.name)) {
          players.push(
            new Player({
              index: player.index,
              id: player.id.value,
              name: player.name.value,
            }),
          );
        }
      }

      const idGroups = new Map<string, [Player, ...Player[]]>();
      const nameGroups = new Map<string, [Player, ...Player[]]>();

      for (const player of players) {
        const byId = idGroups.get(player.id);
        if (byId) {
          byId.push(player);
        } else {
          idGroups.set(player.id, [player]);
        }

        const byName = nameGroups.get(player.name);
        if (byName) {
          byName.push(player);
        } else {
          nameGroups.set(player.name, [player]);
        }
      }

      return yield* Effect.succeed({
        idToPlayer: HashMap.fromIterable(idGroups),
        nameToPlayer: HashMap.fromIterable(
          globalThis.Array.from(nameGroups, ([name, groupedPlayers]) => [
            name,
            { name, players: groupedPlayers },
          ]),
        ),
      } satisfies PlayerMaps).pipe(Effect.withSpan("PlayerService.getPlayerMaps"));
    });

    const getByNames = Effect.fn("PlayerService.getByNames")(function* (
      sheetId: string,
      names: readonly string[],
    ) {
      const { nameToPlayer } = yield* getPlayerMaps(sheetId);
      return yield* Effect.succeed(
        names.map((name) => {
          const normalizedName = upperFirst(name);
          return pipe(
            HashMap.get(nameToPlayer, normalizedName),
            Option.map(
              ({ players }) =>
                players as [Player | PartialNamePlayer, ...(Player | PartialNamePlayer)[]],
            ),
            Option.getOrElse(() => [new PartialNamePlayer({ name: normalizedName })] as const),
          );
        }),
      ).pipe(Effect.withSpan("PlayerService.getByNames"));
    });

    const getByIds = Effect.fn("PlayerService.getByIds")(function* (
      sheetId: string,
      ids: readonly string[],
    ) {
      const { idToPlayer } = yield* getPlayerMaps(sheetId);
      return yield* Effect.succeed(
        ids.map((id) =>
          pipe(
            HashMap.get(idToPlayer, id),
            Option.getOrElse(() => [new PartialIdPlayer({ id })] as const),
          ),
        ),
      ).pipe(Effect.withSpan("PlayerService.getByIds"));
    });

    const getTeamsByNames = Effect.fn("PlayerService.getTeamsByNames")(function* (
      sheetId: string,
      names: readonly string[],
    ) {
      const teams = yield* sheetService.getTeams(sheetId);
      const { nameToPlayer } = yield* getPlayerMaps(sheetId);
      return yield* Effect.succeed(
        names.flatMap((name) => {
          const normalizedName = upperFirst(name);
          return pipe(
            HashMap.get(nameToPlayer, normalizedName),
            Option.map(({ players }) =>
              players.flatMap((player) =>
                teams
                  .filter((team) =>
                    Option.exists(team.playerName, (playerName) => playerName === player.name),
                  )
                  .map(attachPlayerId(player.id)),
              ),
            ),
            Option.getOrElse(() => [] as Team[]),
          );
        }),
      ).pipe(Effect.withSpan("PlayerService.getTeamsByName"));
    });

    const getTeamsByIds = Effect.fn("PlayerService.getTeamsByIds")(function* (
      sheetId: string,
      ids: readonly string[],
    ) {
      const teams = yield* sheetService.getTeams(sheetId);
      const { idToPlayer } = yield* getPlayerMaps(sheetId);
      return yield* Effect.succeed(
        ids.flatMap((id) =>
          pipe(
            HashMap.get(idToPlayer, id),
            Option.map((players) =>
              players.flatMap((player) =>
                teams
                  .filter((team) =>
                    Option.exists(team.playerName, (playerName) => playerName === player.name),
                  )
                  .map(attachPlayerId(player.id)),
              ),
            ),
            Option.getOrElse(() => [] as Team[]),
          ),
        ),
      ).pipe(Effect.withSpan("PlayerService.getTeamsById"));
    });

    const getPlayerMapsCache = yield* ScopedCache.make({ lookup: getPlayerMaps });
    const getByIdsCache = yield* ScopedCache.make({
      lookup: ({ sheetId, ids }: { sheetId: string; ids: readonly string[] }) =>
        getByIds(sheetId, ids),
    });
    const getByNamesCache = yield* ScopedCache.make({
      lookup: ({ sheetId, names }: { sheetId: string; names: readonly string[] }) =>
        getByNames(sheetId, names),
    });
    const getTeamsByIdsCache = yield* ScopedCache.make({
      lookup: ({ sheetId, ids }: { sheetId: string; ids: readonly string[] }) =>
        getTeamsByIds(sheetId, ids),
    });
    const getTeamsByNamesCache = yield* ScopedCache.make({
      lookup: ({ sheetId, names }: { sheetId: string; names: readonly string[] }) =>
        getTeamsByNames(sheetId, names),
    });

    return {
      getPlayerMaps: (sheetId: string) => getPlayerMapsCache.get(sheetId),
      getByIds: (sheetId: string, ids: readonly string[]) => getByIdsCache.get({ sheetId, ids }),
      getByNames: (sheetId: string, names: readonly string[]) =>
        getByNamesCache.get({ sheetId, names }),
      getTeamsByIds: (sheetId: string, ids: readonly string[]) =>
        getTeamsByIdsCache.get({ sheetId, ids }),
      getTeamsByNames: (sheetId: string, names: readonly string[]) =>
        getTeamsByNamesCache.get({ sheetId, names }),
    };
  }),
}) {
  static layer = Layer.effect(PlayerService, this.make).pipe(Layer.provide(SheetService.layer));
}
