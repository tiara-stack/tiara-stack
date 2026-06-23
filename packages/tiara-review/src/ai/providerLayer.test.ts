import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { CodexAgentFailed } from "../review/types";
import {
  kimiModelConfig,
  kimiSessionConfig,
  makeKimiGraphTools,
  makeLanguageModelLayer,
  openAiLanguageModelLayer,
  openRouterLanguageModelLayer,
} from "./providerLayer";

const baseOptions = {
  aspect: "security",
  repoRoot: "/repo",
  schema: Schema.Struct({}),
} as const;

describe("provider layer helpers", () => {
  it("skips Kimi graph tools without graph configuration", () => {
    expect(makeKimiGraphTools(baseOptions)).toBeUndefined();
  });

  it.effect("requires a model for HTTP providers", () =>
    Effect.gen(function* () {
      const exit5 = yield* Effect.exit(
        makeLanguageModelLayer({ ...baseOptions, provider: "openai" }),
      );
      expect(exit5._tag).toBe("Failure");
      if (exit5._tag === "Failure") {
        expect(String(exit5.cause)).toContain(CodexAgentFailed.name);
      }
    }),
  );

  it.effect("rejects blank HTTP provider models", () =>
    Effect.gen(function* () {
      const exit5 = yield* Effect.exit(
        makeLanguageModelLayer({ ...baseOptions, provider: "openai", model: "   " }),
      );
      expect(exit5._tag).toBe("Failure");
      if (exit5._tag === "Failure") {
        expect(String(exit5.cause)).toContain(CodexAgentFailed.name);
      }
    }),
  );

  it("maps Kimi session config fields defensively", () => {
    expect(
      kimiSessionConfig({
        config: {
          sessionId: "session-1",
          model: "kimi-k2",
          thinking: true,
          yoloMode: false,
          executable: "kimi",
          env: { A: "B" },
          agentFile: "agent.md",
          skillsDir: "skills",
          shareDir: "share",
          clientInfo: { name: "tiara-review", version: "1.0.0" },
        },
      }),
    ).toEqual({
      sessionId: "session-1",
      model: "kimi-k2",
      thinking: true,
      yoloMode: false,
      executable: "kimi",
      env: { A: "B" },
      agentFile: "agent.md",
      skillsDir: "skills",
      shareDir: "share",
      clientInfo: { name: "tiara-review", version: "1.0.0" },
    });
  });

  it("drops invalid Kimi session config", () => {
    expect(kimiSessionConfig({ config: { env: { A: 1 } } })).toBeUndefined();
  });

  it("derives Kimi model config from run options", () => {
    expect(
      kimiModelConfig(
        {
          ...baseOptions,
          modelReasoningEffort: "high",
          providerConfig: { kimi: { approvalPolicy: "reject", yoloMode: true } },
        },
        undefined,
      ),
    ).toMatchObject({
      workDir: "/repo",
      thinking: true,
      approvalPolicy: "reject",
      yoloMode: true,
    });
  });

  it("builds HTTP provider layers when a model is present", () => {
    expect(
      openAiLanguageModelLayer({ ...baseOptions, provider: "openai" }, "gpt-test"),
    ).toBeDefined();
    expect(
      openRouterLanguageModelLayer({ ...baseOptions, provider: "openrouter" }, "router-test"),
    ).toBeDefined();
  });
});
