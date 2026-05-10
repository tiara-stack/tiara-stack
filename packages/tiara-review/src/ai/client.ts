import { NodeHttpClient } from "@effect/platform-node";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { CodexClient, CodexConfig, CodexLanguageModel } from "effect-ai-codex";
import { KimiClient, KimiLanguageModel } from "effect-ai-kimi";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as AiError from "effect/unstable/ai/AiError";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import { sqliteLayer } from "../db/client";
import { type KimiDependencyGraphTools, makeKimiDependencyGraphTools } from "../graph/kimi-tools";
import { graphToolkitLayer } from "../graph/toolkit";
import { GraphToolkit } from "../graph/tools";
import {
  type AgentAspect,
  type AiProvider,
  type ReasoningEffort,
  type ResolvedReviewProviderConfig,
  CodexAgentFailed,
  CodexAgentTimedOut,
  InvalidAgentOutput,
} from "../review/types";

export type AiRunOptions = {
  readonly aspect: AgentAspect;
  readonly repoRoot: string;
  readonly provider?: AiProvider;
  readonly providerConfig?: ResolvedReviewProviderConfig;
  readonly model?: string;
  readonly modelReasoningEffort?: ReasoningEffort;
  readonly timeoutMs?: number;
  readonly schema: Schema.Top;
  readonly graphVersionId?: string;
  readonly graphDbPath?: string;
  readonly graphMcpCommand?: string;
  readonly graphMcpArgsPrefix?: ReadonlyArray<string>;
};

export type AiRunResult<A> = {
  readonly threadId: string | null;
  readonly output: A;
};

export interface AiReviewClient {
  readonly runStructured: <A>(
    prompt: string,
    options: AiRunOptions,
  ) => Effect.Effect<AiRunResult<A>, CodexAgentFailed | CodexAgentTimedOut | InvalidAgentOutput>;
}

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

const stringRecord = (value: unknown): Record<string, string> | undefined =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "string")
    ? (value as Record<string, string>)
    : undefined;

const clientInfoConfig = (
  value: unknown,
): { readonly name: string; readonly version: string } | undefined =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { readonly name?: unknown }).name === "string" &&
  typeof (value as { readonly version?: unknown }).version === "string"
    ? {
        name: (value as { readonly name: string }).name,
        version: (value as { readonly version: string }).version,
      }
    : undefined;

const kimiSessionConfig = (
  config: ResolvedReviewProviderConfig["kimi"] | undefined,
): KimiLanguageModel.Config["session"] | undefined => {
  const raw = config?.config;
  if (raw === undefined) {
    return undefined;
  }
  return {
    sessionId: typeof raw["sessionId"] === "string" ? raw["sessionId"] : undefined,
    model: typeof raw["model"] === "string" ? raw["model"] : undefined,
    thinking: typeof raw["thinking"] === "boolean" ? raw["thinking"] : undefined,
    yoloMode: typeof raw["yoloMode"] === "boolean" ? raw["yoloMode"] : undefined,
    executable: typeof raw["executable"] === "string" ? raw["executable"] : undefined,
    env: stringRecord(raw["env"]),
    agentFile: typeof raw["agentFile"] === "string" ? raw["agentFile"] : undefined,
    skillsDir: typeof raw["skillsDir"] === "string" ? raw["skillsDir"] : undefined,
    shareDir: typeof raw["shareDir"] === "string" ? raw["shareDir"] : undefined,
    clientInfo: clientInfoConfig(raw["clientInfo"]),
  };
};

const makeKimiGraphTools = (options: AiRunOptions): KimiDependencyGraphTools | undefined =>
  options.graphVersionId && options.graphDbPath
    ? makeKimiDependencyGraphTools({
        dbPath: options.graphDbPath,
        versionId: options.graphVersionId,
      })
    : undefined;

const kimiModelConfig = (
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
): Effect.Effect<string, CodexAgentFailed> =>
  options.model && options.model.length > 0
    ? Effect.succeed(options.model)
    : Effect.fail(
        new CodexAgentFailed({
          aspect: options.aspect,
          message: `Provider ${provider} requires a model. Set --model or configure model in config.json.`,
        }),
      );

// NOTE: this function is called inside runStructured on every invocation. Layers are
// lightweight to construct, but the underlying SDK clients and HTTP transports are
// re-initialized each time. Lift construction to the review-run call site if
// connection-pool reuse becomes important.
const makeLanguageModelLayer = (
  options: AiRunOptions,
  kimiExternalTools?: KimiDependencyGraphTools,
): Effect.Effect<Layer.Layer<LanguageModel.LanguageModel, never>, CodexAgentFailed> => {
  const provider = options.provider ?? "codex";
  switch (provider) {
    case "codex":
      return Effect.succeed(
        CodexLanguageModel.layer({ model: options.model, config: codexModelConfig(options) }).pipe(
          Layer.provide(CodexClient.CodexClient.layer),
        ),
      );
    case "kimi":
      return Effect.succeed(
        KimiLanguageModel.layer({
          model: options.model,
          config: kimiModelConfig(options, kimiExternalTools),
        }).pipe(Layer.provide(KimiClient.KimiClient.layer)),
      );
    case "openai":
      return requireModel(options, provider).pipe(
        Effect.map((model: string) => {
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
                organizationId: config?.organizationId
                  ? Redacted.make(config.organizationId)
                  : undefined,
                projectId: config?.projectId ? Redacted.make(config.projectId) : undefined,
              }),
            ),
            Layer.provide(NodeHttpClient.layerFetch),
          ) as Layer.Layer<LanguageModel.LanguageModel, never>;
        }),
      );
    case "openrouter":
      return requireModel(options, provider).pipe(
        Effect.map((model: string) => {
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
        }),
      );
  }
};

const responseId = (
  content: ReadonlyArray<{
    readonly type: string;
    readonly id?: string;
    readonly metadata?: unknown;
  }>,
) => {
  const metadataPart = content.find((part) => part.type === "response-metadata");
  const metadata = metadataPart?.metadata as
    | {
        readonly codex?: { readonly threadId?: string | null };
        readonly kimi?: { readonly sessionId?: string | null };
      }
    | undefined;
  return metadata?.codex?.threadId ?? metadata?.kimi?.sessionId ?? metadataPart?.id ?? null;
};

const structuredOutputText = (cause: AiError.AiError) =>
  cause.reason._tag === "StructuredOutputError" ? (cause.reason.responseText ?? "") : "";

const isProviderTimeoutError = (cause: unknown) => {
  if (!AiError.isAiError(cause) || cause.reason._tag !== "InternalProviderError") {
    return false;
  }
  const metadata = cause.reason.metadata as { readonly errorTag?: unknown } | undefined;
  return metadata?.errorTag === "CodexTimeout" || metadata?.errorTag === "KimiTimeout";
};

const mapAiError = (options: AiRunOptions, cause: unknown) =>
  AiError.isAiError(cause) && cause.reason._tag === "StructuredOutputError"
    ? new InvalidAgentOutput({
        aspect: options.aspect,
        message: cause.message,
        output: structuredOutputText(cause),
      })
    : isProviderTimeoutError(cause)
      ? new CodexAgentTimedOut({
          aspect: options.aspect,
          timeoutMs: options.timeoutMs ?? 0,
        })
      : new CodexAgentFailed({
          aspect: options.aspect,
          message: cause instanceof Error ? cause.message : "AI agent failed",
          cause,
        });

const isEmptyStructuredOutput = (error: unknown) =>
  error instanceof InvalidAgentOutput && error.output.length === 0;

export class ProviderAiReviewClient implements AiReviewClient {
  runStructured<A>(
    prompt: string,
    options: AiRunOptions,
  ): Effect.Effect<AiRunResult<A>, CodexAgentFailed | CodexAgentTimedOut | InvalidAgentOutput> {
    const provider = options.provider ?? "codex";
    const kimiExternalTools = provider === "kimi" ? makeKimiGraphTools(options) : undefined;
    return makeLanguageModelLayer(options, kimiExternalTools).pipe(
      Effect.flatMap((modelLayer) => {
        const hasNativeGraphToolkit =
          provider !== "codex" &&
          provider !== "kimi" &&
          options.graphVersionId !== undefined &&
          options.graphDbPath !== undefined;
        let effect = LanguageModel.generateObject({
          prompt,
          schema: options.schema as Schema.Encoder<Record<string, unknown>, unknown>,
          objectName: `${options.aspect.replaceAll("-", "_")}_output`,
          ...(hasNativeGraphToolkit ? { toolkit: GraphToolkit } : {}),
        } as any).pipe(
          Effect.map((result) => ({
            threadId: responseId(result.content),
            output: result.value as A,
          })),
          Effect.mapError((cause) => mapAiError(options, cause)),
          Effect.provide(modelLayer),
        ) as Effect.Effect<
          AiRunResult<A>,
          CodexAgentFailed | CodexAgentTimedOut | InvalidAgentOutput
        >;
        if (hasNativeGraphToolkit) {
          effect = effect.pipe(
            Effect.provide(
              graphToolkitLayer({ versionId: options.graphVersionId! }).pipe(
                Layer.provide(sqliteLayer(options.graphDbPath!)),
              ),
            ),
            Effect.mapError((cause) =>
              cause instanceof CodexAgentFailed ||
              cause instanceof CodexAgentTimedOut ||
              cause instanceof InvalidAgentOutput
                ? cause
                : new CodexAgentFailed({
                    aspect: options.aspect,
                    message: cause instanceof Error ? cause.message : "Graph toolkit failed",
                    cause,
                  }),
            ),
          ) as Effect.Effect<
            AiRunResult<A>,
            CodexAgentFailed | CodexAgentTimedOut | InvalidAgentOutput
          >;
        }
        // Codex and Kimi manage their own abort-based timeout inside the SDK client;
        // only HTTP-based providers (OpenAI and OpenRouter) need an Effect-level fallback.
        if (provider !== "codex" && provider !== "kimi" && options.timeoutMs !== undefined) {
          effect = effect.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(options.timeoutMs),
              orElse: () =>
                Effect.fail(
                  new CodexAgentTimedOut({
                    aspect: options.aspect,
                    timeoutMs: options.timeoutMs!,
                  }),
                ),
            }),
          );
        }
        if (provider === "kimi") {
          // Kimi SDK 0.1.8 can intermittently finish a structured-output turn without
          // emitting a final text ContentPart. A single retry recovers those transient
          // empty responses while still surfacing repeated failures as unavailable reviewers.
          const firstAttempt = effect;
          effect = firstAttempt.pipe(
            Effect.catchIf(isEmptyStructuredOutput, (error) =>
              Effect.logWarning(
                `Retrying Kimi ${options.aspect} reviewer after empty structured output`,
              ).pipe(
                Effect.annotateLogs({
                  output: error instanceof InvalidAgentOutput ? error.output : "",
                }),
                Effect.andThen(firstAttempt),
              ),
            ),
          );
        }
        return kimiExternalTools === undefined
          ? effect
          : effect.pipe(Effect.ensuring(Effect.promise(() => kimiExternalTools.dispose())));
      }),
    );
  }
}

export type CodexRunOptions = AiRunOptions;
export type CodexRunResult<A> = AiRunResult<A>;
export type CodexReviewClient = AiReviewClient;
export const SdkCodexReviewClient = ProviderAiReviewClient;
