import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeProjectName,
  getComposeExecutionContext,
  lifecycleEventFor,
  parseCommand,
  runLauncher,
  type AccessChecker,
  type PortChecker,
  type ProcessExecutor,
} from "./index";

describe("developer launcher command boundary", () => {
  it("accepts lifecycle JSON as an explicit output mode and rejects mixed JSON modes", async () => {
    const parsed = parseCommand(["fast", "up", "--json-stream"]);

    expect(parsed.kind).toBe("mode");
    expect(parsed.options.json).toBe(false);
    expect(parsed.options.jsonStream).toBe(true);

    const plan = await runLauncher(["fast", "up", "--json-stream"], {
      env: {},
      portChecker: async () => ({ available: true }),
    });
    expect(JSON.parse(plan.stdout)).toEqual(
      expect.objectContaining({
        type: "planned",
        format: "tiara-stack.development.lifecycle",
        eventVersion: 1,
      }),
    );

    const result = await runLauncher(["fast", "up", "--json", "--json-stream"], {
      env: {},
      portChecker: async () => ({ available: true }),
    });
    const output = JSON.parse(result.stdout) as {
      readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
    };

    expect(result.exitCode).toBe(2);
    expect(output.diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid-option",
        message: expect.stringContaining("cannot be used together"),
      }),
    ]);
  });

  it("redacts untrusted lifecycle reasons and credential-bearing origins", async () => {
    const result = await runLauncher(["fast", "up", "--json"], {
      env: {},
      portChecker: async () => ({ available: true }),
    });
    const credentialOrigin = new URL("https://example.test/ready?token=query-secret");
    credentialOrigin.username = "user";
    credentialOrigin.password = "origin-secret";
    const event = lifecycleEventFor(
      {
        sequence: 1,
        mode: "fast",
        action: "up",
        service: "sheet-web",
        type: "readiness",
        status: "blocked",
        origin: credentialOrigin.toString(),
        reason:
          'token=reason-secret API_KEY=api-key-secret ACCESS_TOKEN=access-token-secret CLIENT_SECRET=client-secret password="quoted password secret" TOKEN=\'quoted token secret\' {"password":"json-password"}',
      },
      result.output,
    );

    expect(JSON.stringify(event)).not.toContain("origin-secret");
    expect(JSON.stringify(event)).not.toContain("query-secret");
    expect(JSON.stringify(event)).not.toContain("reason-secret");
    expect(JSON.stringify(event)).not.toContain("api-key-secret");
    expect(JSON.stringify(event)).not.toContain("access-token-secret");
    expect(JSON.stringify(event)).not.toContain("client-secret");
    expect(JSON.stringify(event)).not.toContain("quoted password secret");
    expect(JSON.stringify(event)).not.toContain("quoted token secret");
    expect(JSON.stringify(event)).not.toContain("json-password");
    expect(event.origin).toBe("https://<redacted>@example.test/ready?token=<redacted>");
    expect(event.reason).toBe(
      'token=<redacted> API_KEY=<redacted> ACCESS_TOKEN=<redacted> CLIENT_SECRET=<redacted> password="<redacted>" TOKEN=\'<redacted>\' {"password":"<redacted>"}',
    );
  });

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

  it("plans a host-native sheet-auth watch process against local dependencies", async () => {
    const result = await runLauncher(["fast", "up", "--service", "sheet-auth", "--json"], {
      env: {
        POSTGRES_URL: "postgres://tiara:local-password@localhost:5432/tiara",
        REDIS_URL: "redis://default:local-password@localhost:6379",
        DISCORD_CLIENT_ID: "local-client",
        DISCORD_CLIENT_SECRET: "local-secret",
        DEV_LOCAL_JWKS_PORT: "8082",
      },
      portChecker: async () => ({ available: true }),
    });
    const output = JSON.parse(result.stdout) as {
      readonly selectedServices: readonly string[];
      readonly urls: readonly { readonly name: string; readonly url: string }[];
      readonly plannedProcesses: readonly {
        readonly id: string;
        readonly command: string;
        readonly args: readonly string[];
        readonly environment: Readonly<Record<string, string>>;
      }[];
    };

    expect(result.exitCode).toBe(0);
    expect(output.selectedServices).toEqual(["sheet-auth"]);
    expect(output.urls).toContainEqual({ name: "sheet-auth", url: "http://localhost:3002" });
    expect(output.plannedProcesses).toEqual([
      expect.objectContaining({
        command: "pnpm",
        args: ["exec", "tsx", "watch", "--tsconfig", "tsconfig.json", "src/server.ts"],
        environment: expect.objectContaining({
          BASE_URL: "http://localhost:3002",
          POSTGRES_URL: "<redacted>",
          REDIS_URL: "<redacted>",
          PORT: "3002",
        }),
      }),
    ]);
    expect(result.output.plannedProcesses[0]?.environment.SHEET_AUTH_OAUTH_JWKS_URL).toBe(
      "http://localhost:8082/.well-known/jwks.json",
    );
    expect(result.stdout).not.toContain("local-password");
  });

  it("plans the sheet-bot only when explicitly selected with local development credentials", async () => {
    const result = await runLauncher(["fast", "up", "--service", "sheet-bot", "--json"], {
      env: {
        SHEET_BOT_DEV_DISCORD_TOKEN: "development-token",
        REDIS_URL: "redis://localhost:6379",
        SHEET_BOT_OAUTH_CLIENT_ID: "local-bot",
        SHEET_BOT_OAUTH_CLIENT_SECRET: "local-bot-secret",
        SHEET_BOT_CAPABILITY_ENCRYPTION_SECRET: "local-bot-capability-secret-32-characters",
      },
      portChecker: async () => ({ available: true }),
    });
    const output = JSON.parse(result.stdout) as {
      readonly selectedServices: readonly string[];
      readonly plannedProcesses: readonly {
        readonly args: readonly string[];
        readonly environment: Readonly<Record<string, string>>;
      }[];
    };

    expect(result.exitCode).toBe(0);
    expect(output.selectedServices).toEqual(["sheet-bot"]);
    expect(output.plannedProcesses[0]).toEqual(
      expect.objectContaining({
        args: ["exec", "tsx", "watch", "--tsconfig", "tsconfig.json", "src/main.ts"],
        environment: expect.objectContaining({
          DISCORD_TOKEN: "<redacted>",
          SHEET_WORKFLOWS_BASE_URL: "http://localhost:3003",
          SHEET_WEB_BASE_URL: "http://localhost:3001",
          SHEET_AUTH_ISSUER: "http://localhost:3002",
          ZERO_CACHE_SERVER: "http://localhost:4848",
        }),
      }),
    );
    expect(result.stdout).not.toContain("development-token");
  });

  // fallow-ignore-next-line code-duplication
  it("rejects a host-native bot without its development credential set", async () => {
    const result = await runLauncher(["fast", "up", "--service", "sheet-bot", "--json"], {
      env: {
        REDIS_URL: "redis://localhost:6379",
        SHEET_BOT_OAUTH_CLIENT_ID: "local-bot",
        SHEET_BOT_OAUTH_CLIENT_SECRET: "local-bot-secret",
        SHEET_BOT_CAPABILITY_ENCRYPTION_SECRET: "local-bot-capability-secret-32-characters",
      },
      portChecker: async () => ({ available: true }),
    });
    const output = JSON.parse(result.stdout) as {
      readonly errors: readonly { readonly code: string }[];
    };

    expect(result.exitCode).toBe(2);
    expect(output.errors.map(({ code }) => code)).toContain("unsafe-credential");
    expect(output.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("SHEET_BOT_DEV_DISCORD_TOKEN"),
        }),
      ]),
    );
    expect(result.stdout).not.toContain("development-token");
  });

  it("rejects production and legacy Discord credentials for host-native bot mode", async () => {
    const result = await runLauncher(["fast", "up", "--service", "sheet-bot", "--json"], {
      env: {
        DISCORD_TOKEN: "production-token",
        SHEET_BOT_DEV_DISCORD_TOKEN: "development-token",
        REDIS_URL: "redis://localhost:6379",
        SHEET_BOT_OAUTH_CLIENT_ID: "local-bot",
        SHEET_BOT_OAUTH_CLIENT_SECRET: "local-bot-secret",
        SHEET_BOT_CAPABILITY_ENCRYPTION_SECRET: "local-bot-capability-secret-32-characters",
      },
    });

    expect(result.exitCode).toBe(2);
    expect(result.output.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("DISCORD_TOKEN") }),
      ]),
    );
    expect(result.stdout).not.toContain("production-token");
    expect(result.stdout).not.toContain("development-token");
  });

  it("plans the host-native workflow API with the selected supported role", async () => {
    const result = await runLauncher(["fast", "up", "--service", "sheet-workflows", "--json"], {
      cwd: path.resolve(process.cwd(), "../.."),
      env: {
        POSTGRES_URL: "postgres://tiara:local-password@localhost:5432/tiara",
        SHEET_AUTH_OAUTH_CLIENT_ID: "local-workflows",
        SHEET_AUTH_OAUTH_CLIENT_SECRET: "local-workflows-secret",
        SHEET_WORKFLOWS_ROLE: "api",
      },
      portChecker: async () => ({ available: true }),
    });
    const output = JSON.parse(result.stdout) as {
      readonly selectedServices: readonly string[];
      readonly plannedProcesses: readonly {
        readonly id: string;
        readonly command: string;
        readonly args: readonly string[];
        readonly environment: Readonly<Record<string, string>>;
      }[];
    };

    expect(result.exitCode).toBe(0);
    expect(output.selectedServices).toEqual(["sheet-workflows"]);
    expect(output.plannedProcesses).toEqual([
      expect.objectContaining({
        id: "sheet-workflows",
        command: "pnpm",
        args: ["exec", "tsx", "watch", "--tsconfig", "tsconfig.json", "src/index.ts"],
        environment: expect.objectContaining({
          PORT: "3003",
          SHEET_WORKFLOWS_ROLE: "api",
          WORKFLOWS_RUNNER_HOST: "localhost",
          POSTGRES_URL: "<redacted>",
          SHEET_AUTH_OAUTH_CLIENT_SECRET: "<redacted>",
        }),
      }),
    ]);
    expect(result.stdout).not.toContain("local-password");
  });

  it("rejects runner roles instead of starting them as host processes", async () => {
    const result = await runLauncher(["fast", "up", "--service", "sheet-workflows", "--json"], {
      env: {
        POSTGRES_URL: "postgres://tiara:local-password@localhost:5432/tiara",
        SHEET_AUTH_OAUTH_CLIENT_ID: "local-workflows",
        SHEET_AUTH_OAUTH_CLIENT_SECRET: "local-workflows-secret",
        SHEET_WORKFLOWS_ROLE: "browser-runner",
      },
    });
    const output = JSON.parse(result.stdout) as {
      readonly errors: readonly { readonly code: string }[];
      readonly plannedProcesses: readonly unknown[];
    };

    expect(result.exitCode).toBe(2);
    expect(output.errors.map(({ code }) => code)).toContain("invalid-environment");
    expect(output.plannedProcesses).toEqual([]);
  });

  it("preserves the combined workflow role and listener port in its host plan", async () => {
    const result = await runLauncher(["fast", "up", "--service", "sheet-workflows", "--json"], {
      cwd: path.resolve(process.cwd(), "../.."),
      env: {
        POSTGRES_URL: "postgres://tiara:local-password@localhost:5432/tiara",
        SHEET_AUTH_OAUTH_CLIENT_ID: "local-workflows",
        SHEET_AUTH_OAUTH_CLIENT_SECRET: "local-workflows-secret",
        SHEET_WORKFLOWS_ROLE: "combined",
        DEV_WORKFLOWS_RUNNER_PORT: "34432",
        WORKFLOWS_RUNNER_LISTEN_PORT: "34432",
      },
      portChecker: async () => ({ available: true }),
    });
    const output = JSON.parse(result.stdout) as {
      readonly plannedProcesses: readonly {
        readonly environment: Readonly<Record<string, string>>;
      }[];
    };

    expect(result.exitCode).toBe(0);
    expect(output.plannedProcesses[0]?.environment).toEqual(
      expect.objectContaining({
        SHEET_WORKFLOWS_ROLE: "combined",
        WORKFLOWS_RUNNER_LISTEN_PORT: "34432",
      }),
    );
  });

  it("rejects a host-native service when a dependency uses Compose-only DNS", async () => {
    const result = await runLauncher(["fast", "up", "--service", "sheet-db-server", "--json"], {
      // fallow-ignore-next-line code-duplication
      env: { POSTGRES_URL: "postgres://tiara:password@postgres:5432/tiara" },
    });
    const output = JSON.parse(result.stdout) as {
      readonly errors: readonly { readonly code: string }[];
    };

    expect(result.exitCode).toBe(2);
    expect(output.errors.map(({ code }) => code)).toContain("unsafe-origin");
    expect(result.stdout).not.toContain("password");
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

  it("loads the default Fast environment file without accepting backend credentials", async () => {
    const repository = mkdtempSync(path.join(tmpdir(), "developer-launcher-fast-"));
    writeFileSync(
      path.join(repository, ".env.development.local"),
      [
        "APP_BASE_URL=http://localhost:3001",
        "AUTH_BASE_URL=https://auth.dev.theerapakg.moe",
        "SHEET_ZERO_BASE_URL=https://zero.dev.theerapakg.moe",
        "SHEET_WORKFLOWS_BASE_URL=https://workflows.dev.theerapakg.moe",
        "DATABASE_READ_URL=super-secret-db",
      ].join("\n"),
    );

    try {
      const result = await runLauncher(["fast", "up", "--json"], {
        cwd: repository,
        env: {},
        portChecker: async () => ({ available: true }),
      });
      const output = JSON.parse(result.stdout) as {
        readonly errors: readonly unknown[];
        readonly plannedProcesses: readonly {
          readonly environment: Readonly<Record<string, string>>;
        }[];
      };

      expect(result.exitCode).toBe(2);
      expect(output.errors).toEqual([expect.objectContaining({ code: "unsafe-credential" })]);
      expect(result.stdout).not.toContain("super-secret-db");
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it.each(["DATABASE_READ_URL", "REDIS_CONNECTION_URL", "DISCORD_BOT_TOKEN", "GOOGLE_CREDENTIALS"])(
    "rejects %s in Fast mode before startup",
    async (key) => {
      // fallow-ignore-next-line code-duplication
      const result = await runLauncher(["fast", "up", "--json"], {
        env: { [key]: "must-not-be-used" },
        portChecker: async () => ({ available: true }),
      });
      const output = JSON.parse(result.stdout) as {
        readonly errors: readonly { readonly code: string }[];
      };

      expect(result.exitCode).toBe(2);
      expect(output.errors.map(({ code }) => code)).toContain("unsafe-credential");
      expect(result.stdout).not.toContain("must-not-be-used");
    },
  );

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

  // fallow-ignore-next-line code-duplication
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
        readonly id: string;
        readonly command: string;
        readonly args: readonly string[];
        readonly environment: Readonly<Record<string, string>>;
      }[];
    };

    expect(result.exitCode).toBe(0);
    expect(output.plannedProcesses.find(({ id }) => id === "kubernetes-preview")).toEqual(
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
        environment: expect.objectContaining({
          KUBE_CONTEXT: "tiara-stack-dev",
          KUBE_NAMESPACE: "tiara-stack-dev",
          KUBE_RELEASE: "tiara-stack-dev",
          DEV_IMAGE_REGISTRY: expect.any(String),
        }),
      }),
    );
    expect(executions).toEqual([]);
  });

  it("selects affected parity overlays and reports unaffected overlays", async () => {
    const result = await runLauncher(
      [
        "kubernetes",
        "preview",
        "--tag",
        "feature-190",
        "--confirm-development",
        "--changed-surface",
        "authentication",
        "--changed-surface",
        "persistence",
        "--json",
      ],
      { env: { KUBE_CONTEXT: "tiara-stack-dev" } },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output.changedSurfaces).toEqual(["authentication", "persistence"]);
    expect(result.output.parityGates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "compose-evidence", status: "required" }),
        expect.objectContaining({ id: "api-smoke", status: "required" }),
        expect.objectContaining({ id: "ordinary-runner-smoke", status: "required" }),
        expect.objectContaining({ id: "kubernetes-invariants", status: "required" }),
        expect.objectContaining({ id: "browser-runner-smoke", status: "not-affected" }),
        expect.objectContaining({ id: "discord-development-check", status: "not-affected" }),
      ]),
    );
    expect(result.output.plannedProcesses.map(({ id }) => id)).toEqual([
      "kubernetes-compose-evidence",
      "helm-lint",
      "helm-render",
      "kubernetes-preview",
      "kubernetes-api-evidence",
      "kubernetes-workload-readiness",
      "kubernetes-api-smoke",
      "kubernetes-ordinary-runner-smoke",
      "kubernetes-kubernetes-invariants",
    ]);
  });

  it("blocks preview when an affected parity gate fails", async () => {
    const result = await runLauncher(
      [
        "kubernetes",
        "preview",
        "--tag",
        "feature-190",
        "--confirm-development",
        "--changed-surface",
        "workflow-runner",
        "--json",
      ],
      { env: { KUBE_CONTEXT: "tiara-stack-dev" } },
    );
    const executed = await (
      await import("./cli")
    ).executeKubernetesPlan(result, true, async (request) =>
      request.args.includes("--gate") && request.args.includes("workflow-contract-smoke")
        ? { exitCode: 1, stderr: "terminal contract failed" }
        : { exitCode: 0 },
    );

    expect(executed.exitCode).toBe(2);
    expect(executed.output.readiness).toBe("blocked");
    expect(executed.output.errors[0]?.message).toContain("kubernetes-workflow-contract-smoke");
  });

  // fallow-ignore-next-line code-duplication
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
        "compose-docker-check",
        "compose-dependencies",
        "compose-migrations",
        "compose-applications",
      ]);
      const planned = JSON.parse(result.stdout) as {
        readonly checkoutState: string | null;
        readonly plannedProcesses: readonly {
          readonly args: readonly string[];
        }[];
      };
      expect(planned.checkoutState).toMatch(/^Checkout State tiara-/);
      expect(planned.plannedProcesses[1]?.args).toEqual(
        expect.arrayContaining(["--project-name", composeProjectName(repository)]),
      );
      expect(planned.plannedProcesses[1]?.args).toEqual(
        expect.arrayContaining(["--wait", "--wait-timeout", "150"]),
      );
      const context = getComposeExecutionContext(result.output);
      if (context === undefined) throw new Error("expected a cached Compose execution context");
      expect(context.environment).toEqual(
        expect.objectContaining({
          POSTGRES_PASSWORD: "local-postgres-password",
          REDIS_PASSWORD: "local-redis-password",
          SHEET_BOT_OAUTH_CLIENT_ID: "local-bot",
        }),
      );
      expect(getComposeExecutionContext({ ...result.output })).toBeUndefined();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  // fallow-ignore-next-line code-duplication
  it("builds package artifacts explicitly before Compose images", async () => {
    const repository = mkdtempSync(path.join(tmpdir(), "developer-launcher-compose-build-"));
    const envFile = path.join(repository, "compose.env");
    writeFileSync(envFile, "SHEET_WEB_PUBLIC_BASE_URL=http://localhost:3001\n");
    try {
      const result = await runLauncher(["compose", "build", "--env-file", envFile, "--json"], {
        cwd: repository,
        env: {},
      });
      const output = JSON.parse(result.stdout) as {
        readonly plannedProcesses: readonly { readonly id: string }[];
      };
      expect(result.exitCode).toBe(0);
      expect(output.plannedProcesses.map(({ id }) => id)).toEqual([
        "compose-build-artifact-sheet-auth",
        "compose-build-artifact-sheet-db-server",
        "compose-build-artifact-sheet-workflows",
        "compose-build-artifact-sheet-web",
        "compose-build-artifact-sheet-bot",
        "compose-build",
      ]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("plans Compose setup as local credential preparation", async () => {
    const result = await runLauncher(["setup", "compose", "--json"], { env: {} });
    const output = JSON.parse(result.stdout) as {
      readonly readiness: string;
      readonly plannedProcesses: readonly { readonly args: readonly string[] }[];
    };
    expect(result.exitCode).toBe(0);
    expect(output.readiness).toBe("planned");
    expect(output.plannedProcesses[0]?.args).toEqual(["compose:generate-secrets"]);
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
      return {
        exitCode: 0,
        ...(request.args.includes("infisicalstaticsecret")
          ? { stdout: "infisicalstaticsecret/tiara-stack-dev" }
          : {}),
      };
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
      expect(requests.length).toBe(11);
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

  it("reports a missing centrally managed Kubernetes credential set", async () => {
    const result = await runLauncher(["doctor", "--json"], {
      cwd: tmpdir(),
      env: { KUBE_CONTEXT: "tiara-stack-dev" },
      executor: async () => ({ exitCode: 0 }),
      portChecker: async () => ({ available: true }),
      accessChecker: async () => ({ reachable: true }),
    });
    const output = JSON.parse(result.stdout) as {
      readonly errors: readonly { readonly dependency: string | null }[];
    };

    expect(output.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dependency: "centrally managed Development Credential Set" }),
      ]),
    );
  });

  it.each([
    [["unknown", "--json"], "invalid-mode"],
    [["compose", "unknown", "--json"], "invalid-action"],
  ] as const)("rejects %j before executing a process", async (args, code) => {
    const executions: Parameters<ProcessExecutor>[0][] = [];
    const executor: ProcessExecutor = async (request) => {
      executions.push(request);
      return { exitCode: 0 };
    };

    // fallow-ignore-next-line code-duplication
    const result = await runLauncher(args, { executor });
    const output = JSON.parse(result.stdout) as { errors: readonly { code: string }[] };

    expect(result.exitCode).toBe(2);
    expect(output.errors[0]?.code).toBe(code);
    expect(executions).toEqual([]);
  });
});
