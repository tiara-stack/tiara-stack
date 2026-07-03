#!/usr/bin/env node

import { runEffectDiagnostics, type OutputFormat, type SeverityLevel } from "./diagnosticsRunner";

interface CliOptions {
  projects: Array<string>;
  format: OutputFormat;
  strict: boolean;
  progress: boolean;
  severity?: SeverityLevel;
  lspconfig?: string;
}

const outputFormats = new Set(["json", "pretty", "text", "github-actions"]);
const severityLevels = new Set(["error", "warning", "message"]);

const printHelp = () => {
  process.stdout.write(`effect-lint

Runs Effect language-service diagnostics for one or more TypeScript projects.

Usage:
  effect-lint --project tsconfig.json [--format pretty]
  effect-lint --project 'packages/*/tsconfig.json' --format github-actions

Options:
  --project <path-or-glob>       Tsconfig path or glob. Can be repeated.
  --format <format>             pretty, text, json, github-actions. Default: pretty.
  --strict                      Treat warnings as failures in the native diagnostics engine.
  --progress                    Show native diagnostics progress.
  --severity <level>            error, warning, or message.
  --lspconfig <json>            Inline Effect language-service config. Default: {}.
  -h, --help                    Show this help.
`);
};

const readValue = (args: ReadonlyArray<string>, index: number, flag: string) => {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
};

type OptionReader = (options: CliOptions, args: ReadonlyArray<string>, index: number) => number;

const readProject: OptionReader = (options, args, index) => {
  options.projects.push(readValue(args, index, args[index] ?? "--project"));
  return 1;
};

const readFormat: OptionReader = (options, args, index) => {
  const format = readValue(args, index, "--format");
  if (!outputFormats.has(format)) {
    throw new Error(`Unsupported format: ${format}.`);
  }
  options.format = format as OutputFormat;
  return 1;
};

const readSeverity: OptionReader = (options, args, index) => {
  const severity = readValue(args, index, "--severity");
  if (!severityLevels.has(severity)) {
    throw new Error(`Unsupported severity: ${severity}.`);
  }
  options.severity = severity as SeverityLevel;
  return 1;
};

const optionReaders: Record<string, OptionReader> = {
  "--help": () => showHelp(),
  "-h": () => showHelp(),
  "--project": readProject,
  "-p": readProject,
  "--format": readFormat,
  "--severity": readSeverity,
  "--lspconfig": (options, args, index) => {
    options.lspconfig = readValue(args, index, "--lspconfig");
    return 1;
  },
  "--strict": (options) => {
    options.strict = true;
    return 0;
  },
  "--progress": (options) => {
    options.progress = true;
    return 0;
  },
};

const showHelp = () => {
  printHelp();
  process.exit(0);
};

const readPositional = (options: CliOptions, arg: string) => {
  if (arg.startsWith("-")) {
    throw new Error(`Unknown option: ${arg}.`);
  }
  options.projects.push(arg);
  return 0;
};

const parseArg = (options: CliOptions, args: ReadonlyArray<string>, index: number) => {
  const arg = args[index] ?? "";
  const reader = optionReaders[arg];
  return reader ? reader(options, args, index) : readPositional(options, arg);
};

const parseArgs = (args: ReadonlyArray<string>): CliOptions => {
  const options: CliOptions = {
    projects: [],
    format: "pretty",
    strict: false,
    progress: false,
  };

  for (let index = 0; index < args.length; index++) {
    index += parseArg(options, args, index);
  }

  if (options.projects.length === 0) {
    throw new Error("At least one --project path or glob is required.");
  }

  return options;
};

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await runEffectDiagnostics(options);
  process.exitCode = result.exitCode;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
