import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { makeRetryablePromise, spawnProcess, startLongLivedProcess } from "./executor";

const requestForEnvironment = (environmentInheritance?: "standard" | "web-preview") => ({
  command: process.execPath,
  args: [
    "-e",
    "process.stdout.write(JSON.stringify({registry: process.env.NPM_CONFIG_REGISTRY, path: Boolean(process.env.PATH)}))",
  ],
  cwd: process.cwd(),
  env: {},
  ...(environmentInheritance === undefined ? {} : { environmentInheritance }),
  timeoutMs: 5_000,
  kind: "runtime" as const,
  readOnly: true,
  output: "capture" as const,
});

describe("process environment inheritance", () => {
  it.live("keeps registry configuration out of web preview children", () =>
    Effect.gen(function* () {
      const previousRegistry = process.env.NPM_CONFIG_REGISTRY;
      process.env.NPM_CONFIG_REGISTRY = "https://registry.example.test/token:secret";
      try {
        const standard = yield* Effect.promise(() => spawnProcess(requestForEnvironment()));
        const webPreview = yield* Effect.promise(() =>
          spawnProcess(requestForEnvironment("web-preview")),
        );

        expect(standard.exitCode).toBe(0);
        expect(JSON.parse(standard.stdout ?? "{}").registry).toBe(
          "https://registry.example.test/token:secret",
        );
        expect(webPreview.exitCode).toBe(0);
        expect(JSON.parse(webPreview.stdout ?? "{}")).toEqual({ path: true });
      } finally {
        if (previousRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY;
        else process.env.NPM_CONFIG_REGISTRY = previousRegistry;
      }
    }),
  );
});

it.live("kills a one-shot process group after its leader exits", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return;
    let processGroupId: number | undefined;
    try {
      const result = yield* Effect.promise(() =>
        spawnProcess({
          command: process.execPath,
          args: [
            "-e",
            `const { spawn } = require("node:child_process"); const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); descendant.once("spawn", () => { process.stdout.write(String(process.pid)); setTimeout(() => process.exit(0), 50); });`,
          ],
          cwd: process.cwd(),
          env: {},
          timeoutMs: 5_000,
          kind: "runtime",
          readOnly: false,
          output: "capture",
        }),
      );
      const parsedProcessGroupId = Number(result.stdout);
      if (!Number.isSafeInteger(parsedProcessGroupId) || parsedProcessGroupId <= 0)
        return yield* Effect.fail(new Error("one-shot process group ID was not captured"));
      processGroupId = parsedProcessGroupId;
      expect(result.exitCode).toBe(0);
      expect(Number.isSafeInteger(processGroupId)).toBe(true);
      let groupAlive = false;
      try {
        process.kill(-processGroupId, 0);
        groupAlive = true;
      } catch (error) {
        groupAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      expect(groupAlive).toBe(false);
    } finally {
      if (processGroupId !== undefined) {
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch {
          // The process group has already exited.
        }
      }
    }
  }),
);

it.live("keeps process-group cleanup blocked when its leader exits before descendants", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return;
    const child = yield* Effect.promise(() =>
      startLongLivedProcess({
        command: process.execPath,
        args: [
          "-e",
          'const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); setTimeout(() => process.exit(0), 100);',
        ],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 2_147_483_647,
        kind: "runtime",
        readOnly: false,
        output: "inherit",
      }),
    );
    const processGroupId = child.processGroupId;
    expect(processGroupId).toBeDefined();
    try {
      yield* Effect.promise(() => child.exited);
      expect(() => process.kill(-processGroupId!, 0)).not.toThrow();

      const cleanup = yield* Effect.exit(Effect.promise(() => child.kill()));
      expect(cleanup._tag).toBe("Failure");
      expect(() => process.kill(-processGroupId!, 0)).not.toThrow();
    } finally {
      if (processGroupId !== undefined) {
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch {
          // The process group has already exited.
        }
      }
    }
  }),
);

it.live("waits for a signaled process group after its leader exits", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return;
    const directory = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "tiara-preview-")));
    const readyFile = path.join(directory, "descendant-ready");
    let processGroupId: number | undefined;
    try {
      const child = yield* Effect.promise(() =>
        startLongLivedProcess({
          command: process.execPath,
          args: [
            "-e",
            `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "const { writeFileSync } = require('node:fs'); process.on('SIGTERM', () => setTimeout(() => process.exit(0), 750)); writeFileSync(process.env.TIARA_TEST_READY_FILE, 'ready'); setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);`,
          ],
          cwd: process.cwd(),
          env: { TIARA_TEST_READY_FILE: readyFile },
          timeoutMs: 2_147_483_647,
          kind: "runtime",
          readOnly: false,
          output: "inherit",
        }),
      );
      processGroupId = child.processGroupId;
      expect(processGroupId).toBeDefined();
      const descendantStarted = yield* Effect.tryPromise({
        try: async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            try {
              await readFile(readyFile, "utf8");
              return true;
            } catch {
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
            }
          }
          return false;
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      expect(descendantStarted).toBe(true);

      yield* Effect.promise(() => child.kill());

      let groupAlive = true;
      try {
        process.kill(-processGroupId!, 0);
      } catch (error) {
        groupAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      expect(groupAlive).toBe(false);
    } finally {
      if (processGroupId !== undefined) {
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch {
          // The process group has already exited.
        }
      }
      yield* Effect.promise(() => rm(directory, { recursive: true, force: true }));
    }
  }),
);

it.live("does not signal a process group after the leader and group have exited", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return;
    const child = yield* Effect.promise(() =>
      startLongLivedProcess({
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 50)"],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 2_147_483_647,
        kind: "runtime",
        readOnly: false,
        output: "inherit",
      }),
    );
    const processGroupId = child.processGroupId;
    expect(processGroupId).toBeDefined();
    if (processGroupId === undefined) return;
    yield* Effect.promise(() => child.exited);

    const originalKill = process.kill.bind(process);
    const signals: NodeJS.Signals[] = [];
    process.kill = ((pid: number, signal?: NodeJS.Signals | number | null) => {
      if (pid === -processGroupId && signal !== undefined && signal !== null && signal !== 0)
        signals.push(String(signal) as NodeJS.Signals);
      return signal === undefined || signal === null
        ? originalKill(pid)
        : originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      yield* Effect.promise(() => child.kill());
      expect(signals).toEqual([]);
      expect(() => originalKill(-processGroupId!, 0)).toThrow();
    } finally {
      process.kill = originalKill;
    }
  }),
);

it.live("blocks cleanup of an exited Windows child while descendants may remain", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return;
    let processGroupId: number | undefined;
    const child = yield* Effect.promise(() =>
      startLongLivedProcess({
        command: process.execPath,
        args: [
          "-e",
          'const { spawn } = require("node:child_process"); const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); descendant.once("spawn", () => setTimeout(() => process.exit(0), 50));',
        ],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 2_147_483_647,
        kind: "runtime",
        readOnly: false,
        output: "inherit",
      }),
    );
    processGroupId = child.processGroupId;
    expect(processGroupId).toBeDefined();
    if (processGroupId === undefined) return;
    try {
      yield* Effect.promise(() => child.exited);
      expect(() => process.kill(-processGroupId!, 0)).not.toThrow();
      const posixCleanup = yield* Effect.exit(Effect.promise(() => child.kill()));
      expect(posixCleanup._tag).toBe("Failure");
      expect(() => process.kill(-processGroupId!, 0)).not.toThrow();

      const platform = Object.getOwnPropertyDescriptor(process, "platform");
      if (platform === undefined)
        return yield* Effect.fail(new Error("process platform unavailable"));
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      try {
        // The live descendant keeps the POSIX group present. Without the simulated Windows
        // guard, cleanup would fail closed because the exited leader no longer owns the group.
        // Windows must also fail closed because it cannot verify descendant cessation here.
        const windowsCleanup = yield* Effect.exit(Effect.promise(() => child.kill()));
        expect(windowsCleanup._tag).toBe("Failure");
        expect(() => process.kill(-processGroupId!, 0)).not.toThrow();
      } finally {
        Object.defineProperty(process, "platform", platform);
      }
    } finally {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // The process group has already exited.
      }
    }
  }),
);

it("coalesces an in-flight operation and retries after rejection", async () => {
  let attempts = 0;
  let rejectFirstAttempt: ((reason: Error) => void) | undefined;
  const operation = makeRetryablePromise(() => {
    attempts += 1;
    if (attempts > 1) return Promise.resolve("stopped");
    return new Promise<string>((_resolve, reject) => {
      rejectFirstAttempt = reject;
    });
  });

  const firstAttempt = operation();
  expect(operation()).toBe(firstAttempt);
  const firstFailure = new Error("cleanup was temporarily unavailable");
  rejectFirstAttempt?.(firstFailure);
  expect(
    await firstAttempt.then(
      () => undefined,
      (error: unknown) => error,
    ),
  ).toBe(firstFailure);

  const retry = operation();
  expect(retry).not.toBe(firstAttempt);
  expect(await retry).toBe("stopped");
  expect(operation()).toBe(retry);
  expect(attempts).toBe(2);
});
