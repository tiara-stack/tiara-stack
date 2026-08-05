import type { MutatorRegistry } from "@rocicorp/zero";
import { ZeroApiRegistry } from "typhoon-zero/zeroApi";
import { SheetZeroApi } from "./api";
import type { Schema } from "./schema";
import { publicVisibilities } from "./visibilities";

export type Mutators = MutatorRegistry<
  ZeroApiRegistry.MutatorDefinitionsForApi<
    typeof SheetZeroApi,
    (typeof publicVisibilities)[number]
  >,
  Schema
>;

export const mutators: Mutators = ZeroApiRegistry.toMutators(SheetZeroApi, {
  visibilities: publicVisibilities,
});
