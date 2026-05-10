import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql";
import {
  getSymbolDependenciesEffect,
  getSymbolDependentsEffect,
  lookupDependencyGraphSymbolEffect,
} from "./store";
import { GraphToolkit } from "./tools";

export const graphToolErrorMessage = (cause: unknown) => {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (Cause.isCause(cause)) {
    return Cause.pretty(cause);
  }
  if (typeof cause === "object" && cause !== null) {
    try {
      return JSON.stringify(cause);
    } catch {
      return "Unserializable error object";
    }
  }
  if (typeof cause === "string") {
    return cause;
  }
  if (
    typeof cause === "number" ||
    typeof cause === "boolean" ||
    typeof cause === "bigint" ||
    typeof cause === "symbol"
  ) {
    return cause.toString();
  }
  return "Unknown error";
};

export const graphToolkitLayer = (input: { readonly versionId: string }) =>
  GraphToolkit.toLayer(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const runGraphTool = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
        effect.pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catch((cause: unknown) => Effect.succeed({ error: graphToolErrorMessage(cause) })),
        );
      return GraphToolkit.of({
        resolve_symbol: (args) =>
          runGraphTool(
            lookupDependencyGraphSymbolEffect({
              versionId: input.versionId,
              name: args.name,
              file: args.file,
              line: args.line,
              column: args.column,
              limit: args.limit,
            }),
          ),
        symbol_dependencies: (args) =>
          runGraphTool(
            getSymbolDependenciesEffect({
              versionId: input.versionId,
              symbolKey: args.symbolKey,
              edgeKinds: args.edgeKinds,
              limit: args.limit,
            }),
          ),
        symbol_dependents: (args) =>
          runGraphTool(
            getSymbolDependentsEffect({
              versionId: input.versionId,
              symbolKey: args.symbolKey,
              edgeKinds: args.edgeKinds,
              limit: args.limit,
            }),
          ),
      });
    }),
  );
