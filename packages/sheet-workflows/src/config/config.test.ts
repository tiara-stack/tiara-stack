import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { config } from "./config";

const readWorkflowRole = (env: Record<string, unknown>) =>
  Effect.runPromise(
    config.sheetWorkflowsRole.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    ),
  );

const readRunnerHealthLabelSelector = (env: Record<string, unknown>) =>
  Effect.runPromise(
    config.workflowsRunnerHealthLabelSelector.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    ),
  );

describe("sheet-workflows config", () => {
  it("defaults SHEET_WORKFLOWS_ROLE to combined", async () => {
    await expect(readWorkflowRole({})).resolves.toBe("combined");
  });

  it("accepts SHEET_WORKFLOWS_ROLE=api", async () => {
    await expect(readWorkflowRole({ SHEET_WORKFLOWS_ROLE: "api" })).resolves.toBe("api");
  });

  it("accepts SHEET_WORKFLOWS_ROLE=runner", async () => {
    await expect(readWorkflowRole({ SHEET_WORKFLOWS_ROLE: "runner" })).resolves.toBe("runner");
  });

  it("rejects invalid SHEET_WORKFLOWS_ROLE values", async () => {
    await expect(readWorkflowRole({ SHEET_WORKFLOWS_ROLE: "worker" })).rejects.toThrow();
  });

  it("defaults WORKFLOWS_RUNNER_HEALTH_LABEL_SELECTOR to sheet-workflows", async () => {
    await expect(readRunnerHealthLabelSelector({})).resolves.toBe("app=sheet-workflows");
  });

  it("accepts WORKFLOWS_RUNNER_HEALTH_LABEL_SELECTOR overrides", async () => {
    await expect(
      readRunnerHealthLabelSelector({
        WORKFLOWS_RUNNER_HEALTH_LABEL_SELECTOR: "app=sheet-workflows-runner",
      }),
    ).resolves.toBe("app=sheet-workflows-runner");
  });

  it("rejects empty WORKFLOWS_RUNNER_HEALTH_LABEL_SELECTOR values", async () => {
    await expect(
      readRunnerHealthLabelSelector({ WORKFLOWS_RUNNER_HEALTH_LABEL_SELECTOR: "" }),
    ).rejects.toThrow();
  });
});
