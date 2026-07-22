import { beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { KimiClient, type RunOptions } from "./KimiClient";
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

const runEvents = (events: ReadonlyArray<unknown>, options: Partial<RunOptions> = {}) => {
  const turn = makeTurn(events);
  createSessionMock.mockReturnValue({
    sessionId: "session_1",
    prompt: vi.fn(() => turn),
    close: vi.fn(),
  });
  const result = Effect.gen(function* () {
    const client = yield* KimiClient;
    return yield* client.run({ prompt: "inspect", workDir: "/tmp/repo", ...options });
  }).pipe(Effect.provide(KimiClient.layer));
  return { turn, result };
};

const approvalRequest = (
  id: string,
  commands?: ReadonlyArray<string>,
): Record<string, unknown> => ({
  type: "ApprovalRequest",
  payload: {
    id,
    action: "Run shell command",
    description: commands?.join(" && ") ?? "git status",
    ...(commands === undefined
      ? {}
      : {
          display: commands.map((command) => ({ type: "shell", language: "bash", command })),
        }),
  },
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

  const approvalCases = [
    {
      name: "rejects approval requests by default",
      policy: undefined,
      requests: [approvalRequest("approval_1", ["git fetch origin main"])],
      decisions: [["approval_1", "reject"]],
    },
    {
      name: "approves simple git inspection commands when read-only git approvals are enabled",
      policy: "allow-read-only-git" as const,
      requests: [
        approvalRequest("approval_1", ["git diff -- packages/effect-ai-kimi/src/KimiClient.ts"]),
        approvalRequest("approval_2", ["git ls-remote origin main && git diff origin/main...HEAD"]),
      ],
      decisions: [
        ["approval_1", "approve"],
        ["approval_2", "approve"],
      ],
    },
    {
      name: "rejects unsafe shell chains even when read-only git approvals are enabled",
      policy: "allow-read-only-git" as const,
      requests: [approvalRequest("approval_1", ["git fetch origin main; rm -rf .git"])],
      decisions: [["approval_1", "reject"]],
    },
    {
      name: "rejects mutating git commands when read-only git approvals are enabled",
      policy: "allow-read-only-git" as const,
      requests: [
        approvalRequest("approval_1", ["git fetch origin main"]),
        approvalRequest("approval_2", ["git diff --output=/tmp/review.diff"]),
      ],
      decisions: [
        ["approval_1", "reject"],
        ["approval_2", "reject"],
      ],
    },
    {
      name: "rejects mixed approval payloads unless every shell command is allowed",
      policy: "allow-read-only-git" as const,
      requests: [
        approvalRequest("approval_1", ["git status", "git fetch origin main"]),
        approvalRequest("approval_2"),
      ],
      decisions: [
        ["approval_1", "reject"],
        ["approval_2", "reject"],
      ],
    },
    {
      name: "rejects top-level git config injection in approved git inspection commands",
      policy: "allow-read-only-git" as const,
      requests: [
        approvalRequest("approval_1", ["git -c core.sshCommand=/tmp/evil fetch origin main"]),
      ],
      decisions: [["approval_1", "reject"]],
    },
  ] as const;

  for (const testCase of approvalCases) {
    it.live(testCase.name, () =>
      Effect.gen(function* () {
        const options = testCase.policy === undefined ? {} : { approvalPolicy: testCase.policy };
        const { turn, result } = runEvents(testCase.requests, options);
        yield* result;

        for (const [id, decision] of testCase.decisions) {
          expect(turn.approve).toHaveBeenCalledWith(id, decision);
        }
      }),
    );
  }
});
