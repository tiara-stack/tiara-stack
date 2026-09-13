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
import { spawnProcess, startLongLivedProcess } from "./executor";
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

// fallow-ignore-next-line complexity
const executeComposePlan = async (
  result: Awaited<ReturnType<typeof runLauncherFromParsed>>,
  json: boolean,
) => {
  // startLongLivedProcess owns lifecycle timeout and ignores request.timeoutMs.
  const longLivedTimeoutMs = 2_147_000_000;
  if (!result.output.ok || result.output.plannedProcesses.length === 0) return result;
  let longLivedStarted = false;
  for (const planned of result.output.plannedProcesses) {
    const request = {
      command: planned.command,
      args: planned.args,
      cwd: process.cwd(),
      env: planned.environment,
      timeoutMs: planned.longLived ? longLivedTimeoutMs : 30 * 60_000,
      kind: "runtime" as const,
      readOnly: planned.readOnly,
      output: json ? ("stderr" as const) : ("inherit" as const),
    };
    let processResult;
    if (planned.longLived) {
      let running: Awaited<ReturnType<typeof startLongLivedProcess>> | undefined;
      let signal: NodeJS.Signals | undefined;
      let stopPromise: Promise<void> | undefined;
      let executionError: unknown;
      let resolveSignal!: () => void;
      const signalReceived = new Promise<void>((resolve) => {
        resolveSignal = resolve;
      });
      const stop = (received: NodeJS.Signals) => {
        signal = received;
        resolveSignal();
        if (running !== undefined) {
          stopPromise ??= running.kill();
          void stopPromise.catch(() => undefined);
        }
      };
      const onInterrupt = () => stop("SIGINT");
      const onTerminate = () => stop("SIGTERM");
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", onTerminate);
      try {
        try {
          running = await startLongLivedProcess(request);
        } catch (error) {
          executionError = error;
        }
        if (running === undefined) {
          processResult = {
            exitCode: 127,
            timedOut: false,
            stderr:
              executionError instanceof Error ? executionError.message : String(executionError),
          };
        } else {
          longLivedStarted = true;
          if (!json) {
            process.stdout.write(
              renderLauncherOutput({ ...result.output, readiness: "ready" }, false),
            );
          }
          if (signal !== undefined) stop(signal);
          try {
            processResult = await Promise.race([
              running.exited,
              signalReceived.then(() => ({
                exitCode: signal === "SIGINT" ? 130 : 143,
                timedOut: false,
                stderr: undefined,
              })),
            ]);
            await stopPromise;
          } catch (error) {
            executionError = error;
            processResult = {
              exitCode: 1,
              timedOut: false,
              stderr: error instanceof Error ? error.message : String(error),
            };
          }
        }
      } finally {
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
      }
      if (signal !== undefined && executionError === undefined) {
        const stopped = { ...result.output, readiness: "stopped" as const };
        return {
          ...result,
          exitCode: signal === "SIGINT" ? 130 : 143,
          output: stopped,
          stdout: renderLauncherOutput(stopped, json),
        };
      }
    } else {
      processResult = await spawnProcess(request);
    }
    if (processResult.exitCode === 0 && !processResult.timedOut) continue;
    if (processResult.exitCode === 130 || processResult.exitCode === 143) {
      const stopped = { ...result.output, readiness: "stopped" as const };
      return {
        ...result,
        exitCode: processResult.exitCode,
        output: stopped,
        stdout: renderLauncherOutput(stopped, json),
      };
    }
    const failure = makeDiagnostic(
      processResult.timedOut ? "dependency-timeout" : "required-dependency-failed",
      `${planned.id} failed with exit code ${processResult.exitCode}${
        processResult.stderr === undefined ? "" : `: ${processResult.stderr}`
      }`,
      `Fix ${planned.id} and retry the same pnpm dev command. No later Compose process was started.`,
      { mode: "compose", action: result.output.action ?? "setup" },
    );
    const blocked = {
      ...result.output,
      ok: false,
      readiness: "blocked" as const,
      errors: [failure],
    };
    return {
      ...result,
      exitCode: 2,
      output: blocked,
      stdout: renderLauncherOutput(blocked, json),
    } satisfies Awaited<ReturnType<typeof runLauncherFromParsed>>;
  }
  const completedOutput = {
    ...result.output,
    readiness: longLivedStarted ? ("stopped" as const) : ("ready" as const),
  };
  return {
    ...result,
    output: completedOutput,
    stdout: renderLauncherOutput(completedOutput, json),
  };
};

// Effect CLI owns executable flag syntax. runLauncher keeps a second parser for
// callers that provide raw argv directly, while this path passes typed values
// through one CommandOptions contract.
// fallow-ignore-next-line complexity
const runParsedCommand = (config: Parameters<typeof launcherOptions>[0]) =>
  // fallow-ignore-next-line complexity
  Effect.tryPromise({
    // fallow-ignore-next-line complexity
    try: async () => {
      let result = await runLauncherFromParsed(config.operands, launcherOptions(config));
      if (result.output.mode === "compose" && result.output.action !== null) {
        result = await executeComposePlan(result, config.json);
      }
      if (result.output.ok && result.output.mode === "fast" && result.output.action === "up") {
        const repository = process.cwd();
        const selectedService = result.output.selectedServices[0] ?? "sheet-web";
        const dependencies = await Promise.all(
          (selectedService === "sheet-web"
            ? (["auth", "zero", "workflows"] as const)
            : ([] as const)
          ).map(async (dependency) => {
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

        const planned = result.output.plannedProcesses.find(({ id }) => id === selectedService);
        if (planned === undefined)
          throw new Error(`Fast mode produced no ${selectedService} process`);
        const appUrl =
          selectedService === "sheet-web"
            ? (result.output.urls.find((url) => url.name === "app")?.url ?? FAST_ENDPOINTS.app)
            : (result.output.urls.find((url) => url.name === selectedService)?.url ?? "");
        const readinessUrl = selectedService === "sheet-web" ? appUrl : `${appUrl}/ready`;
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
            cwd: path.join(repository, "packages", selectedService),
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
                `${selectedService} could not be started${detail}`,
                "Run pnpm install, verify the package's tsx/vite-plus tooling is available, and retry Fast mode.",
                { mode: "fast", dependency: selectedService, origin: appUrl },
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
        const readiness = await waitForHttp(readinessUrl, 30_000, running.exited);
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
                `${selectedService} did not become ready at ${readinessUrl}${
                  readiness.reason === undefined ? "" : `: ${readiness.reason}`
                }`,
                "Fix the host-native process startup error and retry pnpm dev fast up.",
                { mode: "fast", dependency: selectedService, origin: readinessUrl },
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
