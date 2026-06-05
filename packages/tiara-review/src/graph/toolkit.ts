import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import { SqlClient } from "effect/unstable/sql";
import {
  getSymbolDependenciesEffect,
  getSymbolDependentsEffect,
  lookupDependencyGraphSymbolEffect,
} from "./store";
import { GraphToolkit } from "./tools";

export const graphToolErrorMessage = (cause: unknown) =>
  Match.value(cause).pipe(
    Match.when(Match.instanceOfUnsafe(Error), (error) => error.message),
    Match.when(Cause.isCause, Cause.pretty),
    Match.when(Predicate.isObjectOrArray, (object) => {
      try {
        return JSON.stringify(object);
      } catch {
        return "Unserializable error object";
      }
    }),
    Match.when(Match.string, (value) => value),
    Match.whenOr(Match.number, Match.boolean, Match.bigint, Match.symbol, (value) =>
      value.toString(),
    ),
    Match.orElse(() => "Unknown error"),
  );

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
