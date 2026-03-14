import { HttpServerRequest } from "@effect/platform";
import { Effect, HashSet, Layer, pipe, Schema } from "effect";
import { MembersApiCacheView } from "dfx-discord-utils/discord";
import { getAccount } from "sheet-auth/client";
import { GuildConfigService, SheetAuthClient } from "@/services";
import { SheetAuthTokenAuthorization } from "../sheetAuthTokenAuthorization/tag";
import { SheetAuthTokenAuthorizationLive } from "../sheetAuthTokenAuthorization/live";
import { SheetAuthTokenGuildMonitorAuthorization } from "./tag";
import { Unauthorized } from "@/schemas/middlewares/unauthorized";

export const SheetAuthTokenGuildMonitorAuthorizationLive = Layer.effect(
  SheetAuthTokenGuildMonitorAuthorization,
  pipe(
    Effect.all({
      authClient: SheetAuthClient,
      guildConfigService: GuildConfigService,
      membersCache: MembersApiCacheView,
      sheetAuthTokenAuthorization: SheetAuthTokenAuthorization,
    }),
    Effect.map(({ authClient, guildConfigService, membersCache, sheetAuthTokenAuthorization }) => {
      return SheetAuthTokenGuildMonitorAuthorization.of({
        sheetAuthToken: Effect.fnUntraced(function* (token) {
          const user = yield* sheetAuthTokenAuthorization.sheetAuthToken(token);

          if (user.permissions?.includes("bot:manage_guild")) {
            return user;
          }

          const { guildId } = yield* HttpServerRequest.schemaSearchParams(
            Schema.Struct({ guildId: Schema.String }),
          ).pipe(
            Effect.mapError(
              () => new Unauthorized({ message: "Missing required query parameter: guildId" }),
            ),
          );

          const account = yield* getAccount(authClient, ["discord", "kubernetes:discord"], {
            Authorization: `Bearer ${user.token}`,
          }).pipe(
            Effect.mapError(
              (error) =>
                new Unauthorized({
                  message: `Failed to retrieve linked account: ${error.message}`,
                }),
            ),
          );

          const member = yield* membersCache
            .get(guildId, account.accountId)
            .pipe(
              Effect.mapError(
                () => new Unauthorized({ message: "User is not a member of the guild" }),
              ),
            );
          const roles = yield* guildConfigService
            .getGuildManagerRoles(guildId)
            .pipe(
              Effect.mapError(
                () => new Unauthorized({ message: "Failed to retrieve guild manager roles" }),
              ),
            );

          if (
            HashSet.intersection(
              HashSet.fromIterable(member.roles),
              HashSet.fromIterable(roles.map((role) => role.roleId)),
            ).pipe(HashSet.size) === 0
          ) {
            return yield* Effect.fail(new Unauthorized({ message: "User is not a guild manager" }));
          }

          return user;
        }),
      });
    }),
  ),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetAuthTokenAuthorizationLive,
      SheetAuthClient.Default,
      GuildConfigService.Default,
    ),
  ),
);
