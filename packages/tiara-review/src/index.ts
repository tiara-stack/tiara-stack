#!/usr/bin/env node

import { isMainThread } from "node:worker_threads";

export { runCheckpointedReview, runCheckpointedReviewWithClient } from "./review/workflow";
export {
  type AiProvider,
  type Checkpoint,
  type ReviewProviderConfig,
  type ReviewRunConfig,
  type ReviewRunResult,
  type ReviewFinding,
  type ReviewAspect,
  type SafetyConfidence,
  type ExternalReviewImportResult,
} from "./review/types";
export { parseExternalReviewWithAi, parseExternalReviewWithCodex } from "./review/external-review";
export { defaultConfigPath, loadReviewConfig, mergeRunConfig } from "./config";
export { ProviderAiReviewClient, type AiReviewClient } from "./ai/client";
export { makeKimiDependencyGraphTools } from "./graph/kimi-tools";
export {
  ensureDependencyGraphVersion,
  lookupDependencyGraphSymbol,
  getSymbolDependencies,
  getSymbolDependents,
} from "./graph/store";
export type {
  DependencyGraphVersion,
  DependencyGraphSymbol,
  DependencyGraphEdge,
  DependencyEdgeKind,
  SymbolLookupResult,
  SymbolDependenciesResult,
  SymbolDependentsResult,
} from "./graph/types";
export { command, main, runMain } from "./cli";
import { runMain } from "./cli";

if (isMainThread && process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  runMain();
}
