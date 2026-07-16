import {
  createSession,
  type ContentPart,
  type ExternalTool,
  type RunResult as SdkRunResult,
  type Session,
  type SessionOptions,
  type StreamEvent,
  type Turn,
} from "@moonshot-ai/kimi-agent-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Config, type ApprovalPolicy } from "./KimiConfig";
import {
  type KimiError,
  KimiQuestionUnsupported,
  KimiSdkError,
  KimiStreamParseError,
  KimiTimeout,
  KimiConfigurationError,
  messageFromCause,
} from "./KimiError";
import { handleEvent, mergeSessionOptions } from "./internal/clientRun";
import { runWithAbortTimeout } from "./internal/timeout";

export type KimiExternalTool = ExternalTool;

export type KimiTokenUsage = {
  readonly input_other: number;
  readonly output: number;
  readonly input_cache_read: number;
  readonly input_cache_creation: number;
};

export const makeExternalTool = (input: {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly handler: (params: Record<string, unknown>) => Promise<{
    readonly output: string;
    readonly message: string;
  }>;
}): ExternalTool => ({
  name: input.name,
  description: input.description,
  parameters: input.parameters,
  handler: input.handler,
});

export type RunOptions = {
  readonly prompt: string | ContentPart[];
  readonly workDir: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly thinking?: boolean;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly timeoutMs?: number;
  readonly cleanupGraceMs?: number;
  readonly externalTools?: ReadonlyArray<ExternalTool>;
  readonly inheritConfigExternalTools?: boolean;
  readonly sessionOptions?: Partial<Omit<SessionOptions, "workDir" | "externalTools">>;
};

export type RunResultStatus = SdkRunResult["status"];

export type RunResult = {
  readonly sessionId: string | null;
  readonly finalResponse: string;
  readonly events: ReadonlyArray<StreamEvent>;
  readonly status: RunResultStatus;
  readonly usage: KimiTokenUsage | null;
};

export interface Service {
  readonly run: (options: RunOptions) => Effect.Effect<RunResult, KimiError>;
  /**
   * Buffered event replay. The Kimi SDK turn is executed through `run`, then the collected
   * events are emitted after completion; this is not live incremental streaming.
   */
  readonly runStreamed: (options: RunOptions) => Stream.Stream<StreamEvent, KimiError>;
}

export const make: Effect.Effect<Service> = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(Config).pipe(
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
  );
  const run = (options: RunOptions) =>
    Effect.tryPromise({
      try: async (): Promise<RunResult> => {
        let session: Session | undefined;
        let turn: Turn | undefined;
        let sessionCloseStarted = false;
        const closeSession = async () => {
          if (session === undefined || sessionCloseStarted) {
            return;
          }
          sessionCloseStarted = true;
          await session?.close();
        };
        const state = {
          events: [] as Array<StreamEvent>,
          finalResponse: "",
          usage: null as KimiTokenUsage | null,
        };
        const approvalPolicy = options.approvalPolicy ?? config?.approvalPolicy ?? "reject";
        const timeoutMs = options.timeoutMs ?? config?.timeoutMs;
        const cleanupGraceMs = options.cleanupGraceMs ?? config?.cleanupGraceMs;
        const runPromise = (async () => {
          session = createSession(mergeSessionOptions(config, options));
          turn = session.prompt(options.prompt);
          for await (const event of turn) {
            await handleEvent(turn, event, state, approvalPolicy);
          }
          const result = await turn.result;
          return {
            sessionId: session.sessionId,
            finalResponse: state.finalResponse,
            events: state.events,
            status: result.status,
            usage: state.usage,
          };
        })();
        try {
          return await runWithAbortTimeout({
            runPromise,
            abort: async () => {
              try {
                await turn?.interrupt();
              } finally {
                await closeSession();
              }
            },
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(cleanupGraceMs === undefined ? {} : { cleanupGraceMs }),
            timeoutError: () => new KimiTimeout({ timeoutMs: timeoutMs ?? 0 }),
          });
        } finally {
          await closeSession();
        }
      },
      catch: (cause) =>
        cause instanceof KimiTimeout ||
        cause instanceof KimiQuestionUnsupported ||
        cause instanceof KimiStreamParseError ||
        cause instanceof KimiConfigurationError
          ? cause
          : new KimiSdkError({ message: messageFromCause(cause), cause }),
    });
  const runStreamed = (options: RunOptions) =>
    Stream.unwrap(run(options).pipe(Effect.map((result) => Stream.fromIterable(result.events))));
  return { run, runStreamed };
});

export class KimiClient extends Context.Service<KimiClient, Service>()(
  "effect-ai-kimi/KimiClient",
  {
    make,
  },
) {
  static layer = Layer.effect(KimiClient, this.make);
}
