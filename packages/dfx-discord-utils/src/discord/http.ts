import { HttpApiBuilder } from "@effect/platform";
import { Effect, Layer } from "effect";
import { DiscordApi } from "./api";
import {
  GuildsCache,
  ChannelsCache,
  RolesCache,
  MembersCache,
  CachesLive,
  Unstorage,
} from "./cache";
import { DiscordApplication } from "./gateway";
import { CacheNotFoundError } from "./schema";
import { Api } from "@effect/platform/HttpApi";
import { DiscordConfig } from "dfx";

// Helper to convert a ReadonlyMap to CacheEntries array
const mapToEntries = <A>(map: ReadonlyMap<string, A>, parentId: string) =>
  Array.from(map.entries()).map(([resourceId, value]) => ({
    parentId,
    resourceId,
    value,
  }));

// Helper to convert a ReadonlyMap to CacheEntries array for resource lookup (cross-parent)
const resourceMapToEntries = <A>(map: ReadonlyMap<string, A>, resourceId: string) =>
  Array.from(map.entries()).map(([parentId, value]) => ({
    parentId,
    resourceId,
    value,
  }));

// Helper to check if error is CacheMissError
const isCacheMissError = (err: unknown): err is { _tag: "CacheMissError" } =>
  typeof err === "object" && err !== null && "_tag" in err && err._tag === "CacheMissError";

// Helper to handle cache errors - converts CacheMissError to CacheNotFoundError, re-throws others as defects
const handleCacheError = <A>(
  effect: Effect.Effect<A, unknown, never>,
  notFoundMessage: string,
): Effect.Effect<A, CacheNotFoundError, never> =>
  effect.pipe(
    Effect.catchAll((err) => {
      if (isCacheMissError(err)) {
        return Effect.fail(new CacheNotFoundError({ message: notFoundMessage }));
      }
      // Re-throw infrastructure errors as defects (will result in HTTP 500)
      return Effect.die(err);
    }),
  );

// Helper to handle size endpoint errors - logs error message and re-throws for 500 response
const handleSizeError = <A>(
  effect: Effect.Effect<A, unknown, never>,
  errorMessage: string,
): Effect.Effect<A, never, never> =>
  effect.pipe(
    Effect.tapError((err) => Effect.logError(`${errorMessage}: ${String(err)}`)),
    Effect.orDie,
  );

export const ApplicationLive = HttpApiBuilder.group(DiscordApi, "application", (handlers) =>
  Effect.all({
    application: DiscordApplication,
  }).pipe(
    Effect.map(({ application }) =>
      handlers.handle("getApplication", () => Effect.succeed({ ownerId: application.owner.id })),
    ),
  ),
).pipe(Layer.provide(DiscordApplication.Default));

export const CacheApiLive = HttpApiBuilder.group(DiscordApi, "cache", (handlers) =>
  Effect.all({
    guildsCache: GuildsCache,
    channelsCache: ChannelsCache,
    rolesCache: RolesCache,
    membersCache: MembersCache,
  }).pipe(
    Effect.map(({ guildsCache, channelsCache, rolesCache, membersCache }) =>
      handlers
        // Guild cache endpoints
        .handle("getGuild", ({ path: { resourceId } }) =>
          handleCacheError(
            guildsCache.get(resourceId).pipe(Effect.map((value) => ({ value }))),
            `Guild ${resourceId} not found`,
          ),
        )
        .handle("getGuildSize", () =>
          handleSizeError(
            guildsCache.size.pipe(Effect.map((size) => ({ size }))),
            "Failed to get guild size",
          ),
        )
        // Channel cache endpoints - get specific resource
        .handle("getChannel", ({ path: { parentId, resourceId } }) =>
          handleCacheError(
            channelsCache.get(parentId, resourceId).pipe(Effect.map((value) => ({ value }))),
            `Channel ${resourceId} in guild ${parentId} not found`,
          ),
        )
        // Role cache endpoints - get specific resource
        .handle("getRole", ({ path: { parentId, resourceId } }) =>
          handleCacheError(
            rolesCache.get(parentId, resourceId).pipe(Effect.map((value) => ({ value }))),
            `Role ${resourceId} in guild ${parentId} not found`,
          ),
        )
        // Member cache endpoints - get specific resource
        .handle("getMember", ({ path: { parentId, resourceId } }) =>
          handleCacheError(
            membersCache.get(parentId, resourceId).pipe(Effect.map((value) => ({ value }))),
            `Member ${resourceId} in guild ${parentId} not found`,
          ),
        )
        // Channel cache endpoints - get all for parent
        .handle("getChannelsForParent", ({ path: { parentId } }) =>
          handleCacheError(
            channelsCache
              .getForParent(parentId)
              .pipe(Effect.map((map) => mapToEntries(map, parentId))),
            `No channels found for guild ${parentId}`,
          ),
        )
        // Role cache endpoints - get all for parent
        .handle("getRolesForParent", ({ path: { parentId } }) =>
          handleCacheError(
            rolesCache
              .getForParent(parentId)
              .pipe(Effect.map((map) => mapToEntries(map, parentId))),
            `No roles found for guild ${parentId}`,
          ),
        )
        // Member cache endpoints - get all for parent
        .handle("getMembersForParent", ({ path: { parentId } }) =>
          handleCacheError(
            membersCache
              .getForParent(parentId)
              .pipe(Effect.map((map) => mapToEntries(map, parentId))),
            `No members found for guild ${parentId}`,
          ),
        )
        // Channel cache endpoints - get all for resource (cross-parent lookup)
        .handle("getChannelsForResource", ({ path: { resourceId } }) =>
          handleCacheError(
            channelsCache
              .getForResource(resourceId)
              .pipe(Effect.map((map) => resourceMapToEntries(map, resourceId))),
            `Channel ${resourceId} not found in any guild`,
          ),
        )
        // Role cache endpoints - get all for resource (cross-parent lookup)
        .handle("getRolesForResource", ({ path: { resourceId } }) =>
          handleCacheError(
            rolesCache
              .getForResource(resourceId)
              .pipe(Effect.map((map) => resourceMapToEntries(map, resourceId))),
            `Role ${resourceId} not found in any guild`,
          ),
        )
        // Member cache endpoints - get all for resource (cross-parent lookup)
        .handle("getMembersForResource", ({ path: { resourceId } }) =>
          handleCacheError(
            membersCache
              .getForResource(resourceId)
              .pipe(Effect.map((map) => resourceMapToEntries(map, resourceId))),
            `Member ${resourceId} not found in any guild`,
          ),
        )
        // Size endpoints
        .handle("getChannelsSize", () =>
          handleSizeError(
            channelsCache.size.pipe(Effect.map((size) => ({ size }))),
            "Failed to get channels size",
          ),
        )
        .handle("getRolesSize", () =>
          handleSizeError(
            rolesCache.size.pipe(Effect.map((size) => ({ size }))),
            "Failed to get roles size",
          ),
        )
        .handle("getMembersSize", () =>
          handleSizeError(
            membersCache.size.pipe(Effect.map((size) => ({ size }))),
            "Failed to get members size",
          ),
        )
        .handle("getChannelsSizeForParent", ({ path: { parentId } }) =>
          handleSizeError(
            channelsCache.sizeForParent(parentId).pipe(Effect.map((size) => ({ size }))),
            `Failed to get channels size for guild ${parentId}`,
          ),
        )
        .handle("getRolesSizeForParent", ({ path: { parentId } }) =>
          handleSizeError(
            rolesCache.sizeForParent(parentId).pipe(Effect.map((size) => ({ size }))),
            `Failed to get roles size for guild ${parentId}`,
          ),
        )
        .handle("getMembersSizeForParent", ({ path: { parentId } }) =>
          handleSizeError(
            membersCache.sizeForParent(parentId).pipe(Effect.map((size) => ({ size }))),
            `Failed to get members size for guild ${parentId}`,
          ),
        )
        .handle("getChannelsSizeForResource", ({ path: { resourceId } }) =>
          handleSizeError(
            channelsCache.sizeForResource(resourceId).pipe(Effect.map((size) => ({ size }))),
            `Failed to get channels size for resource ${resourceId}`,
          ),
        )
        .handle("getRolesSizeForResource", ({ path: { resourceId } }) =>
          handleSizeError(
            rolesCache.sizeForResource(resourceId).pipe(Effect.map((size) => ({ size }))),
            `Failed to get roles size for resource ${resourceId}`,
          ),
        )
        .handle("getMembersSizeForResource", ({ path: { resourceId } }) =>
          handleSizeError(
            membersCache.sizeForResource(resourceId).pipe(Effect.map((size) => ({ size }))),
            `Failed to get members size for resource ${resourceId}`,
          ),
        ),
    ),
  ),
).pipe(Layer.provide(CachesLive));

// Layer that provides the full API handlers
export const DiscordApiLive: Layer.Layer<Api, never, DiscordConfig.DiscordConfig | Unstorage> =
  Layer.provide(HttpApiBuilder.api(DiscordApi), [ApplicationLive, CacheApiLive]);
