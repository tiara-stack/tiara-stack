import type { MutatorRegistry, QueryRegistry } from "@rocicorp/zero";
import { ZeroApiRegistry } from "typhoon-zero/zeroApi";
import { SheetWorkflowZeroObservationApi, SheetZeroApi } from "./api";
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

export type WorkflowObservationServerQueries = QueryRegistry<
  ZeroApiRegistry.QueryDefinitionsForApi<typeof SheetWorkflowZeroObservationApi, "public">,
  Schema
>;

export const workflowObservationQueries: WorkflowObservationServerQueries =
  ZeroApiRegistry.toQueries(SheetWorkflowZeroObservationApi, { visibilities: ["public"] });

export type WorkflowObservationServerMutators = MutatorRegistry<
  ZeroApiRegistry.MutatorDefinitionsForApi<typeof SheetWorkflowZeroObservationApi, "public">,
  Schema
>;

export const workflowObservationMutators: WorkflowObservationServerMutators =
  ZeroApiRegistry.toMutators(SheetWorkflowZeroObservationApi, { visibilities: ["public"] });
