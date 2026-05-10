import {
  createSession,
  type ContentPart,
  type ExternalTool,
  type ApprovalResponse,
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
import { runWithAbortTimeout } from "./internal/timeout";

export type KimiExternalTool = ExternalTool;

export type KimiTokenUsage = {
  readonly input_other: number;
  readonly output: number;
  readonly input_cache_read: number;
  readonly input_cache_creation: number;
};

type KimiTextContentPart = { readonly type: "text"; readonly text: string };
type KimiThinkContentPart = { readonly type: "think"; readonly think: string };
type KimiContentPart = KimiTextContentPart | KimiThinkContentPart | { readonly type: string };

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

export class KimiClient extends Context.Service<KimiClient, Service>()(
  "effect-ai-kimi/KimiClient",
  {
    make: Effect.gen(function* () {
      return yield* make;
    }),
  },
) {
  static layer = Layer.effect(KimiClient, this.make);
}

const mergeSessionOptions = (
  config: Context.Service.Shape<typeof Config> | undefined,
  options: RunOptions,
): SessionOptions => ({
  ...config?.session,
  ...options.sessionOptions,
  workDir: options.workDir,
  sessionId: options.sessionId ?? options.sessionOptions?.sessionId ?? config?.session?.sessionId,
  model: options.model ?? options.sessionOptions?.model ?? config?.session?.model,
  thinking:
    options.thinking ??
    options.sessionOptions?.thinking ??
    config?.thinking ??
    config?.session?.thinking ??
    false,
  yoloMode:
    options.sessionOptions?.yoloMode ?? config?.yoloMode ?? config?.session?.yoloMode ?? false,
  executable:
    options.sessionOptions?.executable ?? config?.executable ?? config?.session?.executable,
  env:
    options.sessionOptions?.env !== undefined ||
    config?.env !== undefined ||
    config?.session?.env !== undefined
      ? {
          ...config?.session?.env,
          ...config?.env,
          ...options.sessionOptions?.env,
        }
      : undefined,
  externalTools: [
    ...(options.inheritConfigExternalTools === false ? [] : (config?.externalTools ?? [])),
    ...(options.externalTools ?? []),
  ] as Array<ExternalTool>,
  agentFile: options.sessionOptions?.agentFile ?? config?.agentFile ?? config?.session?.agentFile,
  skillsDir: options.sessionOptions?.skillsDir ?? config?.skillsDir ?? config?.session?.skillsDir,
  shareDir: options.sessionOptions?.shareDir ?? config?.shareDir ?? config?.session?.shareDir,
  clientInfo: options.sessionOptions?.clientInfo ?? config?.session?.clientInfo,
});

const contentPartText = (part: ContentPart) => {
  const content = part as KimiContentPart;
  switch (content.type) {
    case "text":
      return (content as KimiTextContentPart).text;
    default:
      return "";
  }
};

const shellUnsafePattern = /[;|`$()<>]|\r|\n/;

const gitReadOnlySubcommands = [
  "branch",
  "diff",
  "fetch",
  "grep",
  "log",
  "ls-files",
  "ls-remote",
  "merge-base",
  "rev-list",
  "rev-parse",
  "show",
  "status",
] as const;

const gitInspectionPattern = new RegExp(
  String.raw`^\s*git\s+(?:` +
    gitReadOnlySubcommands.join("|") +
    String.raw`)(?:\s+(?:--[A-Za-z0-9][A-Za-z0-9-]*(?:=(?:"[^"]*"|'[^']*'|[^\s;&|` +
    String.raw`$()<>]+))?|-[A-Za-z0-9]+|[^\s;&|` +
    String.raw`$()<>]+))*\s*$`,
);

const approvalTextValues = (value: unknown): Array<string> => {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(approvalTextValues);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(approvalTextValues);
  }
  return [];
};

const approvalShellCommands = (payload: unknown): Array<string> => {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const display = (payload as { readonly display?: unknown }).display;
  if (!Array.isArray(display)) {
    return [];
  }
  return display.flatMap((block) =>
    typeof block === "object" &&
    block !== null &&
    (block as { readonly type?: unknown }).type === "shell" &&
    typeof (block as { readonly command?: unknown }).command === "string"
      ? [(block as { readonly command: string }).command]
      : [],
  );
};

const isAllowedGitInspectionApproval = (payload: unknown) => {
  const commands = approvalShellCommands(payload);
  const candidates = commands.length > 0 ? commands : approvalTextValues(payload);
  return candidates.some((candidate) => {
    if (shellUnsafePattern.test(candidate) || candidate.replaceAll("&&", "").includes("&")) {
      return false;
    }
    const segments = candidate
      .split(/\s*&&\s*/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    return segments.length > 0 && segments.every((segment) => gitInspectionPattern.test(segment));
  });
};

const approvalResponse = (payload: unknown, policy: ApprovalPolicy | undefined): ApprovalResponse =>
  policy === "allow-read-only-git" && isAllowedGitInspectionApproval(payload)
    ? "approve"
    : "reject";

const handleEvent = async (
  turn: Turn,
  event: StreamEvent,
  state: {
    readonly events: Array<StreamEvent>;
    finalResponse: string;
    usage: KimiTokenUsage | null;
  },
  approvalPolicy: ApprovalPolicy | undefined,
) => {
  state.events.push(event);
  if (event.type === "ContentPart") {
    state.finalResponse += contentPartText(event.payload);
    return;
  }
  if (event.type === "StatusUpdate") {
    state.usage =
      (event.payload as { readonly token_usage?: KimiTokenUsage | null }).token_usage ??
      state.usage;
    return;
  }
  if (event.type === "ApprovalRequest") {
    await turn.approve(event.payload.id, approvalResponse(event.payload, approvalPolicy));
    return;
  }
  if (event.type === "QuestionRequest") {
    throw new KimiQuestionUnsupported({
      questionId: event.payload.id,
      message: "Kimi question requests are not supported during unattended review",
    });
  }
  if (event.type === "error") {
    throw new KimiStreamParseError({ message: event.message, cause: event });
  }
};

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
            timeoutMs,
            cleanupGraceMs: options.cleanupGraceMs ?? config?.cleanupGraceMs,
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
