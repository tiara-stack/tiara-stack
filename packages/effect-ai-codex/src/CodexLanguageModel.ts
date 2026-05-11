import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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

const primitiveJsonPattern = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const defaultStructuredResponseMaxCharacters = 1_000_000;

class StructuredResponseTooLarge extends Data.TaggedError("StructuredResponseTooLarge")<{
  readonly length: number;
  readonly maxLength: number;
}> {}

class StructuredResponseMissingJson extends Data.TaggedError("StructuredResponseMissingJson")<{
  readonly length: number;
  readonly maxLength: number;
}> {}

class StructuredResponseUnsupportedItem extends Data.TaggedError(
  "StructuredResponseUnsupportedItem",
)<{
  readonly itemType: string;
}> {}

const structuredResponseMaxCharacters = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) || value <= 0
    ? defaultStructuredResponseMaxCharacters
    : Math.floor(value);

const isCompositeJsonStart = (char: string) => char === "{" || char === "[";

const isPrimitiveJsonStart = (char: string) =>
  char === '"' ||
  char === "-" ||
  (char >= "0" && char <= "9") ||
  char === "t" ||
  char === "f" ||
  char === "n";

const isJsonTerminator = (char: string | undefined) =>
  char === undefined ||
  char === "," ||
  char === "}" ||
  char === "]" ||
  char === " " ||
  char === "\t" ||
  char === "\n" ||
  char === "\r";

type JsonValueBoundary =
  | { readonly _tag: "found"; readonly end: number; readonly primitive: boolean }
  | { readonly _tag: "not-found"; readonly resumeAt: number };

const findCompositeJsonEnd = (text: string, start: number): JsonValueBoundary => {
  const stack: Array<string> = [];
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
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = stack.pop();
      if (char !== expected) {
        return { _tag: "not-found", resumeAt: index + 1 };
      }
      if (stack.length === 0) {
        return { _tag: "found", end: index + 1, primitive: false };
      }
    }
  }
  return { _tag: "not-found", resumeAt: text.length };
};

const findStringJsonEnd = (text: string, start: number): JsonValueBoundary => {
  let escaped = false;
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return { _tag: "found", end: index + 1, primitive: true };
    }
  }
  return { _tag: "not-found", resumeAt: text.length };
};

const findJsonValueBoundary = (text: string, start: number): JsonValueBoundary => {
  const char = text[start]!;
  if (isCompositeJsonStart(char)) {
    return findCompositeJsonEnd(text, start);
  }
  if (char === '"') {
    return findStringJsonEnd(text, start);
  }
  const match = primitiveJsonPattern.exec(text.slice(start));
  const end = match === null ? undefined : start + match[0].length;
  return end !== undefined && isJsonTerminator(text[end])
    ? { _tag: "found", end, primitive: true }
    : { _tag: "not-found", resumeAt: start + 1 };
};

const scanJsonWindow = (
  text: string,
  isValidStructuredValue: (value: unknown) => boolean,
): string | undefined => {
  const firstNonWhitespace = /\S/.exec(text)?.index;
  const trimmed = text.trim();
  for (let start = 0; start < text.length; start++) {
    const char = text[start]!;
    const isCandidateStart =
      isCompositeJsonStart(char) || (start === firstNonWhitespace && isPrimitiveJsonStart(char));
    if (!isCandidateStart) {
      continue;
    }
    const boundary = findJsonValueBoundary(text, start);
    if (boundary._tag === "not-found") {
      start = boundary.resumeAt - 1;
      continue;
    }
    const candidate = text.slice(start, boundary.end);
    // In scanJsonWindow, boundary.primitive candidates only count when start is
    // firstNonWhitespace and candidate equals trimmed, so the primitive is the whole token.
    if (boundary.primitive && candidate !== trimmed) {
      start = boundary.end - 1;
      continue;
    }
    try {
      const parsed = Tool.unsafeSecureJsonParse(candidate);
      if (isValidStructuredValue(parsed)) {
        return candidate;
      }
    } catch {
      // Keep scanning so JSON-looking prose before the final answer does not poison decoding.
    }
    start = boundary.end - 1;
  }
  return undefined;
};

const extractJsonValue = (
  text: string,
  isValidStructuredValue: (value: unknown) => boolean,
  maxCharacters: number,
): string => {
  // maxCharacters bounds memory and load-sheds worst-case scanJsonWindow /
  // findJsonValueBoundary complexity on pathological structured responses.
  if (text.length > maxCharacters) {
    throw new StructuredResponseTooLarge({ length: text.length, maxLength: maxCharacters });
  }
  const json = scanJsonWindow(text, isValidStructuredValue);
  if (json === undefined) {
    throw new StructuredResponseMissingJson({ length: text.length, maxLength: maxCharacters });
  }
  return json;
};

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

const assembleRunResultParts = (
  result: RunResult,
  modelId: string | undefined,
  itemParts: ReadonlyArray<Response.PartEncoded>,
  finalResponseText: string,
): Array<Response.PartEncoded> => {
  const parts: Array<Response.PartEncoded> = [metadataPart(result, modelId), ...itemParts];
  if (finalResponseText.length > 0 && !parts.some((part) => part.type === "text")) {
    parts.push({ type: "text", text: finalResponseText });
  }
  parts.push(usagePart(result.usage));
  return parts;
};

const runTextResultToParts = (
  result: RunResult,
  modelId: string | undefined,
): Array<Response.PartEncoded> =>
  assembleRunResultParts(
    result,
    modelId,
    result.items.flatMap((item) => itemToParts(item) as Array<Response.PartEncoded>),
    result.finalResponse,
  );

const structuredResponseItemPartTypes = new Set<string>(["reasoning", "error"]);

const structuredResponseItemToParts = (
  item: ThreadItem,
  strictItemTypes: boolean,
): Array<Response.PartEncoded> => {
  switch (item.type) {
    case "agent_message":
    case "mcp_tool_call":
      return [];
    case "reasoning":
    case "error":
      return itemToParts(item).filter((part) =>
        structuredResponseItemPartTypes.has(part.type),
      ) as Array<Response.PartEncoded>;
    default:
      if (strictItemTypes) {
        throw new StructuredResponseUnsupportedItem({ itemType: String(item.type) });
      }
      // Compatibility policy: structured JSON comes from finalResponse, so unknown
      // provider item kinds are reported as reasoning unless explicitly reviewed above.
      return [
        {
          type: "reasoning",
          text: `Ignored unsupported Codex thread item type in structured response: ${String(item.type)}`,
          metadata: { codex: { unsupportedItemType: String(item.type) } } as any,
        },
      ];
  }
};

const runStructuredResultToParts = (
  result: RunResult,
  modelId: string | undefined,
  structuredOutput: {
    readonly isValidValue: (value: unknown) => boolean;
    readonly maxCharacters: number;
    readonly strictItemTypes: boolean;
  },
): Array<Response.PartEncoded> =>
  assembleRunResultParts(
    result,
    modelId,
    result.items.flatMap((item) =>
      structuredResponseItemToParts(item, structuredOutput.strictItemTypes),
    ),
    extractJsonValue(
      result.finalResponse,
      structuredOutput.isValidValue,
      structuredOutput.maxCharacters,
    ),
  );

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

const structuredResponseErrorDescription = (
  error:
    | StructuredResponseTooLarge
    | StructuredResponseMissingJson
    | StructuredResponseUnsupportedItem,
) =>
  error._tag === "StructuredResponseTooLarge"
    ? `Codex structured response exceeded ${error.maxLength} characters`
    : error._tag === "StructuredResponseMissingJson"
      ? "Codex structured response did not contain JSON matching the schema"
      : `Codex structured response contained unsupported item type: ${error.itemType}`;

const structuredResponseError = (
  method: string,
  error:
    | StructuredResponseTooLarge
    | StructuredResponseMissingJson
    | StructuredResponseUnsupportedItem,
) => {
  const metadata: Record<string, string | number | boolean> = {
    provider: "codex",
    errorTag: error._tag,
  };
  if (
    error._tag === "StructuredResponseTooLarge" ||
    error._tag === "StructuredResponseMissingJson"
  ) {
    metadata.responseLength = error.length;
    metadata.maxResponseLength = error.maxLength;
  }
  if (error._tag === "StructuredResponseUnsupportedItem") {
    metadata.itemType = error.itemType;
  }
  return AiError.make({
    module: "CodexLanguageModel",
    method,
    reason: new AiError.InternalProviderError({
      description: structuredResponseErrorDescription(error),
      metadata,
    }),
  });
};

const isStructuredResponseError = (
  error: unknown,
): error is
  | StructuredResponseTooLarge
  | StructuredResponseMissingJson
  | StructuredResponseUnsupportedItem =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error._tag === "StructuredResponseTooLarge" ||
    error._tag === "StructuredResponseMissingJson" ||
    error._tag === "StructuredResponseUnsupportedItem");

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
        try {
          const structuredOutput =
            options.responseFormat.type === "json"
              ? (() => {
                  const decoder = Schema.decodeUnknownSync(
                    options.responseFormat.schema as Schema.Decoder<unknown>,
                  );
                  const maxCharacters = structuredResponseMaxCharacters(
                    config.structuredResponseMaxCharacters,
                  );
                  return {
                    maxCharacters,
                    strictItemTypes: config.strictStructuredResponseItemTypes ?? false,
                    isValidValue: (value: unknown) => {
                      try {
                        decoder(value);
                        return true;
                      } catch {
                        return false;
                      }
                    },
                  };
                })()
              : undefined;
          return structuredOutput === undefined
            ? runTextResultToParts(result, modelId)
            : runStructuredResultToParts(result, modelId, structuredOutput);
        } catch (error) {
          if (isStructuredResponseError(error)) {
            return yield* Effect.fail(structuredResponseError("generateText", error));
          }
          throw error;
        }
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
