import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  executeFast,
  executeCompose,
  makeComposeExecutionContext as makeComposeContext,
  makeComposeStateAdapter,
  makeFastExecutionContext,
  type ComposeContainerState,
  type ComposeStateAdapter,
  type FastExecutionContext,
  type ComposeExecutionContext,
  type ComposeExecutionContextOptions,
  type LifecycleObservation,
} from "./execution";
import type {
  ComposeService,
  LauncherOutput,
  ProcessExecutor,
  ProcessStarter,
  RunningProcess,
} from "./types";

const makeComposeExecutionContext = (
  output: LauncherOutput,
  cwd: string,
  options: Omit<ComposeExecutionContextOptions, "environment"> = {},
) => makeComposeContext(output, cwd, { ...options, environment: {} });

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

const composeOutput = (
  action: "build" | "down" | "seed" | "reset" | "up",
  plannedProcesses: readonly LauncherOutput["plannedProcesses"][number][],
  services: readonly ComposeService[] = ["sheet-auth", "sheet-web"],
): LauncherOutput => ({
  schemaVersion: 3,
  ok: true,
  command: `compose ${action}`,
  mode: "compose",
  action,
  selectedServices: services,
  checkoutState: "Checkout State tiara-test-123",
  plannedProcesses,
  urls: [
    { name: "app", url: "http://localhost:3001" },
    { name: "auth", url: "http://localhost:3002" },
    { name: "zero", url: "http://localhost:4848" },
    { name: "workflows", url: "http://localhost:3003" },
  ],
  readiness: "planned",
  warnings: [],
  errors: [],
  changedSurfaces: [],
  parityGates: [],
});

const composeUpOutput = (): LauncherOutput =>
  composeOutput("up", [
    {
      id: "compose-docker-check",
      packageName: null,
      command: "docker",
      args: ["version"],
      environment: {},
      longLived: false,
      readOnly: true,
    },
    {
      id: "compose-dependencies",
      packageName: null,
      command: "docker",
      args: ["compose", "--project-name", "tiara-test-123", "up", "-d", "postgres", "redis"],
      environment: {},
      longLived: false,
      readOnly: false,
    },
    {
      id: "compose-migrations",
      packageName: null,
      command: "pnpm",
      args: ["compose:migrate-sheet-db", "--", "--env-file", "/checkout/compose.env"],
      environment: {},
      longLived: false,
      readOnly: false,
    },
    {
      id: "compose-applications",
      packageName: null,
      command: "docker",
      args: [
        "compose",
        "--project-name",
        "tiara-test-123",
        "up",
        "--no-build",
        "sheet-auth",
        "sheet-web",
      ],
      environment: {},
      longLived: true,
      readOnly: false,
    },
  ]);

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

describe("Compose execution seam", () => {
  it.effect(
    "runs finite Compose actions in plan order and completes without implicit cleanup",
    () =>
      Effect.gen(function* () {
        const requests: Parameters<ProcessExecutor>[0][] = [];
        const output = composeOutput("build", [
          {
            id: "compose-build-artifact-sheet-auth",
            packageName: "sheet-auth",
            command: "pnpm",
            args: ["--filter", "sheet-auth", "build"],
            environment: {},
            longLived: false,
            readOnly: false,
          },
          {
            id: "compose-build-artifact-sheet-web",
            packageName: "sheet-web",
            command: "pnpm",
            args: ["--filter", "sheet-web", "build"],
            environment: {},
            longLived: false,
            readOnly: false,
          },
          {
            id: "compose-build",
            packageName: null,
            command: "docker",
            args: ["compose", "--project-name", "tiara-test-123", "build"],
            environment: {},
            longLived: false,
            readOnly: false,
          },
        ]);
        const context: ComposeExecutionContext = makeComposeExecutionContext(output, "/checkout", {
          finiteTimeoutMs: 10,
        });

        const result = yield* executeCompose(context, {
          interruptions: Effect.never,
          executor: async (request) => {
            requests.push(request);
            return { exitCode: 0 };
          },
        });

        expect(requests.map(({ args }) => args)).toEqual([
          ["--filter", "sheet-auth", "build"],
          ["--filter", "sheet-web", "build"],
          ["compose", "--project-name", "tiara-test-123", "build"],
        ]);
        expect(result.outcome).toEqual(
          expect.objectContaining({ status: "completed", exitCode: 0 }),
        );
        expect(result.output.readiness).toBe("completed");
        expect(result.observations.at(-1)).toEqual(
          expect.objectContaining({ type: "terminal", outcome: "completed" }),
        );
      }),
  );

  it.live("waits for every selected container's internal GET /ready before reporting ready", () =>
    Effect.gen(function* () {
      const output = composeUpOutput();
      const context = makeComposeExecutionContext(output, "/checkout", {
        startupTimeoutMs: 10,
        readinessTimeoutMs: 100,
        pollIntervalMs: 0,
      });
      const processExit = deferredExit();
      const stop = interruption();
      const finiteRequests: Parameters<ProcessExecutor>[0][] = [];
      const probes: string[] = [];
      const stopped: string[][] = [];
      let stateCalls = 0;
      const containers: readonly ComposeContainerState[] = [
        { id: "auth-container", service: "sheet-auth", state: "running" },
        { id: "web-container", service: "sheet-web", state: "running" },
      ];
      const stateAdapter: ComposeStateAdapter = {
        listApplicationContainers: async () => {
          stateCalls += 1;
          return stateCalls === 1 ? [] : containers;
        },
        probeApplicationReadiness: async ({ service, container }) => {
          probes.push(`${service}:${container.id}`);
          return service === "sheet-web" &&
            probes.filter((probe) => probe.startsWith("sheet-web:")).length === 1
            ? { reachable: false, status: 503 }
            : { reachable: true, status: 204 };
        },
        stopApplicationContainers: async ({ containers: owned }) => {
          stopped.push(owned.map(({ id }) => id));
          return { verified: true, remaining: [] };
        },
      };
      const result = yield* executeCompose(context, {
        interruptions: stop.effect,
        executor: async (request) => {
          finiteRequests.push(request);
          return { exitCode: 0 };
        },
        stateAdapter,
        processStarter: async () => ({
          pid: 42,
          exited: processExit.promise,
          kill: async () => processExit.resolve({ exitCode: 143 }),
        }),
        onObservation: (observation) => {
          if (
            observation.type === "readiness" &&
            observation.status === "ready" &&
            observation.allSelected
          ) {
            stop.resolve("SIGINT");
          }
        },
        output: "stderr",
      });

      expect(finiteRequests.map(({ args }) => args)).toEqual([
        ["version"],
        ["compose", "--project-name", "tiara-test-123", "up", "-d", "postgres", "redis"],
        ["compose:migrate-sheet-db", "--", "--env-file", "/checkout/compose.env"],
      ]);
      expect(probes).toEqual([
        "sheet-auth:auth-container",
        "sheet-web:web-container",
        "sheet-web:web-container",
      ]);
      expect(result.readyOutput?.readiness).toBe("ready");
      expect(result.output.readiness).toBe("ready");
      expect(result.outcome).toEqual(expect.objectContaining({ status: "stopped", exitCode: 130 }));
      expect(stopped).toEqual([["auth-container", "web-container"]]);
    }),
  );

  it.live("reprobes readiness when a Compose container changes identity or state", () =>
    Effect.gen(function* () {
      const output = {
        ...composeUpOutput(),
        selectedServices: ["sheet-auth", "sheet-web"] as const,
      };
      const context = makeComposeExecutionContext(output, "/checkout", {
        readinessTimeoutMs: 100,
        pollIntervalMs: 0,
      });
      const processExit = deferredExit();
      const oldAuth = { id: "old-auth", service: "sheet-auth", state: "running" } as const;
      const newAuth = { id: "new-auth", service: "sheet-auth", state: "restarting" } as const;
      const web = { id: "web-container", service: "sheet-web", state: "running" } as const;
      const probes: string[] = [];
      let stateCalls = 0;
      const result = yield* executeCompose(context, {
        interruptions: Effect.never,
        executor: async () => ({ exitCode: 0 }),
        processStarter: async () => ({
          pid: 42,
          exited: processExit.promise,
          kill: async () => processExit.resolve({ exitCode: 143 }),
        }),
        stateAdapter: {
          listApplicationContainers: async () => {
            stateCalls += 1;
            if (stateCalls <= 1) return [];
            if (stateCalls <= 3) return [oldAuth, web];
            return [newAuth, web];
          },
          probeApplicationReadiness: async ({ container }) => {
            probes.push(container.id);
            if (container.id === "old-auth") return { reachable: true, status: 204 };
            if (container.id === "new-auth") {
              return probes.filter((id) => id === "new-auth").length === 1
                ? { reachable: false, status: 503 }
                : { reachable: true, status: 204 };
            }
            return probes.filter((id) => id === "web-container").length === 1
              ? { reachable: false, status: 503 }
              : { reachable: true, status: 204 };
          },
          stopApplicationContainers: async () => ({ verified: true, remaining: [] }),
        },
        onObservation: (observation) => {
          if (
            observation.type === "readiness" &&
            observation.status === "ready" &&
            observation.allSelected
          ) {
            processExit.resolve({ exitCode: 143 });
          }
        },
      });

      expect(result.outcome.status).toBe("failed");
      expect(probes).toEqual([
        "old-auth",
        "web-container",
        "new-auth",
        "web-container",
        "new-auth",
      ]);
    }),
  );

  it.effect("blocks every later Compose step when migration fails", () =>
    Effect.gen(function* () {
      const requests: Parameters<ProcessExecutor>[0][] = [];
      let started = 0;
      let cleaned = 0;
      const output = composeUpOutput();
      const context = makeComposeExecutionContext(output, "/checkout", {
        finiteTimeoutMs: 10,
      });
      const result = yield* executeCompose(context, {
        interruptions: Effect.never,
        executor: async (request) => {
          requests.push(request);
          return request.command === "pnpm"
            ? { exitCode: 7, stderr: "migration failed" }
            : { exitCode: 0 };
        },
        processStarter: async () => {
          started += 1;
          return runningProcess(Promise.resolve({ exitCode: 0 }));
        },
        stateAdapter: {
          listApplicationContainers: async () => [],
          probeApplicationReadiness: async () => ({ reachable: false, status: 503 }),
          stopApplicationContainers: async () => {
            cleaned += 1;
            return { verified: true, remaining: [] };
          },
        },
      });

      expect(requests.map(({ command, args }) => [command, ...args])).toEqual([
        ["docker", "version"],
        ["docker", "compose", "--project-name", "tiara-test-123", "up", "-d", "postgres", "redis"],
        ["pnpm", "compose:migrate-sheet-db", "--", "--env-file", "/checkout/compose.env"],
      ]);
      expect(started).toBe(0);
      expect(cleaned).toBe(0);
      expect(result.outcome.status).toBe("blocked");
      expect(result.outcome.diagnostic?.dependency).toBe("compose-migrations");
      expect(result.observations).not.toContainEqual(
        expect.objectContaining({ type: "step", id: "compose-applications" }),
      );
    }),
  );

  it.live("cleans tracked application containers after partial startup", () =>
    Effect.gen(function* () {
      const processExit = deferredExit();
      const containers: readonly ComposeContainerState[] = [
        { id: "auth-container", service: "sheet-auth", state: "running" },
        { id: "web-container", service: "sheet-web", state: "exited", exitCode: 9 },
      ];
      const stopped: string[][] = [];
      let stateCalls = 0;
      const output = composeUpOutput();
      const context = makeComposeExecutionContext(output, "/checkout", {
        readinessTimeoutMs: 100,
        pollIntervalMs: 0,
      });
      const result = yield* executeCompose(context, {
        interruptions: Effect.never,
        executor: async () => ({ exitCode: 0 }),
        processStarter: async () => ({
          pid: 42,
          exited: processExit.promise,
          kill: async () => processExit.resolve({ exitCode: 143 }),
        }),
        stateAdapter: {
          listApplicationContainers: async () => {
            stateCalls += 1;
            return stateCalls === 1 ? [] : containers;
          },
          probeApplicationReadiness: async () => ({ reachable: false, status: 503 }),
          stopApplicationContainers: async ({ containers: owned }) => {
            stopped.push(owned.map(({ id }) => id));
            return { verified: true, remaining: [] };
          },
        },
      });

      expect(result.outcome.status).toBe("blocked");
      expect(result.outcome.diagnostic?.message).toContain("before becoming ready");
      expect(stopped).toEqual([["auth-container", "web-container"]]);
      expect(result.observations.filter(({ type }) => type === "cleanup")).toHaveLength(2);
    }),
  );

  it.live("keeps the startup failure primary when Compose cleanup cannot verify termination", () =>
    Effect.gen(function* () {
      const containers: readonly ComposeContainerState[] = [
        { id: "web-container", service: "sheet-web", state: "running" },
      ];
      const output = composeUpOutput();
      const context = makeComposeExecutionContext(output, "/checkout", {
        readinessTimeoutMs: 100,
        pollIntervalMs: 0,
      });
      let stateCalls = 0;
      const result = yield* executeCompose(context, {
        interruptions: Effect.never,
        executor: async () => ({ exitCode: 0 }),
        processStarter: async () => runningProcess(new Promise(() => undefined)),
        stateAdapter: {
          listApplicationContainers: async () => {
            stateCalls += 1;
            return stateCalls === 1 ? [] : containers;
          },
          probeApplicationReadiness: async () => ({ reachable: false, status: 503 }),
          stopApplicationContainers: async () => ({
            verified: false,
            remaining: containers,
            reason: "application containers are still running",
          }),
        },
      });

      expect(result.outcome.status).toBe("blocked");
      expect(result.outcome.diagnostic?.code).toBe("dependency-timeout");
      expect(result.outcome.cleanupDiagnostic?.code).toBe("cleanup-failed");
      expect(result.output.errors.map(({ code }) => code)).toEqual([
        "dependency-timeout",
        "cleanup-failed",
      ]);
    }),
  );

  it.live("does not stop a pre-existing application container from another invocation", () =>
    Effect.gen(function* () {
      const output = { ...composeUpOutput(), selectedServices: ["sheet-web"] as const };
      const context = makeComposeExecutionContext(output, "/checkout", {
        readinessTimeoutMs: 100,
        pollIntervalMs: 0,
      });
      const processExit = deferredExit();
      const existing = { id: "existing-web", service: "sheet-web", state: "running" } as const;
      const started = { id: "new-web", service: "sheet-web", state: "running" } as const;
      let stateCalls = 0;
      const stopped: string[][] = [];
      const result = yield* executeCompose(context, {
        interruptions: Effect.never,
        executor: async () => ({ exitCode: 0 }),
        processStarter: async () => ({
          pid: 42,
          exited: processExit.promise,
          kill: async () => processExit.resolve({ exitCode: 143 }),
        }),
        stateAdapter: {
          listApplicationContainers: async () => {
            stateCalls += 1;
            return stateCalls === 1 ? [existing] : [existing, started];
          },
          probeApplicationReadiness: async () => ({ reachable: true, status: 200 }),
          stopApplicationContainers: async ({ containers }) => {
            stopped.push(containers.map(({ id }) => id));
            return { verified: true, remaining: [] };
          },
        },
        onObservation: (observation) => {
          if (
            observation.type === "readiness" &&
            observation.status === "ready" &&
            observation.allSelected
          ) {
            processExit.resolve({ exitCode: 0 });
          }
        },
      });

      expect(result.outcome.status).toBe("completed");
      expect(stopped).toEqual([["new-web"]]);
    }),
  );

  it.live("cleans containers created before an application starter times out", () =>
    Effect.gen(function* () {
      const output = { ...composeUpOutput(), selectedServices: ["sheet-web"] as const };
      const context = makeComposeExecutionContext(output, "/checkout", {
        startupTimeoutMs: 10,
        readinessTimeoutMs: 100,
        pollIntervalMs: 0,
      });
      const created = { id: "created-web", service: "sheet-web", state: "running" } as const;
      let stateCalls = 0;
      const stopped: string[][] = [];
      const result = yield* executeCompose(context, {
        interruptions: Effect.never,
        executor: async () => ({ exitCode: 0 }),
        processStarter: async (_request, signal) =>
          new Promise<RunningProcess>(() => {
            signal?.addEventListener("abort", () => undefined);
          }),
        stateAdapter: {
          listApplicationContainers: async () => {
            stateCalls += 1;
            return stateCalls === 1 ? [] : [created];
          },
          probeApplicationReadiness: async () => ({ reachable: false, status: 503 }),
          stopApplicationContainers: async ({ containers }) => {
            stopped.push(containers.map(({ id }) => id));
            return { verified: true, remaining: [] };
          },
        },
      });

      expect(result.outcome.status).toBe("blocked");
      expect(result.outcome.diagnostic?.code).toBe("dependency-timeout");
      expect(stopped).toEqual([["created-web"]]);
    }),
  );

  it.live(
    "does not stop an existing container when cancellation interrupts application startup",
    () =>
      Effect.gen(function* () {
        const output = { ...composeUpOutput(), selectedServices: ["sheet-web"] as const };
        const context = makeComposeExecutionContext(output, "/checkout", {
          startupTimeoutMs: 100,
          readinessTimeoutMs: 100,
          pollIntervalMs: 0,
        });
        const stop = interruption();
        const existing = { id: "existing-web", service: "sheet-web", state: "running" } as const;
        const stopped: string[][] = [];
        const result = yield* executeCompose(context, {
          interruptions: stop.effect,
          executor: async () => ({ exitCode: 0 }),
          processStarter: async () => {
            queueMicrotask(() => stop.resolve("SIGTERM"));
            return new Promise<RunningProcess>(() => undefined);
          },
          stateAdapter: {
            listApplicationContainers: async () => [existing],
            probeApplicationReadiness: async () => ({ reachable: true, status: 200 }),
            stopApplicationContainers: async ({ containers }) => {
              stopped.push(containers.map(({ id }) => id));
              return { verified: true, remaining: [] };
            },
          },
        });

        expect(result.outcome).toEqual(
          expect.objectContaining({ status: "stopped", exitCode: 143 }),
        );
        expect(stopped).toEqual([]);
      }),
  );

  it.live("ignores a pre-existing one-off container when checking service startup", () =>
    Effect.gen(function* () {
      const output = { ...composeUpOutput(), selectedServices: ["sheet-web"] as const };
      const context = makeComposeExecutionContext(output, "/checkout", {
        startupTimeoutMs: 100,
        readinessTimeoutMs: 25,
        pollIntervalMs: 0,
      });
      const oneOff = {
        id: "one-off-web",
        service: "sheet-web",
        state: "exited",
        exitCode: 0,
        oneOff: true,
      } as const;
      const stopped: string[][] = [];
      const result = yield* executeCompose(context, {
        interruptions: Effect.never,
        executor: async () => ({ exitCode: 0 }),
        processStarter: async () => runningProcess(new Promise(() => undefined)),
        stateAdapter: {
          listApplicationContainers: async () => [oneOff],
          probeApplicationReadiness: async () => ({ reachable: true, status: 200 }),
          stopApplicationContainers: async ({ containers }) => {
            stopped.push(containers.map(({ id }) => id));
            return { verified: true, remaining: [] };
          },
        },
      });

      expect(result.outcome.status).toBe("blocked");
      expect(result.outcome.diagnostic?.code).toBe("dependency-timeout");
      expect(stopped).toEqual([]);
    }),
  );

  it("rejects a Compose context when its environment file cannot be read", () => {
    const output = composeOutput("build", [
      {
        id: "compose-build",
        packageName: null,
        command: "docker",
        args: [
          "compose",
          "--project-name",
          "tiara-test-123",
          "--env-file",
          "/path/that/does/not/exist/compose.env",
          "build",
        ],
        environment: {},
        longLived: false,
        readOnly: false,
      },
    ]);

    expect(() => makeComposeContext(output, "/checkout")).toThrow(
      "[env-file-not-found] Cannot read environment file /path/that/does/not/exist/compose.env",
    );
  });

  it("verifies Compose container state and escalates when graceful stop leaves a container running", async () => {
    const requests: Parameters<ProcessExecutor>[0][] = [];
    let stateChecks = 0;
    const adapter = makeComposeStateAdapter(async (request) => {
      requests.push(request);
      if (request.args.includes("ps")) {
        stateChecks += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              ID: "web-container",
              Service: "sheet-web",
              State: stateChecks === 1 ? "running" : "exited",
              ExitCode: stateChecks === 1 ? 0 : 137,
            },
          ]),
        };
      }
      return { exitCode: 0 };
    }, "/checkout");

    const result = await adapter.stopApplicationContainers({
      projectName: "tiara-test-123",
      envFile: "/checkout/compose.env",
      cwd: "/checkout",
      services: ["sheet-web"],
      containers: [{ id: "web-container", service: "sheet-web", state: "running" }],
      timeoutMs: 15_000,
    });

    expect(result).toEqual({ verified: true, remaining: [] });
    expect(requests.map(({ args }) => args[0])).toEqual(["stop", "compose", "kill", "compose"]);
    expect(requests[0]?.args).toEqual(["stop", "--time", "5", "--", "web-container"]);
    expect(requests[2]?.args).toEqual(["kill", "--signal", "SIGKILL", "--", "web-container"]);
    expect(
      requests.filter(({ args }) => args.includes("down") || args.includes("--volumes")),
    ).toEqual([]);
    expect(requests[1]?.args).toEqual(
      expect.arrayContaining([
        "compose",
        "--project-name",
        "tiara-test-123",
        "--env-file",
        "/checkout/compose.env",
      ]),
    );
  });

  it("ignores blank lines in Compose container state output", async () => {
    const adapter = makeComposeStateAdapter(async (request) =>
      request.args.includes("ps")
        ? {
            exitCode: 0,
            stdout: [
              JSON.stringify({ ID: "auth-container", Service: "sheet-auth", State: "running" }),
              "",
              "  ",
              JSON.stringify({ ID: "web-container", Service: "sheet-web", State: "exited" }),
            ].join("\n"),
          }
        : { exitCode: 0 },
    );

    await expect(
      adapter.listApplicationContainers({
        projectName: "tiara-test-123",
        envFile: null,
        cwd: "/checkout",
        services: ["sheet-auth", "sheet-web"],
        timeoutMs: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "auth-container", service: "sheet-auth" }),
      expect.objectContaining({ id: "web-container", service: "sheet-web" }),
    ]);
  });

  it("does not verify or escalate containers outside the cleanup request", async () => {
    const requests: Parameters<ProcessExecutor>[0][] = [];
    const adapter = makeComposeStateAdapter(async (request) => {
      requests.push(request);
      if (request.args.includes("ps")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              ID: "requested-container",
              Service: "sheet-web",
              State: "exited",
              ExitCode: 0,
            },
            {
              ID: "unrelated-container",
              Service: "sheet-web",
              State: "running",
              ExitCode: 0,
            },
          ]),
        };
      }
      return { exitCode: 0 };
    }, "/checkout");

    const result = await adapter.stopApplicationContainers({
      projectName: "tiara-test-123",
      envFile: "/checkout/compose.env",
      cwd: "/checkout",
      services: ["sheet-web"],
      containers: [{ id: "requested-container", service: "sheet-web", state: "running" }],
      timeoutMs: 10,
    });

    expect(result).toEqual({ verified: true, remaining: [] });
    expect(requests.map(({ args }) => args[0])).toEqual(["stop", "compose"]);
    expect(requests.some(({ args }) => args.includes("kill"))).toBe(false);
  });
});
