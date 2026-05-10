import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AiError from "effect/unstable/ai/AiError";
import * as AiModel from "effect/unstable/ai/Model";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Prompt from "effect/unstable/ai/Prompt";
import * as Response from "effect/unstable/ai/Response";
import * as Tool from "effect/unstable/ai/Tool";
import { CodexClient, type RunOptions, type RunResult } from "./CodexClient";
import { Config as CodexConfig, type ConfigShape } from "./CodexConfig";
import { type CodexError, CodexTimeout } from "./CodexError";

export type Config = ConfigShape;

const messageText = (message: Prompt.Prompt["content"][number]) => {
  const content = (message as { readonly content: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part
          ? String(part.text)
          : "",
      )
      .filter((part) => part.length > 0)
      .join("\n\n");
  }
  return "";
};

const messageRole = (message: Prompt.Prompt["content"][number]) =>
  typeof (message as { readonly role?: unknown }).role === "string"
    ? (message as { readonly role: string }).role
    : "message";

const promptToString = (prompt: Prompt.Prompt) => {
  const messages = prompt.content
    .map((message) => ({ role: messageRole(message), text: messageText(message) }))
    .filter((message) => message.text.length > 0);
  return messages
    .map((message) => (messages.length > 1 ? `${message.role}:\n${message.text}` : message.text))
    .join("\n\n");
};

const usagePart = (usage: Usage | null): typeof Response.FinishPart.Encoded => ({
  type: "finish",
  reason: "stop",
  usage: {
    inputTokens: {
      total: usage?.input_tokens,
      uncached: usage === null ? undefined : usage.input_tokens - usage.cached_input_tokens,
      cacheRead: usage?.cached_input_tokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage?.output_tokens,
      text: undefined,
      reasoning: usage?.reasoning_output_tokens,
    },
  },
  response: undefined,
  metadata: {
    codex: { usage },
  } as any,
});

const metadataPart = (
  result: Pick<RunResult, "threadId">,
  modelId: string | undefined,
): typeof Response.ResponseMetadataPart.Encoded => ({
  type: "response-metadata",
  id: result.threadId ?? undefined,
  modelId,
  timestamp: undefined,
  request: undefined,
  metadata: {
    codex: {
      provider: "codex",
      threadId: result.threadId,
    },
  } as any,
});

const itemToParts = (
  item: ThreadItem,
): Array<Response.PartEncoded | Response.StreamPartEncoded> => {
  switch (item.type) {
    case "agent_message":
      return [
        {
          type: "text",
          text: item.text,
          metadata: { codex: { itemId: item.id } } as any,
        },
      ];
    case "reasoning":
      return [
        {
          type: "reasoning",
          text: item.text,
          metadata: { codex: { itemId: item.id } } as any,
        },
      ];
    case "mcp_tool_call": {
      const name = `mcp.${item.server}.${item.tool}`;
      return [
        {
          type: "tool-call",
          id: item.id,
          name,
          params: item.arguments,
          providerExecuted: true,
          metadata: {
            codex: { itemId: item.id, server: item.server, status: item.status },
          } as any,
        },
        {
          type: "tool-result",
          id: item.id,
          name,
          result: item.result ?? item.error ?? null,
          isFailure: item.status === "failed",
          providerExecuted: true,
          metadata: {
            codex: { itemId: item.id, server: item.server, status: item.status },
          } as any,
        },
      ];
    }
    case "error":
      return [{ type: "error", error: item.message }];
    default:
      return [];
  }
};

const runResultToParts = (
  result: RunResult,
  modelId: string | undefined,
): Array<Response.PartEncoded> => {
  const parts: Array<Response.PartEncoded> = [metadataPart(result, modelId)];
  for (const item of result.items) {
    parts.push(...(itemToParts(item) as Array<Response.PartEncoded>));
  }
  if (!parts.some((part) => part.type === "text") && result.finalResponse.length > 0) {
    parts.push({ type: "text", text: result.finalResponse });
  }
  parts.push(usagePart(result.usage));
  return parts;
};

const eventToParts = (
  event: ThreadEvent,
  modelId: string | undefined,
): Array<Response.StreamPartEncoded> => {
  switch (event.type) {
    case "thread.started":
      return [
        {
          type: "response-metadata",
          id: event.thread_id,
          modelId,
          timestamp: undefined,
          request: undefined,
          metadata: { codex: { provider: "codex", threadId: event.thread_id } } as any,
        },
      ];
    case "item.completed":
      return itemToParts(event.item) as Array<Response.StreamPartEncoded>;
    case "turn.completed":
      return [usagePart(event.usage)];
    case "turn.failed":
      return [{ type: "error", error: event.error.message }];
    case "error":
      return [{ type: "error", error: event.message }];
    default:
      return [];
  }
};

const toAiError = (method: string, error: CodexError) =>
  AiError.make({
    module: "CodexLanguageModel",
    method,
    reason:
      error instanceof CodexTimeout
        ? new AiError.InternalProviderError({
            description: `Codex timed out after ${error.timeoutMs}ms`,
            metadata: {
              provider: "codex",
              errorTag: "CodexTimeout",
              timeoutMs: error.timeoutMs,
            },
          })
        : new AiError.InternalProviderError({
            description: error.message,
          }),
  });

const makeRunOptions = (
  options: LanguageModel.ProviderOptions,
  config: Context.Service.Shape<typeof CodexConfig> | undefined,
  modelId: string | undefined,
): RunOptions => ({
  prompt: promptToString(options.prompt),
  threadId: options.previousResponseId,
  threadOptions: {
    ...config?.thread,
    model: modelId,
  },
  timeoutMs: config?.timeoutMs,
  cleanupGraceMs: config?.cleanupGraceMs,
  clientOptions: {
    codexPathOverride: config?.codexPathOverride,
    baseUrl: config?.baseUrl,
    apiKey: config?.apiKey,
    env: config?.env,
    config: config?.config,
  },
  turnOptions:
    options.responseFormat.type === "json"
      ? { outputSchema: Tool.getJsonSchemaFromSchema(options.responseFormat.schema) }
      : undefined,
});

const mergeEnv = (
  providerEnv: Record<string, string> | undefined,
  serviceEnv: Record<string, string> | undefined,
) =>
  providerEnv === undefined && serviceEnv === undefined
    ? undefined
    : { ...providerEnv, ...serviceEnv };

export const model = (
  modelName: string,
  config?: Omit<Config, "thread">,
): AiModel.Model<"codex", LanguageModel.LanguageModel, CodexClient> =>
  AiModel.make("codex", modelName, layer({ model: modelName, config }));

export const make = ({
  model,
  config: providerConfig,
}: {
  readonly model?: string;
  readonly config?: Config;
}): Effect.Effect<LanguageModel.Service, never, CodexClient> =>
  Effect.gen(function* () {
    const client = yield* CodexClient;
    const makeConfig = Effect.gen(function* () {
      const serviceConfig = yield* Effect.serviceOption(CodexConfig);
      const serviceConfigValue = serviceConfig._tag === "Some" ? serviceConfig.value : undefined;
      return {
        ...providerConfig,
        ...serviceConfigValue,
        env: mergeEnv(providerConfig?.env, serviceConfigValue?.env),
      };
    });
    return yield* LanguageModel.make({
      generateText: Effect.fnUntraced(function* (options) {
        const config = yield* makeConfig;
        const modelId = model ?? config.thread?.model;
        const result = yield* client
          .run(makeRunOptions(options, config, modelId))
          .pipe(Effect.mapError((error) => toAiError("generateText", error)));
        return runResultToParts(result, modelId);
      }),
      streamText: (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const config = yield* makeConfig;
            const modelId = model ?? config.thread?.model;
            return client.runStreamed(makeRunOptions(options, config, modelId)).pipe(
              Stream.mapError((error) => toAiError("streamText", error)),
              Stream.flatMap((event) => Stream.fromIterable(eventToParts(event, modelId))),
            );
          }),
        ),
    });
  });

export const layer = (options: {
  readonly model?: string;
  readonly config?: Config;
}): Layer.Layer<LanguageModel.LanguageModel, never, CodexClient> =>
  Layer.effect(LanguageModel.LanguageModel, make(options));
