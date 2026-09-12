import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runLauncher, type AccessChecker, type PortChecker, type ProcessExecutor } from "./index";

describe("developer launcher command boundary", () => {
  it("prints help for the bare command without executing a process", async () => {
    const executions: Parameters<ProcessExecutor>[0][] = [];
    const executor: ProcessExecutor = async (request) => {
      executions.push(request);
      return { exitCode: 0 };
    };

    const result = await runLauncher([], { executor });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pnpm dev fast");
    expect(result.stdout).toContain("pnpm dev doctor");
    expect(executions).toEqual([]);
  });

  it("prints mode help without starting a mode that has no action", async () => {
    const executions: Parameters<ProcessExecutor>[0][] = [];
    const executor: ProcessExecutor = async (request) => {
      executions.push(request);
      return { exitCode: 0 };
    };

    const result = await runLauncher(["compose"], { executor });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pnpm dev compose up");
    expect(result.stdout).toContain("pnpm dev compose reset --confirm");
    expect(executions).toEqual([]);
  });

  it("plans the Fast sheet-web process with safe development URLs", async () => {
    const executions: Parameters<ProcessExecutor>[0][] = [];
    const executor: ProcessExecutor = async (request) => {
      executions.push(request);
      return { exitCode: 0 };
    };

    const result = await runLauncher(["fast", "up", "--json"], {
      executor,
      env: {},
      portChecker: async () => ({ available: true }),
    });
    const output = JSON.parse(result.stdout) as {
      readonly mode: string;
      readonly action: string;
      readonly readiness: string;
      readonly selectedServices: readonly string[];
      readonly plannedProcesses: readonly {
        readonly id: string;
        readonly command: string;
        readonly args: readonly string[];
        readonly environment: Readonly<Record<string, string>>;
      }[];
      readonly urls: readonly { readonly name: string; readonly url: string }[];
    };

    expect(result.exitCode).toBe(0);
    expect(output.mode).toBe("fast");
    expect(output.action).toBe("up");
    expect(output.readiness).toBe("planned");
    expect(output.selectedServices).toEqual(["sheet-web"]);
    expect(output.plannedProcesses).toEqual([
      expect.objectContaining({
        id: "sheet-web",
        command: "vp",
        args: ["dev", "--port", "3001"],
        environment: {
          APP_BASE_URL: "http://localhost:3001",
          AUTH_BASE_URL: "https://auth.dev.theerapakg.moe",
          SHEET_ZERO_BASE_URL: "https://zero.dev.theerapakg.moe",
          SHEET_WORKFLOWS_BASE_URL: "https://workflows.dev.theerapakg.moe",
        },
      }),
    ]);
    expect(output.urls).toEqual([
      { name: "app", url: "http://localhost:3001" },
      { name: "auth", url: "https://auth.dev.theerapakg.moe" },
      { name: "zero", url: "https://zero.dev.theerapakg.moe" },
      { name: "workflows", url: "https://workflows.dev.theerapakg.moe" },
    ]);
    expect(executions).toEqual([]);
  });

  it("rejects production origins and backend secrets without exposing their values", async () => {
    const secret = "production-token-that-must-not-be-printed";
    const result = await runLauncher(["fast", "up", "--json"], {
      env: {
        AUTH_BASE_URL: "https://auth.theerapakg.moe",
        POSTGRES_URL: `postgres://user:${secret}@production.example/tiara`,
      },
    });
    const output = JSON.parse(result.stdout) as {
      readonly errors: readonly { readonly code: string }[];
    };

    expect(result.exitCode).toBe(2);
    expect(output.errors.map(({ code }) => code)).toEqual(["unsafe-credential", "unsafe-origin"]);
    expect(result.stdout).not.toContain(secret);
  });

  // fallow-ignore-next-line code-duplication
  it("requires explicit confirmation for a Compose reset", async () => {
    const result = await runLauncher(["compose", "reset", "--json"], { env: {} });
    const output = JSON.parse(result.stdout) as {
      readonly errors: readonly { readonly code: string }[];
    };

    expect(result.exitCode).toBe(2);
    expect(output.errors[0]?.code).toBe("confirmation-required");
  });

  it("rejects an occupied deterministic Fast port without choosing a replacement", async () => {
    const result = await runLauncher(["fast", "up", "--json"], {
      env: {},
      portChecker: async () => ({ available: false }),
    });
    const output = JSON.parse(result.stdout) as {
      readonly plannedProcesses: readonly unknown[];
      readonly errors: readonly {
        readonly code: string;
        readonly port: number | null;
      }[];
    };

    expect(result.exitCode).toBe(2);
    expect(output.errors).toEqual([
      expect.objectContaining({ code: "port-collision", port: 3001 }),
    ]);
    expect(output.plannedProcesses).toEqual([
      expect.objectContaining({ args: ["dev", "--port", "3001"] }),
    ]);
  });

  it("keeps an explicit Fast port deterministic and binds the local URL to it", async () => {
    const result = await runLauncher(["fast", "up", "--json"], {
      env: { DEV_SHEET_WEB_PORT: "3011" },
      portChecker: async (port) => ({ available: port === 3011 }),
    });
    const output = JSON.parse(result.stdout) as {
      readonly urls: readonly { readonly name: string; readonly url: string }[];
      readonly plannedProcesses: readonly { readonly args: readonly string[] }[];
    };

    expect(result.exitCode).toBe(0);
    expect(output.urls[0]).toEqual({ name: "app", url: "http://localhost:3011" });
    expect(output.plannedProcesses[0]?.args).toEqual(["dev", "--port", "3011"]);
  });

  it("rejects invalid port assignments before planning a process", async () => {
    const result = await runLauncher(["fast", "up", "--json"], {
      env: { DEV_SHEET_WEB_PORT: "0" },
      portChecker: async () => ({ available: true }),
    });
    const output = JSON.parse(result.stdout) as {
      readonly errors: readonly { readonly code: string; readonly port: number | null }[];
    };

    expect(result.exitCode).toBe(2);
    expect(output.errors).toEqual([expect.objectContaining({ code: "invalid-port", port: 0 })]);
  });

  it("plans a development-only Kubernetes preview with the fixed release and tag", async () => {
    const executions: Parameters<ProcessExecutor>[0][] = [];
    const result = await runLauncher(
      ["kubernetes", "preview", "--tag", "feature-183", "--confirm-development", "--json"],
      {
        env: { KUBE_CONTEXT: "tiara-stack-dev" },
        executor: async (request) => {
          executions.push(request);
          return { exitCode: 0 };
        },
      },
    );
    const output = JSON.parse(result.stdout) as {
      readonly plannedProcesses: readonly {
        readonly command: string;
        readonly args: readonly string[];
        readonly environment: Readonly<Record<string, string>>;
      }[];
    };

    expect(result.exitCode).toBe(0);
    expect(output.plannedProcesses[0]).toEqual(
      expect.objectContaining({
        command: "helm",
        args: expect.arrayContaining([
          "upgrade",
          "--install",
          "tiara-stack-dev",
          "--namespace",
          "tiara-stack-dev",
          "--set-string",
          "global.appImage.tag=feature-183",
        ]),
        environment: {},
      }),
    );
    expect(executions).toEqual([]);
  });

  it("keeps Compose dependency, migration, and application plans ordered", async () => {
    const repository = mkdtempSync(path.join(tmpdir(), "developer-launcher-compose-"));
    const envFile = path.join(repository, "compose.env");
    writeFileSync(
      envFile,
      [
        "POSTGRES_PASSWORD=local-postgres-password",
        "REDIS_PASSWORD=local-redis-password",
        "SHEET_BOT_CAPABILITY_ENCRYPTION_SECRET=local-bot-capability-secret-32-characters",
        "SHEET_BOT_OAUTH_CLIENT_ID=local-bot",
        "SHEET_BOT_OAUTH_CLIENT_SECRET=local-bot-secret",
        "SHEET_WORKFLOWS_OAUTH_CLIENT_ID=local-workflows",
        "SHEET_WORKFLOWS_OAUTH_CLIENT_SECRET=local-workflows-secret",
      ].join("\n"),
    );

    try {
      const result = await runLauncher(["compose", "up", "--env-file", envFile, "--json"], {
        cwd: repository,
        env: {},
        portChecker: async () => ({ available: true }),
      });
      const output = JSON.parse(result.stdout) as {
        readonly plannedProcesses: readonly { readonly id: string }[];
      };

      expect(result.exitCode).toBe(0);
      expect(output.plannedProcesses.map(({ id }) => id)).toEqual([
        "compose-dependencies",
        "compose-migrations",
        "compose-applications",
      ]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("runs doctor checks through the read-only executor and keeps observability failures as warnings", async () => {
    const repository = mkdtempSync(path.join(tmpdir(), "developer-launcher-doctor-"));
    const composeDirectory = path.join(repository, "deploy/compose");
    const secretsDirectory = path.join(composeDirectory, "secrets");
    mkdirSync(secretsDirectory, { recursive: true });
    for (const file of ["postgres-password", "redis-password", "jwks.json"]) {
      writeFileSync(path.join(secretsDirectory, file), "local-development-value\n");
    }
    const envFile = path.join(composeDirectory, ".env");
    writeFileSync(
      envFile,
      [
        "POSTGRES_PASSWORD=local-postgres-password",
        "REDIS_PASSWORD=local-redis-password",
        "SHEET_BOT_CAPABILITY_ENCRYPTION_SECRET=local-bot-capability-secret-32-characters",
        "SHEET_BOT_OAUTH_CLIENT_ID=local-bot",
        "SHEET_BOT_OAUTH_CLIENT_SECRET=local-bot-secret",
        "SHEET_WORKFLOWS_OAUTH_CLIENT_ID=local-workflows",
        "SHEET_WORKFLOWS_OAUTH_CLIENT_SECRET=local-workflows-secret",
        "SHEET_WEB_PUBLIC_BASE_URL=http://localhost:3001",
        "SHEET_AUTH_PUBLIC_BASE_URL=http://localhost:3002",
        "SHEET_ZERO_PUBLIC_BASE_URL=http://localhost:4848",
        "SHEET_WORKFLOWS_PUBLIC_BASE_URL=http://localhost:3003",
        "TRUSTED_ORIGINS=http://localhost:3001,http://localhost:3002",
      ].join("\n"),
    );
    chmodSync(envFile, 0o600);

    const requests: Parameters<ProcessExecutor>[0][] = [];
    const executor: ProcessExecutor = async (request) => {
      requests.push(request);
      return { exitCode: 0 };
    };
    const portChecker: PortChecker = async () => ({ available: true });
    const accessChecker: AccessChecker = async (request) => ({
      reachable: !request.optional,
    });

    try {
      const result = await runLauncher(["doctor", "--env-file", envFile, "--json"], {
        cwd: repository,
        env: { KUBE_CONTEXT: "tiara-stack-dev" },
        executor,
        portChecker,
        accessChecker,
      });
      const output = JSON.parse(result.stdout) as {
        readonly ok: boolean;
        readonly readiness: string;
        readonly errors: readonly unknown[];
        readonly warnings: readonly { readonly code: string }[];
      };

      expect(result.exitCode).toBe(0);
      expect(output.ok).toBe(true);
      expect(output.readiness).toBe("ready");
      expect(output.errors).toEqual([]);
      expect(output.warnings.map(({ code }) => code)).toEqual(["access-failed"]);
      expect(requests.length).toBe(6);
      expect(requests.every((request) => request.kind === "dependency-check")).toBe(true);
      expect(requests.every((request) => request.readOnly)).toBe(true);
      expect(requests.every((request) => request.timeoutMs <= 2_000)).toBe(true);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("makes required dependency and port failures blocking", async () => {
    const executor: ProcessExecutor = async (request) =>
      request.command === "helm" ? { exitCode: 1, timedOut: true } : { exitCode: 0 };
    const portChecker: PortChecker = async (port) => ({ available: port !== 3001 });
    const accessChecker: AccessChecker = async () => ({ reachable: true });

    const result = await runLauncher(["doctor", "--json"], {
      cwd: tmpdir(),
      env: { KUBE_CONTEXT: "tiara-stack-dev" },
      executor,
      portChecker,
      accessChecker,
    });
    const output = JSON.parse(result.stdout) as {
      readonly readiness: string;
      readonly errors: readonly {
        readonly code: string;
        readonly mode: string | null;
        readonly dependency: string | null;
        readonly port: number | null;
        readonly remediation: string;
      }[];
    };

    expect(result.exitCode).toBe(2);
    expect(output.readiness).toBe("blocked");
    expect(output.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "dependency-timeout",
          mode: "kubernetes",
          dependency: "Helm",
        }),
        expect.objectContaining({
          code: "port-collision",
          dependency: "sheet-web",
          port: 3001,
        }),
      ]),
    );
    expect(output.errors.every(({ remediation }) => remediation.length > 0)).toBe(true);
  });

  it.each([
    [["unknown", "--json"], "invalid-mode"],
    [["compose", "unknown", "--json"], "invalid-action"],
    [["fast", "up", "--service", "sheet-auth", "--json"], "invalid-service"],
  ] as const)("rejects %j before executing a process", async (args, code) => {
    const executions: Parameters<ProcessExecutor>[0][] = [];
    const executor: ProcessExecutor = async (request) => {
      executions.push(request);
      return { exitCode: 0 };
    };

    const result = await runLauncher(args, { executor });
    const output = JSON.parse(result.stdout) as { errors: readonly { code: string }[] };

    expect(result.exitCode).toBe(2);
    expect(output.errors[0]?.code).toBe(code);
    expect(executions).toEqual([]);
  });
});
