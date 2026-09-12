import { spawn } from "node:child_process";
import { sensitiveEnvironmentKeys } from "./config";
import type { ProcessExecutor, ProcessRequest, ProcessResult } from "./types";

const outputLimit = 64 * 1024;

const executionEnvironmentKeys = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "NODE_PATH",
  "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_USER_AGENT",
]);

const isSecretEnvironmentKey = (key: string) => sensitiveEnvironmentKeys.has(key);

const collect = (chunks: string[], chunk: Buffer | string) => {
  const current = chunks.join("");
  if (current.length >= outputLimit) return;
  chunks.push(chunk.toString().slice(0, outputLimit - current.length));
};

const inheritedEnvironment = () => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalizedKey = key.toUpperCase();
    if (
      value !== undefined &&
      executionEnvironmentKeys.has(normalizedKey) &&
      !isSecretEnvironmentKey(key)
    ) {
      environment[key] = value;
    }
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
      stdio: ["ignore", request.output === "inherit" ? "inherit" : "pipe", "pipe"],
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
    if (request.output === "stderr") child.stdout?.pipe(process.stderr);
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

export interface RunningProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<ProcessResult>;
  readonly kill: () => Promise<void>;
}

// fallow-ignore-next-line complexity
export const startLongLivedProcess = async (request: ProcessRequest): Promise<RunningProcess> => {
  const invocation = spawnCommand(request);
  const child = spawn(invocation.command, invocation.args, {
    cwd: request.cwd,
    env: { ...inheritedEnvironment(), ...request.env },
    stdio: [
      "ignore",
      request.output === "stderr" || request.output === "capture" ? "pipe" : "inherit",
      "inherit",
    ],
    detached: process.platform !== "win32",
    shell: false,
    windowsVerbatimArguments: invocation.verbatim,
  });
  let resolveExit!: (result: ProcessResult) => void;
  const stdout: string[] = [];
  const exited = new Promise<ProcessResult>((resolve) => {
    resolveExit = resolve;
  });
  child.once("error", (error) => resolveExit({ exitCode: 127, stderr: error.message }));
  child.once("close", (code) => resolveExit({ exitCode: code ?? 1, stdout: stdout.join("") }));
  if (request.output === "stderr") child.stdout?.pipe(process.stderr);
  if (request.output === "capture") {
    child.stdout?.on("data", (chunk: Buffer | string) => collect(stdout, chunk));
  }
  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
  return {
    pid: child.pid,
    exited,
    // fallow-ignore-next-line complexity
    kill: async () => {
      const send = (signal: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      const sendWindowsTreeKill = () =>
        new Promise<boolean>((resolve) => {
          if (child.pid === undefined) {
            resolve(true);
            return;
          }
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
            windowsHide: true,
          });
          const timer = setTimeout(() => {
            killer.kill();
            resolve(false);
          }, 500);
          killer.once("close", (code) => {
            clearTimeout(timer);
            resolve(code === 0);
          });
          killer.once("error", () => {
            clearTimeout(timer);
            resolve(false);
          });
        });
      if (process.platform === "win32") await sendWindowsTreeKill();
      else send("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
      let processGroupAlive = child.exitCode === null;
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 0);
          processGroupAlive = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") processGroupAlive = false;
          else throw error;
        }
      }
      if (processGroupAlive && child.pid !== undefined) {
        if (process.platform === "win32") await sendWindowsTreeKill();
        else send("SIGKILL");
      }
      const terminated = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      if (!terminated)
        throw new Error("sheet-web process did not terminate within the shutdown deadline");
    },
  };
};
