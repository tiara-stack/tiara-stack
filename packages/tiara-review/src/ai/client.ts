import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as AiError from "effect/unstable/ai/AiError";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import { sqliteLayer } from "../db/client";
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
import { makeKimiGraphTools, makeLanguageModelLayer } from "./providerLayer";

export type AiRunOptions = {
  readonly aspect: AgentAspect;
  readonly repoRoot: string;
  readonly provider?: AiProvider | undefined;
  readonly providerConfig?: ResolvedReviewProviderConfig | undefined;
  readonly model?: string | undefined;
  readonly modelReasoningEffort?: ReasoningEffort | undefined;
  readonly timeoutMs?: number | undefined;
  readonly schema: Schema.Top;
  readonly graphVersionId?: string | undefined;
  readonly graphDbPath?: string | undefined;
  readonly graphMcpCommand?: string | undefined;
  readonly graphMcpArgsPrefix?: ReadonlyArray<string> | undefined;
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

const responseId = (
  content: ReadonlyArray<{
    readonly type: string;
    readonly id?: string | undefined;
    readonly metadata?: unknown;
  }>,
) => {
  const metadataPart = content.find((part) => part.type === "response-metadata");
  const metadata = metadataPart?.metadata as
    | {
        readonly codex?: { readonly threadId?: string | null } | undefined;
        readonly kimi?: { readonly sessionId?: string | null } | undefined;
      }
    | undefined;
  return metadata?.codex?.threadId ?? metadata?.kimi?.sessionId ?? metadataPart?.id ?? null;
};

const structuredOutputText = (cause: AiError.AiError) =>
  cause.reason._tag === "StructuredOutputError" ? (cause.reason.responseText ?? "") : "";

const isProviderTimeoutError = (cause: unknown) =>
  Match.value(cause).pipe(
    Match.when(AiError.isAiError, (error) => {
      if (error.reason._tag !== "InternalProviderError") {
        return false;
      }
      const metadata = error.reason.metadata as { readonly errorTag?: unknown } | undefined;
      return metadata?.errorTag === "CodexTimeout" || metadata?.errorTag === "KimiTimeout";
    }),
    Match.orElse(() => false),
  );

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
  Match.value(error).pipe(
    Match.when(Match.instanceOfUnsafe(InvalidAgentOutput), (error) => error.output.length === 0),
    Match.orElse(() => false),
  );

export class ProviderAiReviewClient implements AiReviewClient {
  // fallow-ignore-next-line unused-class-member
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
