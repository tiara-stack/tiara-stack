#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { checkHttpAccess, waitForHttp } from "./access";
import { FAST_ENDPOINTS } from "./config";
import { startLongLivedProcess } from "./executor";
import { makeDiagnostic } from "./diagnostics";
import { renderLauncherOutput, runLauncherFromParsed } from "./index";
import type { LauncherOutput } from "./types";
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
// fallow-ignore-next-line complexity
const runParsedCommand = (config: Parameters<typeof launcherOptions>[0]) =>
  // fallow-ignore-next-line complexity
  Effect.tryPromise({
    // fallow-ignore-next-line complexity
    try: async () => {
      const result = await runLauncherFromParsed(config.operands, launcherOptions(config));
      if (result.output.ok && result.output.mode === "fast" && result.output.action === "up") {
        const repository = process.cwd();
        const dependencies = await Promise.all(
          (["auth", "zero", "workflows"] as const).map(async (dependency) => {
            const origin = result.output.urls.find((url) => url.name === dependency)?.url;
            if (origin === undefined) {
              return makeDiagnostic(
                "access-failed",
                `${dependency} has no configured Fast endpoint`,
                "Use the approved Fast development endpoint configuration and retry.",
                { mode: "fast", dependency },
              );
            }
            const access = await checkHttpAccess({
              mode: "fast",
              dependency,
              origin,
              timeoutMs: 2_000,
              optional: false,
            });
            return access.reachable
              ? undefined
              : makeDiagnostic(
                  access.timedOut ? "dependency-timeout" : "access-failed",
                  `${dependency} at ${origin} is not reachable`,
                  "Check the approved development endpoint and retry Fast mode.",
                  { mode: "fast", dependency, origin },
                );
          }),
        );
        const dependencyErrors = dependencies.filter(
          (diagnostic): diagnostic is NonNullable<typeof diagnostic> => diagnostic !== undefined,
        );
        if (dependencyErrors.length > 0) {
          const blocked = {
            ...result.output,
            ok: false,
            readiness: "blocked" as const,
            errors: dependencyErrors,
          } satisfies LauncherOutput;
          process.exitCode = 2;
          process.stdout.write(renderLauncherOutput(blocked, config.json));
          return null;
        }

        const planned = result.output.plannedProcesses[0];
        if (planned === undefined) throw new Error("Fast mode produced no sheet-web process");
        const appUrl = result.output.urls[0]?.url ?? FAST_ENDPOINTS.app;
        let running: Awaited<ReturnType<typeof startLongLivedProcess>> | undefined;
        let terminationExitCode: number | undefined;
        let shutdownPromise: Promise<void> | undefined;
        const shutdown = async (signal: NodeJS.Signals) => {
          terminationExitCode = 128 + (signal === "SIGINT" ? 2 : 15);
          process.exitCode = terminationExitCode;
          if (running !== undefined) await running.kill();
        };
        const onInterrupt = () => {
          shutdownPromise ??= shutdown("SIGINT");
        };
        const onTerminate = () => {
          shutdownPromise ??= shutdown("SIGTERM");
        };
        process.once("SIGINT", onInterrupt);
        process.once("SIGTERM", onTerminate);
        try {
          running = await startLongLivedProcess({
            command: planned.command,
            args: planned.args,
            cwd: path.join(repository, "packages/sheet-web"),
            env: planned.environment,
            timeoutMs: 30_000,
            kind: "runtime",
            readOnly: false,
            output: config.json ? "stderr" : "inherit",
          });
        } catch (cause) {
          if (terminationExitCode !== undefined) {
            await shutdownPromise?.catch(() => undefined);
            process.off("SIGINT", onInterrupt);
            process.off("SIGTERM", onTerminate);
            return null;
          }
          const detail = cause instanceof Error ? `: ${cause.message}` : "";
          const blocked = {
            ...result.output,
            ok: false,
            readiness: "blocked" as const,
            errors: [
              makeDiagnostic(
                "dependency-unavailable",
                `sheet-web could not be started${detail}`,
                "Run pnpm install, verify vite-plus is available, and retry Fast mode.",
                { mode: "fast", dependency: "sheet-web", origin: appUrl },
              ),
            ],
          } satisfies LauncherOutput;
          process.exitCode = 2;
          process.stdout.write(renderLauncherOutput(blocked, config.json));
          process.off("SIGINT", onInterrupt);
          process.off("SIGTERM", onTerminate);
          return null;
        }
        if (terminationExitCode !== undefined) {
          try {
            await (shutdownPromise ?? running.kill().catch(() => undefined)).catch(() => undefined);
            await running.kill().catch(() => undefined);
          } finally {
            process.off("SIGINT", onInterrupt);
            process.off("SIGTERM", onTerminate);
          }
          return null;
        }
        const readiness = await waitForHttp(appUrl, 30_000, running.exited);
        if (!readiness.reachable) {
          try {
            await (shutdownPromise ?? running.kill().catch(() => undefined));
          } finally {
            process.off("SIGINT", onInterrupt);
            process.off("SIGTERM", onTerminate);
          }
          if (terminationExitCode !== undefined) return null;
          const blocked = {
            ...result.output,
            ok: false,
            readiness: "blocked" as const,
            errors: [
              makeDiagnostic(
                readiness.timedOut ? "dependency-timeout" : "access-failed",
                `sheet-web did not become ready at ${appUrl}${
                  readiness.reason === undefined ? "" : `: ${readiness.reason}`
                }`,
                "Fix the sheet-web startup error and retry pnpm dev fast up.",
                { mode: "fast", dependency: "sheet-web", origin: appUrl },
              ),
            ],
          } satisfies LauncherOutput;
          process.exitCode = 2;
          process.stdout.write(renderLauncherOutput(blocked, config.json));
          return null;
        }
        try {
          process.stdout.write(
            renderLauncherOutput({ ...result.output, readiness: "ready" }, config.json),
          );
          const exit = await running.exited;
          await shutdownPromise?.catch(() => undefined);
          process.exitCode = terminationExitCode ?? exit.exitCode;
        } finally {
          process.off("SIGINT", onInterrupt);
          process.off("SIGTERM", onTerminate);
        }
        return null;
      }
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
