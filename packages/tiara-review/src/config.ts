import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { NodeFileSystem } from "@effect/platform-node";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  type AiProvider,
  type ReasoningEffort,
  type ReviewProviderConfig,
  type ReviewRunConfig,
  DatabaseOpenFailed,
} from "./review/types";

const providerChoices = ["codex", "openai", "openrouter", "kimi"] as const;
const reasoningChoices = ["minimal", "low", "medium", "high", "xhigh"] as const;
const kimiApprovalPolicyChoices = ["reject", "allow-read-only-git"] as const;

export const defaultDataDir = () => {
  const xdgDataHome = process.env["XDG_DATA_HOME"];
  return xdgDataHome
    ? join(xdgDataHome, "tiara-review")
    : join(homedir(), ".local", "share", "tiara-review");
};

export const defaultDbPath = () => join(defaultDataDir(), "reviews.sqlite");

export const defaultConfigDir = () => {
  const xdgConfigHome = process.env["XDG_CONFIG_HOME"];
  return xdgConfigHome
    ? join(xdgConfigHome, "tiara-review")
    : join(homedir(), ".config", "tiara-review");
};

export const defaultConfigPath = () => join(defaultConfigDir(), "config.json");

export const expandHomePath = (path: string) =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

export const ensureDbDirectory = (dbPath: string) =>
  Effect.tryPromise({
    try: () => mkdir(dirname(dbPath), { recursive: true }),
    catch: (cause) => new DatabaseOpenFailed({ dbPath, cause }),
  });

export class ReviewConfigLoadFailed extends Data.TaggedError("ReviewConfigLoadFailed")<{
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ReviewConfigInvalid extends Data.TaggedError("ReviewConfigInvalid")<{
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const JsonValueSchema: Schema.Schema<unknown> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Array(JsonValueSchema),
    Schema.Record(Schema.String, JsonValueSchema),
  ]),
);

const JsonObjectSchema = Schema.Record(Schema.String, JsonValueSchema);

const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const CodexProviderConfigSchema = Schema.Struct({
  apiKey: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  codexPathOverride: Schema.optional(Schema.String),
  cleanupGraceMs: Schema.optional(positiveInt),
  config: Schema.optional(JsonObjectSchema),
});

const OpenAiProviderConfigSchema = Schema.Struct({
  apiKey: Schema.optional(Schema.String),
  apiUrl: Schema.optional(Schema.String),
  organizationId: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  config: Schema.optional(JsonObjectSchema),
});

const OpenRouterProviderConfigSchema = Schema.Struct({
  apiKey: Schema.optional(Schema.String),
  apiUrl: Schema.optional(Schema.String),
  siteReferrer: Schema.optional(Schema.String),
  siteTitle: Schema.optional(Schema.String),
  config: Schema.optional(JsonObjectSchema),
});

const KimiProviderConfigSchema = Schema.Struct({
  executable: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  thinking: Schema.optional(Schema.Boolean),
  yoloMode: Schema.optional(Schema.Boolean),
  approvalPolicy: Schema.optional(Schema.Literals(kimiApprovalPolicyChoices)),
  agentFile: Schema.optional(Schema.String),
  skillsDir: Schema.optional(Schema.String),
  shareDir: Schema.optional(Schema.String),
  cleanupGraceMs: Schema.optional(positiveInt),
  config: Schema.optional(JsonObjectSchema),
});

export const ReviewProviderConfigSchema = Schema.Struct({
  provider: Schema.optional(Schema.Literals(providerChoices)),
  model: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Literals(reasoningChoices)),
  modelReasoningEffort: Schema.optional(Schema.Literals(reasoningChoices)),
  timeoutMs: Schema.optional(positiveInt),
  dbPath: Schema.optional(Schema.String),
  providers: Schema.optional(
    Schema.Struct({
      codex: Schema.optional(CodexProviderConfigSchema),
      openai: Schema.optional(OpenAiProviderConfigSchema),
      openrouter: Schema.optional(OpenRouterProviderConfigSchema),
      kimi: Schema.optional(KimiProviderConfigSchema),
    }),
  ),
});

export type CliRunOptions = {
  readonly cwd: string;
  readonly provider?: AiProvider;
  readonly model?: string;
  readonly reasoning?: ReasoningEffort;
  readonly dbPath?: string;
  readonly timeoutMs?: number;
  readonly externalReviewMarkdown?: string;
  readonly graphMcpCommand?: string;
  readonly graphMcpArgsPrefix?: ReadonlyArray<string>;
};

export const loadReviewConfig = (
  path?: string,
): Effect.Effect<ReviewProviderConfig, ReviewConfigLoadFailed | ReviewConfigInvalid> => {
  const explicitPath = path !== undefined;
  const configPath = expandHomePath(path ?? defaultConfigPath());
  const loadFailed = (cause: unknown) =>
    new ReviewConfigLoadFailed({
      path: configPath,
      message: cause instanceof Error ? cause.message : "Failed to read review config",
      cause,
    });
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!explicitPath) {
      const exists = yield* fs.exists(configPath).pipe(Effect.mapError(loadFailed));
      if (!exists) {
        return undefined;
      }
    }
    return yield* fs.readFileString(configPath).pipe(Effect.mapError(loadFailed));
  }).pipe(
    Effect.flatMap((contents) =>
      contents === undefined
        ? Effect.succeed({} as ReviewProviderConfig)
        : Effect.try({
            try: () => JSON.parse(contents) as unknown,
            catch: (cause) =>
              new ReviewConfigInvalid({
                path: configPath,
                message: cause instanceof Error ? cause.message : "Invalid JSON review config",
                cause,
              }),
          }),
    ),
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(ReviewProviderConfigSchema)(json).pipe(
        Effect.mapError(
          (cause) =>
            new ReviewConfigInvalid({
              path: configPath,
              message: String(cause),
              cause,
            }),
        ),
      ),
    ),
    Effect.map((config) => {
      const normalizedReasoning = config.modelReasoningEffort ?? config.reasoning;
      const providers = config.providers as ReviewProviderConfig["providers"] | undefined;
      const kimi = providers?.kimi;
      return {
        provider: config.provider,
        model: config.model,
        modelReasoningEffort: normalizedReasoning,
        timeoutMs: config.timeoutMs,
        dbPath: config.dbPath === undefined ? undefined : expandHomePath(config.dbPath),
        providers:
          providers === undefined
            ? undefined
            : {
                ...providers,
                kimi:
                  kimi === undefined
                    ? undefined
                    : {
                        ...kimi,
                        executable:
                          kimi.executable?.startsWith("~") === true
                            ? expandHomePath(kimi.executable)
                            : kimi.executable,
                        agentFile:
                          kimi.agentFile === undefined ? undefined : expandHomePath(kimi.agentFile),
                        skillsDir:
                          kimi.skillsDir === undefined ? undefined : expandHomePath(kimi.skillsDir),
                        shareDir:
                          kimi.shareDir === undefined ? undefined : expandHomePath(kimi.shareDir),
                      },
              },
      } satisfies ReviewProviderConfig;
    }),
    Effect.provide(NodeFileSystem.layer),
  ) as Effect.Effect<ReviewProviderConfig, ReviewConfigLoadFailed | ReviewConfigInvalid>;
};

export const mergeRunConfig = (input: {
  readonly fileConfig: ReviewProviderConfig;
  readonly cli: CliRunOptions;
}): ReviewRunConfig => ({
  cwd: input.cli.cwd,
  provider: input.cli.provider ?? input.fileConfig.provider ?? "codex",
  providerConfig: input.fileConfig.providers,
  dbPath:
    input.cli.dbPath !== undefined
      ? expandHomePath(input.cli.dbPath)
      : input.fileConfig.dbPath !== undefined
        ? input.fileConfig.dbPath
        : undefined,
  model: input.cli.model ?? input.fileConfig.model,
  modelReasoningEffort: input.cli.reasoning ?? input.fileConfig.modelReasoningEffort,
  timeoutMs: input.cli.timeoutMs ?? input.fileConfig.timeoutMs,
  externalReviewMarkdown: input.cli.externalReviewMarkdown,
  graphMcpCommand: input.cli.graphMcpCommand,
  graphMcpArgsPrefix: input.cli.graphMcpArgsPrefix,
});
