import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { config } from "./config";

const readWorkflowRole = (env: Record<string, unknown>) =>
  config.sheetWorkflowsRole.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

const readRunnerHealthLabelSelector = (env: Record<string, unknown>) =>
  config.workflowsRunnerHealthLabelSelector.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

const readAutoKickConcurrency = (env: Record<string, unknown>) =>
  config.autoKickConcurrency.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

describe("sheet-workflows config", () => {
  it.effect("defaults SHEET_WORKFLOWS_ROLE to combined", () =>
    Effect.gen(function* () {
      expect(yield* readWorkflowRole({})).toBe("combined");
    }),
  );

  it.effect("accepts SHEET_WORKFLOWS_ROLE=api", () =>
    Effect.gen(function* () {
      expect(yield* readWorkflowRole({ SHEET_WORKFLOWS_ROLE: "api" })).toBe("api");
    }),
  );

  it.effect("accepts SHEET_WORKFLOWS_ROLE=runner", () =>
    Effect.gen(function* () {
      expect(yield* readWorkflowRole({ SHEET_WORKFLOWS_ROLE: "runner" })).toBe("runner");
    }),
  );

  it.effect("rejects invalid SHEET_WORKFLOWS_ROLE values", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(readWorkflowRole({ SHEET_WORKFLOWS_ROLE: "worker" }));
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("defaults WORKFLOWS_RUNNER_HEALTH_LABEL_SELECTOR to sheet-workflows", () =>
    Effect.gen(function* () {
      expect(yield* readRunnerHealthLabelSelector({})).toBe("app=sheet-workflows");
    }),
  );

  it.effect("accepts WORKFLOWS_RUNNER_HEALTH_LABEL_SELECTOR overrides", () =>
    Effect.gen(function* () {
      expect(
        yield* readRunnerHealthLabelSelector({
          WORKFLOWS_RUNNER_HEALTH_LABEL_SELECTOR: "app=sheet-workflows-runner",
        }),
      ).toBe("app=sheet-workflows-runner");
    }),
  );

  it.effect("rejects empty WORKFLOWS_RUNNER_HEALTH_LABEL_SELECTOR values", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        readRunnerHealthLabelSelector({ WORKFLOWS_RUNNER_HEALTH_LABEL_SELECTOR: "" }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("defaults AUTO_KICK_CONCURRENCY to four", () =>
    Effect.gen(function* () {
      expect(yield* readAutoKickConcurrency({})).toBe(4);
    }),
  );

  it.effect("accepts positive AUTO_KICK_CONCURRENCY overrides", () =>
    Effect.gen(function* () {
      expect(yield* readAutoKickConcurrency({ AUTO_KICK_CONCURRENCY: 2 })).toBe(2);
    }),
  );

  it.effect("rejects non-positive AUTO_KICK_CONCURRENCY values", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(readAutoKickConcurrency({ AUTO_KICK_CONCURRENCY: 0 }));
      expect(exit._tag).toBe("Failure");
    }),
  );
});
