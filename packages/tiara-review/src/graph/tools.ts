import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { dependencyEdgeKinds } from "./types";

export const EdgeKindSchema = Schema.Literals(dependencyEdgeKinds);
export const PositiveInt = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

export const ResolveSymbolParams = Schema.Struct({
  name: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  line: Schema.optional(PositiveInt),
  column: Schema.optional(PositiveInt),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});

export const SymbolEdgesParams = Schema.Struct({
  symbolKey: Schema.String,
  edgeKinds: Schema.optional(Schema.Array(EdgeKindSchema)),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});

export const ResolveSymbol = Tool.make("resolve_symbol", {
  description:
    "Resolve a TypeScript symbol by name or source location in the current review graph version.",
  parameters: ResolveSymbolParams,
  success: Schema.Unknown,
});

export const SymbolDependencies = Tool.make("symbol_dependencies", {
  description:
    "Return outgoing dependency edges for a TypeScript symbol in the current review graph version.",
  parameters: SymbolEdgesParams,
  success: Schema.Unknown,
});

export const SymbolDependents = Tool.make("symbol_dependents", {
  description:
    "Return incoming dependency edges for a TypeScript symbol in the current review graph version.",
  parameters: SymbolEdgesParams,
  success: Schema.Unknown,
});

export const GraphToolkit = Toolkit.make(ResolveSymbol, SymbolDependencies, SymbolDependents);
