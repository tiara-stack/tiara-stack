import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";
import { defaultDbPath, expandHomePath, loadReviewConfig, mergeRunConfig } from "./config";
import { resolveRepoRoot, getCurrentBranch, captureCheckpoint } from "./git/checkpoint";
import { ensureDependencyGraphVersion, lookupDependencyGraphSymbol } from "./graph/store";
import { runDependencyGraphMcpServer } from "./graph/mcp";
import { runCheckpointedReview } from "./review/workflow";
import type { AiProvider, ReasoningEffort } from "./review/types";

const reasoningChoices = ["minimal", "low", "medium", "high", "xhigh"] as const;
const providerChoices = ["codex", "openai", "openrouter", "kimi"] as const;

class EmptyReviewStdin extends Data.TaggedError("EmptyReviewStdin")<{
  readonly message: string;
}> {}

class StdinReadFailed extends Data.TaggedError("StdinReadFailed")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export const readStdin = () =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const chunks: Array<Buffer> = [];
        process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
        process.stdin.on("error", reject);
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        process.stdin.resume();
      }),
    catch: (cause) =>
      new StdinReadFailed({
        message: cause instanceof Error ? cause.message : "Failed to read stdin",
        cause,
      }),
  });

const runCommand = Command.make(
  "run",
  {
    cwd: Flag.directory("cwd").pipe(Flag.withDefault(process.cwd())),
    configPath: Flag.path("config").pipe(Flag.optional),
    provider: Flag.choice("provider", providerChoices).pipe(Flag.optional),
    model: Flag.string("model").pipe(Flag.optional),
    reasoning: Flag.choice("reasoning", reasoningChoices).pipe(Flag.optional),
    db: Flag.path("db").pipe(Flag.optional),
    json: Flag.boolean("json").pipe(Flag.withDefault(false)),
    timeoutMs: Flag.integer("timeout-ms").pipe(Flag.optional),
    reviewStdin: Flag.boolean("review-stdin").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const externalReviewMarkdown = config.reviewStdin ? yield* readStdin() : undefined;
      if (config.reviewStdin && externalReviewMarkdown?.trim().length === 0) {
        return yield* Effect.fail(
          new EmptyReviewStdin({
            message: "--review-stdin was provided but stdin was empty",
          }),
        );
      }
      const fileConfig = yield* loadReviewConfig(
        config.configPath._tag === "Some" ? expandHomePath(config.configPath.value) : undefined,
      );
      const result = yield* runCheckpointedReview(
        mergeRunConfig({
          fileConfig,
          cli: {
            cwd: config.cwd,
            provider:
              config.provider._tag === "Some" ? (config.provider.value as AiProvider) : undefined,
            dbPath: config.db._tag === "Some" ? config.db.value : undefined,
            model: config.model._tag === "Some" ? config.model.value : undefined,
            reasoning:
              config.reasoning._tag === "Some"
                ? (config.reasoning.value as ReasoningEffort)
                : undefined,
            timeoutMs: config.timeoutMs._tag === "Some" ? config.timeoutMs.value : undefined,
            externalReviewMarkdown,
            graphMcpCommand: process.execPath,
            graphMcpArgsPrefix: process.argv[1] ? [process.argv[1]] : undefined,
          },
        }),
      );
      const externalReviewPrefix = result.externalReviewImport
        ? `External review import: ${result.externalReviewImport.importedFindingCount} findings imported; ${result.externalReviewImport.skippedFindingCount} skipped; ${result.externalReviewImport.warnings.length} warnings.\n\n`
        : "";
      yield* Console.log(
        config.json
          ? JSON.stringify(result, null, 2)
          : `${externalReviewPrefix}${result.reportMarkdown}`,
      );
    }),
).pipe(Command.withDescription("Run a checkpointed multi-agent AI code review"));

const graphBuildCommand = Command.make(
  "build",
  {
    cwd: Flag.directory("cwd").pipe(Flag.withDefault(process.cwd())),
    db: Flag.path("db").pipe(Flag.optional),
  },
  (config) =>
    Effect.gen(function* () {
      const repoRoot = yield* resolveRepoRoot(config.cwd);
      const branch = yield* getCurrentBranch(repoRoot);
      const checkpoint = yield* captureCheckpoint(repoRoot);
      const version = yield* ensureDependencyGraphVersion({
        repoRoot,
        branch,
        checkpointRef: checkpoint.checkpointRef,
        checkpointCommit: checkpoint.checkpointCommit,
        diffHash: "",
        dbPath: config.db._tag === "Some" ? config.db.value : defaultDbPath(),
      });
      yield* Console.log(JSON.stringify(version, null, 2));
    }),
).pipe(Command.withDescription("Build the TypeScript dependency graph for the current checkpoint"));

const graphLookupCommand = Command.make(
  "lookup",
  {
    db: Flag.path("db").pipe(Flag.optional),
    graphVersion: Flag.string("graph-version"),
    symbol: Flag.string("symbol").pipe(Flag.optional),
    file: Flag.string("file").pipe(Flag.optional),
    line: Flag.integer("line").pipe(Flag.optional),
    column: Flag.integer("column").pipe(Flag.optional),
  },
  (config) =>
    Effect.gen(function* () {
      const result = yield* lookupDependencyGraphSymbol({
        dbPath: config.db._tag === "Some" ? config.db.value : defaultDbPath(),
        versionId: config.graphVersion,
        name: config.symbol._tag === "Some" ? config.symbol.value : undefined,
        file: config.file._tag === "Some" ? config.file.value : undefined,
        line: config.line._tag === "Some" ? config.line.value : undefined,
        column: config.column._tag === "Some" ? config.column.value : undefined,
      });
      yield* Console.log(JSON.stringify(result, null, 2));
    }),
).pipe(Command.withDescription("Look up TypeScript symbols in a dependency graph version"));

const graphMcpCommand = Command.make(
  "mcp",
  {
    db: Flag.path("db").pipe(Flag.optional),
    graphVersion: Flag.string("graph-version"),
  },
  (config) =>
    runDependencyGraphMcpServer({
      dbPath: config.db._tag === "Some" ? config.db.value : defaultDbPath(),
      versionId: config.graphVersion,
    }),
).pipe(Command.withDescription("Run the dependency graph MCP server over stdio"));

const graphCommand = Command.make("graph").pipe(
  Command.withDescription("Build and query TypeScript dependency graphs"),
  Command.withSubcommands([graphBuildCommand, graphLookupCommand, graphMcpCommand]),
);

export const command = Command.make("tiara-review").pipe(
  Command.withDescription("Checkpointed AI code review CLI"),
  Command.withSubcommands([runCommand, graphCommand]),
);

export const main = Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
);

export const runMain = () => NodeRuntime.runMain(main as Effect.Effect<void, unknown>);
