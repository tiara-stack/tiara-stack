import { spawn } from "node:child_process";
import { sensitiveEnvironmentKeys } from "./config";
import type { ProcessExecutor, ProcessRequest, ProcessResult } from "./types";

const outputLimit = 64 * 1024;

const isSecretEnvironmentKey = (key: string) => sensitiveEnvironmentKeys.has(key);

const collect = (chunks: string[], chunk: Buffer | string) => {
  const current = chunks.join("");
  if (current.length >= outputLimit) return;
  chunks.push(chunk.toString().slice(0, outputLimit - current.length));
};

const inheritedEnvironment = () => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isSecretEnvironmentKey(key)) environment[key] = value;
  }
  return environment;
};

const executable = (command: string) =>
  process.platform === "win32" && (command === "pnpm" || command === "vp")
    ? `${command}.cmd`
    : command;

const quoteWindowsCommandArgument = (value: string) => {
  const quoted = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1");
  return `"${quoted.replaceAll("%", "%%")}"`;
};

const spawnCommand = (request: ProcessRequest) => {
  const command = executable(request.command);
  if (process.platform === "win32" && command.endsWith(".cmd")) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        [command, ...request.args].map(quoteWindowsCommandArgument).join(" "),
      ],
      verbatim: true,
    };
  }
  return { command, args: [...request.args], verbatim: false };
};

export const spawnProcess: ProcessExecutor = (request: ProcessRequest) =>
  new Promise((resolve) => {
    const invocation = spawnCommand(request);
    const child = spawn(invocation.command, invocation.args, {
      cwd: request.cwd,
      env: { ...inheritedEnvironment(), ...request.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsVerbatimArguments: invocation.verbatim,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout;
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(result);
    };
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          exitCode: 1,
          stdout: stdout.join(""),
          stderr: stderr.join(""),
          timedOut: true,
        });
      }, 100);
    }, request.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => collect(stderr, chunk));
    child.once("error", (error) => {
      finish({ exitCode: 127, stdout: stdout.join(""), stderr: error.message, timedOut });
    });
    child.once("close", (code) => {
      finish({
        exitCode: code ?? 1,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        timedOut,
      });
    });
  });
