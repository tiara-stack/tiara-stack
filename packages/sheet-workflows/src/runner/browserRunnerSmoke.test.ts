import { spawn, type ChildProcess } from "node:child_process";
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
