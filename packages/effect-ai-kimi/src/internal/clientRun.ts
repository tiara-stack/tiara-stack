import type {
  ApprovalResponse,
  ContentPart,
  ExternalTool,
  SessionOptions,
  StreamEvent,
  Turn,
} from "@moonshot-ai/kimi-agent-sdk";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import type { ApprovalPolicy, ConfigShape } from "../KimiConfig";
import { KimiQuestionUnsupported, KimiStreamParseError } from "../KimiError";
import type { KimiTokenUsage, RunOptions } from "../KimiClient";

type KimiTextContentPart = { readonly type: "text"; readonly text: string };
type KimiThinkContentPart = { readonly type: "think"; readonly think: string };
type KimiContentPart = KimiTextContentPart | KimiThinkContentPart | { readonly type: string };

export const mergeSessionOptions = (
  config: ConfigShape | undefined,
  options: RunOptions,
): SessionOptions => {
  const sessionId =
    options.sessionId ?? options.sessionOptions?.sessionId ?? config?.session?.sessionId;
  const model = options.model ?? options.sessionOptions?.model ?? config?.session?.model;
  const executable =
    options.sessionOptions?.executable ?? config?.executable ?? config?.session?.executable;
  const env =
    options.sessionOptions?.env !== undefined ||
    config?.env !== undefined ||
    config?.session?.env !== undefined
      ? {
          ...config?.session?.env,
          ...config?.env,
          ...options.sessionOptions?.env,
        }
      : undefined;
  const agentFile =
    options.sessionOptions?.agentFile ?? config?.agentFile ?? config?.session?.agentFile;
  const skillsDir =
    options.sessionOptions?.skillsDir ?? config?.skillsDir ?? config?.session?.skillsDir;
  const shareDir =
    options.sessionOptions?.shareDir ?? config?.shareDir ?? config?.session?.shareDir;
  const clientInfo = options.sessionOptions?.clientInfo ?? config?.session?.clientInfo;
  return {
    ...config?.session,
    ...options.sessionOptions,
    workDir: options.workDir,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(model === undefined ? {} : { model }),
    thinking:
      options.thinking ??
      options.sessionOptions?.thinking ??
      config?.thinking ??
      config?.session?.thinking ??
      false,
    yoloMode:
      options.sessionOptions?.yoloMode ?? config?.yoloMode ?? config?.session?.yoloMode ?? false,
    ...(executable === undefined ? {} : { executable }),
    ...(env === undefined ? {} : { env }),
    externalTools: [
      ...(options.inheritConfigExternalTools === false ? [] : (config?.externalTools ?? [])),
      ...(options.externalTools ?? []),
    ] as Array<ExternalTool>,
    ...(agentFile === undefined ? {} : { agentFile }),
    ...(skillsDir === undefined ? {} : { skillsDir }),
    ...(shareDir === undefined ? {} : { shareDir }),
    ...(clientInfo === undefined ? {} : { clientInfo }),
  };
};

const contentPartText = (part: ContentPart) => {
  const content = part as KimiContentPart;
  return Match.value(content).pipe(
    Match.when({ type: "text" }, (content) => (content as KimiTextContentPart).text),
    Match.orElse(() => ""),
  );
};

const shellUnsafePattern = /[;|`$()<>]|\r|\n/;

const gitReadOnlySubcommands = [
  "diff",
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

const gitWriteOptionPattern = /\s--(?:output|exec-path)(?:=|\s|$)/;

const gitInspectionPattern = new RegExp(
  String.raw`^\s*git\s+(?:` +
    gitReadOnlySubcommands.join("|") +
    String.raw`)(?:\s+(?:--[A-Za-z0-9][A-Za-z0-9-]*(?:=(?:"[^"]*"|'[^']*'|[^\s;&|` +
    String.raw`$()<>]+))?|-[A-Za-z0-9]+|[^\s;&|` +
    String.raw`$()<>]+))*\s*$`,
);

const approvalShellCommands = (payload: unknown): Array<string> => {
  if (!Predicate.hasProperty(payload, "display")) {
    return [];
  }
  const { display } = payload;
  if (!Array.isArray(display)) {
    return [];
  }
  return display.flatMap((block) =>
    Predicate.hasProperty(block, "type") &&
    block.type === "shell" &&
    Predicate.hasProperty(block, "command") &&
    Predicate.isString(block.command)
      ? [block.command]
      : [],
  );
};

const isAllowedGitInspectionCommand = (command: string) => {
  if (
    shellUnsafePattern.test(command) ||
    command.replaceAll("&&", "").includes("&") ||
    gitWriteOptionPattern.test(command)
  ) {
    return false;
  }
  const segments = command
    .split(/\s*&&\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return segments.length > 0 && segments.every((segment) => gitInspectionPattern.test(segment));
};

const isAllowedGitInspectionApproval = (payload: unknown) => {
  const commands = approvalShellCommands(payload);
  return commands.length > 0 && commands.every(isAllowedGitInspectionCommand);
};

const approvalResponse = (payload: unknown, policy: ApprovalPolicy | undefined): ApprovalResponse =>
  policy === "allow-read-only-git" && isAllowedGitInspectionApproval(payload)
    ? "approve"
    : "reject";

export const handleEvent = async (
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
  return Match.value(event).pipe(
    Match.when({ type: "ContentPart" }, (event) => {
      state.finalResponse += contentPartText(event.payload);
    }),
    Match.when({ type: "StatusUpdate" }, (event) => {
      state.usage =
        (event.payload as { readonly token_usage?: KimiTokenUsage | null }).token_usage ??
        state.usage;
    }),
    Match.when({ type: "ApprovalRequest" }, (event) =>
      turn.approve(event.payload.id, approvalResponse(event.payload, approvalPolicy)),
    ),
    Match.when({ type: "QuestionRequest" }, (event) => {
      throw new KimiQuestionUnsupported({
        questionId: event.payload.id,
        message: "Kimi question requests are not supported during unattended review",
      });
    }),
    Match.when({ type: "error" }, (event) => {
      throw new KimiStreamParseError({ message: event.message, cause: event });
    }),
    Match.orElse(() => undefined),
  );
};
