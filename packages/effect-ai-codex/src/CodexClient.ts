import {
  Codex,
  type CodexOptions,
  type Input,
  type RunResult as SdkRunResult,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
} from "@openai/codex-sdk";
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Config } from "./CodexConfig";
import {
  type CodexError,
  CodexSdkError,
  CodexStreamParseError,
  CodexTimeout,
  messageFromCause,
} from "./CodexError";
import { runWithAbortTimeout } from "./internal/timeout";

export type RunOptions = {
  readonly prompt: Input;
  readonly threadId?: string;
  readonly threadOptions?: Partial<ThreadOptions>;
  readonly turnOptions?: Omit<TurnOptions, "signal">;
  readonly timeoutMs?: number;
  readonly cleanupGraceMs?: number;
  readonly clientOptions?: CodexOptions;
};

export type RunResult = {
  readonly threadId: string | null;
  readonly items: ReadonlyArray<ThreadItem>;
  readonly finalResponse: string;
  readonly usage: Usage | null;
};

export interface Service {
  readonly run: (options: RunOptions) => Effect.Effect<RunResult, CodexError>;
  /**
   * Buffered event replay. The Codex SDK turn is executed through `runStreamed`, then the collected
   * events are emitted after completion; this is not live incremental streaming.
   */
  readonly runStreamed: (options: RunOptions) => Stream.Stream<ThreadEvent, CodexError>;
}

export class CodexClient extends Context.Service<CodexClient, Service>()(
  "effect-ai-codex/CodexClient",
  {
    make: Effect.gen(function* () {
      return yield* make;
    }),
  },
) {
  static layer = Layer.effect(CodexClient, this.make);
}

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

const mergeClientOptions = (
  config: Context.Service.Shape<typeof Config> | undefined,
  options: CodexOptions | undefined,
): CodexOptions => ({
  codexPathOverride: options?.codexPathOverride ?? config?.codexPathOverride,
  baseUrl: options?.baseUrl ?? config?.baseUrl,
  apiKey: options?.apiKey ?? config?.apiKey,
  env:
    options?.env !== undefined && config?.env !== undefined
      ? { ...config.env, ...options.env }
      : (options?.env ?? config?.env),
  config: {
    ...config?.config,
    ...options?.config,
  },
});

const clientOptionsCacheKey = (options: CodexOptions): string => {
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

const mergeThreadOptions = (
  config: Context.Service.Shape<typeof Config> | undefined,
  options: Partial<ThreadOptions> | undefined,
): ThreadOptions => ({
  ...defaultThreadOptions,
  ...config?.thread,
  ...options,
});

const collectStreamEvents = async (
  events: AsyncIterable<ThreadEvent>,
): Promise<ReadonlyArray<ThreadEvent>> => {
  const collected: Array<ThreadEvent> = [];
  try {
    for await (const event of events) {
      collected.push(event);
    }
  } catch (cause) {
    throw new CodexStreamParseError({
      message: cause instanceof Error ? cause.message : "Codex stream failed",
      cause,
    });
  }
  return collected;
};

export const make: Effect.Effect<Service> = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(Config).pipe(
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
  );
  const maxCachedClients = 32;
  const codexByOptions = new Map<string, Codex>();
  const getCodex = (options: CodexOptions | undefined) => {
    const merged = mergeClientOptions(config, options);
    const key = clientOptionsCacheKey(merged);
    const cached = codexByOptions.get(key);
    if (cached) {
      codexByOptions.delete(key);
      codexByOptions.set(key, cached);
      return cached;
    }
    if (codexByOptions.size >= maxCachedClients) {
      const [firstKey] = codexByOptions.keys();
      if (firstKey !== undefined) {
        codexByOptions.delete(firstKey);
        // Do not close evicted instances here: another run may still hold the client
        // reference. The current SDK has no teardown API, so eviction only bounds reuse.
      }
    }
    const codex = new Codex(merged);
    codexByOptions.set(key, codex);
    return codex;
  };
  const run = (options: RunOptions) =>
    Effect.tryPromise({
      try: async (): Promise<RunResult> => {
        const abortController = new AbortController();
        const threadOptions = mergeThreadOptions(config, options.threadOptions);
        const codex = getCodex(options.clientOptions);
        const thread = options.threadId
          ? codex.resumeThread(options.threadId, threadOptions)
          : codex.startThread(threadOptions);
        const runPromise: Promise<SdkRunResult> = thread.run(options.prompt, {
          ...options.turnOptions,
          signal: abortController.signal,
        });
        const timeoutMs = options.timeoutMs ?? config?.timeoutMs;
        const result = await runWithAbortTimeout({
          runPromise,
          abort: () => abortController.abort(),
          timeoutMs,
          cleanupGraceMs: options.cleanupGraceMs ?? config?.cleanupGraceMs,
          timeoutError: () => new CodexTimeout({ timeoutMs: timeoutMs ?? 0 }),
        });
        return {
          threadId: thread.id,
          items: result.items,
          finalResponse: result.finalResponse,
          usage: result.usage,
        };
      },
      catch: (cause) =>
        cause instanceof CodexTimeout
          ? cause
          : cause instanceof DOMException && cause.name === "AbortError"
            ? new CodexTimeout({ timeoutMs: options.timeoutMs ?? config?.timeoutMs ?? 0 })
            : new CodexSdkError({ message: messageFromCause(cause), cause }),
    });
  const runStreamed = (options: RunOptions) =>
    Stream.unwrap(
      Effect.tryPromise({
        try: async () => {
          const abortController = new AbortController();
          const threadOptions = mergeThreadOptions(config, options.threadOptions);
          const codex = getCodex(options.clientOptions);
          const thread = options.threadId
            ? codex.resumeThread(options.threadId, threadOptions)
            : codex.startThread(threadOptions);
          const streamedPromise = thread.runStreamed(options.prompt, {
            ...options.turnOptions,
            signal: abortController.signal,
          });
          const timeoutMs = options.timeoutMs ?? config?.timeoutMs;
          const events = await runWithAbortTimeout({
            runPromise: streamedPromise.then((streamed) => collectStreamEvents(streamed.events)),
            abort: () => abortController.abort(),
            timeoutMs,
            cleanupGraceMs: options.cleanupGraceMs ?? config?.cleanupGraceMs,
            timeoutError: () => new CodexTimeout({ timeoutMs: timeoutMs ?? 0 }),
          });
          return Stream.fromIterable(events);
        },
        catch: (cause) =>
          cause instanceof CodexTimeout || cause instanceof CodexStreamParseError
            ? cause
            : cause instanceof DOMException && cause.name === "AbortError"
              ? new CodexTimeout({ timeoutMs: options.timeoutMs ?? config?.timeoutMs ?? 0 })
              : new CodexSdkError({ message: messageFromCause(cause), cause }),
      }),
    );
  return { run, runStreamed };
});
