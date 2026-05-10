import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("collects finalResponse from text content only", async () => {
    const turn = makeTurn([
      { type: "ContentPart", payload: { type: "think", think: "Let me analyze..." } },
      { type: "ContentPart", payload: { type: "text", text: '{"ok":true}' } },
    ]);
    createSessionMock.mockReturnValue({
      sessionId: "session_1",
      prompt: vi.fn(() => turn),
      close: vi.fn(),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "return json",
          workDir: "/tmp/repo",
        });
      }).pipe(Effect.provide(KimiClient.layer)),
    );

    expect(result.finalResponse).toBe('{"ok":true}');
    expect(result.events).toHaveLength(2);
  });

  it("uses configured timeout when run options omit timeout", async () => {
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

    const exit = await Effect.runPromiseExit(
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
  });

  it("does not inherit configured external tools when run options opt out", async () => {
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

    await Effect.runPromise(
      Effect.gen(function* () {
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
      ),
    );

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ externalTools: [runTool] }),
    );
  });

  it("merges configured and per-run environment overrides", async () => {
    const turn = makeTurn([]);
    createSessionMock.mockReturnValue({
      sessionId: "session_1",
      prompt: vi.fn(() => turn),
      close: vi.fn(),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
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
  });

  it("inherits configured external tools by default for direct client use", async () => {
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

    await Effect.runPromise(
      Effect.gen(function* () {
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
      ),
    );

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ externalTools: [configuredTool] }),
    );
  });

  it("rejects approval requests by default", async () => {
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

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "fetch",
          workDir: "/tmp/repo",
        });
      }).pipe(Effect.provide(KimiClient.layer)),
    );

    expect(turn.approve).toHaveBeenCalledWith("approval_1", "reject");
  });

  it("approves simple git inspection commands when read-only git approvals are enabled", async () => {
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
          description: "git fetch origin main && git diff origin/main...HEAD",
          display: [
            {
              type: "shell",
              language: "bash",
              command: "git fetch origin main && git diff origin/main...HEAD",
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

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "fetch",
          workDir: "/tmp/repo",
          approvalPolicy: "allow-read-only-git",
        });
      }).pipe(Effect.provide(KimiClient.layer)),
    );

    expect(turn.approve).toHaveBeenCalledWith("approval_1", "approve");
    expect(turn.approve).toHaveBeenCalledWith("approval_2", "approve");
  });

  it("rejects unsafe shell chains even when read-only git approvals are enabled", async () => {
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

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "fetch",
          workDir: "/tmp/repo",
          approvalPolicy: "allow-read-only-git",
        });
      }).pipe(Effect.provide(KimiClient.layer)),
    );

    expect(turn.approve).toHaveBeenCalledWith("approval_1", "reject");
  });

  it("rejects top-level git config injection in approved git inspection commands", async () => {
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

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* KimiClient;
        return yield* client.run({
          prompt: "fetch",
          workDir: "/tmp/repo",
          approvalPolicy: "allow-read-only-git",
        });
      }).pipe(Effect.provide(KimiClient.layer)),
    );

    expect(turn.approve).toHaveBeenCalledWith("approval_1", "reject");
  });
});
