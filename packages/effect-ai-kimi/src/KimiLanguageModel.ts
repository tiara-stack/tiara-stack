import type { StreamEvent } from "@moonshot-ai/kimi-agent-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AiError from "effect/unstable/ai/AiError";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as AiModel from "effect/unstable/ai/Model";
import type * as Prompt from "effect/unstable/ai/Prompt";
import * as Response from "effect/unstable/ai/Response";
import * as Tool from "effect/unstable/ai/Tool";
import {
  KimiClient,
  type KimiExternalTool,
  type KimiTokenUsage,
  type RunOptions,
  type RunResult,
} from "./KimiClient";
import { Config as KimiConfig, type ConfigShape } from "./KimiConfig";
import { type KimiError, KimiConfigurationError, KimiTimeout } from "./KimiError";

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

const jsonInstruction = (options: LanguageModel.ProviderOptions) => {
  if (options.responseFormat.type !== "json") {
    return "";
  }
  const jsonSchema = Tool.getJsonSchemaFromSchema(options.responseFormat.schema);
  const required = requiredTopLevelKeys(jsonSchema).join(", ");
  return [
    "\nReturn the final answer as exactly one JSON object.",
    `Object name: ${options.responseFormat.objectName}`,
    "Do not include markdown fences, commentary, or text outside the JSON object.",
    required.length > 0 ? `Required top-level property names: ${required}.` : "",
    "Use the exact property names from the schema, including camelCase spelling.",
    "If the task asks for a prose report, encode that information inside the JSON schema fields instead of returning markdown.",
    "The JSON object must conform to this JSON Schema:",
    JSON.stringify(jsonSchema),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

const requiredTopLevelKeys = (jsonSchema: unknown): ReadonlyArray<string> =>
  Array.isArray((jsonSchema as { readonly required?: unknown } | null)?.required)
    ? (jsonSchema as { readonly required: ReadonlyArray<unknown> }).required.filter(
        (key): key is string => typeof key === "string",
      )
    : [];

type KimiTextContentPart = { readonly type: "text"; readonly text: string };
type KimiThinkContentPart = { readonly type: "think"; readonly think: string };
type KimiToolCall = {
  readonly type: "function";
  readonly id: string;
  readonly function: {
    readonly name: string;
    readonly arguments?: string | null;
  };
};
type KimiToolResult = {
  readonly tool_call_id: string;
  readonly return_value: {
    readonly is_error: boolean;
    readonly output: unknown;
    readonly message: string;
  };
};

const usagePart = (usage: KimiTokenUsage | null): typeof Response.FinishPart.Encoded => ({
  type: "finish",
  reason: "stop",
  usage: {
    inputTokens: {
      total:
        usage === null
          ? undefined
          : usage.input_other + usage.input_cache_read + usage.input_cache_creation,
      uncached: usage?.input_other,
      cacheRead: usage?.input_cache_read,
      cacheWrite: usage?.input_cache_creation,
    },
    outputTokens: {
      total: usage?.output,
      text: undefined,
      reasoning: undefined,
    },
  },
  response: undefined,
  metadata: {
    kimi: { usage },
  } as any,
});

const metadataPart = (
  result: Pick<RunResult, "sessionId">,
  modelId: string | undefined,
): typeof Response.ResponseMetadataPart.Encoded => ({
  type: "response-metadata",
  id: result.sessionId ?? undefined,
  modelId,
  timestamp: undefined,
  request: undefined,
  metadata: {
    kimi: {
      provider: "kimi",
      sessionId: result.sessionId,
    },
  } as any,
});

const eventToParts = (
  event: StreamEvent,
  allowedToolNames: ReadonlySet<string>,
  toolNameById: Map<string, string>,
): Array<Response.PartEncoded | Response.StreamPartEncoded> => {
  switch (event.type) {
    case "ContentPart": {
      const payload = event.payload as
        | KimiTextContentPart
        | KimiThinkContentPart
        | { readonly type: string };
      return payload.type === "text"
        ? [
            {
              type: "text",
              text: (payload as KimiTextContentPart).text,
              metadata: { kimi: {} } as any,
            },
          ]
        : payload.type === "think"
          ? [
              {
                type: "reasoning",
                text: (payload as KimiThinkContentPart).think,
                metadata: { kimi: {} } as any,
              },
            ]
          : [];
    }
    case "ToolCall": {
      const payload = event.payload as KimiToolCall;
      if (!allowedToolNames.has(payload.function.name)) {
        return [];
      }
      toolNameById.set(payload.id, payload.function.name);
      const args = payload.function.arguments;
      return [
        {
          type: "tool-call",
          id: payload.id,
          name: payload.function.name,
          params: args ? Tool.unsafeSecureJsonParse(args) : {},
          providerExecuted: true,
          metadata: { kimi: { toolCall: payload } } as any,
        },
      ];
    }
    case "ToolResult": {
      const payload = event.payload as KimiToolResult;
      const name = toolNameById.get(payload.tool_call_id);
      if (name === undefined) {
        return [];
      }
      return [
        {
          type: "tool-result",
          id: payload.tool_call_id,
          name,
          result: payload.return_value.output,
          isFailure: payload.return_value.is_error,
          providerExecuted: true,
          metadata: { kimi: { toolResult: payload } } as any,
        },
      ];
    }
    case "StatusUpdate": {
      const usage = (event.payload as { readonly token_usage?: KimiTokenUsage | null }).token_usage;
      return usage === undefined ? [] : [usagePart(usage)];
    }
    case "error":
      return [{ type: "error", error: event.message }];
    default:
      return [];
  }
};

type StreamConversionState = {
  textId: number;
  reasoningId: number;
};

const textStreamParts = (
  text: string,
  state: StreamConversionState,
): Array<Response.StreamPartEncoded> => {
  const id = `kimi_text_${++state.textId}`;
  const metadata = { kimi: {} } as any;
  return [
    { type: "text-start", id, metadata },
    { type: "text-delta", id, delta: text, metadata },
    { type: "text-end", id, metadata },
  ];
};

const reasoningStreamParts = (
  text: string,
  state: StreamConversionState,
): Array<Response.StreamPartEncoded> => {
  const id = `kimi_reasoning_${++state.reasoningId}`;
  const metadata = { kimi: {} } as any;
  return [
    { type: "reasoning-start", id, metadata },
    { type: "reasoning-delta", id, delta: text, metadata },
    { type: "reasoning-end", id, metadata },
  ];
};

const eventToStreamParts = (
  event: StreamEvent,
  allowedToolNames: ReadonlySet<string>,
  toolNameById: Map<string, string>,
  state: StreamConversionState,
): Array<Response.StreamPartEncoded> => {
  if (event.type === "ContentPart") {
    const payload = event.payload as
      | KimiTextContentPart
      | KimiThinkContentPart
      | { readonly type: string };
    if (payload.type === "text") {
      return textStreamParts((payload as KimiTextContentPart).text, state);
    }
    if (payload.type === "think") {
      return reasoningStreamParts((payload as KimiThinkContentPart).think, state);
    }
    return [];
  }
  return eventToParts(event, allowedToolNames, toolNameById) as Array<Response.StreamPartEncoded>;
};

const hasRequiredKeys = (value: unknown, requiredKeys: ReadonlyArray<string>) =>
  requiredKeys.length === 0 ||
  (value !== null &&
    typeof value === "object" &&
    requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key)));

const extractJsonObject = (text: string, requiredKeys: ReadonlyArray<string>): string => {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index]!;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, index + 1);
          try {
            const parsed = Tool.unsafeSecureJsonParse(candidate);
            if (hasRequiredKeys(parsed, requiredKeys)) {
              return candidate;
            }
            // Keep scanning inside valid wrapper objects so a nested response object can be
            // recovered when the provider wraps the requested schema under an extra key.
          } catch {
            // Leave start unchanged on parse failure so the next scan can inspect nested
            // braces inside code-like preamble before the final JSON object.
          }
          break;
        }
      }
    }
  }
  return text;
};

const requireWorkDir = (
  workDir: string | undefined,
): Effect.Effect<string, KimiConfigurationError> => {
  if (workDir !== undefined && workDir.length > 0) {
    return Effect.succeed(workDir);
  }
  return Effect.fail(
    new KimiConfigurationError({
      message: "KimiLanguageModel requires config.workDir to run Kimi sessions",
    }),
  );
};

const runResultToParts = (
  result: RunResult,
  modelId: string | undefined,
  allowedToolNames: ReadonlySet<string>,
  preferFinalResponseText: boolean,
  requiredKeys: ReadonlyArray<string>,
): Array<Response.PartEncoded> => {
  const parts: Array<Response.PartEncoded> = [metadataPart(result, modelId)];
  const toolNameById = new Map<string, string>();
  if (preferFinalResponseText) {
    for (const event of result.events) {
      const eventParts = eventToParts(event, allowedToolNames, toolNameById).filter(
        (part) => part.type !== "text" && part.type !== "finish",
      );
      parts.push(...(eventParts as Array<Response.PartEncoded>));
    }
    if (result.finalResponse.length > 0) {
      parts.push({ type: "text", text: extractJsonObject(result.finalResponse, requiredKeys) });
    }
  } else {
    for (const event of result.events) {
      parts.push(
        ...(eventToParts(event, allowedToolNames, toolNameById).filter(
          (part) => part.type !== "finish",
        ) as Array<Response.PartEncoded>),
      );
    }
  }
  if (!parts.some((part) => part.type === "text") && result.finalResponse.length > 0) {
    parts.push({ type: "text", text: result.finalResponse });
  }
  parts.push(usagePart(result.usage));
  return parts;
};

const runResultToStreamParts = (
  result: RunResult,
  modelId: string | undefined,
  allowedToolNames: ReadonlySet<string>,
  preferFinalResponseText: boolean,
  requiredKeys: ReadonlyArray<string>,
): Array<Response.StreamPartEncoded> => {
  const parts: Array<Response.StreamPartEncoded> = [
    metadataPart(result, modelId) as Response.StreamPartEncoded,
  ];
  const toolNameById = new Map<string, string>();
  const streamState: StreamConversionState = { textId: 0, reasoningId: 0 };
  let collectedText = "";
  let collectedUsage: KimiTokenUsage | null | undefined = result.usage;
  for (const event of result.events) {
    if (event.type === "StatusUpdate") {
      const usage = (event.payload as { readonly token_usage?: KimiTokenUsage | null }).token_usage;
      if (usage !== undefined) {
        collectedUsage = usage;
      }
      continue;
    }
    if (preferFinalResponseText && event.type === "ContentPart") {
      const payload = event.payload as
        | KimiTextContentPart
        | KimiThinkContentPart
        | { readonly type: string };
      if (payload.type === "text") {
        collectedText += (payload as KimiTextContentPart).text;
        continue;
      }
    }
    parts.push(...eventToStreamParts(event, allowedToolNames, toolNameById, streamState));
  }
  if (preferFinalResponseText) {
    const text = collectedText.length > 0 ? collectedText : result.finalResponse;
    if (text.length > 0) {
      parts.push(...textStreamParts(extractJsonObject(text, requiredKeys), streamState));
    }
  } else if (!parts.some((part) => part.type === "text-delta") && result.finalResponse.length > 0) {
    parts.push(...textStreamParts(result.finalResponse, streamState));
  }
  parts.push(usagePart(collectedUsage ?? null));
  return parts;
};

const toAiError = (method: string, error: KimiError) =>
  AiError.make({
    module: "KimiLanguageModel",
    method,
    reason:
      error instanceof KimiTimeout
        ? new AiError.InternalProviderError({
            description: `Kimi timed out after ${error.timeoutMs}ms`,
            metadata: {
              provider: "kimi",
              errorTag: "KimiTimeout",
              timeoutMs: error.timeoutMs,
            },
          })
        : error instanceof KimiConfigurationError
          ? new AiError.InternalProviderError({
              description: error.message,
              metadata: {
                provider: "kimi",
                errorTag: "KimiConfigurationError",
              },
            })
          : new AiError.InternalProviderError({
              description: error.message,
            }),
  });

const makeRunOptions = (
  options: LanguageModel.ProviderOptions,
  config: Context.Service.Shape<typeof KimiConfig> | undefined,
  modelId: string | undefined,
): Effect.Effect<RunOptions, KimiConfigurationError> =>
  Effect.gen(function* () {
    const workDir = yield* requireWorkDir(config?.workDir);
    const session = config?.session;
    return {
      prompt: `${promptToString(options.prompt)}${jsonInstruction(options)}`,
      workDir,
      sessionId: options.previousResponseId ?? session?.sessionId,
      model: modelId,
      thinking: config?.thinking ?? session?.thinking,
      approvalPolicy: config?.approvalPolicy,
      timeoutMs: config?.timeoutMs,
      cleanupGraceMs: config?.cleanupGraceMs,
      externalTools: config?.externalTools,
      inheritConfigExternalTools: config?.externalTools === undefined ? undefined : false,
      sessionOptions: {
        clientInfo: session?.clientInfo,
        executable: config?.executable ?? session?.executable,
        env: config?.env ?? session?.env,
        yoloMode: config?.yoloMode ?? session?.yoloMode,
        agentFile: config?.agentFile ?? session?.agentFile,
        skillsDir: config?.skillsDir ?? session?.skillsDir,
        shareDir: config?.shareDir ?? session?.shareDir,
      },
    };
  });

const mergeExternalTools = (
  providerTools: ReadonlyArray<KimiExternalTool> | undefined,
  serviceTools: ReadonlyArray<KimiExternalTool> | undefined,
) =>
  providerTools === undefined && serviceTools === undefined
    ? undefined
    : [...(providerTools ?? []), ...(serviceTools ?? [])];

const mergeEnv = (
  providerEnv: Record<string, string> | undefined,
  serviceEnv: Record<string, string> | undefined,
) =>
  providerEnv === undefined && serviceEnv === undefined
    ? undefined
    : { ...providerEnv, ...serviceEnv };

export const model = (
  modelName: string,
  config?: Omit<Config, "session">,
): AiModel.Model<"kimi", LanguageModel.LanguageModel, KimiClient> =>
  AiModel.make("kimi", modelName, layer({ model: modelName, config }));

export const make = ({
  model,
  config: providerConfig,
}: {
  readonly model?: string;
  readonly config?: Config;
}): Effect.Effect<LanguageModel.Service, never, KimiClient> =>
  Effect.gen(function* () {
    const client = yield* KimiClient;
    const makeConfig = Effect.gen(function* () {
      const serviceConfig = yield* Effect.serviceOption(KimiConfig);
      const serviceConfigValue = serviceConfig._tag === "Some" ? serviceConfig.value : undefined;
      return {
        ...providerConfig,
        ...serviceConfigValue,
        env: mergeEnv(providerConfig?.env, serviceConfigValue?.env),
        externalTools: mergeExternalTools(
          providerConfig?.externalTools,
          serviceConfigValue?.externalTools,
        ),
      };
    });
    return yield* LanguageModel.make({
      generateText: Effect.fnUntraced(function* (options) {
        const config = yield* makeConfig;
        const modelId = model ?? config.session?.model;
        const runOptions = yield* makeRunOptions(options, config, modelId).pipe(
          Effect.mapError((error) => toAiError("generateText", error)),
        );
        const result = yield* client
          .run(runOptions)
          .pipe(Effect.mapError((error) => toAiError("generateText", error)));
        return runResultToParts(
          result,
          modelId,
          new Set(options.tools.map((tool) => tool.name)),
          options.responseFormat.type === "json",
          options.responseFormat.type === "json"
            ? requiredTopLevelKeys(Tool.getJsonSchemaFromSchema(options.responseFormat.schema))
            : [],
        );
      }),
      streamText: (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const config = yield* makeConfig;
            const modelId = model ?? config.session?.model;
            const allowedToolNames = new Set(options.tools.map((tool) => tool.name));
            const isJson = options.responseFormat.type === "json";
            const runOptions = yield* makeRunOptions(options, config, modelId).pipe(
              Effect.mapError((error) => toAiError("streamText", error)),
            );
            const result = yield* client
              .run(runOptions)
              .pipe(Effect.mapError((error) => toAiError("streamText", error)));
            return Stream.fromIterable(
              runResultToStreamParts(
                result,
                modelId,
                allowedToolNames,
                isJson,
                isJson
                  ? requiredTopLevelKeys(
                      Tool.getJsonSchemaFromSchema(options.responseFormat.schema),
                    )
                  : [],
              ),
            );
          }),
        ),
    });
  });

export const layer = (options: {
  readonly model?: string;
  readonly config?: Config;
}): Layer.Layer<LanguageModel.LanguageModel, never, KimiClient> =>
  Layer.effect(LanguageModel.LanguageModel, make(options));
