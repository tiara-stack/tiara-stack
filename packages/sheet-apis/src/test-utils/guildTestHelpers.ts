import { MembersApiCacheView } from "dfx-discord-utils/discord/cache/members";
import { RolesApiCacheView } from "dfx-discord-utils/discord/cache/roles";
import { CacheNotFoundError } from "dfx-discord-utils/discord/schema";
import { Effect, HashSet, Redacted } from "effect";
import { SheetAuthUser } from "sheet-ingress-api/internal";
import type { SheetAuthOAuthScope } from "sheet-ingress-api/schemas/permissions";
import { WorkspaceConfigService } from "@/services";

export type TestPermission =
  | "service"
  | "app_owner"
  | `member_workspace:${string}`
  | `monitor_workspace:${string}`
  | `manage_workspace:${string}`
  | `account:discord:${string}`;

export const makeUser = (
  permissions: ReadonlyArray<TestPermission>,
  identity = { accountId: "discord-account-1", userId: "better-auth-user-1" },
) => ({
  accountId: identity.accountId,
  userId: identity.userId,
  permissions: HashSet.fromIterable(permissions),
  scopes: new Set<SheetAuthOAuthScope>(),
  token: Redacted.make("token"),
  tokenType: "session" as const,
});

export const withUser =
  <A, E, R>(
    permissions: ReadonlyArray<TestPermission>,
    identity?: { accountId: string; userId: string },
  ) =>
  (effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(SheetAuthUser, makeUser(permissions, identity)));

export const liveWorkspaceServices =
  (options?: {
    readonly memberAccountId?: string;
    readonly memberWorkspaceId?: string;
    readonly memberRoles?: ReadonlyArray<string>;
    readonly monitorRoleIds?: ReadonlyArray<string>;
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(MembersApiCacheView, {
        get: (workspaceId: string, accountId: string) =>
          options?.memberAccountId === accountId &&
          workspaceId === (options?.memberWorkspaceId ?? "guild-1")
            ? Effect.succeed({
                roles: [...(options?.memberRoles ?? [])],
                user: { id: accountId },
              })
            : Effect.fail(new CacheNotFoundError({ message: "not found" })),
      } as unknown as typeof MembersApiCacheView.Service),
      Effect.provideService(WorkspaceConfigService, {
        getWorkspaceMonitorRoles: () =>
          Effect.succeed((options?.monitorRoleIds ?? []).map((roleId) => ({ roleId }))),
      } as unknown as Pick<
        typeof WorkspaceConfigService.Service,
        "getWorkspaceMonitorRoles"
      > as typeof WorkspaceConfigService.Service),
      Effect.provideService(RolesApiCacheView, {
        getForParent: () => Effect.succeed(new Map()),
      } as unknown as typeof RolesApiCacheView.Service),
    );

export const getFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.flip);
