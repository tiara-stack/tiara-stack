import type { MutatorRegistry, QueryRegistry } from "@rocicorp/zero";
import { ZeroApiRegistry } from "typhoon-zero/zeroApi";
import { SheetZeroApi } from "./api";
import type { Schema } from "./schema";
import { serverVisibilities } from "./visibilities";

export type ServerQueries = QueryRegistry<
  ZeroApiRegistry.QueryDefinitionsForApi<typeof SheetZeroApi, (typeof serverVisibilities)[number]>,
  Schema
>;

export type ServerMutators = MutatorRegistry<
  ZeroApiRegistry.MutatorDefinitionsForApi<
    typeof SheetZeroApi,
    (typeof serverVisibilities)[number]
  >,
  Schema
>;

export const serverQueries: ServerQueries = ZeroApiRegistry.toQueries(SheetZeroApi, {
  visibilities: serverVisibilities,
});

export const serverMutators: ServerMutators = ZeroApiRegistry.toMutators(SheetZeroApi, {
  visibilities: serverVisibilities,
});
