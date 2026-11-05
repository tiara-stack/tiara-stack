import { describe, expect, it } from "@effect/vitest";
import { Cause, Config, ConfigProvider, Effect, Exit, Option } from "effect";
import { config } from "./config";
import { sheetWorkflowsRuntimePolicy } from "./runtimePolicy";
import { sheetWorkflowContractCatalogDigest } from "../workflows/catalogIdentity";
import { getSheetDbMigrationArtifactDigest } from "sheet-zero-server/state-plane-admission";

const sheetDbMigrationArtifactDigest = getSheetDbMigrationArtifactDigest();

const readWorkflowRole = (env: Record<string, unknown>) =>
  config.sheetWorkflowsRole.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

const readHost = (env: Record<string, unknown>) =>
  config.host.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))));

const readRunnerHealthLabelSelector = (env: Record<string, unknown>) =>
  config.workflowsRunnerHealthLabelSelector.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

const readAutoKickConcurrency = (env: Record<string, unknown>) =>
  config.autoKickConcurrency.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

const readScreenshotBrowserConcurrency = (env: Record<string, unknown>) =>
  config.screenshotBrowserConcurrency.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

const readTrustedSheetPersistenceMaxConnections = (env: Record<string, unknown>) =>
  config.trustedSheetPersistenceMaxConnections.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

const readTrustedSheetPersistenceStatementTimeoutMillis = (env: Record<string, unknown>) =>
  config.trustedSheetPersistenceStatementTimeoutMillis.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

const sourceConfigErrorMessage = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? Cause.findErrorOption(exit.cause).pipe(
        Option.flatMap((error) => {
          if (!(error instanceof Config.ConfigError)) return Option.none();
          if (!(error.cause instanceof ConfigProvider.SourceError)) return Option.none();
          return Option.some(error.cause.message);
        }),
      )
    : Option.none();

describe("sheet-workflows config", () => {
  it.effect("leaves HOST unset unless the operator configures it", () =>
    Effect.gen(function* () {
      expect(yield* readHost({})).toEqual(Option.none());
      expect(yield* readHost({ HOST: "0.0.0.0" })).toEqual(Option.some("0.0.0.0"));
    }),
  );

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

  it.effect("accepts the producer-only API role", () =>
    Effect.gen(function* () {
      expect(yield* readWorkflowRole({ SHEET_WORKFLOWS_ROLE: "producer" })).toBe("producer");
    }),
  );

  it.effect("defaults producer trigger, smoke, and target ownership capabilities off", () =>
    Effect.gen(function* () {
      const policy = yield* sheetWorkflowsRuntimePolicy.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              SHEET_WORKFLOWS_ROLE: "producer",
              WORKFLOWS_STATE_PLANE_POLICY: "shared-admission",
              WORKFLOWS_PREVIEW_CATALOG_DIGEST: sheetWorkflowContractCatalogDigest,
              WORKFLOWS_PREVIEW_SCHEMA_ARTIFACT_DIGEST: sheetDbMigrationArtifactDigest,
              WORKFLOWS_AUTONOMOUS_TRIGGER_NAMES: "not-a-trigger",
              WORKFLOWS_SMOKE_WORKFLOW_ENABLED: "not-a-boolean",
            }),
          ),
        ),
      );

      expect(policy).toMatchObject({
        role: "producer",
        producer: true,
        workflowApi: true,
        workflowRunner: false,
        reconciliationConsumer: false,
        autonomousTriggerNames: [],
        smokeEnqueue: false,
        triggerTargetOwner: { _tag: "None" },
      });
    }),
  );

  it.effect("rejects producer startup unless shared State Plane admission is selected", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        sheetWorkflowsRuntimePolicy.pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_WORKFLOWS_ROLE: "producer" })),
          ),
        ),
      );

      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("rejects a session-bound producer without complete profile identities", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        sheetWorkflowsRuntimePolicy.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                SHEET_WORKFLOWS_ROLE: "producer",
                WORKFLOWS_STATE_PLANE_POLICY: "shared-admission",
                WORKFLOWS_PREVIEW_SESSION_ID: "123e4567-e89b-42d3-a456-426614174000",
                WORKFLOWS_PREVIEW_API_ENDPOINT: "https://session-api.dev.tiara-stack.moe",
                WORKFLOWS_SOURCE_REVISION: `sha256:${"d".repeat(64)}`,
                WORKFLOWS_PREVIEW_GROUP_TARGET: "workflow-execution:state:manifest:api:catalog",
                WORKFLOWS_PREVIEW_MANIFEST_DIGEST: `sha256:${"b".repeat(64)}`,
                WORKFLOWS_PREVIEW_CATALOG_DIGEST: sheetWorkflowContractCatalogDigest,
                WORKFLOWS_PREVIEW_SCHEMA_ARTIFACT_DIGEST: sheetDbMigrationArtifactDigest,
              }),
            ),
          ),
        ),
      );

      expect(exit._tag).toBe("Failure");
      const failureMessage = sourceConfigErrorMessage(exit);
      expect(Option.isSome(failureMessage)).toBe(true);
      if (Option.isSome(failureMessage))
        expect(failureMessage.value).toContain("A session-bound producer requires");
    }),
  );

  it.effect(
    "admits readiness identity only with the producer profile's exact revision and group",
    () =>
      Effect.gen(function* () {
        const policy = yield* sheetWorkflowsRuntimePolicy.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                SHEET_WORKFLOWS_ROLE: "producer",
                WORKFLOWS_STATE_PLANE_POLICY: "shared-admission",
                WORKFLOWS_PREVIEW_SESSION_ID: "123e4567-e89b-42d3-a456-426614174000",
                WORKFLOWS_PREVIEW_API_ENDPOINT: "https://session-api.dev.tiara-stack.moe",
                WORKFLOWS_SOURCE_REVISION: `sha256:${"d".repeat(64)}`,
                WORKFLOWS_PREVIEW_GROUP_TARGET: "workflow-execution:state:manifest:api:catalog",
                WORKFLOWS_PREVIEW_API_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
                WORKFLOWS_PREVIEW_MANIFEST_DIGEST: `sha256:${"b".repeat(64)}`,
                WORKFLOWS_PREVIEW_CATALOG_DIGEST: sheetWorkflowContractCatalogDigest,
                WORKFLOWS_PREVIEW_SCHEMA_ARTIFACT_DIGEST: sheetDbMigrationArtifactDigest,
              }),
            ),
          ),
        );

        expect(policy).toMatchObject({
          role: "producer",
          producer: true,
          workflowRunner: false,
          reconciliationConsumer: false,
          autonomousTriggerNames: [],
          smokeEnqueue: false,
          workflowContractCatalogDigest: sheetWorkflowContractCatalogDigest,
          schemaArtifactDigest: sheetDbMigrationArtifactDigest,
        });
      }),
  );

  it.effect("rejects a stale contract or Action Version catalog digest", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        sheetWorkflowsRuntimePolicy.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                SHEET_WORKFLOWS_ROLE: "producer",
                WORKFLOWS_STATE_PLANE_POLICY: "shared-admission",
                WORKFLOWS_PREVIEW_CATALOG_DIGEST: `sha256:${"e".repeat(64)}`,
              }),
            ),
          ),
        ),
      );

      expect(exit._tag).toBe("Failure");
      const failureMessage = sourceConfigErrorMessage(exit);
      expect(Option.isSome(failureMessage)).toBe(true);
      if (Option.isSome(failureMessage))
        expect(failureMessage.value).toContain(
          "Producer Workflow Contract catalog digest does not match",
        );
    }),
  );

  it.effect("rejects a missing or stale producer migration artifact identity", () =>
    Effect.gen(function* () {
      const base = {
        SHEET_WORKFLOWS_ROLE: "producer",
        WORKFLOWS_STATE_PLANE_POLICY: "shared-admission",
        WORKFLOWS_PREVIEW_CATALOG_DIGEST: sheetWorkflowContractCatalogDigest,
      };
      for (const env of [
        base,
        {
          ...base,
          WORKFLOWS_PREVIEW_SCHEMA_ARTIFACT_DIGEST: `sha256:${"0".repeat(64)}`,
        },
        {
          ...base,
          WORKFLOWS_PREVIEW_SCHEMA_ARTIFACT_DIGEST: `sha256:${"e".repeat(64)}`,
        },
      ]) {
        const exit = yield* Effect.exit(
          sheetWorkflowsRuntimePolicy.pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
          ),
        );
        expect(exit._tag).toBe("Failure");
        const failureMessage = sourceConfigErrorMessage(exit);
        expect(Option.isSome(failureMessage)).toBe(true);
        if (Option.isSome(failureMessage))
          expect(failureMessage.value).toContain(
            "Producer schema artifact identity does not match",
          );
      }
    }),
  );

  it.effect("retains legacy API trigger and smoke defaults", () =>
    Effect.gen(function* () {
      const policy = yield* sheetWorkflowsRuntimePolicy.pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_WORKFLOWS_ROLE: "api" })),
        ),
      );

      expect(policy).toMatchObject({
        role: "api",
        producer: false,
        workflowApi: true,
        workflowRunner: false,
        reconciliationConsumer: false,
        autonomousTriggerNames: ["autoCheckin", "autoRoleCleanup"],
        smokeEnqueue: false,
      });
    }),
  );

  it.effect("allows trigger names and a future fenced owner to be selected explicitly", () =>
    Effect.gen(function* () {
      const policy = yield* sheetWorkflowsRuntimePolicy.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              SHEET_WORKFLOWS_ROLE: "api",
              WORKFLOWS_AUTONOMOUS_TRIGGER_NAMES: "autoRoleCleanup",
              WORKFLOWS_SMOKE_WORKFLOW_ENABLED: true,
              WORKFLOWS_TRIGGER_TARGET_OWNER: "session:example",
            }),
          ),
        ),
      );

      expect(policy.autonomousTriggerNames).toEqual(["autoRoleCleanup"]);
      expect(policy.smokeEnqueue).toBe(true);
      expect(Option.getOrUndefined(policy.triggerTargetOwner)).toBe("session:example");
    }),
  );

  it.effect("accepts SHEET_WORKFLOWS_ROLE=runner", () =>
    Effect.gen(function* () {
      expect(yield* readWorkflowRole({ SHEET_WORKFLOWS_ROLE: "runner" })).toBe("runner");
    }),
  );

  it.effect("accepts SHEET_WORKFLOWS_ROLE=browser-runner", () =>
    Effect.gen(function* () {
      expect(yield* readWorkflowRole({ SHEET_WORKFLOWS_ROLE: "browser-runner" })).toBe(
        "browser-runner",
      );
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

  it.effect("bounds screenshot browser concurrency", () =>
    Effect.gen(function* () {
      expect(yield* readScreenshotBrowserConcurrency({})).toBe(2);
      expect(yield* readScreenshotBrowserConcurrency({ SCREENSHOT_BROWSER_CONCURRENCY: 1 })).toBe(
        1,
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            readScreenshotBrowserConcurrency({ SCREENSHOT_BROWSER_CONCURRENCY: 0 }),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            readScreenshotBrowserConcurrency({ SCREENSHOT_BROWSER_CONCURRENCY: 17 }),
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect("configures the trusted sheet persistence pool size", () =>
    Effect.gen(function* () {
      expect(yield* readTrustedSheetPersistenceMaxConnections({})).toBe(10);
      expect(
        yield* readTrustedSheetPersistenceMaxConnections({
          TRUSTED_SHEET_PERSISTENCE_MAX_CONNECTIONS: 4,
        }),
      ).toBe(4);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            readTrustedSheetPersistenceMaxConnections({
              TRUSTED_SHEET_PERSISTENCE_MAX_CONNECTIONS: 0,
            }),
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect("configures the trusted sheet persistence statement timeout", () =>
    Effect.gen(function* () {
      expect(yield* readTrustedSheetPersistenceStatementTimeoutMillis({})).toBe(30_000);
      expect(
        yield* readTrustedSheetPersistenceStatementTimeoutMillis({
          TRUSTED_SHEET_PERSISTENCE_STATEMENT_TIMEOUT_MILLIS: 5_000,
        }),
      ).toBe(5_000);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            readTrustedSheetPersistenceStatementTimeoutMillis({
              TRUSTED_SHEET_PERSISTENCE_STATEMENT_TIMEOUT_MILLIS: 0,
            }),
          ),
        ),
      ).toBe(true);
    }),
  );
});
