import { Effect, Option, Schema } from "effect";

export const ParentCachePageSize = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 100 }),
).pipe(Schema.brand("dfx-discord-utils/ParentCachePageSize"));
export type ParentCachePageSize = Schema.Schema.Type<typeof ParentCachePageSize>;

export interface ParentCachePage<T> {
  readonly entries: ReadonlyMap<string, T>;
  readonly nextCursor?: string;
}

export interface ReverseLookupCacheDriver<E, T> {
  readonly size: Effect.Effect<number, E>;
  sizeForParent: (parentId: string) => Effect.Effect<number, E>;
  sizeForResource: (resourceId: string) => Effect.Effect<number, E>;
  get: (parentId: string, resourceId: string) => Effect.Effect<Option.Option<T>, E>;
  getForParent: (parentId: string) => Effect.Effect<Option.Option<ReadonlyMap<string, T>>, E>;
  /**
   * Retrieves one page for a parent using `cursor` as the exclusive starting point and `limit`
   * as the maximum number of entries. `Option.none()` means the parent does not exist. An
   * exhausted or out-of-range cursor returns `Option.some()` with an empty entries map so callers
   * do not mistake an empty page for a missing parent.
   *
   * When `cursor` is undefined and a scan reaches the end with every indexed resource missing,
   * the driver returns `Option.none()` so the caller can repopulate the parent.
   *
   * Entries are ordered lexicographically by resource ID. `cursor` is compared against that stable
   * ordering, and `nextCursor` identifies the last returned or scanned resource ID.
   */
  getPageForParent: (
    parentId: string,
    cursor: string | undefined,
    limit: ParentCachePageSize,
  ) => Effect.Effect<Option.Option<ParentCachePage<T>>, E>;
  getForResource: (resourceId: string) => Effect.Effect<Option.Option<ReadonlyMap<string, T>>, E>;
  /**
   * Stores every entry for `parentId` and merges its resource IDs into the existing parent index.
   * Resource IDs omitted from `entries` remain indexed, and duplicate IDs keep the last entry.
   */
  setForParent: (
    parentId: string,
    entries: ReadonlyArray<readonly [resourceId: string, resource: T]>,
  ) => Effect.Effect<void, E>;
  set: (parentId: string, resourceId: string, resource: T) => Effect.Effect<void, E>;
  delete: (parentId: string, resourceId: string) => Effect.Effect<void, E>;
  parentDelete: (parentId: string) => Effect.Effect<void, E>;
  resourceDelete: (resourceId: string) => Effect.Effect<void, E>;
  refreshTTL: (parentId: string, resourceId: string) => Effect.Effect<void, E>;
  readonly run: Effect.Effect<never, E>;
}

export const createReverseLookupDriver = <E, T>(
  driver: ReverseLookupCacheDriver<E, T>,
): ReverseLookupCacheDriver<E, T> => driver;
