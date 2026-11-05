import { Config, ConfigProvider, Effect, Match, Option } from "effect";
import type { ConfigError } from "effect/Config";
import { config } from "./config";
import {
  selectedSheetWorkflowActionVersions,
  selectedSheetWorkflowDurableFormatVersions,
  selectedSheetWorkflowIdentityRegistrations,
  sheetWorkflowCatalogDigestFor,
} from "../workflows/catalogIdentity";
import { sheetWorkflowRuntimeDefinitions } from "../workflows/runtimeDefinitions";
import { getSheetDbMigrationArtifactDigest } from "sheet-zero-server/state-plane-admission";

const loadedSheetDbMigrationArtifactDigest = getSheetDbMigrationArtifactDigest();

const loadedSheetWorkflowContractCatalogDigest = sheetWorkflowCatalogDigestFor(
  selectedSheetWorkflowIdentityRegistrations,
  selectedSheetWorkflowActionVersions,
  selectedSheetWorkflowDurableFormatVersions,
  sheetWorkflowRuntimeDefinitions,
);

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
  readonly workflowContractCatalogDigest: string;
  readonly schemaArtifactDigest: string;
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

const producerRuntimeConfigError = (message: string) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message }));

type ProducerRuntimeValidationInput = {
  readonly role: SheetWorkflowsRuntimeRole;
  readonly statePlanePolicy: "deployment-default" | "shared-admission" | "owned-admission";
  readonly previewSessionId: string;
  readonly previewSourceRevision: string;
  readonly previewApiEndpoint: string;
  readonly previewGroupTarget: string;
  readonly previewApiArtifactDigest: string;
  readonly previewManifestDigest: string;
  readonly previewCatalogDigest: string;
  readonly previewSchemaArtifactDigest: string;
};

const validateProducerStatePlane = (input: ProducerRuntimeValidationInput) =>
  input.role !== "producer" || input.statePlanePolicy === "shared-admission"
    ? Effect.void
    : Effect.fail(
        producerRuntimeConfigError(
          "SHEET_WORKFLOWS_ROLE=producer requires WORKFLOWS_STATE_PLANE_POLICY=shared-admission",
        ),
      );

const validateProducerCatalog = (input: ProducerRuntimeValidationInput) =>
  input.role !== "producer" ||
  input.previewCatalogDigest === loadedSheetWorkflowContractCatalogDigest
    ? Effect.void
    : Effect.fail(
        producerRuntimeConfigError(
          "Producer Workflow Contract catalog digest does not match the loaded schemas, authorization policies, workflow definition versions, and Action Versions",
        ),
      );

const validateProducerSchemaArtifact = (input: ProducerRuntimeValidationInput) =>
  input.role !== "producer" ||
  (input.previewSchemaArtifactDigest === loadedSheetDbMigrationArtifactDigest &&
    input.previewCatalogDigest === loadedSheetWorkflowContractCatalogDigest)
    ? Effect.void
    : Effect.fail(
        producerRuntimeConfigError(
          "Producer schema artifact identity does not match the loaded State Plane migration sources",
        ),
      );

const producerSessionIdentityIsComplete = (input: ProducerRuntimeValidationInput) =>
  input.previewSourceRevision.length > 0 &&
  input.previewApiEndpoint.length > 0 &&
  input.previewGroupTarget.length > 0 &&
  input.previewApiArtifactDigest !== `sha256:${"0".repeat(64)}` &&
  input.previewManifestDigest !== `sha256:${"0".repeat(64)}` &&
  input.previewCatalogDigest !== `sha256:${"0".repeat(64)}` &&
  input.previewSchemaArtifactDigest !== `sha256:${"0".repeat(64)}`;

const validateProducerSessionIdentity = (input: ProducerRuntimeValidationInput) =>
  input.role !== "producer" ||
  input.previewSessionId.length === 0 ||
  producerSessionIdentityIsComplete(input)
    ? Effect.void
    : Effect.fail(
        producerRuntimeConfigError(
          "A session-bound producer requires non-placeholder API, manifest, catalog, schema, route, group, and source revision identities",
        ),
      );

const validateProducerRuntime = (
  input: ProducerRuntimeValidationInput,
): Effect.Effect<void, ConfigError> =>
  Effect.gen(function* () {
    yield* validateProducerStatePlane(input);
    yield* validateProducerCatalog(input);
    yield* validateProducerSchemaArtifact(input);
    yield* validateProducerSessionIdentity(input);
  });

export const sheetWorkflowsRuntimePolicy: Effect.Effect<SheetWorkflowsRuntimePolicy, ConfigError> =
  Effect.gen(function* () {
    const role = yield* config.sheetWorkflowsRole;
    const statePlanePolicy = yield* config.statePlanePolicy;
    const previewSessionId = yield* config.workflowsPreviewSessionId;
    const previewSourceRevision = yield* config.workflowsSourceRevision;
    const previewApiEndpoint = yield* config.workflowsPreviewApiEndpoint;
    const previewGroupTarget = yield* config.workflowsPreviewGroupTarget;
    const previewApiArtifactDigest = yield* config.workflowsPreviewApiArtifactDigest;
    const previewManifestDigest = yield* config.workflowsPreviewManifestDigest;
    const previewCatalogDigest = yield* config.workflowsPreviewCatalogDigest;
    const previewSchemaArtifactDigest = yield* config.workflowsPreviewSchemaArtifactDigest;
    yield* validateProducerRuntime({
      role,
      statePlanePolicy,
      previewSessionId,
      previewSourceRevision,
      previewApiEndpoint,
      previewGroupTarget,
      previewApiArtifactDigest,
      previewManifestDigest,
      previewCatalogDigest,
      previewSchemaArtifactDigest,
    });
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
      workflowContractCatalogDigest: loadedSheetWorkflowContractCatalogDigest,
      schemaArtifactDigest: loadedSheetDbMigrationArtifactDigest,
      triggerTargetOwner:
        triggerTargetOwner.length === 0 ? Option.none() : Option.some(triggerTargetOwner),
    };
  });
