import type { Effect } from "effect";
import type { ZeroClient } from "typhoon-zero/client";
import { ZeroApiClient } from "typhoon-zero/zeroApi";
import { SheetZeroApi } from "./api";
import type { SheetClient } from "./client";
import type { Schema } from "./schema";
import { serverMutators, serverQueries } from "./serverRegistries";
import { serviceVisibilities } from "./visibilities";

export type SheetServiceClient = ZeroApiClient.FunctionClient<
  typeof SheetZeroApi,
  (typeof serviceVisibilities)[number]
>;

export const makeSheetServiceClient = (
  zeroClient: ZeroClient.ZeroClientExecutor<Schema, unknown>,
): Effect.Effect<SheetServiceClient> =>
  ZeroApiClient.makeFunctionsWithVisibilities(SheetZeroApi, zeroClient, {
    queries: serverQueries,
    mutators: serverMutators,
    visibilities: serviceVisibilities,
  });

/**
 * Compatibility constructor for callers configured with the combined legacy registries.
 *
 * @deprecated Import `makeSheetClient` from `sheet-zero-api` and use the public registries.
 */
export const makeLegacySheetClient = (
  zeroClient: ZeroClient.ZeroClientExecutor<Schema, unknown>,
): Effect.Effect<SheetClient> =>
  ZeroApiClient.makeFunctionsWithService(SheetZeroApi, zeroClient, {
    queries: serverQueries,
    mutators: serverMutators,
  });
