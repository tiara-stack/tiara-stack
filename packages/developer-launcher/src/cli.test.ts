import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { command, executeComposePlan, executeFastPlan, executeKubernetesPlan } from "./cli";
import { runLauncherFromParsed, getKubernetesExecutionContext } from "./index";
import { runKubernetesExecution, type KubernetesLifecycleObservation } from "./execution";
import type { ComposeContainerState, ComposeStateAdapter } from "./execution";
import type { ProcessExecutor, ProcessResult, ProcessStarter, RunningProcess } from "./types";

const kubernetesOptions = {
  json: true,
  help: false,
  envFile: null,
  service: null,
  confirm: false,
  confirmDevelopment: true,
  tag: "test-tag",
  changedSurfaces: [] as readonly string[],
};

const kubernetesResult = (
  action: "validate" | "preview",
  changedSurfaces = kubernetesOptions.changedSurfaces,
) =>
  runLauncherFromParsed(
    ["kubernetes", action],
    {
      ...kubernetesOptions,
      changedSurfaces,
      ...(action === "validate" ? { confirmDevelopment: false, tag: null } : {}),
    },
    { env: { KUBE_CONTEXT: "tiara-stack-dev" } },
  );

const kubernetesExecutionContext = async (
  action: "validate" | "preview",
  changedSurfaces?: readonly string[],
) => {
  const result = await kubernetesResult(action, changedSurfaces);
  const context = getKubernetesExecutionContext(result);
  if (context === undefined) throw new Error("expected a Kubernetes execution context");
  return context;
};

const interruption = () => {
  let resolve!: (signal: NodeJS.Signals) => void;
  const promise = new Promise<NodeJS.Signals>((resolver) => (resolve = resolver));
  return { effect: Effect.promise(() => promise), resolve };
};

const stopWhenStepStarts =
  (stop: ReturnType<typeof interruption>, stepId?: string) =>
  (observation: KubernetesLifecycleObservation) => {
    if (
      observation.type === "step" &&
      observation.status === "started" &&
      (stepId === undefined || observation.id === stepId)
    ) {
      stop.resolve("SIGINT");
    }
  };

const expectStoppedKubernetesExecution = (
  executed: Awaited<ReturnType<typeof runKubernetesExecution>>,
  killed: number,
) => {
  expect(executed.outcome.status).toBe("stopped");
  expect(executed.outcome.exitCode).toBe(130);
  expect(executed.output.readiness).toBe("stopped");
  expect(killed).toBe(1);
};

const runningProcess = (exited: Promise<ProcessResult>): RunningProcess => ({
  pid: 42,
  exited,
  kill: async () => undefined,
});

const runCliHelp = () =>
  Effect.gen(function* () {
    yield* Command.runWith(command, { version: "0.0.0" })(["--help"]);
    return (yield* TestConsole.logLines).join("\n");
  }).pipe(Effect.provide(TestConsole.layer), Effect.provide(NodeServices.layer));

describe("developer launcher Effect CLI", () => {
  const commandOptions = (json = true) => ({
    json,
    help: false,
    envFile: null,
    service: null,
    confirm: false,
    confirmDevelopment: false,
    tag: null,
    changedSurfaces: [],
  });

  it("reports finite Compose actions as completed through the terminal adapter", async () => {
    const result = await runLauncherFromParsed(["compose", "down"], commandOptions(), {
      env: {},
    });
    const requests: Parameters<ProcessExecutor>[0][] = [];

    const executed = await executeComposePlan(result, true, {
      executor: async (request) => {
        requests.push(request);
        return { exitCode: 0 };
      },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    expect(requests).toHaveLength(1);
    expect(executed.exitCode).toBe(0);
    expect(executed.stdout).toContain('"readiness":"completed"');
    expect(executed.output.readiness).toBe("completed");
  });

  it("streams finite Compose lifecycle events and ends with one terminal outcome", async () => {
    const result = await runLauncherFromParsed(
      ["compose", "down"],
      { ...commandOptions(false), jsonStream: true },
      { env: {} },
    );
    const lines: Record<string, unknown>[] = [];

    const executed = await executeComposePlan(result, true, {
      jsonStream: true,
      executor: async () => ({ exitCode: 0 }),
      writeStdout: (value) => lines.push(JSON.parse(value) as Record<string, unknown>),
      writeStderr: () => undefined,
    });

    expect(executed.exitCode).toBe(0);
    expect(executed.stdout).toBe("");
    expect(lines.map(({ type }) => type)).toEqual(["validated", "step", "step", "terminal"]);
    expect(lines.every((line) => line.format === "tiara-stack.development.lifecycle")).toBe(true);
    expect(lines.every((line) => line.eventVersion === 1)).toBe(true);
    expect(lines.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    expect(lines.at(-1)).toEqual(
      expect.objectContaining({
        type: "terminal",
        outcome: "completed",
        readiness: "completed",
        exitCode: 0,
      }),
    );
  });

  it("streams Compose readiness before cleanup and its terminal outcome", async () => {
    const repository = mkdtempSync(path.join(tmpdir(), "developer-launcher-compose-stream-"));
    const envFile = path.join(repository, "compose.env");
    writeFileSync(
      envFile,
      [
        "POSTGRES_PASSWORD=postgres-password",
        "REDIS_PASSWORD=redis-password",
        "SHEET_BOT_CAPABILITY_ENCRYPTION_SECRET=bot-capability-secret-32-characters",
        "SHEET_BOT_OAUTH_CLIENT_ID=local-bot",
        "SHEET_BOT_OAUTH_CLIENT_SECRET=local-bot-secret",
        "SHEET_WORKFLOWS_OAUTH_CLIENT_ID=local-workflows",
        "SHEET_WORKFLOWS_OAUTH_CLIENT_SECRET=local-workflows-secret",
      ].join("\n"),
    );
    const result = await runLauncherFromParsed(
      ["compose", "up"],
      {
        ...commandOptions(false),
        jsonStream: true,
        envFile,
        service: "sheet-web",
      },
      { cwd: repository, env: {} },
    );
    const lines: Record<string, unknown>[] = [];
    let resolveExit!: (result: ProcessResult) => void;
    const processExit = new Promise<ProcessResult>((resolve) => {
      resolveExit = resolve;
    });
    const containers: readonly ComposeContainerState[] = [
      { id: "web-container", service: "sheet-web", state: "running" },
    ];
    let stateCalls = 0;

    try {
      const executed = await executeComposePlan(result, true, {
        jsonStream: true,
        interruptions: Effect.never,
        executor: async () => ({ exitCode: 0 }),
        processStarter: async () => ({
          pid: 42,
          exited: processExit,
          kill: async () => undefined,
        }),
        stateAdapter: {
          listApplicationContainers: async () => {
            stateCalls += 1;
            return stateCalls === 1 ? [] : containers;
          },
          probeApplicationReadiness: async () => ({ reachable: true, status: 204 }),
          stopApplicationContainers: async () => ({ verified: true, remaining: [] }),
        },
        onObservation: (observation) => {
          if (
            observation.type === "readiness" &&
            observation.status === "ready" &&
            observation.allSelected
          ) {
            resolveExit({ exitCode: 0 });
          }
        },
        writeStdout: (value) => lines.push(JSON.parse(value) as Record<string, unknown>),
        writeStderr: () => undefined,
      });

      const readinessIndex = lines.findIndex(
        ({ type, status }) => type === "readiness" && status === "ready",
      );
      const cleanupIndex = lines.findIndex(({ type }) => type === "cleanup");
      const terminalIndex = lines.findIndex(({ type }) => type === "terminal");

      expect(executed.exitCode).toBe(0);
      expect(readinessIndex).toBeGreaterThanOrEqual(0);
      expect(cleanupIndex).toBeGreaterThan(readinessIndex);
      expect(terminalIndex).toBeGreaterThan(cleanupIndex);
      expect(lines[terminalIndex]).toEqual(
        expect.objectContaining({ outcome: "completed", readiness: "ready" }),
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("streams Kubernetes progress through the same event format", async () => {
    const result = await kubernetesResult("validate");
    const lines: Record<string, unknown>[] = [];

    const executed = await executeKubernetesPlan(result, true, {
      jsonStream: true,
      executor: async () => ({ exitCode: 0 }),
      writeStdout: (value) => lines.push(JSON.parse(value) as Record<string, unknown>),
      writeStderr: () => undefined,
    });

    expect(executed.exitCode).toBe(0);
    expect(executed.stdout).toBe("");
    expect(lines[0]).toEqual(expect.objectContaining({ type: "validated", sequence: 1 }));
    expect(lines.at(-1)).toEqual(
      expect.objectContaining({
        type: "terminal",
        outcome: "completed",
        readiness: "completed",
      }),
    );
    expect(lines.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: lines.length }, (_, index) => index + 1),
    );
  });

  it("streams a Kubernetes gate failure with redacted diagnostics", async () => {
    const result = await kubernetesResult("preview");
    const lines: Record<string, unknown>[] = [];
    const secret = "stream-kubernetes-secret";

    const executed = await executeKubernetesPlan(result, true, {
      jsonStream: true,
      executor: async (request) => {
        if (request.args.includes("upgrade")) {
          return { exitCode: 1, stderr: `password=${secret}` };
        }
        if (request.command === "kubectl") {
          return { exitCode: 0, stdout: `pod/sheet-web token: ${secret}` };
        }
        return { exitCode: 0 };
      },
      writeStdout: (value) => lines.push(JSON.parse(value) as Record<string, unknown>),
      writeStderr: () => undefined,
    });

    expect(executed.exitCode).toBe(2);
    expect(JSON.stringify(lines)).not.toContain(secret);
    expect(lines.at(-1)).toEqual(
      expect.objectContaining({
        type: "terminal",
        outcome: "blocked",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "required-dependency-failed" }),
        ]),
      }),
    );
  });

  it("streams Kubernetes cancellation after cleanup failure", async () => {
    const result = await kubernetesResult("validate");
    const stop = interruption();
    const lines: Record<string, unknown>[] = [];

    const executed = await executeKubernetesPlan(result, true, {
      jsonStream: true,
      interruptions: stop.effect,
      cleanupTimeoutMs: 10,
      processStarter: async () => ({
        pid: 42,
        exited: new Promise<ProcessResult>(() => undefined),
        kill: async () => {
          throw new Error("local validation process could not be stopped");
        },
      }),
      onObservation: (observation) => {
        if (observation.type === "step" && observation.status === "started") {
          stop.resolve("SIGINT");
        }
      },
      writeStdout: (value) => lines.push(JSON.parse(value) as Record<string, unknown>),
      writeStderr: () => undefined,
    });

    expect(executed.exitCode).toBe(2);
    expect(lines).toContainEqual(expect.objectContaining({ type: "cleanup", status: "failed" }));
    expect(lines.at(-1)).toEqual(
      expect.objectContaining({
        type: "terminal",
        outcome: "blocked",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "preview-incomplete" }),
          expect.objectContaining({ code: "cleanup-failed" }),
        ]),
      }),
    );
  });

  it("keeps a Fast lifecycle stream alive through readiness, late failure, and cleanup", async () => {
    const result = await runLauncherFromParsed(
      ["fast", "up"],
      { ...commandOptions(false), jsonStream: true },
      { env: {}, portChecker: async () => ({ available: true }) },
    );
    const lines: Record<string, unknown>[] = [];
    const stderr: string[] = [];
    let resolveExit!: (result: ProcessResult) => void;
    const processExit = new Promise<ProcessResult>((resolve) => {
      resolveExit = resolve;
    });

    const executed = await executeFastPlan(result, true, {
      jsonStream: true,
      interruptions: Effect.never,
      accessChecker: async () => ({ reachable: true, status: 204 }),
      readinessChecker: async () => ({ reachable: true, status: 204 }),
      processStarter: async () => ({
        pid: 42,
        exited: processExit,
        kill: async () => undefined,
      }),
      onObservation: (observation) => {
        if (observation.type === "readiness" && observation.status === "ready") {
          resolveExit({ exitCode: 17, stderr: "late child failure" });
        }
      },
      writeStdout: (value) => lines.push(JSON.parse(value) as Record<string, unknown>),
      writeStderr: (value) => stderr.push(value),
    });

    expect(executed.exitCode).toBe(17);
    expect(lines.map(({ type }) => type).at(-1)).toBe("terminal");
    expect(lines.at(-1)).toEqual(
      expect.objectContaining({
        type: "terminal",
        outcome: "blocked",
        executionOutcome: "failed",
        exitCode: 17,
        readiness: "ready",
      }),
    );
    expect(
      lines.find(({ type, status }) => type === "readiness" && status === "ready"),
    ).toBeDefined();
    expect(
      lines.find(({ type, status }) => type === "cleanup" && status === "completed"),
    ).toBeDefined();
    expect(stderr.join("")).toContain("after becoming ready");
    expect(lines.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: lines.length }, (_, index) => index + 1),
    );
  });

  it("streams an early Fast exit as a blocked terminal outcome", async () => {
    const result = await runLauncherFromParsed(
      ["fast", "up"],
      { ...commandOptions(false), jsonStream: true },
      { env: {}, portChecker: async () => ({ available: true }) },
    );
    const lines: Record<string, unknown>[] = [];

    const executed = await executeFastPlan(result, true, {
      jsonStream: true,
      interruptions: Effect.never,
      accessChecker: async () => ({ reachable: true, status: 204 }),
      readinessChecker: async () => ({ reachable: true, status: 204 }),
      processStarter: async () => runningProcess(Promise.resolve({ exitCode: 0 })),
      writeStdout: (value) => lines.push(JSON.parse(value) as Record<string, unknown>),
      writeStderr: () => undefined,
    });

    expect(executed.exitCode).toBe(2);
    expect(lines).not.toContainEqual(
      expect.objectContaining({ type: "readiness", status: "ready" }),
    );
    expect(lines.at(-1)).toEqual(
      expect.objectContaining({ type: "terminal", outcome: "blocked", readiness: "blocked" }),
    );
  });

  it("does not copy rejected Fast startup exception text into lifecycle diagnostics", async () => {
    const result = await runLauncherFromParsed(
      ["fast", "up"],
      { ...commandOptions(false), jsonStream: true },
      { env: {}, portChecker: async () => ({ available: true }) },
    );
    const lines: Record<string, unknown>[] = [];
    const secret = "unlabeled-startup-secret";

    const executed = await executeFastPlan(result, true, {
      jsonStream: true,
      interruptions: Effect.never,
      accessChecker: async () => ({ reachable: true, status: 204 }),
      processStarter: async () => {
        throw new Error(`process start failed: ${secret}`);
      },
      writeStdout: (value) => lines.push(JSON.parse(value) as Record<string, unknown>),
      writeStderr: () => undefined,
    });

    expect(executed.exitCode).toBe(2);
    expect(JSON.stringify(lines)).not.toContain(secret);
    expect(lines.at(-1)).toEqual(
      expect.objectContaining({
        type: "terminal",
        outcome: "blocked",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "dependency-unavailable",
            message: expect.not.stringContaining(secret),
          }),
        ]),
      }),
    );
  });

  it("keeps Fast stream sequence numbers contiguous after a stream write fails", async () => {
    const result = await runLauncherFromParsed(
      ["fast", "up"],
      { ...commandOptions(false), jsonStream: true },
      { env: {}, portChecker: async () => ({ available: true }) },
    );
    const lines: Record<string, unknown>[] = [];
    const attempts: Record<string, unknown>[] = [];
    let failNextWrite = true;

    const executed = await executeFastPlan(result, true, {
      jsonStream: true,
      interruptions: Effect.never,
      accessChecker: async () => ({ reachable: true, status: 204 }),
      processStarter: async () => runningProcess(Promise.resolve({ exitCode: 0 })),
      writeStdout: (value) => {
        const event = JSON.parse(value) as Record<string, unknown>;
        attempts.push(event);
        if (failNextWrite && event.type === "prerequisite") {
          failNextWrite = false;
          throw new Error("stream writer failed");
        }
        lines.push(event);
      },
      writeStderr: () => undefined,
    });

    expect(attempts.map(({ type, sequence }) => ({ type, sequence }))).toEqual(
      expect.arrayContaining([
        { type: "prerequisite", sequence: expect.any(Number) },
        { type: "terminal", sequence: expect.any(Number) },
      ]),
    );
    expect(executed.exitCode).toBe(2);
    expect(lines.at(-1)).toEqual(expect.objectContaining({ type: "terminal" }));
    expect(lines.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: lines.length }, (_, index) => index + 1),
    );
  });

  it("classifies a Fast stream write failure after readiness as a dependency failure", async () => {
    const result = await runLauncherFromParsed(
      ["fast", "up"],
      { ...commandOptions(false), jsonStream: true },
      { env: {}, portChecker: async () => ({ available: true }) },
    );
    const lines: Record<string, unknown>[] = [];
    let resolveExit!: (result: ProcessResult) => void;
    const processExit = new Promise<ProcessResult>((resolve) => {
      resolveExit = resolve;
    });
    let readinessWritten = false;
    let failTerminalWrite = true;

    const executed = await executeFastPlan(result, true, {
      jsonStream: true,
      interruptions: Effect.never,
      accessChecker: async () => ({ reachable: true, status: 204 }),
      readinessChecker: async () => ({ reachable: true, status: 204 }),
      processStarter: async () => runningProcess(processExit),
      onObservation: (observation) => {
        if (observation.type === "readiness" && observation.status === "ready") {
          resolveExit({ exitCode: 17 });
        }
      },
      writeStdout: (value) => {
        const event = JSON.parse(value) as Record<string, unknown>;
        if (event.type === "readiness" && event.status === "ready") readinessWritten = true;
        if (event.type === "terminal" && readinessWritten && failTerminalWrite) {
          failTerminalWrite = false;
          throw new Error("stream writer failed after readiness");
        }
        lines.push(event);
      },
      writeStderr: () => undefined,
    });

    expect(executed.exitCode).toBe(1);
    expect(lines.at(-1)).toEqual(
      expect.objectContaining({
        type: "terminal",
        outcome: "blocked",
        readiness: "ready",
        exitCode: 1,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "required-dependency-failed" }),
        ]),
      }),
    );
    expect(lines.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: lines.length }, (_, index) => index + 1),
    );
  });

  it("blocks Compose execution when its validated context is unavailable", async () => {
    const result = await runLauncherFromParsed(["compose", "down"], commandOptions(), {
      env: {},
    });
    const executed = await executeComposePlan({ ...result, output: { ...result.output } }, true, {
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    expect(executed.exitCode).toBe(2);
    expect(executed.output.readiness).toBe("blocked");
    expect(executed.output.errors).toEqual([
      expect.objectContaining({ code: "context-preparation-failed" }),
    ]);
    expect(executed.stdout).toContain('"readiness":"blocked"');
  });

  it("executes Kubernetes validation through the shared execution seam", async () => {
    const context = await kubernetesExecutionContext("validate");
    const requests: Parameters<ProcessExecutor>[0][] = [];

    const executed = await runKubernetesExecution(context, {
      executor: async (request) => {
        requests.push(request);
        return { exitCode: 0 };
      },
      output: "capture",
    });

    expect(executed.outcome.status).toBe("completed");
    expect(executed.output.readiness).toBe("completed");
    expect(requests.map(({ command }) => command)).toEqual(["helm", "helm"]);
    expect(requests.some(({ args }) => args.includes("upgrade"))).toBe(false);
  });

  it("carries the validated Kubernetes target into execution instead of parsing command output", async () => {
    const result = await runLauncherFromParsed(["kubernetes", "preview"], kubernetesOptions, {
      env: { KUBE_CONTEXT: "tiara-stack-dev", KUBECONFIG: "/tmp/tiara-kubeconfig" },
    });
    const context = getKubernetesExecutionContext(result);
    if (context === undefined) throw new Error("expected a Kubernetes execution context");

    expect(context.target).toEqual({
      context: "tiara-stack-dev",
      namespace: "tiara-stack-dev",
      release: "tiara-stack-dev",
      registry: "registry.digitalocean.com/theerapakg-registry",
      imageTag: "test-tag",
      kubeconfig: "/tmp/tiara-kubeconfig",
    });
    expect(context.steps.find(({ id }) => id === "kubernetes-preview")?.request.args).toEqual(
      expect.arrayContaining(["--kube-context", "tiara-stack-dev"]),
    );
    expect(getKubernetesExecutionContext({ ...result })).toBe(context);
  });

  it("rejects an unsafe Kubernetes target before creating an execution context", async () => {
    const result = await runLauncherFromParsed(["kubernetes", "preview"], kubernetesOptions, {
      env: { KUBE_CONTEXT: "production" },
    });

    expect(result.exitCode).toBe(2);
    expect(result.output.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid-environment" })]),
    );
    expect(getKubernetesExecutionContext(result)).toBeUndefined();
  });

  it("bounds a Kubernetes command after it starts and reports its failed step", async () => {
    const context = await kubernetesExecutionContext("validate");
    const timedContext = {
      ...context,
      steps: context.steps.map((step, index) =>
        index === 0 ? { ...step, request: { ...step.request, timeoutMs: 10 } } : step,
      ),
    };
    let killed = 0;
    const executed = await runKubernetesExecution(timedContext, {
      processStarter: async () => ({
        pid: 42,
        exited: new Promise<{ readonly exitCode: number }>(() => undefined),
        kill: async () => {
          killed += 1;
        },
      }),
      interruptions: Effect.never,
      output: "capture",
    });

    expect(killed).toBe(1);
    expect(executed.outcome.status).toBe("blocked");
    expect(executed.outcome.diagnostic?.code).toBe("dependency-timeout");
    expect(executed.observations).toContainEqual(
      expect.objectContaining({ type: "step", status: "failed", exitCode: 1 }),
    );
  });

  it("reports command-start failures as failed lifecycle steps", async () => {
    const context = await kubernetesExecutionContext("validate");
    const observed: KubernetesLifecycleObservation[] = [];

    const executed = await runKubernetesExecution(context, {
      processStarter: async () => {
        throw new Error("helm is not installed");
      },
      interruptions: Effect.never,
      output: "capture",
      onObservation: (observation) => observed.push(observation),
    });

    expect(executed.outcome.status).toBe("blocked");
    expect(observed).toContainEqual(
      expect.objectContaining({ type: "step", id: "helm-lint", status: "failed" }),
    );
    expect(observed.at(-1)).toEqual(
      expect.objectContaining({ type: "terminal", outcome: "blocked" }),
    );
  });

  it("returns a structured stopped result when validation is interrupted", async () => {
    const context = await kubernetesExecutionContext("validate");
    const stop = interruption();
    let killed = 0;
    const requests: Parameters<ProcessExecutor>[0][] = [];
    const executed = await runKubernetesExecution(context, {
      processStarter: async (request) => {
        requests.push(request);
        return {
          pid: 42,
          exited: new Promise<{ readonly exitCode: number }>(() => undefined),
          kill: async () => {
            killed += 1;
          },
        };
      },
      interruptions: stop.effect,
      output: "capture",
      onObservation: stopWhenStepStarts(stop),
    });

    expectStoppedKubernetesExecution(executed, killed);
    expect(requests).toHaveLength(1);
  });

  it("stops at the first failed Kubernetes gate and adds bounded read-only workload details", async () => {
    const context = await kubernetesExecutionContext("preview", ["workflow-runner"]);
    const requests: Parameters<ProcessExecutor>[0][] = [];
    const executed = await runKubernetesExecution(context, {
      executor: async (request) => {
        requests.push(request);
        if (request.args.includes("workflow-contract-smoke")) {
          return { exitCode: 1, stderr: "terminal contract failed" };
        }
        // fallow-ignore-next-line code-duplication
        if (request.command === "kubectl") {
          return { exitCode: 0, stdout: "pod/sheet-web-abc 0/1 ImagePullBackOff" };
        }
        return { exitCode: 0 };
      },
      output: "capture",
    });

    expect(executed.outcome.status).toBe("blocked");
    expect(executed.output.readiness).toBe("blocked");
    expect(executed.output.errors[0]?.message).toContain("ImagePullBackOff");
    expect(requests.at(-1)?.command).toBe("kubectl");
    expect(requests.some(({ args }) => args.includes("browser-runner-smoke"))).toBe(false);
    expect(executed.output.parityGates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "api-smoke", status: "not-affected" }),
        expect.objectContaining({ id: "browser-runner-smoke", status: "not-affected" }),
      ]),
    );
    expect(executed.observations.at(-1)).toEqual(
      expect.objectContaining({ type: "terminal", outcome: "blocked" }),
    );
  });

  it("keeps workload-detail collection on the injected starter seam", async () => {
    const context = await kubernetesExecutionContext("preview");
    const requests: Parameters<ProcessExecutor>[0][] = [];
    const processStarter: ProcessStarter = async (request) => {
      requests.push(request);
      if (request.args.includes("upgrade")) {
        return runningProcess(Promise.resolve({ exitCode: 1, stderr: "rollout failed" }));
      }
      if (request.command === "kubectl") {
        return runningProcess(
          Promise.resolve({ exitCode: 0, stdout: "pod/sheet-web-abc 0/1 ImagePullBackOff" }),
        );
      }
      return runningProcess(Promise.resolve({ exitCode: 0 }));
    };

    const executed = await runKubernetesExecution(context, {
      processStarter,
      output: "capture",
    });

    expect(executed.outcome.status).toBe("blocked");
    expect(executed.output.errors[0]?.message).toContain("ImagePullBackOff");
    expect(requests.at(-1)?.command).toBe("kubectl");
  });

  it("keeps a failed gate blocking when workload-detail inspection is interrupted", async () => {
    const context = await kubernetesExecutionContext("preview");
    const executed = await runKubernetesExecution(context, {
      executor: async (request) => {
        if (request.args.includes("upgrade")) return { exitCode: 1, stderr: "rollout failed" };
        // fallow-ignore-next-line code-duplication
        if (request.command === "kubectl") return { exitCode: 143 };
        return { exitCode: 0 };
      },
      output: "capture",
    });

    expect(executed.outcome.status).toBe("blocked");
    expect(executed.output.readiness).toBe("blocked");
    expect(executed.output.errors[0]?.message).toContain("rollout failed");
    expect(executed.output.errors[0]?.message).toContain(
      "workload detail collection was interrupted",
    );
  });

  it("reports interrupted preview work after cleanup without issuing rollback commands", async () => {
    const context = await kubernetesExecutionContext("preview");
    const stop = interruption();
    const previewExit = (() => {
      let resolve!: (result: { readonly exitCode: number }) => void;
      const promise = new Promise<{ readonly exitCode: number }>(
        (resolver) => (resolve = resolver),
      );
      return { promise, resolve };
    })();
    const requests: Parameters<ProcessExecutor>[0][] = [];
    let killed = 0;
    const observations: KubernetesLifecycleObservation[] = [];
    const processStarter: ProcessStarter = async (request) => {
      requests.push(request);
      if (request.args.includes("upgrade")) {
        return {
          pid: 42,
          exited: previewExit.promise,
          kill: async () => {
            killed += 1;
            previewExit.resolve({ exitCode: 143 });
          },
        };
      }
      return runningProcess(Promise.resolve({ exitCode: 0 }));
    };

    const executed = await runKubernetesExecution(context, {
      processStarter,
      interruptions: stop.effect,
      output: "capture",
      onObservation: (observation) => {
        observations.push(observation);
        stopWhenStepStarts(stop, "kubernetes-preview")(observation);
      },
    });

    expectStoppedKubernetesExecution(executed, killed);
    expect(executed.output.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "preview-incomplete" })]),
    );
    expect(observations.filter(({ type }) => type === "cleanup")).toHaveLength(2);
    expect(
      requests.some(({ args }) =>
        args.some((argument) => /rollback|delete|teardown|down/i.test(argument)),
      ),
    ).toBe(false);
  });

  it("keeps an interrupted Kubernetes cleanup failure visible", async () => {
    const context = await kubernetesExecutionContext("preview");
    const stop = interruption();
    let killed = 0;
    const processStarter: ProcessStarter = async (request) => {
      if (request.args.includes("upgrade")) {
        return {
          pid: 42,
          exited: new Promise<{ readonly exitCode: number }>(() => undefined),
          kill: async () => {
            killed += 1;
            throw new Error("local command could not be stopped");
          },
        };
      }
      return runningProcess(Promise.resolve({ exitCode: 0 }));
    };

    const executed = await runKubernetesExecution(context, {
      processStarter,
      interruptions: stop.effect,
      cleanupTimeoutMs: 10,
      output: "capture",
      onObservation: (observation) => {
        if (observation.type === "step" && observation.id === "kubernetes-preview") {
          stop.resolve("SIGTERM");
        }
      },
    });

    expect(killed).toBe(1);
    expect(executed.outcome.status).toBe("failed");
    expect(executed.outcome.exitCode).toBe(2);
    expect(executed.output.readiness).toBe("blocked");
    expect(executed.output.errors.map(({ code }) => code)).toEqual([
      "preview-incomplete",
      "cleanup-failed",
    ]);
  });

  it("redacts copied Kubernetes command and workload output", async () => {
    const context = await kubernetesExecutionContext("preview");
    const secret = "kube-output-secret";
    const apiKey = "kube-api-key";
    const accessToken = "kube-access-token";
    const clientSecret = "kube-client-secret";
    const dockerAuth = "docker-registry-auth-secret";
    const dockerAuthConfig = JSON.stringify(
      { auths: { "registry.example.test": { auth: dockerAuth } } },
      null,
      2,
    );
    const executed = await runKubernetesExecution(context, {
      executor: async (request) => {
        if (request.args.includes("upgrade")) {
          return {
            exitCode: 1,
            stderr: `password=${secret} API_KEY=${apiKey} ACCESS_TOKEN=${accessToken} CLIENT_SECRET=${clientSecret} DOCKER_AUTH_CONFIG=${dockerAuthConfig}`,
          };
        }
        if (request.command === "kubectl") {
          return {
            exitCode: 0,
            stdout: `pod/sheet-web password: ${secret} token: ${secret} API_KEY: ${apiKey} ACCESS_TOKEN: ${accessToken} CLIENT_SECRET: ${clientSecret} DOCKER_AUTH_CONFIG: '${dockerAuthConfig}'`,
          };
        }
        return { exitCode: 0 };
      },
      output: "capture",
    });

    expect(JSON.stringify(executed.output)).not.toContain(secret);
    expect(JSON.stringify(executed.output)).not.toContain(apiKey);
    expect(JSON.stringify(executed.output)).not.toContain(accessToken);
    expect(JSON.stringify(executed.output)).not.toContain(clientSecret);
    expect(JSON.stringify(executed.output)).not.toContain(dockerAuth);
    expect(JSON.stringify(executed.output)).not.toContain(dockerAuthConfig);
    expect(executed.output.errors[0]?.message).toContain("<redacted>");
  });

  it("emits one JSON readiness document before attached Compose shutdown", async () => {
    const repository = mkdtempSync(path.join(tmpdir(), "developer-launcher-compose-cli-"));
    const envFile = path.join(repository, "compose.env");
    writeFileSync(
      envFile,
      [
        "POSTGRES_PASSWORD=postgres-password",
        "REDIS_PASSWORD=redis-password",
        "SHEET_BOT_CAPABILITY_ENCRYPTION_SECRET=bot-capability-secret-32-characters",
        "SHEET_BOT_OAUTH_CLIENT_ID=local-bot",
        "SHEET_BOT_OAUTH_CLIENT_SECRET=local-bot-secret",
        "SHEET_WORKFLOWS_OAUTH_CLIENT_ID=local-workflows",
        "SHEET_WORKFLOWS_OAUTH_CLIENT_SECRET=local-workflows-secret",
      ].join("\n"),
    );
    const result = await runLauncherFromParsed(
      ["compose", "up"],
      { ...commandOptions(), envFile },
      { cwd: repository, env: {} },
    );
    const output: string[] = [];
    const errors: string[] = [];
    let resolveExit!: (result: { readonly exitCode: number }) => void;
    const processExit = new Promise<{ readonly exitCode: number }>((resolve) => {
      resolveExit = resolve;
    });
    const containers: readonly ComposeContainerState[] = [
      { id: "auth-container", service: "sheet-auth", state: "running" },
      { id: "db-container", service: "sheet-db-server", state: "running" },
      { id: "workflows-container", service: "sheet-workflows", state: "running" },
      { id: "web-container", service: "sheet-web", state: "running" },
      { id: "bot-container", service: "sheet-bot", state: "running" },
    ];
    let stateCalls = 0;
    const stateAdapter: ComposeStateAdapter = {
      listApplicationContainers: async () => {
        stateCalls += 1;
        return stateCalls === 1 ? [] : containers;
      },
      probeApplicationReadiness: async () => ({ reachable: true, status: 200 }),
      stopApplicationContainers: async () => ({ verified: true, remaining: [] }),
    };
    const processStarter = async (): Promise<RunningProcess> => ({
      pid: 42,
      exited: processExit,
      kill: async () => undefined,
    });

    try {
      const executed = await executeComposePlan(result, true, {
        executor: async () => ({ exitCode: 0 }),
        processStarter,
        stateAdapter,
        interruptions: Effect.never,
        writeStdout: (value) => output.push(value),
        writeStderr: (value) => errors.push(value),
        onObservation: (observation) => {
          if (
            observation.type === "readiness" &&
            observation.status === "ready" &&
            observation.allSelected
          ) {
            resolveExit({ exitCode: 0 });
          }
        },
      });

      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0] ?? "{}")).toEqual(
        expect.objectContaining({ readiness: "ready" }),
      );
      expect(executed.stdout).toBe("");
      expect(errors).toEqual([]);
      expect(executed.output.readiness).toBe("ready");
      expect(executed.exitCode).toBe(0);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  // fallow-ignore-next-line code-duplication
  it("reports failed Kubernetes workloads through the executor seam", async () => {
    const result = await runLauncherFromParsed(
      ["kubernetes", "preview"],
      {
        json: true,
        help: false,
        envFile: null,
        service: null,
        confirm: false,
        confirmDevelopment: true,
        tag: "test-tag",
        changedSurfaces: [],
      },
      { env: { KUBE_CONTEXT: "tiara-stack-dev" } },
    );
    const requests: Parameters<ProcessExecutor>[0][] = [];
    const executor: ProcessExecutor = async (request) => {
      requests.push(request);
      return request.args.includes("upgrade")
        ? { exitCode: 1, stderr: "rollout failed" }
        : { exitCode: 0, stdout: "pod/sheet-web-abc 0/1 ImagePullBackOff" };
    };

    const executed = await executeKubernetesPlan(result, true, executor);

    // fallow-ignore-next-line code-duplication
    expect(executed.exitCode).toBe(2);
    expect(executed.output.readiness).toBe("blocked");
    expect(executed.output.errors[0]?.message).toContain("ImagePullBackOff");
    expect(requests.map(({ command }) => command)).toEqual(["helm", "helm", "helm", "kubectl"]);
    expect(requests[3]?.args).toEqual(
      expect.arrayContaining(["--context", "tiara-stack-dev", "--namespace", "tiara-stack-dev"]),
    );
  });

  it.live("uses Effect CLI to render root help and typed flags", () =>
    Effect.gen(function* () {
      const output = yield* runCliHelp();

      expect(output).toContain("Select a safe TiaraStack development mode");
      expect(output).toContain("--env-file");
      expect(output).toContain("--confirm-development");
      expect(output).toContain("--json");
      expect(output).toContain("--json-stream");
    }),
  );

  it.live("keeps mode help on the launcher command instead of Effect's root help flag", () =>
    Effect.gen(function* () {
      process.exitCode = 0;
      try {
        yield* Command.runWith(command, { version: "0.0.0" })(["fast", "help"]);
        const output = (yield* TestConsole.logLines).join("\n");

        expect(output).toContain("TiaraStack fast mode");
        expect(output).toContain("pnpm dev fast up");
      } finally {
        process.exitCode = 0;
      }
    }).pipe(Effect.provide(TestConsole.layer), Effect.provide(NodeServices.layer)),
  );

  it.live("keeps launcher failures structured through the Effect CLI handler", () =>
    Effect.gen(function* () {
      process.exitCode = 0;
      try {
        yield* Command.runWith(command, { version: "0.0.0" })(["unknown", "--json"]);
        const output = (yield* TestConsole.logLines).join("\n");

        expect(output).toContain('"code":"invalid-mode"');
        expect(process.exitCode).toBe(2);
      } finally {
        process.exitCode = 0;
      }
    }).pipe(Effect.provide(TestConsole.layer), Effect.provide(NodeServices.layer)),
  );
});
