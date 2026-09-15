import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  executeFast,
  makeFastExecutionContext,
  type FastExecutionContext,
  type LifecycleObservation,
} from "./execution";
import type { LauncherOutput, ProcessStarter, RunningProcess } from "./types";

const plannedOutput = (
  service: string,
  environment: Readonly<Record<string, string>> = {},
): LauncherOutput => ({
  schemaVersion: 3,
  ok: true,
  command: "fast up",
  mode: "fast",
  action: "up",
  selectedServices: [service],
  checkoutState: null,
  plannedProcesses: [
    {
      id: service,
      packageName: service,
      command: service === "sheet-web" ? "vp" : "pnpm",
      args: service === "sheet-web" ? ["dev", "--port", "3001"] : ["exec", "tsx", "watch"],
      environment,
      longLived: true,
      readOnly: false,
    },
  ],
  urls:
    service === "sheet-web"
      ? [
          { name: "app", url: "http://localhost:3001" },
          { name: "auth", url: "https://auth.dev.theerapakg.moe" },
          { name: "zero", url: "https://zero.dev.theerapakg.moe" },
          { name: "workflows", url: "https://workflows.dev.theerapakg.moe" },
        ]
      : [{ name: service, url: "http://localhost:3002" }],
  readiness: "planned",
  warnings: [],
  errors: [],
  changedSurfaces: [],
  parityGates: [],
});

const webContext = (output = plannedOutput("sheet-web")): FastExecutionContext =>
  makeFastExecutionContext(output, "/checkout", {
    dependencyTimeoutMs: 10,
    startupTimeoutMs: 10,
    readinessTimeoutMs: 5_000,
    pollIntervalMs: 0,
  });

const interruption = () => {
  let resolve!: (signal: NodeJS.Signals) => void;
  const promise = new Promise<NodeJS.Signals>((resolver) => {
    resolve = resolver;
  });
  return { effect: Effect.promise(() => promise), resolve };
};

const deferredExit = () => {
  let resolve!: (result: { readonly exitCode: number }) => void;
  const promise = new Promise<{ readonly exitCode: number }>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
};

const resolveExitWhenReady =
  (processExit: ReturnType<typeof deferredExit>, exitCode: number) =>
  (observation: LifecycleObservation) => {
    if (observation.type === "readiness" && observation.status === "ready") {
      processExit.resolve({ exitCode });
    }
  };

const runningProcess = (exited: Promise<{ readonly exitCode: number }>): RunningProcess => ({
  pid: 42,
  exited,
  kill: async () => undefined,
});

describe("Fast execution seam", () => {
  it.live("requires a live process and only accepts a GET /ready 2xx response", () =>
    Effect.gen(function* () {
      const statuses = [401, 403, 404, 503, 204];
      const requests: string[] = [];
      const processExit = deferredExit();
      let killed = 0;
      const stop = interruption();
      const result = yield* executeFast(webContext(), {
        interruptions: stop.effect,
        accessChecker: async () => ({ reachable: true, status: 204 }),
        readinessChecker: async (request) => {
          requests.push(request.origin);
          const status = statuses.shift() ?? 204;
          return { reachable: status >= 200 && status < 300, status };
        },
        processStarter: async () => ({
          pid: 42,
          exited: processExit.promise,
          kill: async () => {
            killed += 1;
            processExit.resolve({ exitCode: 143 });
          },
        }),
        onObservation: (observation) => {
          if (observation.type === "readiness" && observation.status === "ready") {
            setTimeout(() => stop.resolve("SIGINT"), 0);
          }
        },
      });
      expect(requests).toEqual([
        "http://localhost:3001/ready",
        "http://localhost:3001/ready",
        "http://localhost:3001/ready",
        "http://localhost:3001/ready",
        "http://localhost:3001/ready",
      ]);
      expect(result.observations.map(({ type }) => type)).toContain("readiness");
      expect(result.observations.find((observation) => observation.type === "readiness")).toEqual(
        expect.objectContaining({ type: "readiness", status: "ready", responseStatus: 204 }),
      );
      expect(result.output.readiness).toBe("ready");
      expect(result.outcome.status).toBe("stopped");
      expect(killed).toBe(1);
    }),
  );

  it.live("turns a bounded startup timeout into a blocked terminal outcome", () =>
    Effect.gen(function* () {
      let aborted = false;
      const result = yield* executeFast(webContext(), {
        interruptions: Effect.never,
        accessChecker: async () => ({ reachable: true, status: 204 }),
        processStarter: async (_request, signal) =>
          new Promise<RunningProcess>(() => {
            signal?.addEventListener("abort", () => {
              aborted = true;
            });
          }),
      });

      expect(aborted).toBe(true);
      expect(result.outcome.status).toBe("blocked");
      expect(result.outcome.diagnostic?.code).toBe("dependency-timeout");
      expect(result.output.readiness).toBe("blocked");
    }),
  );

  it.live("blocks when the selected process exits before readiness, including exit zero", () =>
    Effect.gen(function* () {
      let started = 0;
      const result = yield* executeFast(webContext(), {
        interruptions: Effect.never,
        accessChecker: async () => ({ reachable: true, status: 204 }),
        readinessChecker: async () => ({ reachable: true, status: 204 }),
        processStarter: (async () => {
          started += 1;
          return runningProcess(Promise.resolve({ exitCode: 0 }));
        }) satisfies ProcessStarter,
      });

      expect(started).toBe(1);
      expect(result.outcome.status).toBe("blocked");
      expect(result.output.readiness).toBe("blocked");
      expect(result.outcome.diagnostic?.message).toContain("before becoming ready");
    }),
  );

  it.live("treats an exit at the readiness boundary as a startup failure", () =>
    Effect.gen(function* () {
      const processExit = deferredExit();
      const result = yield* executeFast(webContext(), {
        interruptions: Effect.never,
        accessChecker: async () => ({ reachable: true, status: 204 }),
        readinessChecker: async () => {
          queueMicrotask(() => processExit.resolve({ exitCode: 0 }));
          return { reachable: true, status: 204 };
        },
        processStarter: async () => ({
          pid: 42,
          exited: processExit.promise,
          kill: async () => undefined,
        }),
      });

      expect(result.output.readiness).toBe("blocked");
      expect(result.outcome.status).toBe("blocked");
      expect(result.observations).toContainEqual(
        expect.objectContaining({ type: "exited", phase: "startup", exitCode: 0 }),
      );
      expect(result.observations).not.toContainEqual(
        expect.objectContaining({ type: "readiness", status: "ready" }),
      );
    }),
  );

  it.live("does not start the selected process after a required prerequisite fails", () =>
    Effect.gen(function* () {
      let started = 0;
      const result = yield* executeFast(webContext(), {
        interruptions: Effect.never,
        accessChecker: async (request) =>
          request.dependency === "zero"
            ? { reachable: false, status: 503 }
            : { reachable: true, status: 204 },
        processStarter: async () => {
          started += 1;
          return runningProcess(Promise.resolve({ exitCode: 0 }));
        },
      });

      expect(started).toBe(0);
      expect(result.outcome.status).toBe("blocked");
      expect(result.output.errors[0]?.dependency).toBe("zero");
    }),
  );

  it.live("uses strict GET readiness checks for backend readiness prerequisites", () =>
    Effect.gen(function* () {
      const output = plannedOutput("sheet-db-server", {
        POSTGRES_URL: "postgres://localhost:5432/tiara",
        SHEET_AUTH_ISSUER: "http://localhost:3002",
      });
      const context = makeFastExecutionContext(output, "/checkout", {
        dependencyTimeoutMs: 10,
        startupTimeoutMs: 10,
        readinessTimeoutMs: 10,
        pollIntervalMs: 0,
      });
      const accessDependencies: string[] = [];
      const readinessDependencies: string[] = [];
      let started = false;
      const result = yield* executeFast(context, {
        interruptions: Effect.never,
        accessChecker: async (request) => {
          accessDependencies.push(request.dependency);
          return { reachable: true, status: 204 };
        },
        readinessChecker: async (request) => {
          readinessDependencies.push(request.dependency);
          return { reachable: false, status: 401 };
        },
        tcpAccessChecker: async () => ({ reachable: true }),
        processStarter: async () => {
          started = true;
          return runningProcess(Promise.resolve({ exitCode: 0 }));
        },
      });

      expect(accessDependencies).toEqual([]);
      expect(readinessDependencies).toEqual(["sheet-auth"]);
      expect(started).toBe(false);
      expect(result.outcome.status).toBe("blocked");
    }),
  );

  it.live("keeps owning a ready process and reports a later nonzero exit after cleanup", () =>
    Effect.gen(function* () {
      const processExit = deferredExit();
      let killed = 0;
      const result = yield* executeFast(webContext(), {
        interruptions: Effect.never,
        accessChecker: async () => ({ reachable: true, status: 204 }),
        readinessChecker: async () => ({ reachable: true, status: 204 }),
        onObservation: resolveExitWhenReady(processExit, 17),
        processStarter: async () => ({
          pid: 42,
          exited: processExit.promise,
          kill: async () => {
            killed += 1;
          },
        }),
      });

      expect(result.outcome.status).toBe("failed");
      expect(result.outcome.exitCode).toBe(17);
      expect(result.readyOutput?.readiness).toBe("ready");
      expect(result.outcome.diagnostic?.message).toContain("after becoming ready");
      expect(killed).toBe(1);
    }),
  );

  it.live("runs cleanup exactly once when startup is interrupted", () =>
    Effect.gen(function* () {
      const stop = interruption();
      let killed = 0;
      const result = yield* executeFast(webContext(), {
        interruptions: stop.effect,
        accessChecker: async () => ({ reachable: true, status: 204 }),
        readinessChecker: async () => ({ reachable: false, status: 503 }),
        processStarter: async () => ({
          pid: 42,
          exited: new Promise(() => undefined),
          kill: async () => {
            killed += 1;
          },
        }),
        onObservation: (observation) => {
          if (observation.type === "started") stop.resolve("SIGTERM");
        },
      });

      expect(result.outcome.status).toBe("stopped");
      expect(result.outcome.exitCode).toBe(143);
      expect(killed).toBe(1);
      expect(result.observations.filter(({ type }) => type === "cleanup")).toHaveLength(2);
    }),
  );

  // fallow-ignore-next-line code-duplication
  it.live("keeps the process failure primary when cleanup also fails", () =>
    Effect.gen(function* () {
      const processExit = deferredExit();
      const result = yield* executeFast(webContext(), {
        interruptions: Effect.never,
        accessChecker: async () => ({ reachable: true, status: 204 }),
        readinessChecker: async () => ({ reachable: true, status: 204 }),
        onObservation: resolveExitWhenReady(processExit, 23),
        cleanupTimeoutMs: 10,
        processStarter: async () => ({
          pid: 42,
          exited: processExit.promise,
          kill: async () => {
            throw new Error("cannot terminate");
          },
        }),
      });

      expect(result.outcome.status).toBe("failed");
      expect(result.outcome.diagnostic?.message).toContain("after becoming ready");
      expect(result.outcome.cleanupDiagnostic?.code).toBe("cleanup-failed");
      expect(result.output.errors.map(({ code }) => code)).toEqual([
        "required-dependency-failed",
        "cleanup-failed",
      ]);
    }),
  );
});
