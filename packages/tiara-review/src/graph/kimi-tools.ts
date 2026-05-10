import { KimiClient } from "effect-ai-kimi";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/unstable/sql";
import * as Tool from "effect/unstable/ai/Tool";
import { sqliteLayer } from "../db/client";
import {
  getSymbolDependenciesEffect,
  getSymbolDependentsEffect,
  lookupDependencyGraphSymbolEffect,
} from "./store";
import { graphToolErrorMessage } from "./toolkit";
import {
  ResolveSymbol,
  ResolveSymbolParams,
  SymbolDependencies,
  SymbolDependents,
  SymbolEdgesParams,
} from "./tools";

type KimiToolResult = {
  readonly output: string;
  readonly message: string;
};

export type KimiDependencyGraphTools = ReadonlyArray<KimiClient.KimiExternalTool> & {
  readonly dispose: () => Promise<void>;
};

const jsonOutput = (value: unknown, message = "ok"): KimiToolResult => ({
  output: JSON.stringify(value),
  message,
});

const errorOutput = (cause: unknown): KimiToolResult => {
  const message = graphToolErrorMessage(cause);
  return jsonOutput({ error: message }, message);
};

const makeRunGraphTool = (dbPath: string) => {
  const graphRuntime = ManagedRuntime.make(sqliteLayer(dbPath));
  const run = <A>(
    effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
  ): Promise<KimiToolResult> =>
    graphRuntime.runPromise(
      effect.pipe(
        Effect.map((result) => jsonOutput(result)),
        Effect.catch((cause) => Effect.succeed(errorOutput(cause))),
      ),
    );
  return Object.assign(run, { dispose: () => graphRuntime.dispose() });
};

const decodeParams = <S extends Schema.Top>(schema: S, params: Record<string, unknown>) =>
  Schema.decodeUnknownEffect(schema)(params).pipe(
    Effect.catch((cause) => Effect.fail(new Error(graphToolErrorMessage(cause)))),
  );

export const makeKimiDependencyGraphTools = (input: {
  readonly dbPath: string;
  readonly versionId: string;
}): KimiDependencyGraphTools => {
  const runGraphTool = makeRunGraphTool(input.dbPath);
  const tools = [
    KimiClient.makeExternalTool({
      name: ResolveSymbol.name,
      description: Tool.getDescription(ResolveSymbol) ?? "",
      parameters: Tool.getJsonSchemaFromSchema(ResolveSymbolParams) as Record<string, unknown>,
      handler: (params) =>
        runGraphTool(
          decodeParams(ResolveSymbolParams, params).pipe(
            Effect.flatMap((args) =>
              lookupDependencyGraphSymbolEffect({
                versionId: input.versionId,
                name: args.name,
                file: args.file,
                line: args.line,
                column: args.column,
                limit: args.limit,
              }),
            ),
          ),
        ),
    }),
    KimiClient.makeExternalTool({
      name: SymbolDependencies.name,
      description: Tool.getDescription(SymbolDependencies) ?? "",
      parameters: Tool.getJsonSchemaFromSchema(SymbolEdgesParams) as Record<string, unknown>,
      handler: (params) =>
        runGraphTool(
          decodeParams(SymbolEdgesParams, params).pipe(
            Effect.flatMap((args) =>
              getSymbolDependenciesEffect({
                versionId: input.versionId,
                symbolKey: args.symbolKey,
                edgeKinds: args.edgeKinds,
                limit: args.limit,
              }),
            ),
          ),
        ),
    }),
    KimiClient.makeExternalTool({
      name: SymbolDependents.name,
      description: Tool.getDescription(SymbolDependents) ?? "",
      parameters: Tool.getJsonSchemaFromSchema(SymbolEdgesParams) as Record<string, unknown>,
      handler: (params) =>
        runGraphTool(
          decodeParams(SymbolEdgesParams, params).pipe(
            Effect.flatMap((args) =>
              getSymbolDependentsEffect({
                versionId: input.versionId,
                symbolKey: args.symbolKey,
                edgeKinds: args.edgeKinds,
                limit: args.limit,
              }),
            ),
          ),
        ),
    }),
  ];
  return Object.assign(tools, { dispose: runGraphTool.dispose });
};
