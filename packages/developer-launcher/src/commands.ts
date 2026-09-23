import { Schema } from "effect";
import {
  DevelopmentModeSchema,
  modeActions,
  type DevelopmentMode,
  type DiagnosticCode,
  type ModeAction,
  type ConnectedPreviewAction,
  connectedPreviewActions,
  type LauncherMode,
} from "./types";

export interface CommandOptions {
  readonly json: boolean;
  readonly jsonStream?: boolean;
  readonly help: boolean;
  readonly envFile: string | null;
  readonly configFile: string | null;
  readonly sessionId: string | null;
  readonly service: string | null;
  readonly confirm: boolean;
  readonly confirmDevelopment: boolean;
  readonly tag: string | null;
  readonly changedSurfaces: readonly string[];
}

export type ParsedCommand =
  | {
      readonly kind: "help";
      readonly mode: LauncherMode | null;
      readonly options: CommandOptions;
      readonly command: string;
    }
  | {
      readonly kind: "doctor";
      readonly options: CommandOptions;
      readonly command: "doctor";
    }
  | {
      readonly kind: "setup";
      readonly mode: DevelopmentMode;
      readonly options: CommandOptions;
      readonly command: "setup";
    }
  | {
      readonly kind: "mode";
      readonly mode: DevelopmentMode;
      readonly action: ModeAction;
      readonly options: CommandOptions;
      readonly command: string;
    }
  | {
      readonly kind: "preview";
      readonly action: "plan";
      readonly options: CommandOptions & { readonly configFile: string; readonly sessionId: null };
      readonly command: string;
    }
  | {
      readonly kind: "preview";
      readonly action: "doctor";
      readonly options: CommandOptions & { readonly configFile: string; readonly sessionId: null };
      readonly command: string;
    }
  | {
      readonly kind: "preview";
      readonly action: "start";
      readonly options: CommandOptions & { readonly configFile: string; readonly sessionId: null };
      readonly command: string;
    }
  | {
      readonly kind: "preview";
      readonly action: "status" | "resume" | "stop" | "cleanup";
      readonly options: CommandOptions & { readonly configFile: null; readonly sessionId: string };
      readonly command: string;
    };

export class CommandParseError extends Error {
  constructor(
    readonly detail: string,
    readonly code: Extract<
      DiagnosticCode,
      "invalid-command" | "invalid-option" | "invalid-mode" | "invalid-action"
    > = "invalid-command",
  ) {
    super(detail);
    this.name = "CommandParseError";
  }
}

type MutableCommandOptions = { -readonly [Key in keyof CommandOptions]: CommandOptions[Key] };

const initialOptions = (): MutableCommandOptions => ({
  json: false,
  jsonStream: false,
  help: false,
  envFile: null,
  configFile: null,
  sessionId: null,
  service: null,
  confirm: false,
  confirmDevelopment: false,
  tag: null,
  changedSurfaces: [],
});

const valueAfterOption = (args: readonly string[], index: number, option: string) => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new CommandParseError(`${option} requires a value`, "invalid-option");
  }
  return value;
};

const nonEmptyOptionValue = (value: string, option: string) => {
  if (value.length === 0) {
    throw new CommandParseError(`${option} requires a non-empty value`, "invalid-option");
  }
  return value;
};

export const normalizeChangedSurfaces = (value: string): readonly string[] => {
  const surfaces = value.split(",").map((surface) => surface.trim());
  if (surfaces.some((surface) => surface.length === 0)) {
    throw new CommandParseError("--changed-surface values must be non-empty", "invalid-option");
  }
  return surfaces;
};

// fallow-ignore-next-line complexity
const parseOptions = (args: readonly string[]) => {
  const options = initialOptions();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }

    if (argument === "--json") {
      if (options.json) {
        throw new CommandParseError("--json may only be provided once", "invalid-option");
      }
      options.json = true;
      continue;
    }
    if (argument === "--json-stream") {
      if (options.jsonStream) {
        throw new CommandParseError("--json-stream may only be provided once", "invalid-option");
      }
      options.jsonStream = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      if (options.help) {
        throw new CommandParseError("--help may only be provided once", "invalid-option");
      }
      options.help = true;
      continue;
    }
    if (argument === "--confirm") {
      if (options.confirm) {
        throw new CommandParseError("--confirm may only be provided once", "invalid-option");
      }
      options.confirm = true;
      continue;
    }
    if (argument === "--confirm-development") {
      if (options.confirmDevelopment) {
        throw new CommandParseError(
          "--confirm-development may only be provided once",
          "invalid-option",
        );
      }
      options.confirmDevelopment = true;
      continue;
    }

    const equalsIndex = argument.indexOf("=");
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : argument.slice(equalsIndex + 1);
    if (option === "--env-file") {
      const value = nonEmptyOptionValue(
        inlineValue ?? valueAfterOption(args, index, option),
        option,
      );
      if (inlineValue === null) index += 1;
      if (options.envFile !== null) {
        throw new CommandParseError(`${option} may only be provided once`, "invalid-option");
      }
      options.envFile = value;
      continue;
    }
    if (option === "--config") {
      const value = nonEmptyOptionValue(
        inlineValue ?? valueAfterOption(args, index, option),
        option,
      );
      if (inlineValue === null) index += 1;
      if (options.configFile !== null) {
        throw new CommandParseError(`${option} may only be provided once`, "invalid-option");
      }
      options.configFile = value;
      continue;
    }
    if (option === "--session") {
      const value = nonEmptyOptionValue(
        inlineValue ?? valueAfterOption(args, index, option),
        option,
      );
      if (inlineValue === null) index += 1;
      if (options.sessionId !== null) {
        throw new CommandParseError(`${option} may only be provided once`, "invalid-option");
      }
      options.sessionId = value;
      continue;
    }
    if (option === "--service") {
      const value = nonEmptyOptionValue(
        inlineValue ?? valueAfterOption(args, index, option),
        option,
      );
      if (inlineValue === null) index += 1;
      if (options.service !== null) {
        throw new CommandParseError(`${option} may only be provided once`, "invalid-option");
      }
      options.service = value;
      continue;
    }
    if (option === "--tag") {
      const value = nonEmptyOptionValue(
        inlineValue ?? valueAfterOption(args, index, option),
        option,
      );
      if (inlineValue === null) index += 1;
      if (options.tag !== null) {
        throw new CommandParseError(`${option} may only be provided once`, "invalid-option");
      }
      options.tag = value;
      continue;
    }
    if (option === "--changed-surface") {
      const value = nonEmptyOptionValue(
        inlineValue ?? valueAfterOption(args, index, option),
        option,
      );
      if (inlineValue === null) index += 1;
      options.changedSurfaces = [...options.changedSurfaces, ...normalizeChangedSurfaces(value)];
      continue;
    }

    throw new CommandParseError(`unknown option ${argument}`, "invalid-option");
  }

  return { options, positionals };
};

const decodeMode = (value: string): DevelopmentMode => {
  try {
    return Schema.decodeUnknownSync(DevelopmentModeSchema)(value);
  } catch {
    throw new CommandParseError(`unknown development mode ${value}`, "invalid-mode");
  }
};

const isModeAction = (mode: DevelopmentMode, value: string): value is ModeAction =>
  (modeActions[mode] as readonly string[]).includes(value);

// fallow-ignore-next-line complexity
export const parsePositionals = (
  positionals: readonly string[],
  options: CommandOptions,
): ParsedCommand => {
  if (options.json && options.jsonStream === true) {
    throw new CommandParseError(
      "--json and --json-stream cannot be used together",
      "invalid-option",
    );
  }
  const [first, second, ...rest] = positionals;

  if (first === undefined) {
    if (
      options.confirm ||
      options.confirmDevelopment ||
      options.configFile !== null ||
      options.sessionId !== null ||
      options.tag !== null ||
      options.changedSurfaces.length > 0
    ) {
      throw new CommandParseError("options require a mode, setup command, or doctor command");
    }
    return { kind: "help", mode: null, options, command: "help" };
  }

  if (first === "help") {
    if (second !== undefined || rest.length > 0) {
      throw new CommandParseError("help does not accept a positional argument");
    }
    return { kind: "help", mode: null, options, command: "help" };
  }

  if (first === "preview") {
    if (options.help && (second === undefined || second === "help")) {
      return { kind: "help", mode: "preview", options, command: "preview help" };
    }
    if (second === undefined || second === "help") {
      if (rest.length > 0) {
        throw new CommandParseError("preview help does not accept a positional argument");
      }
      return { kind: "help", mode: "preview", options, command: "preview help" };
    }
    if (rest.length > 0) {
      throw new CommandParseError(
        `preview accepts one action, received ${[second, ...rest].join(" ")}`,
      );
    }
    if (!(connectedPreviewActions as readonly string[]).includes(second)) {
      throw new CommandParseError(`unknown action ${second} for preview`, "invalid-action");
    }
    if (
      options.envFile !== null ||
      options.service !== null ||
      options.confirm ||
      options.confirmDevelopment ||
      options.tag !== null ||
      options.changedSurfaces.length > 0
    ) {
      throw new CommandParseError(
        "connected preview commands accept --config or --session, not mode-specific Fast, Compose, or Kubernetes options",
        "invalid-option",
      );
    }
    if (options.help) {
      return { kind: "help", mode: "preview", options, command: "preview help" };
    }
    if (second === "plan" || second === "doctor") {
      if (options.configFile === null || options.sessionId !== null) {
        throw new CommandParseError(
          `preview ${second} requires --config <file> and does not accept --session`,
          "invalid-option",
        );
      }
      const previewOptions = { ...options, configFile: options.configFile, sessionId: null };
      if (second === "plan") {
        return {
          kind: "preview",
          action: "plan",
          options: previewOptions,
          command: "preview plan",
        };
      }
      return {
        kind: "preview",
        action: "doctor",
        options: previewOptions,
        command: "preview doctor",
      };
    }
    if (second === "start") {
      if (options.configFile === null || options.sessionId !== null) {
        throw new CommandParseError(
          `preview start requires --config <file> and does not accept --session`,
          "invalid-option",
        );
      }
      return {
        kind: "preview",
        action: "start",
        options: { ...options, configFile: options.configFile, sessionId: null },
        command: "preview start",
      };
    }
    if (options.sessionId === null || options.configFile !== null) {
      throw new CommandParseError(
        `preview ${second} requires --session <id> and does not accept --config`,
        "invalid-option",
      );
    }
    return {
      kind: "preview",
      action: second as Exclude<ConnectedPreviewAction, "plan" | "doctor" | "start">,
      options: { ...options, configFile: null, sessionId: options.sessionId },
      command: `preview ${second}`,
    };
  }

  if (options.configFile !== null || options.sessionId !== null) {
    throw new CommandParseError(
      "--config and --session are only valid for connected preview commands",
      "invalid-option",
    );
  }

  if (first === "doctor") {
    if (second !== undefined || rest.length > 0) {
      throw new CommandParseError("doctor does not accept a positional action");
    }
    if (
      options.service !== null ||
      options.configFile !== null ||
      options.sessionId !== null ||
      options.confirm ||
      options.confirmDevelopment ||
      options.tag !== null ||
      options.changedSurfaces.length > 0
    ) {
      throw new CommandParseError(
        "doctor does not accept service, confirmation, image-tag, or changed-surface options",
      );
    }
    return { kind: "doctor", options, command: "doctor" };
  }

  if (first === "setup") {
    if (second === undefined || rest.length > 0) {
      throw new CommandParseError("setup requires exactly one mode");
    }
    const mode = decodeMode(second);
    if (
      options.service !== null ||
      options.configFile !== null ||
      options.sessionId !== null ||
      options.confirm ||
      options.confirmDevelopment ||
      options.tag !== null ||
      options.changedSurfaces.length > 0
    ) {
      throw new CommandParseError(
        "setup does not accept service, confirmation, image-tag, or changed-surface options",
      );
    }
    return { kind: "setup", mode, options, command: "setup" };
  }

  const mode = decodeMode(first);
  if (options.help && second === undefined && rest.length === 0) {
    return { kind: "help", mode, options, command: `${mode} help` };
  }
  if (second === undefined) {
    if (
      options.confirm ||
      options.confirmDevelopment ||
      options.tag !== null ||
      options.changedSurfaces.length > 0
    ) {
      throw new CommandParseError(`${mode} requires an action before these options can be used`);
    }
    return { kind: "help", mode, options, command: `${mode} help` };
  }
  if (rest.length > 0) {
    throw new CommandParseError(
      `${mode} accepts one action, received ${[second, ...rest].join(" ")}`,
    );
  }
  if (second === "help") {
    return { kind: "help", mode, options, command: `${mode} help` };
  }
  if (!isModeAction(mode, second)) {
    throw new CommandParseError(`unknown action ${second} for ${mode}`, "invalid-action");
  }
  return { kind: "mode", mode, action: second, options, command: `${mode} ${second}` };
};

export const parseCommand = (args: readonly string[]): ParsedCommand => {
  const { options, positionals } = parseOptions(args);
  return parsePositionals(positionals, options);
};
