import { createHash } from "node:crypto";
import { type ConnectedPreviewGroup, type ConnectedPreviewRole } from "./types";

export const workflowRuntimeContractCatalogVersion = 1;

interface RuntimeRoleDefinition {
  readonly groups: readonly ConnectedPreviewGroup[];
  readonly requiredRoles: readonly ConnectedPreviewRole[];
  readonly externalEffects: readonly string[];
  readonly credentialNames: readonly string[];
  readonly environmentKeys: readonly string[];
}

export interface RuntimeContractDefinition {
  readonly providers: readonly ConnectedPreviewRole[];
  readonly consumers: readonly ConnectedPreviewRole[];
  /** Consumers that join the closure only when the preview explicitly selects them. */
  readonly optionalConsumers?: readonly ConnectedPreviewRole[];
  readonly requiredOwnedGroups: readonly ConnectedPreviewGroup[];
}

export const runtimeContractConsumers = (contract: RuntimeContractDefinition) => [
  ...contract.consumers,
  ...(contract.optionalConsumers ?? []),
];

export const runtimeContractConsumersForSelection = (
  contract: RuntimeContractDefinition,
  selectedRoles: ReadonlyArray<string>,
) => [
  ...contract.consumers,
  ...(contract.optionalConsumers ?? []).filter((role) => selectedRoles.includes(role)),
];

export const runtimeContractRolesForSelection = (
  contract: RuntimeContractDefinition,
  selectedRoles: ReadonlyArray<string>,
) => [
  ...new Set([
    ...contract.providers,
    ...runtimeContractConsumersForSelection(contract, selectedRoles),
  ]),
];

export const runtimeContractCatalog = {
  version: workflowRuntimeContractCatalogVersion,
  roles: {
    "sheet-web": {
      groups: ["application-zero", "auth", "workflow-execution", "search"],
      requiredRoles: [],
      externalEffects: ["shared application writes", "workflow enqueue"],
      credentialNames: ["preview-admission", "application-integration", "search-query"],
      environmentKeys: ["NODE_ENV", "LOG_LEVEL"],
    },
    "sheet-auth": {
      groups: ["auth"],
      requiredRoles: [],
      externalEffects: ["OAuth callback handling"],
      credentialNames: [
        "auth-sql",
        "auth-redis",
        "discord-oauth-client",
        "issuer-signing",
        "session-signing",
        "subject-signing",
        "reviewer",
        "workload-proof",
      ],
      environmentKeys: ["NODE_ENV", "LOG_LEVEL"],
    },
    "sheet-db-server": {
      groups: ["application-zero", "auth"],
      requiredRoles: [],
      externalEffects: ["application database and Zero Cache access"],
      credentialNames: ["application-database", "verifier"],
      environmentKeys: ["NODE_ENV", "LOG_LEVEL"],
    },
    "sheet-bot": {
      groups: ["application-zero", "auth", "workflow-execution", "bot-storage"],
      requiredRoles: [],
      externalEffects: ["exclusive Discord gateway", "allocated Google Sheets targets"],
      credentialNames: [
        "discord-bot-token",
        "redis",
        "capability-encryption",
        "internal-oauth-client",
        "bot-delegation-proof",
      ],
      environmentKeys: ["NODE_ENV", "LOG_LEVEL"],
    },
    "sheet-workflows-api": {
      groups: ["application-zero", "auth", "workflow-execution"],
      requiredRoles: [],
      externalEffects: ["workflow enqueue", "autonomous triggers when explicitly enabled"],
      credentialNames: ["workflow-database", "internal-oauth-client", "workload-identity"],
      environmentKeys: ["NODE_ENV", "LOG_LEVEL"],
    },
    "sheet-workflows-runner": {
      groups: ["application-zero", "auth", "workflow-execution"],
      requiredRoles: ["sheet-workflows-api"],
      externalEffects: ["workflow actions and durable effects"],
      credentialNames: [
        "workflow-database",
        "internal-oauth-client",
        "workload-identity",
        "google-service-account",
      ],
      environmentKeys: ["NODE_ENV", "LOG_LEVEL"],
    },
    "sheet-workflows-browser-runner": {
      groups: ["application-zero", "auth", "workflow-execution"],
      requiredRoles: ["sheet-workflows-api", "sheet-workflows-runner"],
      externalEffects: ["anonymous browser rendering and browser child processes"],
      credentialNames: [
        "workflow-database",
        "internal-oauth-client",
        "workload-identity",
        "bot-capability",
      ],
      environmentKeys: ["NODE_ENV", "LOG_LEVEL"],
    },
  } satisfies Readonly<Record<ConnectedPreviewRole, RuntimeRoleDefinition>>,
  contracts: {
    "auth.session": {
      providers: ["sheet-auth"],
      consumers: [
        "sheet-web",
        "sheet-db-server",
        "sheet-bot",
        "sheet-workflows-api",
        "sheet-workflows-runner",
        "sheet-workflows-browser-runner",
      ],
      requiredOwnedGroups: ["auth"],
    },
    "application.zero": {
      providers: ["sheet-db-server"],
      consumers: [
        "sheet-web",
        "sheet-bot",
        "sheet-workflows-api",
        "sheet-workflows-runner",
        "sheet-workflows-browser-runner",
      ],
      requiredOwnedGroups: ["application-zero"],
    },
    "workflow.enqueue": {
      providers: ["sheet-workflows-api"],
      consumers: ["sheet-web", "sheet-bot"],
      requiredOwnedGroups: ["workflow-execution"],
    },
    "workflow.execution": {
      providers: ["sheet-workflows-runner"],
      consumers: ["sheet-workflows-api"],
      // Include browser only when the exercised workflow explicitly selects that role.
      optionalConsumers: ["sheet-workflows-browser-runner"],
      requiredOwnedGroups: ["workflow-execution"],
    },
    "workflow.browser": {
      providers: ["sheet-workflows-browser-runner"],
      consumers: ["sheet-workflows-api", "sheet-workflows-runner"],
      requiredOwnedGroups: ["workflow-execution"],
    },
    "bot.capability": {
      providers: ["sheet-bot"],
      consumers: ["sheet-web", "sheet-workflows-api", "sheet-workflows-browser-runner"],
      requiredOwnedGroups: ["bot-storage"],
    },
    "search.query": {
      providers: [],
      consumers: ["sheet-web"],
      requiredOwnedGroups: ["search"],
    },
  } satisfies Readonly<Record<string, RuntimeContractDefinition>>,
} as const;

export const workflowPreviewRuntimeContractCatalogIdentity = {
  version: workflowRuntimeContractCatalogVersion,
  digest: `sha256:${createHash("sha256").update(JSON.stringify(runtimeContractCatalog)).digest("hex")}`,
} as const;
