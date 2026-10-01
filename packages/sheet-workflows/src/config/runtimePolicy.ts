import { Effect, Match, Option } from "effect";
import type { ConfigError } from "effect/Config";
import { config } from "./config";

export type SheetWorkflowsRuntimeRole =
  | "combined"
  | "api"
  | "producer"
  | "runner"
  | "browser-runner";

/**
 * The role boundary is the policy boundary: producer mode serves API requests
 * but owns no autonomous triggers, smoke enqueue, runner, or reconciliation.
 */
export type SheetWorkflowsRuntimePolicy = {
  readonly role: SheetWorkflowsRuntimeRole;
  readonly producer: boolean;
  readonly workflowApi: boolean;
  readonly workflowRunner: boolean;
  readonly reconciliationConsumer: boolean;
  readonly autonomousTriggerNames: ReadonlyArray<"autoCheckin" | "autoRoleCleanup">;
  readonly smokeEnqueue: boolean;
  readonly triggerTargetOwner: Option.Option<string>;
};

const configuredTriggerSettings = (role: SheetWorkflowsRuntimeRole) =>
  Match.value(role).pipe(
    Match.when("producer", () =>
      Effect.succeed({ autonomousTriggerNames: [], smokeEnqueueEnabled: false }),
    ),
    Match.orElse(() =>
      Effect.all({
        autonomousTriggerNames: config.workflowsAutonomousTriggerNames,
        smokeEnqueueEnabled: config.workflowsSmokeWorkflowEnabled,
      }),
    ),
  );

export const sheetWorkflowsRuntimePolicy: Effect.Effect<SheetWorkflowsRuntimePolicy, ConfigError> =
  Effect.gen(function* () {
    const role = yield* config.sheetWorkflowsRole;
    const { autonomousTriggerNames, smokeEnqueueEnabled } = yield* configuredTriggerSettings(role);
    const triggerTargetOwner = yield* config.workflowsTriggerTargetOwner;
    const producer = role === "producer";
    const workflowApi = role === "api" || role === "producer" || role === "combined";
    const workflowRunner = role !== "api" && role !== "producer";
    const reconciliationConsumer = role === "runner" || role === "combined";

    return {
      role,
      producer,
      workflowApi,
      workflowRunner,
      reconciliationConsumer,
      autonomousTriggerNames: workflowApi || reconciliationConsumer ? autonomousTriggerNames : [],
      smokeEnqueue: workflowApi && !producer && smokeEnqueueEnabled,
      triggerTargetOwner:
        triggerTargetOwner.length === 0 ? Option.none() : Option.some(triggerTargetOwner),
    };
  });
