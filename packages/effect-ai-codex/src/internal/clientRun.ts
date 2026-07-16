import type { CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import type { ConfigShape } from "../CodexConfig";
import { CodexStreamParseError } from "../CodexError";

const defaultThreadOptions: Partial<ThreadOptions> = {
  sandboxMode: "read-only",
  approvalPolicy: "never",
  webSearchMode: "disabled",
  networkAccessEnabled: false,
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((nested) => (nested === undefined ? "null" : stableStringify(nested))).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const mergeClientOptions = (
  config: ConfigShape | undefined,
  options: CodexOptions | undefined,
): CodexOptions => {
  const codexPathOverride = options?.codexPathOverride ?? config?.codexPathOverride;
  const baseUrl = options?.baseUrl ?? config?.baseUrl;
  const apiKey = options?.apiKey ?? config?.apiKey;
  const env =
    options?.env !== undefined && config?.env !== undefined
      ? { ...config.env, ...options.env }
      : (options?.env ?? config?.env);
  return {
    ...(codexPathOverride === undefined ? {} : { codexPathOverride }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(env === undefined ? {} : { env }),
    config: {
      ...config?.config,
      ...options?.config,
    },
  };
};

export const clientOptionsCacheKey = (options: CodexOptions): string => {
  const sensitiveHash = createHash("sha256")
    .update(
      stableStringify({
        apiKey: options.apiKey,
        env: options.env,
      }),
    )
    .digest("hex");
  return stableStringify({
    codexPathOverride: options.codexPathOverride,
    baseUrl: options.baseUrl,
    config: options.config,
    sensitiveHash,
  });
};

export const mergeThreadOptions = (
  config: ConfigShape | undefined,
  options: Partial<ThreadOptions> | undefined,
): ThreadOptions => ({
  ...defaultThreadOptions,
  ...config?.thread,
  ...options,
});

export const collectStreamEvents = (
  events: AsyncIterable<ThreadEvent>,
): Effect.Effect<ReadonlyArray<ThreadEvent>, CodexStreamParseError | DOMException> =>
  Effect.tryPromise({
    try: async () => {
      const collected: Array<ThreadEvent> = [];
      for await (const event of events) {
        collected.push(event);
      }
      return collected;
    },
    catch: (cause) =>
      cause instanceof DOMException && cause.name === "AbortError"
        ? cause
        : new CodexStreamParseError({
            message: cause instanceof Error ? cause.message : "Codex stream failed",
            cause,
          }),
  });
