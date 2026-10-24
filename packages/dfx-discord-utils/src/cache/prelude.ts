import { Cache, Discord, DiscordREST } from "dfx";
import type { CacheDriver } from "dfx/Cache/driver";
import { DiscordGateway } from "dfx/DiscordGateway";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { DiscordApiClient } from "../discord/discordApiClient";
import type { DiscordChannel, DiscordGuild, DiscordMember } from "../discord/schema";
import type { ReverseLookupCacheDriver } from "./driver";
import { make, makeWithReverseLookup } from "./cache";

export type CachedGuildMember = DiscordMember;

// Guild type with relaxed fields (allows unknown future values)
export type CachedGuild = Omit<
  DiscordGuild,
  | "features"
  | "preferred_locale"
  | "region"
  | "afk_timeout"
  | "widget_enabled"
  | "max_members"
  | "max_video_channel_users"
  | "max_stage_video_channel_users"
  | "premium_subscription_count"
> & {
  features: readonly string[];
  preferred_locale: string;
  region?: string | null | undefined;
  afk_timeout: number;
  widget_enabled?: boolean | undefined;
  max_members?: number | undefined;
  max_video_channel_users?: number | undefined;
  max_stage_video_channel_users?: number | undefined;
  premium_subscription_count?: number | undefined;
};

export type ReverseLookupCacheOp<T> =
  | ReverseLookupCacheOp.Create<T>
  | ReverseLookupCacheOp.Update<T>
  | ReverseLookupCacheOp.Delete
  | ReverseLookupCacheOp.ParentDelete
  | ReverseLookupCacheOp.ResourceDelete;

export namespace ReverseLookupCacheOp {
  export interface Create<T> {
    readonly op: "create";
    readonly parentId: string;
    readonly resourceId: string;
    readonly resource: T;
  }

  export interface Update<T> {
    readonly op: "update";
    readonly parentId: string;
    readonly resourceId: string;
    readonly resource: T;
  }

  export interface Delete {
    readonly op: "delete";
    readonly parentId: string;
    readonly resourceId: string;
  }

  export interface ParentDelete {
    readonly op: "parentDelete";
    readonly parentId: string;
  }

  export interface ResourceDelete {
    readonly op: "resourceDelete";
    readonly resourceId: string;
  }
}

export interface OptsWithReverseLookupOptions<E, A> {
  readonly id: (a: A) => string;
  readonly fromParent: Stream.Stream<[parentId: string, resources: ReadonlyArray<A>], E>;
  readonly create: Stream.Stream<[parentId: string, resource: A], E>;
  readonly update: Stream.Stream<[parentId: string, resource: A], E>;
  readonly remove: Stream.Stream<[parentId: string, id: string], E>;
  readonly parentRemove: Stream.Stream<string, E>;
  readonly resourceRemove: Stream.Stream<string, E>;
}

export const opsWithReverseLookup = <E, T>({
  create,
  fromParent,
  id,
  parentRemove,
  remove,
  resourceRemove,
  update,
}: OptsWithReverseLookupOptions<E, T>): Stream.Stream<ReverseLookupCacheOp<T>, E> => {
  const fromParentOps = Stream.flatMap(fromParent, ([parentId, a]) =>
    Stream.fromIterable(
      a.map(
        (resource): ReverseLookupCacheOp<T> => ({
          op: "create",
          parentId,
          resourceId: id(resource),
          resource,
        }),
      ),
    ),
  );

  const createOps = Stream.map(
    create,
    ([parentId, resource]): ReverseLookupCacheOp<T> => ({
      op: "create",
      parentId,
      resourceId: id(resource),
      resource,
    }),
  );

  const updateOps = Stream.map(
    update,
    ([parentId, resource]): ReverseLookupCacheOp<T> => ({
      op: "update",
      parentId,
      resourceId: id(resource),
      resource,
    }),
  );

  const removeOps = Stream.map(
    remove,
    ([parentId, resourceId]): ReverseLookupCacheOp<T> => ({
      op: "delete",
      parentId,
      resourceId,
    }),
  );

  const parentRemoveOps = Stream.map(
    parentRemove,
    (parentId): ReverseLookupCacheOp<T> => ({
      op: "parentDelete",
      parentId,
    }),
  );

  const resourceRemoveOps = Stream.map(
    resourceRemove,
    (resourceId): ReverseLookupCacheOp<T> => ({
      op: "resourceDelete",
      resourceId,
    }),
  );

  return Stream.mergeAll(
    [fromParentOps, createOps, updateOps, removeOps, parentRemoveOps, resourceRemoveOps] as const,
    { concurrency: "unbounded" },
  ) as Stream.Stream<ReverseLookupCacheOp<T>, E>;
};

// Channels reverse lookup cache prelude
export const channelsWithReverseLookup = Effect.fn("cache.channelsWithReverseLookup")(function* <
  RM,
  EM,
  E,
>(makeDriver: Effect.Effect<ReverseLookupCacheDriver<E, DiscordChannel>, EM, RM>) {
  const driver = yield* makeDriver;
  const gateway = yield* DiscordGateway;
  const rest = yield* DiscordREST;

  return yield* makeWithReverseLookup({
    driver,

    id: (c) =>
      Effect.succeed([
        (
          c /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Discord.GuildChannelResponse
        ) /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */.guild_id,
        c.id,
      ]),
    ops: opsWithReverseLookup({
      id: (c: DiscordChannel) => c.id,
      fromParent: Stream.map(gateway.fromDispatch("GUILD_CREATE"), (g) => [
        g.id,
        [...g.channels, ...g.threads] as DiscordChannel[],
      ]),
      create: Stream.merge(
        gateway.fromDispatch("CHANNEL_CREATE"),
        gateway.fromDispatch("THREAD_CREATE"),
      ).pipe(Stream.map((c) => [c.guild_id, c])),
      update: Stream.merge(
        gateway.fromDispatch("CHANNEL_UPDATE"),
        gateway.fromDispatch("THREAD_UPDATE"),
      ).pipe(Stream.map((c) => [c.guild_id, c])),
      remove: Stream.merge(
        gateway.fromDispatch("CHANNEL_DELETE"),
        gateway.fromDispatch("THREAD_DELETE"),
      ).pipe(Stream.map((a) => [a.guild_id, a.id])),
      parentRemove: Stream.map(gateway.fromDispatch("GUILD_DELETE"), (g) => g.id),
      resourceRemove: Stream.never,
    }),
    onMiss: (_, id) => rest.getChannel(id),
    onParentMiss: (guildId) =>
      rest
        .listGuildChannels(guildId)
        .pipe(Effect.map((channels) => channels.map((c) => [c.id, c] as const))),
    onResourceMiss: (id) =>
      Effect.fail(
        new Cache.CacheMissError({
          cacheName: "ChannelsReverseLookupCache",
          id,
        }),
      ),
  });
});

// Roles reverse lookup cache prelude
export const rolesWithReverseLookup = Effect.fn("cache.rolesWithReverseLookup")(function* <
  RM,
  EM,
  E,
>(makeDriver: Effect.Effect<ReverseLookupCacheDriver<E, Discord.GuildRoleResponse>, EM, RM>) {
  const driver = yield* makeDriver;
  const gateway = yield* DiscordGateway;
  const rest = yield* DiscordREST;

  return yield* makeWithReverseLookup({
    driver,
    id: (_) =>
      Effect.fail(new Cache.CacheMissError({ cacheName: "RolesReverseLookupCache/id", id: _.id })),
    ops: opsWithReverseLookup({
      id: (r: Discord.GuildRoleResponse) => r.id,
      fromParent: Stream.map(gateway.fromDispatch("GUILD_CREATE"), (g) => [g.id, g.roles]),
      create: Stream.map(gateway.fromDispatch("GUILD_ROLE_CREATE"), (r) => [r.guild_id, r.role]),
      update: Stream.map(gateway.fromDispatch("GUILD_ROLE_UPDATE"), (r) => [r.guild_id, r.role]),
      remove: Stream.map(gateway.fromDispatch("GUILD_ROLE_DELETE"), (r) => [r.guild_id, r.role_id]),
      parentRemove: Stream.map(gateway.fromDispatch("GUILD_DELETE"), (g) => g.id),
      resourceRemove: Stream.never,
    }),
    onMiss: (_, id) =>
      Effect.fail(
        new Cache.CacheMissError({
          cacheName: "RolesReverseLookupCache",
          id,
        }),
      ),
    onParentMiss: (guildId) =>
      rest
        .listGuildRoles(guildId)
        .pipe(Effect.map((roles) => roles.map((r) => [r.id, r] as const))),
    onResourceMiss: (id) =>
      Effect.fail(
        new Cache.CacheMissError({
          cacheName: "RolesReverseLookupCache",
          id,
        }),
      ),
  });
});

// Members reverse lookup cache prelude
export const membersWithReverseLookup = Effect.fn("cache.membersWithReverseLookup")(function* <
  RM,
  EM,
  E,
>(makeDriver: Effect.Effect<ReverseLookupCacheDriver<E, CachedGuildMember>, EM, RM>) {
  const driver = yield* makeDriver;
  const gateway = yield* DiscordGateway;
  const rest = yield* DiscordREST;

  return yield* makeWithReverseLookup({
    driver,
    id: (_) =>
      Effect.fail(
        new Cache.CacheMissError({ cacheName: "MembersReverseLookupCache/id", id: _.user.id }),
      ),
    ops: opsWithReverseLookup({
      id: (m: CachedGuildMember) => m.user.id,
      fromParent: Stream.map(gateway.fromDispatch("GUILD_CREATE"), (g) => [g.id, g.members]),
      create: Stream.map(gateway.fromDispatch("GUILD_MEMBER_ADD"), (r) => [r.guild_id, r]),
      update: Stream.map(gateway.fromDispatch("GUILD_MEMBER_UPDATE"), (r) => [r.guild_id, r]),
      remove: Stream.map(gateway.fromDispatch("GUILD_MEMBER_REMOVE"), (r) => [
        r.guild_id,
        r.user.id,
      ]),
      parentRemove: Stream.map(gateway.fromDispatch("GUILD_DELETE"), (g) => g.id),
      resourceRemove: Stream.never,
    }),
    onMiss: (guildId, id) => rest.getGuildMember(guildId, id),
    onParentMiss: (guildId) =>
      rest
        .listGuildMembers(guildId)
        .pipe(Effect.map((members) => members.map((m) => [m.user.id, m] as const))),
    onResourceMiss: (id) =>
      Effect.fail(
        new Cache.CacheMissError({
          cacheName: "MembersReverseLookupCache",
          id,
        }),
      ),
  });
});

// ============================================================================
// Cache View Preludes (readonly, no gateway, dies on miss)
// ============================================================================

// Cache view reverse lookup cache prelude
export const cacheViewWithReverseLookup = Effect.fn("cache.cacheViewWithReverseLookup")(function* <
  T,
  RM,
  EM,
  E,
>(id: (a: T) => string, makeDriver: Effect.Effect<ReverseLookupCacheDriver<E, T>, EM, RM>) {
  const driver = yield* makeDriver;

  return yield* makeWithReverseLookup({
    driver,
    id: (_) =>
      Effect.fail(
        new Cache.CacheMissError({ cacheName: "CacheViewReverseLookupCache/id", id: id(_) }),
      ),
    ops: opsWithReverseLookup({
      id: (m: T) => id(m),
      fromParent: Stream.never,
      create: Stream.never,
      update: Stream.never,
      remove: Stream.never,
      parentRemove: Stream.never,
      resourceRemove: Stream.never,
    }),
    onMiss: (_, id) =>
      Effect.fail(
        new Cache.CacheMissError({
          cacheName: "CacheViewReverseLookupCache",
          id,
        }),
      ),
    onParentMiss: (guildId) =>
      Effect.fail(
        new Cache.CacheMissError({
          cacheName: "CacheViewReverseLookupCache",
          id: guildId,
        }),
      ),
    onResourceMiss: (id) =>
      Effect.fail(
        new Cache.CacheMissError({
          cacheName: "CacheViewReverseLookupCache",
          id,
        }),
      ),
    readonly: true,
  });
});

export const channelsCacheViewWithReverseLookup = <RM, EM, E>(
  makeDriver: Effect.Effect<ReverseLookupCacheDriver<E, DiscordChannel>, EM, RM>,
) => cacheViewWithReverseLookup((c) => c.id, makeDriver);

export const rolesCacheViewWithReverseLookup = <RM, EM, E>(
  makeDriver: Effect.Effect<ReverseLookupCacheDriver<E, Discord.GuildRoleResponse>, EM, RM>,
) => cacheViewWithReverseLookup((r) => r.id, makeDriver);

export const membersCacheViewWithReverseLookup = <RM, EM, E>(
  makeDriver: Effect.Effect<ReverseLookupCacheDriver<E, CachedGuildMember>, EM, RM>,
) => cacheViewWithReverseLookup((m) => m.user.id, makeDriver);

// Generic cache view prelude (no gateway subscriptions, read-only view, dies on miss)
export const cacheView = Effect.fn("cache.cacheView")(function* <T, RM, EM, E>(
  id: (a: T) => string,
  makeDriver: Effect.Effect<CacheDriver<E, T>, EM, RM>,
) {
  const driver = yield* makeDriver;

  return yield* make({
    driver,
    id,
    onMiss: (id) => Effect.fail(new Cache.CacheMissError({ cacheName: "CacheView", id })),
    ops: Stream.never,
    readonly: true,
  });
});

// Guilds cache view prelude - uses CacheDriver (not ReverseLookupCacheDriver) since guilds don't have parent relationships
export const guildsCacheView = <RM, EM, E>(
  makeDriver: Effect.Effect<CacheDriver<E, DiscordGuild>, EM, RM>,
) => cacheView((g) => g.id, makeDriver);

// ============================================================================
// API View Preludes (readonly, no gateway, uses our HTTP API on miss)
// ============================================================================

// Channels API view prelude (readonly, no gateway, uses HTTP API on miss)
export const channelsApiCacheViewWithReverseLookup = Effect.fn(
  "cache.channelsApiCacheViewWithReverseLookup",
)(function* <RM, EM, E>(
  makeDriver: Effect.Effect<ReverseLookupCacheDriver<E, DiscordChannel>, EM, RM>,
) {
  const driver = yield* makeDriver;
  const client = yield* DiscordApiClient;

  return yield* makeWithReverseLookup({
    driver,
    id: (_) =>
      Effect.fail(
        new Cache.CacheMissError({ cacheName: "ChannelsApiViewReverseLookup/id", id: _.id }),
      ),
    ops: opsWithReverseLookup({
      id: (c: DiscordChannel) => c.id,
      fromParent: Stream.never,
      create: Stream.never,
      update: Stream.never,
      remove: Stream.never,
      parentRemove: Stream.never,
      resourceRemove: Stream.never,
    }),
    onMiss: (parentId, resourceId) =>
      client.cache.getChannel({ params: { parentId, resourceId } }).pipe(
        Effect.map((r) => r.value),
        Effect.mapError(
          () =>
            new Cache.CacheMissError({
              cacheName: "ChannelsApiViewReverseLookup",
              id: resourceId,
            }),
        ),
      ),
    onParentMiss: (parentId) =>
      client.cache.getChannelsForParent({ params: { parentId } }).pipe(
        Effect.map((entries) => entries.map((e) => [e.resourceId, e.value] as const)),
        Effect.mapError(
          () =>
            new Cache.CacheMissError({
              cacheName: "ChannelsApiViewReverseLookup",
              id: parentId,
            }),
        ),
      ),
    onResourceMiss: (resourceId) =>
      client.cache.getChannelsForResource({ params: { resourceId } }).pipe(
        Effect.map((entries) => entries.map((e) => [e.parentId, e.value] as const)),
        Effect.mapError(
          () =>
            new Cache.CacheMissError({
              cacheName: "ChannelsApiViewReverseLookup",
              id: resourceId,
            }),
        ),
      ),
    readonly: true,
  });
});

// Roles API view prelude (readonly, no gateway, uses HTTP API on miss)
export const rolesApiCacheViewWithReverseLookup = Effect.fn(
  "cache.rolesApiCacheViewWithReverseLookup",
)(function* <RM, EM, E>(
  makeDriver: Effect.Effect<ReverseLookupCacheDriver<E, Discord.GuildRoleResponse>, EM, RM>,
) {
  const driver = yield* makeDriver;
  const client = yield* DiscordApiClient;

  return yield* makeWithReverseLookup({
    driver,
    id: (_) =>
      Effect.fail(
        new Cache.CacheMissError({ cacheName: "RolesApiViewReverseLookup/id", id: _.id }),
      ),
    ops: opsWithReverseLookup({
      id: (r: Discord.GuildRoleResponse) => r.id,
      fromParent: Stream.never,
      create: Stream.never,
      update: Stream.never,
      remove: Stream.never,
      parentRemove: Stream.never,
      resourceRemove: Stream.never,
    }),
    onMiss: (parentId, resourceId) =>
      client.cache.getRole({ params: { parentId, resourceId } }).pipe(
        Effect.map((r) => r.value),
        Effect.mapError(
          () =>
            new Cache.CacheMissError({
              cacheName: "RolesApiViewReverseLookup",
              id: resourceId,
            }),
        ),
      ),
    onParentMiss: (parentId) =>
      client.cache.getRolesForParent({ params: { parentId } }).pipe(
        Effect.map((entries) => entries.map((e) => [e.resourceId, e.value] as const)),
        Effect.mapError(
          () =>
            new Cache.CacheMissError({
              cacheName: "RolesApiViewReverseLookup",
              id: parentId,
            }),
        ),
      ),
    onResourceMiss: (resourceId) =>
      client.cache.getRolesForResource({ params: { resourceId } }).pipe(
        Effect.map((entries) => entries.map((e) => [e.parentId, e.value] as const)),
        Effect.mapError(
          () =>
            new Cache.CacheMissError({
              cacheName: "RolesApiViewReverseLookup",
              id: resourceId,
            }),
        ),
      ),
    readonly: true,
  });
});

// Members API view prelude (readonly, no gateway, uses HTTP API on miss)
export const membersApiCacheViewWithReverseLookup = Effect.fn(
  "cache.membersApiCacheViewWithReverseLookup",
)(function* <RM, EM, E>(
  makeDriver: Effect.Effect<ReverseLookupCacheDriver<E, CachedGuildMember>, EM, RM>,
) {
  const driver = yield* makeDriver;
  const client = yield* DiscordApiClient;

  return yield* makeWithReverseLookup({
    driver,
    id: (_) =>
      Effect.fail(
        new Cache.CacheMissError({
          cacheName: "MembersApiViewReverseLookup/id",
          id: _.user.id,
        }),
      ),
    ops: opsWithReverseLookup({
      id: (m: CachedGuildMember) => m.user.id,
      fromParent: Stream.never,
      create: Stream.never,
      update: Stream.never,
      remove: Stream.never,
      parentRemove: Stream.never,
      resourceRemove: Stream.never,
    }),
    onMiss: (parentId, resourceId) =>
      client.cache.getMember({ params: { parentId, resourceId } }).pipe(
        Effect.map((r) => r.value),
        Effect.mapError(
          () =>
            new Cache.CacheMissError({
              cacheName: "MembersApiViewReverseLookup",
              id: resourceId,
            }),
        ),
      ),
    onParentMiss: (parentId) =>
      client.cache.getMembersForParent({ params: { parentId } }).pipe(
        Effect.map((entries) => entries.map((e) => [e.resourceId, e.value] as const)),
        Effect.mapError(
          () =>
            new Cache.CacheMissError({
              cacheName: "MembersApiViewReverseLookup",
              id: parentId,
            }),
        ),
      ),
    onResourceMiss: (resourceId) =>
      client.cache.getMembersForResource({ params: { resourceId } }).pipe(
        Effect.map((entries) => entries.map((e) => [e.parentId, e.value] as const)),
        Effect.mapError(
          () =>
            new Cache.CacheMissError({
              cacheName: "MembersApiViewReverseLookup",
              id: resourceId,
            }),
        ),
      ),
    readonly: true,
  });
});

// Guilds API view prelude (readonly, no gateway, uses HTTP API on miss)
export const guildsApiCacheView = Effect.fn("cache.guildsApiCacheView")(function* <RM, EM, E>(
  makeDriver: Effect.Effect<CacheDriver<E, CachedGuild>, EM, RM>,
) {
  const driver = yield* makeDriver;
  const client = yield* DiscordApiClient;

  return yield* make({
    driver,
    id: (g: CachedGuild) => g.id,
    onMiss: (id) =>
      client.cache.getGuild({ params: { resourceId: id } }).pipe(
        Effect.map((r) => r.value),
        Effect.mapError(
          () =>
            new Cache.CacheMissError({
              cacheName: "GuildsApiView",
              id,
            }),
        ),
      ),
    ops: Stream.never,
    readonly: true,
  });
});
