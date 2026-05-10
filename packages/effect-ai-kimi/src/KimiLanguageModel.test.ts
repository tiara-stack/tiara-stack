import { describe, expect, it } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AiError from "effect/unstable/ai/AiError";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { KimiClient, type RunOptions, type RunResult } from "./KimiClient";
import { Config as KimiConfig } from "./KimiConfig";
import { KimiTimeout } from "./KimiError";
import * as KimiLanguageModel from "./KimiLanguageModel";

const runResult = (
  finalResponse: string,
  events: RunResult["events"] = [
    { type: "ContentPart", payload: { type: "text", text: finalResponse } },
  ],
) =>
  ({
    sessionId: "session_1",
    finalResponse,
    events,
    status: "finished",
    usage: {
      input_other: 10,
      input_cache_read: 2,
      input_cache_creation: 3,
      output: 5,
    },
  }) as RunResult;

const withFakeClient = (
  run: (options: RunOptions) => Effect.Effect<RunResult, never> | Effect.Effect<RunResult, any>,
  runStreamed: () => Stream.Stream<RunResult["events"][number], never> = () => Stream.empty,
) =>
  Layer.provide(
    KimiLanguageModel.layer({ model: "kimi-k2", config: { workDir: "/tmp/repo" } }),
    Layer.succeed(KimiClient, {
      run,
      runStreamed,
    }),
  );

const failuresFromExit = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
    : [];

describe("KimiLanguageModel", () => {
  it("generateText returns final text from Kimi content", async () => {
    const response = await Effect.runPromise(
      LanguageModel.generateText({ prompt: "review" }).pipe(
        Effect.provide(withFakeClient(() => Effect.succeed(runResult("looks good")))),
      ),
    );

    expect(response.text).toBe("looks good");
    expect(response.content.some((part) => part.type === "finish")).toBe(true);
  });

  it("maps think content to reasoning parts", async () => {
    const response = await Effect.runPromise(
      LanguageModel.generateText({ prompt: "think" }).pipe(
        Effect.provide(
          withFakeClient(() =>
            Effect.succeed(
              runResult("answer", [
                { type: "ContentPart", payload: { type: "think", think: "reasoning" } },
                { type: "ContentPart", payload: { type: "text", text: "answer" } },
              ]),
            ),
          ),
        ),
      ),
    );

    expect(response.reasoningText).toBe("reasoning");
    expect(response.text).toBe("answer");
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

  it("passes provider external tools once through run options", async () => {
    const providerTool = {
      name: "provider_tool",
      description: "provider",
      parameters: {},
      handler: async () => ({ output: "{}", message: "ok" }),
    };
    let captured: RunOptions | undefined;
    await Effect.runPromise(
      LanguageModel.generateText({ prompt: "tools" }).pipe(
        Effect.provide(
          Layer.provide(
            KimiLanguageModel.layer({
              model: "kimi-k2",
              config: { workDir: "/tmp/repo", externalTools: [providerTool] },
            }),
            Layer.succeed(KimiClient, {
              run: (options) => {
                captured = options;
                return Effect.succeed(runResult("ok"));
              },
              runStreamed: () => Stream.empty,
            }),
          ),
        ),
      ),
    );

    expect(captured?.externalTools?.map((tool) => tool.name)).toEqual(["provider_tool"]);
    expect(captured?.inheritConfigExternalTools).toBe(false);
  });

  it("merges provider and service environment config", async () => {
    let captured: RunOptions | undefined;
    await Effect.runPromise(
      LanguageModel.generateText({ prompt: "env" }).pipe(
        Effect.provide(
          Layer.provide(
            KimiLanguageModel.layer({
              model: "kimi-k2",
              config: {
                workDir: "/tmp/repo",
                env: { PROVIDER_ONLY: "provider", SHARED: "provider" },
              },
            }),
            Layer.succeed(KimiClient, {
              run: (options) => {
                captured = options;
                return Effect.succeed(runResult("ok"));
              },
              runStreamed: () => Stream.empty,
            }),
          ),
        ),
        Effect.provide(
          Layer.succeed(KimiConfig, {
            env: { SERVICE_ONLY: "service", SHARED: "service" },
          }),
        ),
      ),
    );

    expect(captured?.sessionOptions?.env).toEqual({
      PROVIDER_ONLY: "provider",
      SERVICE_ONLY: "service",
      SHARED: "service",
    });
  });

  it("preserves session-level yoloMode when top-level config omits it", async () => {
    let captured: RunOptions | undefined;
    await Effect.runPromise(
      LanguageModel.generateText({ prompt: "review" }).pipe(
        Effect.provide(
          Layer.provide(
            KimiLanguageModel.layer({
              model: "kimi-k2",
              config: { workDir: "/tmp/repo", session: { yoloMode: true } },
            }),
            Layer.succeed(KimiClient, {
              run: (options) => {
                captured = options;
                return Effect.succeed(runResult("ok"));
              },
              runStreamed: () => Stream.empty,
            }),
          ),
        ),
      ),
    );

    expect(captured?.sessionOptions?.yoloMode).toBe(true);
  });

  it("generateText emits a single finish part when status updates include usage", async () => {
    const response = await Effect.runPromise(
      LanguageModel.generateText({ prompt: "usage" }).pipe(
        Effect.provide(
          withFakeClient(() =>
            Effect.succeed(
              runResult("answer", [
                { type: "ContentPart", payload: { type: "text", text: "answer" } },
                {
                  type: "StatusUpdate",
                  payload: {
                    token_usage: {
                      input_other: 10,
                      input_cache_read: 2,
                      input_cache_creation: 3,
                      output: 5,
                    },
                  },
                },
              ]),
            ),
          ),
        ),
      ),
    );

    expect(response.content.filter((part) => part.type === "finish")).toHaveLength(1);
  });

  it("generateObject appends JSON schema instructions and decodes valid JSON", async () => {
    let captured: RunOptions | undefined;
    const Output = Schema.Struct({ ok: Schema.Boolean });
    const response = await Effect.runPromise(
      LanguageModel.generateObject({
        prompt: "return json",
        schema: Output,
        objectName: "kimi_test_output",
      }).pipe(
        Effect.provide(
          withFakeClient((options) => {
            captured = options;
            return Effect.succeed(runResult(JSON.stringify({ ok: true })));
          }),
        ),
      ),
    );

    expect(response.value).toEqual({ ok: true });
    expect(captured?.prompt).toContain("return json\nReturn the final answer");
    expect(captured?.prompt).toContain("kimi_test_output");
    expect(captured?.prompt).toContain("JSON Schema");
  });

  it("generateObject extracts JSON when Kimi wraps it in prose", async () => {
    const Output = Schema.Struct({ ok: Schema.Boolean });
    const response = await Effect.runPromise(
      LanguageModel.generateObject({
        prompt: "return json",
        schema: Output,
        objectName: "kimi_test_output",
      }).pipe(
        Effect.provide(
          withFakeClient(() =>
            Effect.succeed(
              runResult(
                [
                  "The earlier code looked like { ok: true }.",
                  JSON.stringify({ matches: [] }),
                  JSON.stringify({ ok: true }),
                ].join("\n"),
              ),
            ),
          ),
        ),
      ),
    );

    expect(response.value).toEqual({ ok: true });
  });

  it("generateObject extracts nested response objects from provider wrappers", async () => {
    const Output = Schema.Struct({ target: Schema.String });
    const response = await Effect.runPromise(
      LanguageModel.generateObject({
        prompt: "return json",
        schema: Output,
        objectName: "kimi_test_output",
      }).pipe(
        Effect.provide(
          withFakeClient(() =>
            Effect.succeed(runResult(JSON.stringify({ result: { target: "nested" } }))),
          ),
        ),
      ),
    );

    expect(response.value).toEqual({ target: "nested" });
  });

  it("fails clearly when workDir is not configured", async () => {
    const exit = await Effect.runPromiseExit(
      LanguageModel.generateText({ prompt: "review" }).pipe(
        Effect.provide(
          Layer.provide(
            KimiLanguageModel.layer({ model: "kimi-k2" }),
            Layer.succeed(KimiClient, {
              run: () => Effect.succeed(runResult("ok")),
              runStreamed: () => Stream.empty,
            }),
          ),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("requires config.workDir");
  });

  it("generateObject ignores Kimi reasoning when decoding structured text", async () => {
    const Output = Schema.Struct({ ok: Schema.Boolean });
    const response = await Effect.runPromise(
      LanguageModel.generateObject({
        prompt: "return json",
        schema: Output,
        objectName: "kimi_test_output",
      }).pipe(
        Effect.provide(
          withFakeClient(() =>
            Effect.succeed(
              runResult(JSON.stringify({ ok: true }), [
                { type: "ContentPart", payload: { type: "think", think: "Let me analyze..." } },
                {
                  type: "ContentPart",
                  payload: { type: "text", text: JSON.stringify({ ok: true }) },
                },
              ]),
            ),
          ),
        ),
      ),
    );

    expect(response.value).toEqual({ ok: true });
  });

  it("invalid JSON fails as an AiError", async () => {
    const Output = Schema.Struct({ ok: Schema.Boolean });
    const exit = await Effect.runPromiseExit(
      LanguageModel.generateObject({
        prompt: "return json",
        schema: Output,
        objectName: "kimi_test_output",
      }).pipe(Effect.provide(withFakeClient(() => Effect.succeed(runResult("{"))))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(failuresFromExit(exit)[0]).toBeInstanceOf(AiError.AiError);
    }
  });

  it("maps Kimi timeouts to AiError", async () => {
    const exit = await Effect.runPromiseExit(
      LanguageModel.generateText({ prompt: "slow" }).pipe(
        Effect.provide(withFakeClient(() => Effect.fail(new KimiTimeout({ timeoutMs: 100 })))),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(failuresFromExit(exit)[0])).toContain("Kimi timed out after 100ms");
    }
  });

  it("represents Kimi tool calls and results as provider-executed parts", async () => {
    const ResolveSymbol = Tool.make("resolve_symbol", {
      parameters: Schema.Struct({ name: Schema.String }),
      success: Schema.String,
    });
    const GraphToolkit = Toolkit.make(ResolveSymbol);
    const response = await Effect.runPromise(
      LanguageModel.generateText({
        prompt: "use graph",
        toolkit: GraphToolkit,
        disableToolCallResolution: true,
      }).pipe(
        Effect.provide(
          withFakeClient(() =>
            Effect.succeed(
              runResult("", [
                {
                  type: "ToolCall",
                  payload: {
                    type: "function",
                    id: "tool_1",
                    function: { name: "resolve_symbol", arguments: '{"name":"run"}' },
                  },
                },
                {
                  type: "ToolResult",
                  payload: {
                    tool_call_id: "tool_1",
                    return_value: {
                      is_error: false,
                      output: '{"matches":[]}',
                      message: "ok",
                      display: [],
                    },
                  },
                },
              ]),
            ),
          ),
        ),
      ),
    );

    expect(response.toolCalls[0]).toMatchObject({
      id: "tool_1",
      name: "resolve_symbol",
      providerExecuted: true,
    });
    expect(response.toolResults[0]).toMatchObject({
      id: "tool_1",
      providerExecuted: true,
      isFailure: false,
    });
  });

  it("streamText emits finish usage from status updates", async () => {
    const parts = await Effect.runPromise(
      LanguageModel.streamText({ prompt: "stream" }).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.provide(
          withFakeClient(() =>
            Effect.succeed(
              runResult("answer later", [
                { type: "ContentPart", payload: { type: "text", text: "answer" } },
                {
                  type: "StatusUpdate",
                  payload: {
                    token_usage: {
                      input_other: 1,
                      input_cache_read: 0,
                      input_cache_creation: 0,
                      output: 1,
                    },
                  },
                },
                { type: "ContentPart", payload: { type: "text", text: " later" } },
                {
                  type: "StatusUpdate",
                  payload: {
                    token_usage: {
                      input_other: 10,
                      input_cache_read: 2,
                      input_cache_creation: 3,
                      output: 5,
                    },
                  },
                },
              ]),
            ),
          ),
        ),
      ),
    );

    const metadata = parts.find((part) => part.type === "response-metadata");
    const finish = parts.find((part) => part.type === "finish");
    expect(metadata).toMatchObject({ id: "session_1" });
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1);
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join(""),
    ).toBe("answer later");
    expect(finish?.usage.inputTokens.total).toBe(15);
    expect(finish?.usage.outputTokens.total).toBe(5);
  });
});
