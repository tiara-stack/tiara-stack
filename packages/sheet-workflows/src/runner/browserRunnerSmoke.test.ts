import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { waitForChildExit } from "../../browser-runner-smoke.mjs";

const spawnNode = (source: string) => spawn(process.execPath, ["-e", source], { stdio: "ignore" });

const waitForSpawn = (child: ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

const smokeScriptPath = fileURLToPath(new URL("../../browser-runner-smoke.mjs", import.meta.url));
const smokePackageRoot = fileURLToPath(new URL("../../", import.meta.url));

const controlledPlaywrightModule = `
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const record = (event) => appendFileSync(process.env.TIA_BROWSER_SMOKE_RECORD, event + String.fromCharCode(10));
const failure = process.env.TIA_BROWSER_SMOKE_FAILURE;
let navigationCount = 0;
let pageCount = 0;
const page = {
  goto: async (url) => {
    navigationCount += 1;
    record("page.goto");
    if (failure === "render" && navigationCount === 1) throw new Error("controlled render failure");
    if (url.startsWith("file:///missing-browser-runner-fixture.html")) throw new Error("controlled missing fixture");
  },
  locator: () => ({
    textContent: async () => "Controlled browser fixture",
    count: async () => 1,
    screenshot: async () => new Uint8Array([1]),
  }),
};
const context = {
  newPage: async () => {
    pageCount += 1;
    record("context.newPage");
    if (failure === "newPage" && pageCount === 1)
      throw new Error("controlled page creation failure");
    return page;
  },
  close: async () => {
    record("context.close");
    if (failure === "context-close") throw new Error("controlled context close failure");
  },
};
const browser = {
  newContext: async () => {
    record("browser.newContext");
    if (failure === "context") throw new Error("controlled context creation failure");
    return context;
  },
  close: async () => {
    record("browser.close");
    if (failure === "browser-close") throw new Error("controlled browser close failure");
  },
};

export const chromium = {
  launchServer: async () => {
    record("launchServer");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(process.env.TIA_BROWSER_SMOKE_CHILD_PID, String(child.pid));
    child.once("exit", (code, signal) => {
      record("child.exit");
      writeFileSync(process.env.TIA_BROWSER_SMOKE_CHILD_EXIT, JSON.stringify({ code, signal }));
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return {
      process: () => {
        record("server.process");
        if (failure === "process") throw new Error("controlled child acquisition failure");
        return child;
      },
      wsEndpoint: () => {
        record("server.wsEndpoint");
        if (failure === "endpoint") throw new Error("controlled endpoint failure");
        return "ws://127.0.0.1:1/controlled";
      },
      close: async () => {
        record("server.close");
        if (failure === "server-close") throw new Error("controlled server close failure");
        child.kill("SIGTERM");
        if (failure === "process")
          await new Promise((resolve) => child.once("exit", resolve));
      },
    };
  },
  connect: async () => {
    record("connect");
    if (failure === "connect") throw new Error("controlled CDP connection rejection");
    return browser;
  },
};
`;

const terminateRecordedChild = (pidPath: string) => {
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8"));
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The child may have exited between the marker check and kill request.
  }
};

const waitForFile = async (path: string, timeoutMillis: number) => {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return existsSync(path);
};

const runSmokeScenario = async (failure: string) => {
  const workspace = mkdtempSync(join(tmpdir(), "tia250-browser-smoke-lifecycle-"));
  const modulePath = join(workspace, "controlled-playwright.mjs");
  const recordPath = join(workspace, "events.log");
  const childPidPath = join(workspace, "child.pid");
  const childExitPath = join(workspace, "child.exit");
  writeFileSync(modulePath, controlledPlaywrightModule);
  const smoke = spawn(process.execPath, [smokeScriptPath], {
    cwd: smokePackageRoot,
    env: {
      TIA_BROWSER_SMOKE_PLAYWRIGHT_MODULE: modulePath,
      TIA_BROWSER_SMOKE_RECORD: recordPath,
      TIA_BROWSER_SMOKE_CHILD_PID: childPidPath,
      TIA_BROWSER_SMOKE_CHILD_EXIT: childExitPath,
      TIA_BROWSER_SMOKE_FAILURE: failure,
    },
    stdio: "ignore",
  });

  try {
    let smokeExit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | Error;
    try {
      smokeExit = await waitForChildExit(smoke, 3_000);
    } catch (error) {
      smokeExit = error instanceof Error ? error : new Error(String(error));
    }
    const childExited = await waitForFile(childExitPath, 1_000);
    const events = existsSync(recordPath)
      ? readFileSync(recordPath, "utf8").trim().split("\n")
      : [];
    return { smokeExit, childExited, events };
  } finally {
    terminateRecordedChild(childPidPath);
    if (smoke.exitCode === null && smoke.signalCode === null) {
      smoke.kill("SIGKILL");
      await waitForChildExit(smoke, 1_000);
    }
    rmSync(workspace, { recursive: true, force: true });
  }
};

it.live("cleans acquired smoke resources across startup, render, and shutdown failures", () =>
  Effect.promise(async () => {
    const cases = [
      {
        failure: "connect",
        exitCode: 1,
        acquiredAndClosed: [
          "launchServer",
          "server.process",
          "server.wsEndpoint",
          "connect",
          "server.close",
        ],
        notAcquired: ["browser.newContext", "context.close", "browser.close"],
      },
      {
        failure: "endpoint",
        exitCode: 1,
        acquiredAndClosed: ["launchServer", "server.process", "server.wsEndpoint", "server.close"],
        notAcquired: ["connect", "browser.newContext", "context.close", "browser.close"],
      },
      {
        failure: "process",
        exitCode: 1,
        acquiredAndClosed: ["launchServer", "server.process", "server.close"],
        notAcquired: ["connect", "context.close", "browser.close"],
      },
      {
        failure: "context",
        exitCode: 1,
        acquiredAndClosed: ["connect", "browser.newContext", "browser.close", "server.close"],
        notAcquired: ["context.close"],
      },
      {
        failure: "newPage",
        exitCode: 1,
        acquiredAndClosed: [
          "browser.newContext",
          "context.newPage",
          "context.close",
          "browser.close",
          "server.close",
        ],
        notAcquired: [],
      },
      {
        failure: "render",
        exitCode: 1,
        acquiredAndClosed: [
          "context.newPage",
          "page.goto",
          "context.close",
          "browser.close",
          "server.close",
        ],
        notAcquired: [],
      },
      {
        failure: "context-close",
        exitCode: 1,
        acquiredAndClosed: ["context.close", "browser.close", "server.close"],
        notAcquired: [],
      },
      {
        failure: "browser-close",
        exitCode: 1,
        acquiredAndClosed: ["context.close", "browser.close", "server.close"],
        notAcquired: [],
      },
      {
        failure: "server-close",
        exitCode: 1,
        acquiredAndClosed: ["context.close", "browser.close", "server.close"],
        notAcquired: [],
      },
      {
        failure: "success",
        exitCode: 0,
        acquiredAndClosed: ["context.close", "browser.close", "server.close"],
        notAcquired: [],
      },
    ] as const;

    for (const scenario of cases) {
      const result = await runSmokeScenario(scenario.failure);
      expect(result.smokeExit, scenario.failure).toEqual({ code: scenario.exitCode, signal: null });
      expect(result.childExited, scenario.failure).toBe(true);
      expect(result.events, scenario.failure).toContain("child.exit");
      for (const event of scenario.acquiredAndClosed)
        expect(result.events, scenario.failure).toContain(event);
      for (const event of scenario.notAcquired)
        expect(result.events, scenario.failure).not.toContain(event);
    }
  }),
);

it.live("waits for a normal smoke child exit", () =>
  Effect.promise(async () => {
    const child = spawnNode("process.exit(0)");
    const exit = await waitForChildExit(child, 1_000);
    expect(exit).toEqual({ code: 0, signal: null });
  }),
);

it.live("waits for signal-based child cessation", () =>
  Effect.promise(async () => {
    const child = spawnNode("setInterval(() => {}, 1000)");
    await waitForSpawn(child);
    child.kill("SIGTERM");
    const exit = await waitForChildExit(child, 1_000);
    expect(exit).toEqual({ code: null, signal: "SIGTERM" });
  }),
);

it.live("fails when a signaled smoke child remains alive past the bound", () =>
  Effect.promise(async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      const stdout = child.stdout;
      if (stdout === null) throw new Error("Still-live child stdout is unavailable");
      await new Promise<void>((resolve, reject) => {
        stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      child.kill("SIGTERM");
      let timeoutError: unknown;
      try {
        await waitForChildExit(child, 50);
      } catch (error) {
        timeoutError = error;
      }
      expect(timeoutError).toBeInstanceOf(Error);
      expect(String(timeoutError)).toContain("did not exit");
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForChildExit(child, 1_000);
    }
  }),
);
