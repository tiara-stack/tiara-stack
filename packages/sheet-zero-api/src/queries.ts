import type { QueryRegistry } from "@rocicorp/zero";
import { ZeroApiRegistry } from "typhoon-zero/zeroApi";
import { SheetZeroApi } from "./api";
import type { Schema } from "./schema";
import { publicVisibilities } from "./visibilities";

export type Queries = QueryRegistry<
  ZeroApiRegistry.QueryDefinitionsForApi<typeof SheetZeroApi, (typeof publicVisibilities)[number]>,
  Schema
>;

export const queries: Queries = ZeroApiRegistry.toQueries(SheetZeroApi, {
  visibilities: publicVisibilities,
});
