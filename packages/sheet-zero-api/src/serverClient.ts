import type { Effect } from "effect";
import type { ZeroClient } from "typhoon-zero/client";
import { ZeroApiClient } from "typhoon-zero/zeroApi";
import { SheetZeroApi } from "./api";
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
