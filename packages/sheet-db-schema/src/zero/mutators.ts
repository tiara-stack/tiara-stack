import type { MutatorRegistry } from "@rocicorp/zero";
import { ZeroApiRegistry } from "typhoon-zero/zeroApi";
import { SheetZeroApi } from "./api";
import type { Schema } from "./schema";
import { exposedVisibilities } from "./visibilities";

export type Mutators = MutatorRegistry<
  ZeroApiRegistry.MutatorDefinitionsForApi<
    typeof SheetZeroApi,
    (typeof exposedVisibilities)[number]
  >,
  Schema
>;

export const mutators: Mutators = ZeroApiRegistry.toMutators(SheetZeroApi, {
  visibilities: exposedVisibilities,
});
