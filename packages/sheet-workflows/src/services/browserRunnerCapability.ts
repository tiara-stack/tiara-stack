import { createHash } from "node:crypto";
import { Config, ConfigProvider, Effect, Redacted } from "effect";
import { ScreenshotsCaptureAndDeliver } from "sheet-workflow-contracts";
import { config } from "@/config";
import { sheetWorkflowsRuntimePolicy } from "@/config/runtimePolicy";
import {
  screenshotActionVersion,
  screenshotWorkflowDefinitionVersion,
} from "@/workflows/screenshots/catalog";
import { playwrightPackageVersionFrom } from "./playwrightPackage";

const playwrightVersion = playwrightPackageVersionFrom(import.meta.url);

export type BrowserRunnerCapabilityIdentity = {
  readonly databaseEndpointIdentity: string;
  readonly loadedCatalogDigest: string;
  readonly loadedSchemaArtifactDigest: string;
  readonly playwrightVersion: string;
};

const browserRunnerCapabilityGroupPrefix = "brcap-v1-";
const browserRunnerCapabilityDigestLength = 32;

/** Builds a shard group whose ownership is tied to the loaded browser runtime and selected store. */
export const browserRunnerCapabilityGroupFor = (identity: BrowserRunnerCapabilityIdentity) => {
  const capabilityIdentity = {
    schemaVersion: 1,
    role: "browser-runner",
    capability: "screenshots.captureAndDeliver",
    workflow: {
      identity: ScreenshotsCaptureAndDeliver.identity,
      wireVersion: ScreenshotsCaptureAndDeliver.wireVersion,
      definitionVersion: screenshotWorkflowDefinitionVersion,
      actionVersion: screenshotActionVersion,
    },
    playwrightVersion: identity.playwrightVersion,
    databaseEndpointIdentity: identity.databaseEndpointIdentity,
    loadedCatalogDigest: identity.loadedCatalogDigest,
    loadedSchemaArtifactDigest: identity.loadedSchemaArtifactDigest,
  };
  const digest = createHash("sha256").update(JSON.stringify(capabilityIdentity)).digest("hex");
  return browserRunnerCapabilityGroupPrefix + digest.slice(0, browserRunnerCapabilityDigestLength);
};

const databaseEndpointIdentity = (url: Redacted.Redacted<string>) =>
  Effect.try({
    try: () => {
      const parsed = new URL(Redacted.value(url));
      const protocol = parsed.protocol.toLowerCase();
      if ((protocol !== "postgres:" && protocol !== "postgresql:") || parsed.hostname === "")
        throw new Error("Unsupported PostgreSQL endpoint");
      const port = parsed.port || "5432";
      if (parsed.pathname.length < 2) throw new Error("PostgreSQL database path is missing");
      return `${protocol}//${parsed.hostname.toLowerCase()}:${port}${parsed.pathname}`;
    },
    catch: () =>
      new Config.ConfigError(
        new ConfigProvider.SourceError({
          message: "POSTGRES_URL must identify a PostgreSQL database endpoint",
        }),
      ),
  });

/** Shared by API admission and the browser runner's actual assigned shard groups. */
export const browserRunnerCapabilityIdentity = Effect.gen(function* () {
  const [policy, postgresUrl, installedPlaywrightVersion] = yield* Effect.all([
    sheetWorkflowsRuntimePolicy,
    config.postgresUrl,
    playwrightVersion,
  ] as const);

  return {
    databaseEndpointIdentity: yield* databaseEndpointIdentity(postgresUrl),
    loadedCatalogDigest: policy.workflowContractCatalogDigest,
    loadedSchemaArtifactDigest: policy.schemaArtifactDigest,
    playwrightVersion: installedPlaywrightVersion,
  } satisfies BrowserRunnerCapabilityIdentity;
}).pipe(Effect.withSpan("sheet-workflows.browserRunner.capabilityGroup"));

export const browserRunnerCapabilityGroup = browserRunnerCapabilityIdentity.pipe(
  Effect.map(browserRunnerCapabilityGroupFor),
);

export const browserRunnerCapabilityShardPattern = (group: string) => `${group}:%`;
