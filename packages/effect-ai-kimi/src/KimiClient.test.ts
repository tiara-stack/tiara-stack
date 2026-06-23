import { beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { KimiClient } from "./KimiClient";
import { Config } from "./KimiConfig";
import { KimiTimeout } from "./KimiError";

const createSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@moonshot-ai/kimi-agent-sdk", () => ({
  createSession: createSessionMock,
}));

const makeTurn = (events: ReadonlyArray<unknown>) => ({
  async *[Symbol.asyncIterator]() {
    for (const event of events) {
      yield event;
    }
  },
  result: Promise.resolve({ status: "finished" }),
  approve: vi.fn(),
  interrupt: vi.fn(),
});

describe("KimiClient", () => {
  beforeEach(() => {
    createSessionMock.mockReset();
  });

  it.effect("collects finalResponse from text content only", () =>
    Effect.gen(function* () {
      const turn = makeTurn([
        { type: "ContentPart", payload: { type: "think", think: "Let me analyze..." } },
        { type: "ContentPart", payload: { type: "text", text: '{"ok":true}' } },
      ]);
      createSessionMock.mockReturnValue({
        sessionId: "session_1",
        prompt: vi.fn(() => turn),
        close: vi.fn(),
      });

      const result = yield* Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "return json",
          workDir: "/tmp/repo",
        });
      }).pipe(Effect.provide(KimiClient.layer));

      expect(result.finalResponse).toBe('{"ok":true}');
      expect(result.events).toHaveLength(2);
    }),
  );

  it.live("uses configured timeout when run options omit timeout", () =>
    Effect.gen(function* () {
      const interrupt = vi.fn();
      const close = vi.fn();
      const turn = {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<unknown>>(() => undefined),
          };
        },
        result: new Promise(() => undefined),
        approve: vi.fn(),
        interrupt,
      };
      createSessionMock.mockReturnValue({
        sessionId: "session_1",
        prompt: vi.fn(() => turn),
        close,
      });

      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const client = yield* KimiClient;
          return yield* client.run({
            prompt: "slow",
            workDir: "/tmp/repo",
          });
        }).pipe(
          Effect.provide(
            Layer.provide(
              KimiClient.layer,
              Layer.succeed(Config, { timeoutMs: 1, cleanupGraceMs: 1 }),
            ),
          ),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(failure).toBeInstanceOf(KimiTimeout);
        expect((failure as KimiTimeout).timeoutMs).toBe(1);
      }
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    }),
  );

  it.live("does not inherit configured external tools when run options opt out", () =>
    Effect.gen(function* () {
      const configuredTool = {
        name: "configured",
        description: "configured",
        parameters: {},
        handler: vi.fn(),
      };
      const runTool = {
        name: "run",
        description: "run",
        parameters: {},
        handler: vi.fn(),
      };
      const turn = makeTurn([]);
      createSessionMock.mockReturnValue({
        sessionId: "session_1",
        prompt: vi.fn(() => turn),
        close: vi.fn(),
      });

      yield* Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "tools",
          workDir: "/tmp/repo",
          externalTools: [runTool],
          inheritConfigExternalTools: false,
        });
      }).pipe(
        Effect.provide(
          Layer.provide(
            KimiClient.layer,
            Layer.succeed(Config, { externalTools: [configuredTool] }),
          ),
        ),
      );

      expect(createSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({ externalTools: [runTool] }),
      );
    }),
  );

  it.live("merges configured and per-run environment overrides", () =>
    Effect.gen(function* () {
      const turn = makeTurn([]);
      createSessionMock.mockReturnValue({
        sessionId: "session_1",
        prompt: vi.fn(() => turn),
        close: vi.fn(),
      });

      yield* Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "env",
          workDir: "/tmp/repo",
          sessionOptions: {
            env: {
              REQUEST_ONLY: "request",
              SHARED: "request",
            },
          },
        });
      }).pipe(
        Effect.provide(
          Layer.provide(
            KimiClient.layer,
            Layer.succeed(Config, {
              env: {
                CONFIG_ONLY: "config",
                SHARED: "config",
              },
              session: {
                env: {
                  SESSION_ONLY: "session",
                  SHARED: "session",
                },
              },
            }),
          ),
        ),
      );

      expect(createSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          env: {
            SESSION_ONLY: "session",
            CONFIG_ONLY: "config",
            REQUEST_ONLY: "request",
            SHARED: "request",
          },
        }),
      );
    }),
  );

  it.live("inherits configured external tools by default for direct client use", () =>
    Effect.gen(function* () {
      const configuredTool = {
        name: "configured",
        description: "configured",
        parameters: {},
        handler: vi.fn(),
      };
      const turn = makeTurn([]);
      createSessionMock.mockReturnValue({
        sessionId: "session_1",
        prompt: vi.fn(() => turn),
        close: vi.fn(),
      });

      yield* Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "tools",
          workDir: "/tmp/repo",
        });
      }).pipe(
        Effect.provide(
          Layer.provide(
            KimiClient.layer,
            Layer.succeed(Config, { externalTools: [configuredTool] }),
          ),
        ),
      );

      expect(createSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({ externalTools: [configuredTool] }),
      );
    }),
  );

  it.live("rejects approval requests by default", () =>
    Effect.gen(function* () {
      const turn = makeTurn([
        {
          type: "ApprovalRequest",
          payload: {
            id: "approval_1",
            action: "Run shell command",
            description: "git fetch origin main",
            display: [{ type: "shell", language: "bash", command: "git fetch origin main" }],
          },
        },
      ]);
      createSessionMock.mockReturnValue({
        sessionId: "session_1",
        prompt: vi.fn(() => turn),
        close: vi.fn(),
      });

      yield* Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "fetch",
          workDir: "/tmp/repo",
        });
      }).pipe(Effect.provide(KimiClient.layer));

      expect(turn.approve).toHaveBeenCalledWith("approval_1", "reject");
    }),
  );

  it.live("approves simple git inspection commands when read-only git approvals are enabled", () =>
    Effect.gen(function* () {
      const turn = makeTurn([
        {
          type: "ApprovalRequest",
          payload: {
            id: "approval_1",
            action: "Run shell command",
            description: "git diff -- packages/effect-ai-kimi/src/KimiClient.ts",
            display: [
              {
                type: "shell",
                language: "bash",
                command: "git diff -- packages/effect-ai-kimi/src/KimiClient.ts",
              },
            ],
          },
        },
        {
          type: "ApprovalRequest",
          payload: {
            id: "approval_2",
            action: "Run shell command",
            description: "git ls-remote origin main && git diff origin/main...HEAD",
            display: [
              {
                type: "shell",
                language: "bash",
                command: "git ls-remote origin main && git diff origin/main...HEAD",
              },
            ],
          },
        },
      ]);
      createSessionMock.mockReturnValue({
        sessionId: "session_1",
        prompt: vi.fn(() => turn),
        close: vi.fn(),
      });

      yield* Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "fetch",
          workDir: "/tmp/repo",
          approvalPolicy: "allow-read-only-git",
        });
      }).pipe(Effect.provide(KimiClient.layer));

      expect(turn.approve).toHaveBeenCalledWith("approval_1", "approve");
      expect(turn.approve).toHaveBeenCalledWith("approval_2", "approve");
    }),
  );

  it.live("rejects unsafe shell chains even when read-only git approvals are enabled", () =>
    Effect.gen(function* () {
      const turn = makeTurn([
        {
          type: "ApprovalRequest",
          payload: {
            id: "approval_1",
            action: "Run shell command",
            description: "git fetch origin main; rm -rf .git",
            display: [
              { type: "shell", language: "bash", command: "git fetch origin main; rm -rf .git" },
            ],
          },
        },
      ]);
      createSessionMock.mockReturnValue({
        sessionId: "session_1",
        prompt: vi.fn(() => turn),
        close: vi.fn(),
      });

      yield* Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "fetch",
          workDir: "/tmp/repo",
          approvalPolicy: "allow-read-only-git",
        });
      }).pipe(Effect.provide(KimiClient.layer));

      expect(turn.approve).toHaveBeenCalledWith("approval_1", "reject");
    }),
  );

  it.live("rejects mutating git commands when read-only git approvals are enabled", () =>
    Effect.gen(function* () {
      const turn = makeTurn([
        {
          type: "ApprovalRequest",
          payload: {
            id: "approval_1",
            action: "Run shell command",
            description: "git fetch origin main",
            display: [{ type: "shell", language: "bash", command: "git fetch origin main" }],
          },
        },
        {
          type: "ApprovalRequest",
          payload: {
            id: "approval_2",
            action: "Run shell command",
            description: "git diff --output=/tmp/review.diff",
            display: [
              { type: "shell", language: "bash", command: "git diff --output=/tmp/review.diff" },
            ],
          },
        },
      ]);
      createSessionMock.mockReturnValue({
        sessionId: "session_1",
        prompt: vi.fn(() => turn),
        close: vi.fn(),
      });

      yield* Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "inspect",
          workDir: "/tmp/repo",
          approvalPolicy: "allow-read-only-git",
        });
      }).pipe(Effect.provide(KimiClient.layer));

      expect(turn.approve).toHaveBeenCalledWith("approval_1", "reject");
      expect(turn.approve).toHaveBeenCalledWith("approval_2", "reject");
    }),
  );

  it.live("rejects mixed approval payloads unless every shell command is allowed", () =>
    Effect.gen(function* () {
      const turn = makeTurn([
        {
          type: "ApprovalRequest",
          payload: {
            id: "approval_1",
            action: "Run shell command",
            description: "git status",
            display: [
              { type: "shell", language: "bash", command: "git status" },
              { type: "shell", language: "bash", command: "git fetch origin main" },
            ],
          },
        },
        {
          type: "ApprovalRequest",
          payload: {
            id: "approval_2",
            action: "Run shell command",
            description: "git status",
          },
        },
      ]);
      createSessionMock.mockReturnValue({
        sessionId: "session_1",
        prompt: vi.fn(() => turn),
        close: vi.fn(),
      });

      yield* Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "inspect",
          workDir: "/tmp/repo",
          approvalPolicy: "allow-read-only-git",
        });
      }).pipe(Effect.provide(KimiClient.layer));

      expect(turn.approve).toHaveBeenCalledWith("approval_1", "reject");
      expect(turn.approve).toHaveBeenCalledWith("approval_2", "reject");
    }),
  );

  it.live("rejects top-level git config injection in approved git inspection commands", () =>
    Effect.gen(function* () {
      const turn = makeTurn([
        {
          type: "ApprovalRequest",
          payload: {
            id: "approval_1",
            action: "Run shell command",
            description: "git -c core.sshCommand=/tmp/evil fetch origin main",
            display: [
              {
                type: "shell",
                language: "bash",
                command: "git -c core.sshCommand=/tmp/evil fetch origin main",
              },
            ],
          },
        },
      ]);
      createSessionMock.mockReturnValue({
        sessionId: "session_1",
        prompt: vi.fn(() => turn),
        close: vi.fn(),
      });

      yield* Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "fetch",
          workDir: "/tmp/repo",
          approvalPolicy: "allow-read-only-git",
        });
      }).pipe(Effect.provide(KimiClient.layer));

      expect(turn.approve).toHaveBeenCalledWith("approval_1", "reject");
    }),
  );
});
