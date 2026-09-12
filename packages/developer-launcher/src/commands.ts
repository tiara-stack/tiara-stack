import { Schema } from "effect";
import {
  DevelopmentModeSchema,
  modeActions,
  type DevelopmentMode,
  type DiagnosticCode,
  type ModeAction,
} from "./types";

export interface CommandOptions {
  readonly json: boolean;
  readonly help: boolean;
  readonly envFile: string | null;
  readonly service: string | null;
  readonly confirm: boolean;
  readonly confirmDevelopment: boolean;
  readonly tag: string | null;
}

export type ParsedCommand =
  | {
      readonly kind: "help";
      readonly mode: DevelopmentMode | null;
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
  help: false,
  envFile: null,
  service: null,
  confirm: false,
  confirmDevelopment: false,
  tag: null,
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
  const [first, second, ...rest] = positionals;

  if (first === undefined) {
    if (
      options.envFile !== null ||
      options.service !== null ||
      options.confirm ||
      options.confirmDevelopment ||
      options.tag !== null
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

  if (first === "doctor") {
    if (second !== undefined || rest.length > 0) {
      throw new CommandParseError("doctor does not accept a positional action");
    }
    if (
      options.service !== null ||
      options.confirm ||
      options.confirmDevelopment ||
      options.tag !== null
    ) {
      throw new CommandParseError(
        "doctor does not accept service, confirmation, or image-tag options",
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
      options.confirm ||
      options.confirmDevelopment ||
      options.tag !== null
    ) {
      throw new CommandParseError(
        "setup does not accept service, confirmation, or image-tag options",
      );
    }
    return { kind: "setup", mode, options, command: "setup" };
  }

  const mode = decodeMode(first);
  if (options.help && second === undefined && rest.length === 0) {
    return { kind: "help", mode, options, command: `${mode} help` };
  }
  if (second === undefined) {
    if (options.confirm || options.confirmDevelopment || options.tag !== null) {
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
