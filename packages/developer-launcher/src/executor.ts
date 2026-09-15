import { spawn } from "node:child_process";
import { sensitiveEnvironmentKeys } from "./config";
import type { ProcessExecutor, ProcessRequest, ProcessResult, ProcessStarter } from "./types";

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
  "KUBECONFIG",
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

const terminateProcessTree = (
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): Promise<boolean> => {
  if (child.pid === undefined) return Promise.resolve(true);
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(success);
      };
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        killer.kill();
        finish(false);
      }, 500);
      killer.once("error", () => finish(false));
      killer.once("close", (code) => finish(code === 0));
    });
  }
  try {
    process.kill(-child.pid, signal);
    return Promise.resolve(true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return Promise.resolve(false);
    try {
      child.kill(signal);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }
};

const scheduleProcessTreeKill = (
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  onComplete: () => void,
) => void terminateProcessTree(child, signal).then(onComplete);

const processGroupAlive = (child: ReturnType<typeof spawn>) => {
  if (process.platform === "win32" || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const withReceivedSignal = (result: ProcessResult, signal: NodeJS.Signals | undefined) =>
  signal === undefined ? result : { ...result, exitCode: signal === "SIGINT" ? 130 : 143 };

const registerAbort = (signal: AbortSignal | undefined, onAbort: () => void) => {
  if (signal === undefined) return () => undefined;
  const remove = () => signal.removeEventListener("abort", onAbort);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return remove;
};

export const spawnProcess: ProcessExecutor = (request: ProcessRequest, signal?: AbortSignal) =>
  new Promise((resolve) => {
    const invocation = spawnCommand(request);
    const child = spawn(invocation.command, invocation.args, {
      cwd: request.cwd,
      env: { ...inheritedEnvironment(), ...request.env },
      stdio: ["ignore", request.output === "inherit" ? "inherit" : "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
      windowsVerbatimArguments: invocation.verbatim,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let timedOut = false;
    let receivedSignal: NodeJS.Signals | undefined;
    let escalationDeadline: number | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout;
    let removeAbortListener: () => void = () => undefined;
    const complete = (result: ProcessResult) => {
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      removeAbortListener();
      resolve(withReceivedSignal(result, receivedSignal));
    };
    // fallow-ignore-next-line complexity
    const finish = (result: ProcessResult) => {
      if (settled) return;
      if (processGroupAlive(child)) {
        escalationDeadline ??= Date.now() + 2_000;
        if (Date.now() >= escalationDeadline) {
          complete(result);
          return;
        }
        if (killTimer === undefined) {
          killTimer = setTimeout(() => {
            killTimer = undefined;
            scheduleProcessTreeKill(child, "SIGKILL", () => finish(result));
          }, 50);
        }
        return;
      }
      complete(result);
    };
    const onSignal = (signal: NodeJS.Signals) => {
      if (settled || receivedSignal !== undefined) return;
      receivedSignal = signal;
      escalationDeadline ??= Date.now() + 2_000;
      scheduleProcessTreeKill(child, signal, () => {
        if (settled) return;
        killTimer ??= setTimeout(() => {
          if (settled) return;
          scheduleProcessTreeKill(child, "SIGKILL", () => {
            if (settled) return;
            finish({ exitCode: signal === "SIGINT" ? 130 : 143 });
          });
        }, 1_000);
      });
    };
    const onInterrupt = () => onSignal("SIGINT");
    const onTerminate = () => onSignal("SIGTERM");
    const onAbort = () => onSignal("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    removeAbortListener = registerAbort(signal, onAbort);
    timer = setTimeout(() => {
      timedOut = true;
      escalationDeadline = Date.now() + 2_000;
      scheduleProcessTreeKill(child, "SIGTERM", () => {
        if (settled) return;
        killTimer = setTimeout(() => {
          if (settled) return;
          scheduleProcessTreeKill(child, "SIGKILL", () => {
            if (settled) return;
            finish({
              exitCode: 1,
              stdout: stdout.join(""),
              stderr: stderr.join(""),
              timedOut: true,
            });
          });
        }, 1_000);
      });
    }, request.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => collect(stdout, chunk));
    if (request.output === "stderr") child.stdout?.pipe(process.stderr);
    child.stderr?.on("data", (chunk: Buffer | string) => collect(stderr, chunk));
    if (request.output !== "capture") child.stderr?.pipe(process.stderr);
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

// fallow-ignore-next-line complexity
export const startLongLivedProcess: ProcessStarter = async (request, signal) => {
  const invocation = spawnCommand(request);
  const child = spawn(invocation.command, invocation.args, {
    cwd: request.cwd,
    env: { ...inheritedEnvironment(), ...request.env },
    stdio: [
      "ignore",
      request.output === "stderr" || request.output === "capture" ? "pipe" : "inherit",
      "pipe",
    ],
    detached: process.platform !== "win32",
    shell: false,
    windowsVerbatimArguments: invocation.verbatim,
  });
  let resolveExit!: (result: ProcessResult) => void;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exited = new Promise<ProcessResult>((resolve) => {
    resolveExit = resolve;
  });
  child.once("error", (error) =>
    resolveExit({ exitCode: 127, stdout: stdout.join(""), stderr: error.message }),
  );
  child.once("close", (code) =>
    resolveExit({ exitCode: code ?? 1, stdout: stdout.join(""), stderr: stderr.join("") }),
  );
  if (request.output === "stderr") child.stdout?.pipe(process.stderr);
  if (request.output === "capture") {
    child.stdout?.on("data", (chunk: Buffer | string) => collect(stdout, chunk));
  }
  child.stderr?.on("data", (chunk: Buffer | string) => collect(stderr, chunk));
  if (request.output !== "capture") child.stderr?.pipe(process.stderr);
  let removeAbortListener: () => void = () => undefined;
  let killPromise: Promise<void> | undefined;
  const killProcess = async () => {
    if (killPromise !== undefined) return killPromise;
    killPromise = (async () => {
      removeAbortListener();
      if (child.pid === undefined && child.exitCode === null) return;
      const firstTerminationSucceeded = await terminateProcessTree(child, "SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
      const processIsAlive =
        child.exitCode === null &&
        child.signalCode === null &&
        (process.platform === "win32" ? !firstTerminationSucceeded : processGroupAlive(child));
      if (processIsAlive) await terminateProcessTree(child, "SIGKILL");
      const terminated = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      if (!terminated)
        throw new Error("Fast process did not terminate within the shutdown deadline");
    })();
    return killPromise;
  };
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let startupAborted = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const rejectInterrupted = () =>
      finish(() => reject(new Error("Fast process startup was interrupted")));
    const rejectCleanupFailure = (error: unknown) =>
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    const cleanupThenReject = () =>
      void killProcess().then(rejectInterrupted, rejectCleanupFailure);
    const onSpawn = () => {
      child.off("error", onError);
      if (startupAborted) {
        cleanupThenReject();
      } else {
        finish(resolve);
      }
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      removeAbortListener();
      finish(() => reject(error));
    };
    const onAbort = () => {
      startupAborted = true;
      if (child.pid === undefined && child.exitCode === null) return;
      cleanupThenReject();
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    removeAbortListener = registerAbort(signal, onAbort);
  });
  return {
    pid: child.pid,
    exited,
    kill: killProcess,
  };
};
