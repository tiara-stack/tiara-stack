import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { createRequire } from "node:module";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import {
  resolveRepoRoot,
  captureCheckpoint,
  deleteCheckpointRef,
  determineReviewBaseFromCompletedCheckpoint,
  getCurrentBranch,
} from "../git/checkpoint";
import { getDiffInfo } from "../git/diff";
import { ensureDependencyGraphVersion } from "../graph/store";
import {
  ConsolidatedOutputSchema,
  SpecialistOutputSchema,
  decodeConsolidatedOutput,
  decodeSpecialistOutput,
  ProviderAiReviewClient,
  type CodexReviewClient,
} from "../codex/client";
import { groupedPriorFindings, makeId, ReviewRepository } from "../db/repository";
import { defaultDbPath } from "../config";
import { makeOrchestratorPrompt, makeSpecialistPrompt } from "./prompts";
import { renderReviewReport } from "./report";
import {
  type ReviewAspect,
  type ReviewRunConfig,
  type ReviewRunRecord,
  type ReviewRunResult,
  type SpecialistReviewOutput,
  type ExternalReviewImportResult,
  type FindingSource,
  type ReviewFinding,
  CodexAgentFailed,
  CodexAgentTimedOut,
  OrchestratorFailed,
  reviewAspects,
  type AgentStatus,
} from "./types";
import { parseExternalReviewWithAi } from "./external-review";

const now = () => Math.floor(Date.now() / 1000);
export const tiaraReviewCliBinPath = "dist/index.mjs";
const tiaraReviewCliBinNameFallback = "tiara-review";
const require = createRequire(import.meta.url);
const compiledFileDir = dirname(fileURLToPath(import.meta.url));
export const packageRootFallbackFromCompiledDir = (compiledDir: string) => {
  let current = compiledDir;
  while (true) {
    if (existsSync(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return dirname(compiledDir);
    }
    current = parent;
  }
};
const packageRootFallback = () => packageRootFallbackFromCompiledDir(compiledFileDir);
const packageRoot = () => {
  try {
    return dirname(require.resolve("tiara-review/package.json"));
  } catch {
    return packageRootFallback();
  }
};
const defaultGraphMcpCommand = () => process.execPath;
const packageBinMetadata = () => {
  try {
    const pkg = require("tiara-review/package.json") as {
      readonly bin?: string | Record<string, string>;
    };
    if (typeof pkg.bin === "string" && pkg.bin.length > 0) {
      return { name: tiaraReviewCliBinNameFallback, entrypoint: pkg.bin };
    }
    if (pkg.bin && typeof pkg.bin === "object") {
      const binName = pkg.bin[tiaraReviewCliBinNameFallback]
        ? tiaraReviewCliBinNameFallback
        : Object.keys(pkg.bin)[0];
      const binEntry = binName ? pkg.bin[binName] : undefined;
      if (binName && binEntry && binEntry.length > 0) {
        return { name: binName, entrypoint: binEntry };
      }
    }
  } catch {
    // Fall back to the current bundled path when package metadata is unavailable.
  }
  return null;
};
const resolvedCliBinName = () => packageBinMetadata()?.name ?? tiaraReviewCliBinNameFallback;
const resolvedCliEntrypoint = () => {
  const metadata = packageBinMetadata();
  if (metadata) {
    return join(packageRoot(), metadata.entrypoint);
  }
  return join(packageRoot(), tiaraReviewCliBinPath);
};
const defaultGraphMcpEntrypoint = resolvedCliEntrypoint;
const scopedPackageNamePattern = /^@[^/\\]+\/[^/\\]+$/;
export const looksLikeFilesystemPath = (path: string) =>
  !scopedPackageNamePattern.test(path) &&
  (path.startsWith("/") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.startsWith("file:") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.includes("/") ||
    path.includes("\\"));
const looksLikeBareEntrypointPath = (path: string) =>
  !path.startsWith("@") && !path.startsWith("-") && extname(path).length > 0;
const resolveEntrypointPath = (path: string, repoRoot: string) =>
  isAbsolute(path) ? path : resolve(repoRoot, path);
const looksLikeDirectGraphMcpCommand = (command: string) => {
  const commandName = basename(command).toLowerCase();
  const binName = resolvedCliBinName().toLowerCase();
  return (
    commandName === binName || commandName === `${binName}.cmd` || commandName === `${binName}.ps1`
  );
};
const isInsidePath = (parent: string, child: string) => {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
};
const isExecutableFile = (path: string) => {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const pathCandidatesForCommand = (command: string, repoRoot: string) => {
  if (looksLikeFilesystemPath(command)) {
    return [isAbsolute(command) ? command : resolve(repoRoot, command)];
  }
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32" && extname(command).length === 0
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  return pathEntries.flatMap((entry) =>
    extensions.map((extension) => resolve(entry, `${command}${extension}`)),
  );
};
const resolveCommandExecutable = (command: string, repoRoot: string) => {
  for (const candidate of pathCandidatesForCommand(command, repoRoot)) {
    if (isInsidePath(repoRoot, candidate)) {
      continue;
    }
    if (isExecutableFile(candidate)) {
      let commandPath: string;
      try {
        commandPath = realpathSync(candidate);
      } catch {
        continue;
      }
      if (!isInsidePath(repoRoot, commandPath)) {
        return commandPath;
      }
    }
  }
  return null;
};
const resolveDirectGraphMcpCommand = (command: string, repoRoot: string) => {
  if (!looksLikeDirectGraphMcpCommand(command)) {
    return null;
  }
  const commandPath = resolveCommandExecutable(command, repoRoot);
  return commandPath;
};
const graphMcpLauncher = (config: ReviewRunConfig, repoRoot: string) => {
  if (config.graphMcpCommand !== undefined || config.graphMcpArgsPrefix !== undefined) {
    const command = config.graphMcpCommand ?? defaultGraphMcpCommand();
    const argsPrefix = config.graphMcpArgsPrefix ?? [];
    const firstArg = argsPrefix[0];
    const resolvedDirectCommand =
      argsPrefix.length === 0 ? resolveDirectGraphMcpCommand(command, repoRoot) : null;
    const missingNoPrefixCommand = argsPrefix.length === 0 && resolvedDirectCommand === null;
    const entrypointPath =
      firstArg !== undefined &&
      (looksLikeFilesystemPath(firstArg) || looksLikeBareEntrypointPath(firstArg))
        ? resolveEntrypointPath(firstArg, repoRoot)
        : null;
    const missingEntrypoint =
      missingNoPrefixCommand || (entrypointPath !== null && !existsSync(entrypointPath));
    const available = command.length > 0 && !missingEntrypoint;
    return {
      command: resolvedDirectCommand ?? command,
      argsPrefix,
      available,
      unavailableReason:
        command.length === 0
          ? "custom graph MCP command is empty"
          : missingNoPrefixCommand
            ? `custom graph MCP command is unavailable: ${command}`
            : `custom graph MCP entrypoint is unavailable: ${entrypointPath ?? firstArg}`,
    };
  }
  const entrypoint = defaultGraphMcpEntrypoint();
  const available = existsSync(entrypoint);
  return {
    command: defaultGraphMcpCommand(),
    argsPrefix: [entrypoint],
    available,
    unavailableReason: `default graph MCP entrypoint is unavailable: ${entrypoint}`,
  };
};
const graphFailureSummary = (cause: Cause.Cause<unknown>) =>
  String(cause)
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/[`<>]/g, "")
    .slice(0, 240);

const agentFailureStatus = (cause: Cause.Cause<unknown>): AgentStatus => {
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) && error.value instanceof CodexAgentTimedOut ? "timed-out" : "failed";
};

export const runCheckpointedReviewWithClient = (
  config: ReviewRunConfig,
  client: CodexReviewClient,
) =>
  Effect.gen(function* () {
    const repoRoot = yield* resolveRepoRoot(config.cwd);
    const dbPath = config.dbPath ?? defaultDbPath();
    const provider = config.provider ?? "codex";
    const repository = yield* ReviewRepository;
    const checkpoint = yield* captureCheckpoint(repoRoot);
    const runAfterCheckpoint = Effect.gen(function* () {
      const branch = yield* getCurrentBranch(repoRoot);
      const priorCheckpoint = yield* repository.run(
        repository.loadLatestCompletedCheckpoint(repoRoot, branch),
      );
      const base = yield* determineReviewBaseFromCompletedCheckpoint(
        repoRoot,
        checkpoint,
        priorCheckpoint,
      );
      const diffInfo = yield* getDiffInfo(repoRoot, base, checkpoint);
      const runId = makeId();
      const createdAt = now();
      const runRecord = {
        id: runId,
        repoRoot,
        branch,
        headCommit: checkpoint.headCommit,
        baseRef: base.baseRef,
        baseCommit: base.baseCommit,
        checkpointRef: checkpoint.checkpointRef,
        checkpointCommit: checkpoint.checkpointCommit,
        checkpointCreatedAtMillis: checkpoint.createdAt,
        diffHash: diffInfo.diffHash,
        diffStatJson: JSON.stringify(diffInfo.stat),
        createdAt,
        status: "running",
      } satisfies ReviewRunRecord;

      yield* repository.run(repository.insertRun(runRecord));
      const completeRunOnError = (cause: Cause.Cause<unknown>) =>
        repository
          .run(
            repository.completeRun({
              runId,
              status: "failed",
              completedAt: now(),
              error: String(cause),
            }),
          )
          .pipe(Effect.ignore);
      const dependencyGraphExit = yield* Effect.exit(
        ensureDependencyGraphVersion({
          repoRoot,
          branch,
          checkpointRef: checkpoint.checkpointRef,
          checkpointCommit: checkpoint.checkpointCommit,
          diffHash: diffInfo.diffHash,
          dbPath,
        }),
      );
      const dependencyGraphVersion = Exit.isSuccess(dependencyGraphExit)
        ? dependencyGraphExit.value
        : null;
      const graphLauncher = graphMcpLauncher(config, repoRoot);
      const dependencyGraphToolsAvailable =
        dependencyGraphVersion !== null && (provider === "kimi" || graphLauncher.available);
      const dependencyGraphReviewNotes = Exit.isFailure(dependencyGraphExit)
        ? [`Dependency graph tools unavailable: ${graphFailureSummary(dependencyGraphExit.cause)}`]
        : provider !== "kimi" && dependencyGraphVersion !== null && !dependencyGraphToolsAvailable
          ? [`Dependency graph tools unavailable: ${graphLauncher.unavailableReason}`]
          : [];
      const markAgentFailed = (input: {
        readonly agentId: string;
        readonly status: AgentStatus;
        readonly error: string;
        readonly codexThreadId?: string | null;
      }) =>
        repository.run(
          repository.updateAgent({
            id: input.agentId,
            status: input.status,
            codexThreadId: input.codexThreadId,
            completedAt: now(),
            error: input.error,
          }),
        );
      const failWithAgentFailureAndMarkFailure = (
        agentCause: Cause.Cause<unknown>,
        markCause: Cause.Cause<unknown>,
      ) => Effect.failCause(Cause.combine(agentCause, markCause));
      const persistCompletedAgentFindings = (input: {
        readonly agentId: string;
        readonly source: FindingSource;
        readonly threadId: string | null;
        readonly findings: ReadonlyArray<ReviewFinding>;
      }) =>
        Effect.gen(function* () {
          yield* repository.run(
            repository.updateAgent({
              id: input.agentId,
              status: "completed",
              codexThreadId: input.threadId,
              completedAt: now(),
            }),
          );
          yield* repository.run(
            repository.insertFindings({
              runId,
              agentId: input.agentId,
              source: input.source,
              findings: input.findings,
            }),
          );
        });
      const reviewExecution = Effect.gen(function* () {
        const externalReviewMarkdown = config.externalReviewMarkdown;
        const externalReviewImport: ExternalReviewImportResult | undefined =
          externalReviewMarkdown && externalReviewMarkdown.trim().length > 0
            ? yield* Effect.gen(function* () {
                const parserAgentId = makeId();
                yield* repository.run(
                  repository.insertAgent({
                    id: parserAgentId,
                    runId,
                    aspect: "external-review-parser",
                    status: "running",
                    startedAt: now(),
                  }),
                );
                const parserExit = yield* Effect.exit(
                  parseExternalReviewWithAi(
                    {
                      markdown: externalReviewMarkdown,
                      repoRoot,
                      provider,
                      providerConfig: config.providerConfig,
                      model: config.model,
                      modelReasoningEffort: config.modelReasoningEffort ?? "high",
                      timeoutMs: config.timeoutMs,
                    },
                    client,
                  ),
                );
                if (Exit.isFailure(parserExit)) {
                  const error = String(parserExit.cause);
                  const failureUpdateExit = yield* Effect.exit(
                    markAgentFailed({
                      agentId: parserAgentId,
                      status: agentFailureStatus(parserExit.cause),
                      error,
                    }),
                  );
                  if (Exit.isFailure(failureUpdateExit)) {
                    return yield* failWithAgentFailureAndMarkFailure(
                      parserExit.cause,
                      failureUpdateExit.cause,
                    );
                  }
                  return yield* Effect.failCause(parserExit.cause);
                }
                const persistenceExit = yield* Effect.exit(
                  persistCompletedAgentFindings({
                    agentId: parserAgentId,
                    source: "external-review",
                    threadId: parserExit.value.threadId,
                    findings: parserExit.value.findings,
                  }),
                );
                if (Exit.isFailure(persistenceExit)) {
                  const failureUpdateExit = yield* Effect.exit(
                    markAgentFailed({
                      agentId: parserAgentId,
                      status: "failed",
                      codexThreadId: parserExit.value.threadId,
                      error: `Failed to persist external review parser result: ${String(persistenceExit.cause)}`,
                    }),
                  );
                  if (Exit.isFailure(failureUpdateExit)) {
                    return yield* failWithAgentFailureAndMarkFailure(
                      persistenceExit.cause,
                      failureUpdateExit.cause,
                    );
                  }
                  return yield* Effect.failCause(persistenceExit.cause);
                }
                return {
                  importedFindingCount: parserExit.value.findings.length,
                  skippedFindingCount: parserExit.value.skippedFindingCount,
                  warnings: parserExit.value.warnings,
                  codexThreadId: parserExit.value.threadId,
                } satisfies ExternalReviewImportResult;
              })
            : undefined;

        const priorFindings = yield* repository.run(
          repository.loadReviewInputFindings({ repoRoot, currentRunId: runId }),
        );
        const priorByAspect = groupedPriorFindings(priorFindings);

        const reviewerEffects = reviewAspects.map((aspect) =>
          Effect.gen(function* () {
            const agentId = makeId();
            yield* repository.run(
              repository.insertAgent({
                id: agentId,
                runId,
                aspect,
                status: "running",
                startedAt: now(),
              }),
            );
            const prompt = makeSpecialistPrompt({
              aspect,
              baseRef: base.baseRef,
              checkpointRef: checkpoint.checkpointRef,
              checkpointCommit: checkpoint.checkpointCommit,
              diffText: diffInfo.diffText,
              priorFindings: priorByAspect[aspect],
              dependencyGraphAvailable: dependencyGraphToolsAvailable,
            });
            const resultExit = yield* Effect.exit(
              client
                .runStructured<unknown>(prompt, {
                  aspect,
                  repoRoot,
                  provider,
                  providerConfig: config.providerConfig,
                  model: config.model,
                  modelReasoningEffort: config.modelReasoningEffort ?? "high",
                  timeoutMs: config.timeoutMs,
                  schema: SpecialistOutputSchema,
                  graphVersionId: dependencyGraphToolsAvailable
                    ? dependencyGraphVersion.id
                    : undefined,
                  graphDbPath: dbPath,
                  graphMcpCommand: graphLauncher.command,
                  graphMcpArgsPrefix: graphLauncher.argsPrefix,
                })
                .pipe(
                  Effect.flatMap((result) =>
                    decodeSpecialistOutput(aspect, result.output).pipe(
                      Effect.map((output) => ({ output, threadId: result.threadId })),
                    ),
                  ),
                ),
            );
            if (Exit.isFailure(resultExit)) {
              const failureUpdateExit = yield* Effect.exit(
                markAgentFailed({
                  agentId,
                  status: agentFailureStatus(resultExit.cause),
                  error: String(resultExit.cause),
                }),
              );
              if (Exit.isFailure(failureUpdateExit)) {
                return yield* failWithAgentFailureAndMarkFailure(
                  resultExit.cause,
                  failureUpdateExit.cause,
                );
              }
              return { aspect, agentId, output: null, failed: true as const };
            }
            const persistenceExit = yield* Effect.exit(
              persistCompletedAgentFindings({
                agentId,
                source: "specialist",
                threadId: resultExit.value.threadId,
                findings: resultExit.value.output.findings,
              }),
            );
            if (Exit.isFailure(persistenceExit)) {
              const failureUpdateExit = yield* Effect.exit(
                markAgentFailed({
                  agentId,
                  status: "failed",
                  codexThreadId: resultExit.value.threadId,
                  error: `Failed to persist reviewer result: ${String(persistenceExit.cause)}`,
                }),
              );
              if (Exit.isFailure(failureUpdateExit)) {
                return yield* failWithAgentFailureAndMarkFailure(
                  persistenceExit.cause,
                  failureUpdateExit.cause,
                );
              }
              return yield* Effect.failCause(persistenceExit.cause);
            }
            return { aspect, agentId, output: resultExit.value.output, failed: false as const };
          }),
        );

        const reviewerResults = yield* Effect.all(reviewerEffects, { concurrency: "unbounded" });
        const successfulOutputs = reviewerResults
          .filter(
            (
              result,
            ): result is typeof result & {
              readonly output: SpecialistReviewOutput;
              readonly failed: false;
            } => !result.failed,
          )
          .map((result) => result.output);
        const failedAspects = reviewerResults
          .filter((result) => result.failed)
          .map((result) => result.aspect as ReviewAspect);

        const orchestratorAgentId = makeId();
        yield* repository.run(
          repository.insertAgent({
            id: orchestratorAgentId,
            runId,
            aspect: "orchestrator",
            status: "running",
            startedAt: now(),
          }),
        );
        const orchestratorPrompt = makeOrchestratorPrompt({
          baseRef: base.baseRef,
          checkpointRef: checkpoint.checkpointRef,
          diffInfo,
          reviewerOutputs: successfulOutputs,
          failedAspects,
          reviewNotes: dependencyGraphReviewNotes,
        });
        const orchestratorExit = yield* Effect.exit(
          client
            .runStructured<unknown>(orchestratorPrompt, {
              aspect: "orchestrator",
              repoRoot,
              provider,
              providerConfig: config.providerConfig,
              model: config.model,
              modelReasoningEffort: config.modelReasoningEffort ?? "high",
              timeoutMs: config.timeoutMs,
              schema: ConsolidatedOutputSchema,
            })
            .pipe(
              Effect.flatMap((result) =>
                decodeConsolidatedOutput("orchestrator", result.output).pipe(
                  Effect.map((output) => ({ output, threadId: result.threadId })),
                ),
              ),
            ),
        );

        if (Exit.isFailure(orchestratorExit)) {
          const error = String(orchestratorExit.cause);
          const failureUpdateExit = yield* Effect.exit(
            markAgentFailed({
              agentId: orchestratorAgentId,
              status: agentFailureStatus(orchestratorExit.cause),
              error,
            }),
          );
          if (Exit.isFailure(failureUpdateExit)) {
            return yield* failWithAgentFailureAndMarkFailure(
              orchestratorExit.cause,
              failureUpdateExit.cause,
            );
          }
          return yield* Effect.fail(
            new OrchestratorFailed({
              message: "Orchestrator failed",
              cause: orchestratorExit.cause,
            }),
          );
        }

        const consolidated = orchestratorExit.value.output;
        const reportMarkdown = renderReviewReport(consolidated);
        const orchestratorPersistenceExit = yield* Effect.exit(
          repository.run(
            repository.completeOrchestratorRun({
              runId,
              agentId: orchestratorAgentId,
              threadId: orchestratorExit.value.threadId,
              findings: consolidated.issues,
              rechecks: consolidated.priorIssuesRechecked,
              completedAt: now(),
              safetyConfidence: consolidated.safetyConfidence,
              reportMarkdown,
              reportJson: JSON.stringify(consolidated),
            }),
          ),
        );
        if (Exit.isFailure(orchestratorPersistenceExit)) {
          const failureUpdateExit = yield* Effect.exit(
            markAgentFailed({
              agentId: orchestratorAgentId,
              status: "failed",
              codexThreadId: orchestratorExit.value.threadId,
              error: `Failed to persist orchestrator result: ${String(orchestratorPersistenceExit.cause)}`,
            }),
          );
          if (Exit.isFailure(failureUpdateExit)) {
            return yield* failWithAgentFailureAndMarkFailure(
              orchestratorPersistenceExit.cause,
              failureUpdateExit.cause,
            );
          }
          return yield* Effect.failCause(orchestratorPersistenceExit.cause);
        }

        return {
          runId,
          baseReviewed: consolidated.baseReviewed,
          checkpointRef: checkpoint.checkpointRef,
          checkpointCommit: checkpoint.checkpointCommit,
          safetyConfidence: consolidated.safetyConfidence,
          findings: consolidated.issues,
          reportMarkdown,
          failedAspects,
          externalReviewImport,
        } satisfies ReviewRunResult;
      });
      return yield* reviewExecution.pipe(Effect.onError(completeRunOnError));
    });
    return yield* runAfterCheckpoint.pipe(
      Effect.onError(() =>
        deleteCheckpointRef(repoRoot, checkpoint.checkpointRef).pipe(Effect.ignore),
      ),
    );
  }).pipe(Effect.provide(ReviewRepository.layer(config.dbPath ?? defaultDbPath())));

export const runCheckpointedReview = (config: ReviewRunConfig) =>
  Effect.try({
    try: () => new ProviderAiReviewClient(),
    catch: (cause) =>
      new CodexAgentFailed({
        aspect: "orchestrator",
        message: cause instanceof Error ? cause.message : "Unable to initialize AI review client",
        cause,
      }),
  }).pipe(Effect.flatMap((client) => runCheckpointedReviewWithClient(config, client)));
