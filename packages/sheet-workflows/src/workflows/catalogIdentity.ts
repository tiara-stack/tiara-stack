import { SchemaRepresentation } from "effect";
import { createHash } from "node:crypto";
import { getSheetDbMigrationArtifactDigest } from "sheet-zero-server/state-plane-admission";
import { workflowContractKey } from "effect-zero-workflow/contract";
import type { WorkflowDefinition } from "effect-zero-workflow";
import {
  selectedSheetWorkflowIdentityRegistrations,
  selectedSheetWorkflowRuntimeDefinitionIdentities,
  type SelectedSheetWorkflowRegistrationIdentity,
} from "./selected/identity";
export { selectedSheetWorkflowIdentityRegistrations } from "./selected/identity";
import { calculationActionVersion, calculationSerializationVersion } from "./calculations/catalog";
import { autoCheckinTestActionVersion, checkinsOpenActionVersion } from "./checkins/catalog";
import { screenshotActionVersion } from "./screenshots/catalog";
import { teamSubmissionsSheetWorkflowActionVersion } from "./teamSubmissions/catalog";

const loadedSheetDbMigrationArtifactDigest = getSheetDbMigrationArtifactDigest();

export type SheetWorkflowActionVersion = {
  readonly identity: string;
  readonly version: string;
};

export type SheetWorkflowDurableFormatVersion = {
  readonly identity: string;
  readonly version: string;
};

const compareVersionedIdentity = (
  left: SheetWorkflowActionVersion,
  right: SheetWorkflowActionVersion,
) => {
  if (left.identity !== right.identity) return left.identity < right.identity ? -1 : 1;
  if (left.version !== right.version) return left.version < right.version ? -1 : 1;
  return 0;
};

/** Explicit action and durable-format versions not represented by a workflow registration. */
export const selectedSheetWorkflowActionVersions: ReadonlyArray<SheetWorkflowActionVersion> =
  Object.freeze([
    { identity: "calculations.action", version: calculationActionVersion },
    { identity: "checkins.open.action", version: checkinsOpenActionVersion },
    { identity: "checkins.testAuto.action", version: autoCheckinTestActionVersion },
    { identity: "screenshots.captureAndDeliver.action", version: screenshotActionVersion },
    {
      identity: "teamSubmissions.delivery.action",
      version: teamSubmissionsSheetWorkflowActionVersion,
    },
  ]);

export const selectedSheetWorkflowDurableFormatVersions: ReadonlyArray<SheetWorkflowDurableFormatVersion> =
  Object.freeze([
    { identity: "calculations.serialization", version: calculationSerializationVersion },
  ]);

/**
 * Computes producer compatibility from loaded contracts, authorization policy,
 * workflow definition versions, explicit Action Versions, and durable formats.
 */
export const sheetWorkflowCatalogDigestFor = (
  registrations: ReadonlyArray<SelectedSheetWorkflowRegistrationIdentity>,
  actionVersions: ReadonlyArray<SheetWorkflowActionVersion> = selectedSheetWorkflowActionVersions,
  durableFormatVersions: ReadonlyArray<SheetWorkflowDurableFormatVersion> = selectedSheetWorkflowDurableFormatVersions,
  definitions: ReadonlyArray<
    Pick<WorkflowDefinition, "name">
  > = selectedSheetWorkflowRuntimeDefinitionIdentities,
): `sha256:${string}` => {
  const definitionsByWorkflow = new Map(
    registrations.map(({ contract, definitionVersion }) => [
      workflowContractKey(contract),
      definitionVersion,
    ]),
  );
  const contracts = registrations
    .map(({ contract, definitionVersion }) => ({
      identity: contract.identity,
      wireVersion: contract.wireVersion,
      definitionVersion,
      authorizationPolicy: contract.authorizationPolicy,
      input: SchemaRepresentation.fromAST(contract.input.ast),
      success: SchemaRepresentation.fromAST(contract.success.ast),
      declaredFailure: SchemaRepresentation.fromAST(contract.declaredFailure.ast),
    }))
    .sort((left, right) => {
      if (left.identity !== right.identity) return left.identity < right.identity ? -1 : 1;
      if (left.wireVersion !== right.wireVersion)
        return left.wireVersion < right.wireVersion ? -1 : 1;
      return 0;
    });
  const sortedActionVersions = [...actionVersions].sort(compareVersionedIdentity);
  const sortedDurableFormatVersions = [...durableFormatVersions].sort(compareVersionedIdentity);
  const runtimeDefinitions = definitions
    .map((definition) => ({
      name: definition.name,
      definitionVersion: definitionsByWorkflow.get(definition.name) ?? "1",
    }))
    .sort((left, right) => {
      if (left.name !== right.name) return left.name < right.name ? -1 : 1;
      return 0;
    });

  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 3,
        schemaArtifactDigest: loadedSheetDbMigrationArtifactDigest,
        contracts,
        runtimeDefinitions,
        actionVersions: sortedActionVersions,
        durableFormatVersions: sortedDurableFormatVersions,
      }),
    )
    .digest("hex")}`;
};

/** Identity checked by producer startup and reported by API readiness. */
export const sheetWorkflowContractCatalogDigest = sheetWorkflowCatalogDigestFor(
  selectedSheetWorkflowIdentityRegistrations,
);
