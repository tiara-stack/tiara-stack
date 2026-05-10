import { describe, expect, it } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AiError from "effect/unstable/ai/AiError";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import * as ResponseIdTracker from "effect/unstable/ai/ResponseIdTracker";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { CodexClient, type RunOptions, type RunResult } from "./CodexClient";
import { Config as CodexConfig } from "./CodexConfig";
import * as CodexLanguageModel from "./CodexLanguageModel";
import { CodexTimeout } from "./CodexError";

const usage = {
  input_tokens: 10,
  cached_input_tokens: 2,
  output_tokens: 5,
  reasoning_output_tokens: 1,
};

const runResult = (
  finalResponse: string,
  items: RunResult["items"] = [{ id: "item_1", type: "agent_message", text: finalResponse }],
) =>
  ({
    threadId: "thread_1",
    finalResponse,
    items,
    usage,
  }) as RunResult;

const withFakeClient = (
  run: (options: RunOptions) => Effect.Effect<RunResult, never> | Effect.Effect<RunResult, any>,
) =>
  Layer.provide(
    CodexLanguageModel.layer({ model: "gpt-5-codex" }),
    Layer.succeed(CodexClient, {
      run,
      runStreamed: () => Stream.empty,
    }),
  );

const failuresFromExit = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
    : [];

describe("CodexLanguageModel", () => {
  it("generateText returns final text from Codex final response", async () => {
    const program = LanguageModel.generateText({ prompt: "review this" });
    const response = await Effect.runPromise(
      program.pipe(Effect.provide(withFakeClient(() => Effect.succeed(runResult("looks good"))))),
    );

    expect(response.text).toBe("looks good");
    expect(response.content.some((part) => part.type === "finish")).toBe(true);
  });

  it("preserves message roles when flattening multi-message prompts", async () => {
    let captured: RunOptions | undefined;
    await Effect.runPromise(
      LanguageModel.generateText({
        prompt: [
          { role: "system", content: "follow policy" },
          { role: "user", content: "review this" },
        ],
      }).pipe(
        Effect.provide(
          withFakeClient((options) => {
            captured = options;
            return Effect.succeed(runResult("looks good"));
          }),
        ),
      ),
    );

    expect(captured?.prompt).toBe("system:\nfollow policy\n\nuser:\nreview this");
  });

  it("merges provider and service environment config", async () => {
    let captured: RunOptions | undefined;
    await Effect.runPromise(
      LanguageModel.generateText({ prompt: "review" }).pipe(
        Effect.provide(
          Layer.provide(
            CodexLanguageModel.layer({
              model: "gpt-5-codex",
              config: { env: { PROVIDER_ONLY: "provider", SHARED: "provider" } },
            }),
            Layer.succeed(CodexClient, {
              run: (options) => {
                captured = options;
                return Effect.succeed(runResult("ok"));
              },
              runStreamed: () => Stream.empty,
            }),
          ),
        ),
        Effect.provide(
          Layer.succeed(CodexConfig, {
            env: { SERVICE_ONLY: "service", SHARED: "service" },
          }),
        ),
      ),
    );

    expect(captured?.clientOptions?.env).toEqual({
      PROVIDER_ONLY: "provider",
      SERVICE_ONLY: "service",
      SHARED: "service",
    });
  });

  it("resumes the Codex thread tracked from prior response metadata", async () => {
    const firstUser = Prompt.make("first").content[0]!;
    const assistant = Prompt.make([{ role: "assistant", content: "first answer" }]).content[0]!;
    const secondUser = Prompt.make("continue").content[0]!;
    const captured: Array<RunOptions> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* LanguageModel.generateText({
          prompt: Prompt.fromMessages([firstUser]),
        });
        yield* LanguageModel.generateText({
          prompt: Prompt.fromMessages([firstUser, assistant, secondUser]),
        });
      }).pipe(
        Effect.provide(
          withFakeClient((options) => {
            captured.push(options);
            return Effect.succeed(runResult("continued"));
          }),
        ),
        Effect.provide(Layer.effect(ResponseIdTracker.ResponseIdTracker, ResponseIdTracker.make)),
      ),
    );

    expect(captured[1]?.threadId).toBe("thread_1");
  });

  it("generateObject passes JSON schema to Codex run and decodes a valid object", async () => {
    let captured: RunOptions | undefined;
    const Output = Schema.Struct({ ok: Schema.Boolean });
    const program = LanguageModel.generateObject({
      prompt: "return json",
      schema: Output,
      objectName: "codex_test_output",
    });

    const response = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          withFakeClient((options) => {
            captured = options;
            return Effect.succeed(runResult(JSON.stringify({ ok: true })));
          }),
        ),
      ),
    );

    expect(response.value).toEqual({ ok: true });
    expect(captured?.turnOptions?.outputSchema).toMatchObject({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
  });

  it("generateObject maps invalid output to AiError", async () => {
    const Output = Schema.Struct({ ok: Schema.Boolean });
    const exit = await Effect.runPromiseExit(
      LanguageModel.generateObject({
        prompt: "return json",
        schema: Output,
        objectName: "codex_test_output",
      }).pipe(
        Effect.provide(
          withFakeClient(() => Effect.succeed(runResult(JSON.stringify({ ok: "no" })))),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failures = failuresFromExit(exit);
      expect(failures[0]).toBeInstanceOf(AiError.AiError);
      expect(String(failures[0])).toContain("Structured output validation failed");
    }
  });

  it("maps Codex timeouts to AiError", async () => {
    const exit = await Effect.runPromiseExit(
      LanguageModel.generateText({ prompt: "slow" }).pipe(
        Effect.provide(withFakeClient(() => Effect.fail(new CodexTimeout({ timeoutMs: 100 })))),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failures = failuresFromExit(exit);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures[0]).toBeInstanceOf(AiError.AiError);
      expect(String(failures[0])).toContain("Codex timed out after 100ms");
    }
  });

  it("represents MCP tool events as provider-executed tool parts", async () => {
    const GraphTool = Tool.providerDefined({
      id: "codex.mcp_graph_resolve_symbol",
      customName: "mcp.graph.resolve_symbol",
      providerName: "resolve_symbol",
      parameters: Schema.Unknown,
      success: Schema.Unknown,
      failure: Schema.Unknown,
    })();
    const GraphToolkit = Toolkit.make(GraphTool);
    const response = await Effect.runPromise(
      LanguageModel.generateText({ prompt: "use graph", toolkit: GraphToolkit }).pipe(
        Effect.provide(
          withFakeClient(() =>
            Effect.succeed(
              runResult("", [
                {
                  id: "tool_1",
                  type: "mcp_tool_call",
                  server: "graph",
                  tool: "resolve_symbol",
                  arguments: { name: "run" },
                  result: { content: [], structured_content: { matches: [] } },
                  status: "completed",
                },
              ]),
            ),
          ),
        ),
      ),
    );

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]).toMatchObject({
      id: "tool_1",
      name: "mcp.graph.resolve_symbol",
      providerExecuted: true,
    });
    expect(response.toolResults[0]).toMatchObject({
      id: "tool_1",
      name: "mcp.graph.resolve_symbol",
      providerExecuted: true,
      isFailure: false,
    });
  });
});
