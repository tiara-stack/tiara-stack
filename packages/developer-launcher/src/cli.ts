#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { runLauncherFromParsed } from "./index";
import type { CommandOptions } from "./commands";

const commonFlags = {
  envFile: Flag.string("env-file").pipe(Flag.optional),
  service: Flag.string("service").pipe(Flag.optional),
  confirm: Flag.boolean("confirm").pipe(Flag.withDefault(false)),
  confirmDevelopment: Flag.boolean("confirm-development").pipe(Flag.withDefault(false)),
  tag: Flag.string("tag").pipe(Flag.optional),
  json: Flag.boolean("json").pipe(Flag.withDefault(false)),
};

const launcherOptions = (config: {
  readonly operands: ReadonlyArray<string>;
  readonly envFile: Option.Option<string>;
  readonly service: Option.Option<string>;
  readonly confirm: boolean;
  readonly confirmDevelopment: boolean;
  readonly tag: Option.Option<string>;
  readonly json: boolean;
}): CommandOptions => ({
  json: config.json,
  help: false,
  envFile: Option.getOrNull(config.envFile),
  service: Option.getOrNull(config.service),
  confirm: config.confirm,
  confirmDevelopment: config.confirmDevelopment,
  tag: Option.getOrNull(config.tag),
});

// Effect CLI owns executable flag syntax. runLauncher keeps a second parser for
// callers that provide raw argv directly, while this path passes typed values
// through one CommandOptions contract.
const runParsedCommand = (config: Parameters<typeof launcherOptions>[0]) =>
  Effect.tryPromise({
    try: async () => {
      const result = await runLauncherFromParsed(config.operands, launcherOptions(config));
      process.exitCode = result.exitCode;
      const output = result.stdout.trimEnd();
      return output.length === 0 ? null : output;
    },
    catch: (cause) => {
      process.exitCode = 1;
      return cause instanceof Error
        ? cause
        : new Error("The development launcher failed before it could produce a result.");
    },
  }).pipe(
    Effect.flatMap((output) => (output === null ? Effect.void : Console.log(output))),
    Effect.catch((error: unknown) =>
      Console.error(error instanceof Error ? error.message : "The development launcher failed."),
    ),
  );

export const command = Command.make(
  "dev",
  {
    operands: Argument.string("command").pipe(Argument.variadic()),
    ...commonFlags,
  },
  runParsedCommand,
).pipe(
  Command.withDescription(
    "Select a safe TiaraStack development mode or run read-only prerequisite checks",
  ),
  Command.withExamples([
    { command: "pnpm dev", description: "Print the launcher help" },
    { command: "pnpm dev fast up", description: "Plan the Fast sheet-web slice" },
    { command: "pnpm dev doctor --json", description: "Run prerequisite checks as JSON" },
  ]),
);

// fallow-ignore-next-line code-duplication
export const main = Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
);

export const runMain = () => NodeRuntime.runMain(main);

const canonicalPath = (value: string) => {
  try {
    return realpathSync(value);
  } catch {
    return path.normalize(path.resolve(value));
  }
};

const isMain = () => {
  if (!process.argv[1]) return false;
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));
};

if (isMain()) runMain();
