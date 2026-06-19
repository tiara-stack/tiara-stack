import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { NodeHttpClient } from "@effect/platform-node";
import { CodexClient, CodexConfig, CodexLanguageModel } from "effect-ai-codex";
import { KimiClient, KimiLanguageModel } from "effect-ai-kimi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import { type KimiDependencyGraphTools, makeKimiDependencyGraphTools } from "../graph/kimi-tools";
import {
  type AiProvider,
  CodexAgentFailed,
  type ResolvedReviewProviderConfig,
} from "../review/types";
import type { AiRunOptions } from "./client";

const codexModelConfig = (options: AiRunOptions): CodexLanguageModel.Config => {
  const codexConfig = options.providerConfig?.codex;
  const thread = {
    workingDirectory: options.repoRoot,
    sandboxMode: "read-only" as const,
    approvalPolicy: "never" as const,
    webSearchMode: "disabled" as const,
    networkAccessEnabled: false,
    model: options.model,
    modelReasoningEffort: options.modelReasoningEffort,
  };
  const baseConfig: CodexLanguageModel.Config = {
    thread,
    timeoutMs: options.timeoutMs,
    cleanupGraceMs: codexConfig?.cleanupGraceMs,
    apiKey: codexConfig?.apiKey,
    baseUrl: codexConfig?.baseUrl,
    codexPathOverride: codexConfig?.codexPathOverride,
    config: codexConfig?.config as CodexLanguageModel.Config["config"],
  };
  if (!options.graphVersionId || !options.graphDbPath || !options.graphMcpCommand) {
    return baseConfig;
  }
  return {
    ...baseConfig,
    config: {
      ...baseConfig.config,
      ...CodexConfig.makeMcpServerConfig({
        tiara_review_graph: {
          command: options.graphMcpCommand,
          args: [
            ...(options.graphMcpArgsPrefix ?? []),
            "graph",
            "mcp",
            "--db",
            options.graphDbPath,
            "--graph-version",
            options.graphVersionId,
          ],
          cwd: options.repoRoot,
          enabled_tools: ["resolve_symbol", "symbol_dependencies", "symbol_dependents"],
          startup_timeout_ms: 10_000,
          tool_timeout_sec: 30,
          required: true,
        },
      }),
    },
  };
};

const KimiSessionConfigSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.Boolean),
  yoloMode: Schema.optional(Schema.Boolean),
  executable: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  agentFile: Schema.optional(Schema.String),
  skillsDir: Schema.optional(Schema.String),
  shareDir: Schema.optional(Schema.String),
  clientInfo: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
    }),
  ),
});

export const kimiSessionConfig = (
  config: ResolvedReviewProviderConfig["kimi"] | undefined,
): KimiLanguageModel.Config["session"] | undefined => {
  const raw = config?.config;
  if (raw === undefined) {
    return undefined;
  }
  return Option.getOrUndefined(Schema.decodeUnknownOption(KimiSessionConfigSchema)(raw));
};

export const makeKimiGraphTools = (options: AiRunOptions): KimiDependencyGraphTools | undefined =>
  options.graphVersionId && options.graphDbPath
    ? makeKimiDependencyGraphTools({
        dbPath: options.graphDbPath,
        versionId: options.graphVersionId,
      })
    : undefined;

export const kimiModelConfig = (
  options: AiRunOptions,
  externalTools: KimiDependencyGraphTools | undefined,
): KimiLanguageModel.Config => {
  const kimiConfig = options.providerConfig?.kimi;
  const thinking =
    kimiConfig?.thinking ??
    (options.modelReasoningEffort === "high" || options.modelReasoningEffort === "xhigh");
  return {
    workDir: options.repoRoot,
    executable: kimiConfig?.executable,
    env: kimiConfig?.env,
    thinking,
    approvalPolicy: kimiConfig?.approvalPolicy ?? "allow-read-only-git",
    yoloMode: kimiConfig?.yoloMode ?? false,
    agentFile: kimiConfig?.agentFile,
    skillsDir: kimiConfig?.skillsDir,
    shareDir: kimiConfig?.shareDir,
    timeoutMs: options.timeoutMs,
    cleanupGraceMs: kimiConfig?.cleanupGraceMs,
    session: kimiSessionConfig(kimiConfig),
    externalTools,
  };
};

const requireModel = (
  options: AiRunOptions,
  provider: AiProvider,
): Effect.Effect<string, CodexAgentFailed> => {
  const model = options.model?.trim();
  return model && model.length > 0
    ? Effect.succeed(model)
    : Effect.fail(
        new CodexAgentFailed({
          aspect: options.aspect,
          message: `Provider ${provider} requires a model. Set --model or configure model in config.json.`,
        }),
      );
};

export const openAiLanguageModelLayer = (
  options: AiRunOptions,
  model: string,
): Layer.Layer<LanguageModel.LanguageModel, never> => {
  const config = options.providerConfig?.openai;
  const apiKey = config?.apiKey ?? process.env["OPENAI_API_KEY"];
  return OpenAiLanguageModel.layer({
    model,
    config: config?.config as any,
  }).pipe(
    Layer.provide(
      OpenAiClient.layer({
        apiKey: apiKey ? Redacted.make(apiKey) : undefined,
        apiUrl: config?.apiUrl,
        organizationId: config?.organizationId ? Redacted.make(config.organizationId) : undefined,
        projectId: config?.projectId ? Redacted.make(config.projectId) : undefined,
      }),
    ),
    Layer.provide(NodeHttpClient.layerFetch),
  ) as Layer.Layer<LanguageModel.LanguageModel, never>;
};

export const openRouterLanguageModelLayer = (
  options: AiRunOptions,
  model: string,
): Layer.Layer<LanguageModel.LanguageModel, never> => {
  const config = options.providerConfig?.openrouter;
  const apiKey = config?.apiKey ?? process.env["OPENROUTER_API_KEY"];
  return OpenRouterLanguageModel.layer({
    model,
    config: config?.config as any,
  }).pipe(
    Layer.provide(
      OpenRouterClient.layer({
        apiKey: apiKey ? Redacted.make(apiKey) : undefined,
        apiUrl: config?.apiUrl,
        siteReferrer: config?.siteReferrer,
        siteTitle: config?.siteTitle,
      }),
    ),
    Layer.provide(NodeHttpClient.layerFetch),
  ) as Layer.Layer<LanguageModel.LanguageModel, never>;
};

type LanguageModelLayerFactory = (
  options: AiRunOptions,
  kimiExternalTools: KimiDependencyGraphTools | undefined,
) => Effect.Effect<Layer.Layer<LanguageModel.LanguageModel, never>, CodexAgentFailed>;

const languageModelLayerFactories: Record<AiProvider, LanguageModelLayerFactory> = {
  codex: (options) =>
    Effect.succeed(
      CodexLanguageModel.layer({ model: options.model, config: codexModelConfig(options) }).pipe(
        Layer.provide(CodexClient.CodexClient.layer),
      ),
    ),
  kimi: (options, kimiExternalTools) =>
    Effect.succeed(
      KimiLanguageModel.layer({
        model: options.model,
        config: kimiModelConfig(options, kimiExternalTools),
      }).pipe(Layer.provide(KimiClient.KimiClient.layer)),
    ),
  openai: (options) =>
    requireModel(options, "openai").pipe(
      Effect.map((model: string) => openAiLanguageModelLayer(options, model)),
    ),
  openrouter: (options) =>
    requireModel(options, "openrouter").pipe(
      Effect.map((model: string) => openRouterLanguageModelLayer(options, model)),
    ),
};

// Layers are lightweight to construct, but the underlying SDK clients and HTTP
// transports are initialized here. Lift this to the review-run call site if
// connection-pool reuse becomes important.
export const makeLanguageModelLayer = (
  options: AiRunOptions,
  kimiExternalTools?: KimiDependencyGraphTools,
): Effect.Effect<Layer.Layer<LanguageModel.LanguageModel, never>, CodexAgentFailed> => {
  const provider = options.provider ?? "codex";
  return languageModelLayerFactories[provider](options, kimiExternalTools);
};
