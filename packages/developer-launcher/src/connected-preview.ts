import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import * as Console from "effect/Console";
import { Duration, Effect, FileSystem, Match, Option, Predicate, Result, Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { sensitiveEnvironmentKeys } from "./config";
import { ownedApplicationResource } from "./owned-application-plane";
import { syntheticDevelopmentSeedId } from "./synthetic-development-seed";
import {
  dispatchPreviewSessionProtocol,
  PreviewSessionController,
  previewSessionHeartbeatMs,
  SessionCredentialsSchema,
} from "./preview-sessions";
import { PreviewAllocationController } from "./preview-allocations";
import { PreviewAllocationError } from "./preview-allocations";
import {
  buildPreviewRelayResourcePlan,
  PreviewRelayHostListenerSchema,
  PreviewRelayProviderUnavailable,
  previewRelayDoctorCheckIds,
  relayNameFor,
  type PreviewRelayDoctorCheck,
  type PreviewRelayResourcePlan,
} from "./preview-relay-provider";
import {
  PreviewCapacityBaselineSchema,
  previewCapacityDimensionsByGroup,
} from "./preview-allocations";
import { makeDiagnostic, makeWarning } from "./diagnostics";
import type { ParsedCommand } from "./commands";
import {
  connectedPreviewGroups,
  connectedPreviewRoles,
  type ConnectedPreviewGroup,
  type ConnectedPreviewReport,
  type ConnectedPreviewRole,
  type Diagnostic,
  type LauncherOptions,
  type LauncherOutput,
} from "./types";

const catalogVersion = 1;
const supervisedWebCleanupRetryCount = 10;

interface RuntimeRoleDefinition {
  readonly groups: readonly ConnectedPreviewGroup[];
  readonly requiredRoles: readonly ConnectedPreviewRole[];
  readonly externalEffects: readonly string[];
  readonly credentialNames: readonly string[];
  readonly environmentKeys: readonly string[];
}

interface RuntimeContractDefinition {
  readonly providers: readonly ConnectedPreviewRole[];
  readonly consumers: readonly ConnectedPreviewRole[];
  readonly requiredOwnedGroups: readonly ConnectedPreviewGroup[];
}

const runtimeContractCatalog = {
  version: catalogVersion,
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
      consumers: ["sheet-workflows-api", "sheet-workflows-browser-runner"],
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

const runtimeContractCatalogIdentity = {
  version: catalogVersion,
  digest: `sha256:${createHash("sha256").update(JSON.stringify(runtimeContractCatalog)).digest("hex")}`,
} as const;

const roleSchema = Schema.Literals(connectedPreviewRoles);
const groupSchema = Schema.Struct({
  id: Schema.Literals(connectedPreviewGroups),
  ownership: Schema.Literals(["owned", "reused"]),
  allocationProfile: Schema.optionalKey(Schema.String),
  endpoint: Schema.optionalKey(Schema.String),
  stateIdentity: Schema.optionalKey(Schema.String),
  deployedManifestDigest: Schema.optionalKey(Schema.String),
});
const environmentFileInputSchema = Schema.Struct({
  role: roleSchema,
  path: Schema.String,
});
const changeSchema = Schema.Struct({
  role: roleSchema,
  contract: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  classification: Schema.Literals(["implementation-only", "compatible", "incompatible", "unknown"]),
  sourceRevision: Schema.String,
  artifactDigest: Schema.String,
  deployedManifestDigest: Schema.String,
  catalogVersion: Schema.Number,
});
const triggerSchema = Schema.Struct({
  name: Schema.String,
  targets: Schema.Array(Schema.String),
});
const botHandoffSchema = Schema.Struct({
  targetAllocation: Schema.String,
  acknowledgedSharedInterruption: Schema.Boolean,
});
const identitiesSchema = Schema.Struct({
  sourceRevision: Schema.String,
  artifactDigests: Schema.Record(Schema.String, Schema.String),
  deployedManifestDigest: Schema.String,
  catalogVersion: Schema.Number,
});
const connectedPreviewConfigSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1]),
  environment: Schema.String,
  profile: Schema.String,
  owner: Schema.String,
  roles: Schema.Array(roleSchema),
  hostListeners: Schema.optionalKey(Schema.Array(PreviewRelayHostListenerSchema)),
  identities: identitiesSchema,
  environmentFileInputs: Schema.Array(environmentFileInputSchema),
  groups: Schema.Array(groupSchema),
  changes: Schema.Array(changeSchema),
  credentialReferences: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  sharedExecution: Schema.Literals(["disabled", "producer-only"]),
  seed: Schema.optionalKey(Schema.String),
  additionalUserGrants: Schema.optionalKey(Schema.Array(Schema.String)),
  triggers: Schema.optionalKey(Schema.Array(triggerSchema)),
  externalTargets: Schema.optionalKey(Schema.Array(Schema.String)),
  botHandoff: Schema.optionalKey(Schema.Union([Schema.Null, botHandoffSchema])),
});
type ConnectedPreviewConfig = Schema.Schema.Type<typeof connectedPreviewConfigSchema>;
type PreviewGroupConfig = Schema.Schema.Type<typeof groupSchema>;
type PreviewChangeConfig = Schema.Schema.Type<typeof changeSchema>;

const prerequisites = [
  {
    id: "telepresence-client-pin",
    reason:
      "The prepared workspace Telepresence client version has not been verified against the operator pin.",
  },
  {
    id: "telepresence-manager-agent-pin",
    reason:
      "The development cluster Telepresence manager and traffic-agent versions have not been verified against the operator pin.",
  },
  {
    id: "workspace-tun-capabilities",
    reason:
      "The workspace TUN device and effective NET_ADMIN/network capabilities have not been verified.",
  },
  {
    id: "workspace-dns",
    reason:
      "Approved development service FQDN resolution and required DNS suffix routing have not been verified.",
  },
  {
    id: "managed-service-dns",
    reason:
      "Configured managed database/cache DNS names have not been resolved from the prepared workspace.",
  },
  {
    id: "development-network",
    reason:
      "Workspace routes and NetworkPolicy access to each approved development destination have not been verified.",
  },
  {
    id: "managed-service-tls",
    reason:
      "Managed database/cache TLS negotiation and certificate verification have not been checked independently of network reachability.",
  },
  {
    id: "application-authentication",
    reason:
      "Application credentials and authorization against approved development dependencies have not been verified independently of TLS.",
  },
  {
    id: "development-cluster-access",
    reason: "Authenticated access to the configured development cluster has not been verified.",
  },
  {
    id: "scoped-relay-attachment",
    reason:
      "The pinned Telepresence installation has not proved attachment authorization to a session relay and denial for shared workloads.",
  },
  {
    id: "session-controller",
    reason:
      "Controller authentication, durable session state, and allocator availability have not been checked.",
  },
  {
    id: "routes-and-identity",
    reason:
      "DNS, TLS, gateway admission, OAuth registrations, and session role routes have not been checked.",
  },
  {
    id: "deployed-manifest",
    reason: "The configured deployed manifest has not been compared with a live observed manifest.",
  },
  {
    id: "state-grants-and-capacity",
    reason: "Database grants, dependency ownership, and measured capacity have not been checked.",
  },
  {
    id: "runtime-credentials",
    reason:
      "Per-role credential delivery, workload identity, and target permissions have not been checked.",
  },
  {
    id: "cleanup-ownership",
    reason: "Durable cleanup ownership, settlement, and quarantine behavior have not been checked.",
  },
  {
    id: "external-target-ownership",
    reason:
      "External target ownership, permissions, and exclusive-writer status have not been checked.",
  },
] as const;

const quotaResourceDimensions = previewCapacityDimensionsByGroup satisfies Readonly<
  Record<ConnectedPreviewGroup, readonly string[]>
>;

type ContractId = keyof typeof runtimeContractCatalog.contracts;
type GroupOwnership = "owned" | "reused";
type ConnectedPreviewCommand = Extract<ParsedCommand, { readonly kind: "preview" }>;
type PreviewStartCommand = Extract<ConnectedPreviewCommand, { readonly action: "start" }>;
const getRuntimeContract = (contractId: string | null | undefined) => {
  if (contractId == null || !Object.hasOwn(runtimeContractCatalog.contracts, contractId)) {
    return undefined;
  }
  return runtimeContractCatalog.contracts[contractId as ContractId];
};

const contractsForRole = (role: ConnectedPreviewRole) => {
  const providedContracts: ContractId[] = [];
  const consumedContracts: ContractId[] = [];
  for (const contract of Object.keys(runtimeContractCatalog.contracts) as ContractId[]) {
    const definition = runtimeContractCatalog.contracts[contract];
    if (definition.providers.some((provider) => provider === role))
      providedContracts.push(contract);
    if (definition.consumers.some((consumer) => consumer === role))
      consumedContracts.push(contract);
  }
  return { providedContracts, consumedContracts };
};

const exactKeys = (
  value: unknown,
  allowed: readonly string[],
  location: string,
): string | undefined => {
  if (!Predicate.isObject(value)) return undefined;
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  return unexpected === undefined ? undefined : `${location}.${unexpected}`;
};

const firstUnexpectedListField = (
  value: unknown,
  allowed: readonly string[],
  location: string,
): string | undefined => {
  if (!Array.isArray(value)) return undefined;
  for (const [index, item] of value.entries()) {
    const unexpected = exactKeys(item, allowed, `${location}[${index}]`);
    if (unexpected !== undefined) return unexpected;
  }
  return undefined;
};

const unexpectedConfigurationField = (value: unknown): string | undefined => {
  const root = exactKeys(
    value,
    [
      "schemaVersion",
      "environment",
      "profile",
      "owner",
      "roles",
      "hostListeners",
      "identities",
      "environmentFileInputs",
      "groups",
      "changes",
      "credentialReferences",
      "sharedExecution",
      "seed",
      "additionalUserGrants",
      "triggers",
      "externalTargets",
      "botHandoff",
    ],
    "config",
  );
  if (root !== undefined) return root;
  if (!Predicate.isObject(value)) return undefined;
  const property = (key: string) => (Predicate.hasProperty(value, key) ? value[key] : undefined);
  return (
    exactKeys(
      property("identities"),
      ["sourceRevision", "artifactDigests", "deployedManifestDigest", "catalogVersion"],
      "config.identities",
    ) ??
    firstUnexpectedListField(
      property("environmentFileInputs"),
      ["role", "path"],
      "config.environmentFileInputs",
    ) ??
    firstUnexpectedListField(
      property("hostListeners"),
      ["role", "host", "port", "processId"],
      "config.hostListeners",
    ) ??
    firstUnexpectedListField(
      property("groups"),
      [
        "id",
        "ownership",
        "allocationProfile",
        "endpoint",
        "stateIdentity",
        "deployedManifestDigest",
      ],
      "config.groups",
    ) ??
    firstUnexpectedListField(
      property("changes"),
      [
        "role",
        "contract",
        "classification",
        "sourceRevision",
        "artifactDigest",
        "deployedManifestDigest",
        "catalogVersion",
      ],
      "config.changes",
    ) ??
    firstUnexpectedListField(property("triggers"), ["name", "targets"], "config.triggers") ??
    exactKeys(
      property("botHandoff"),
      ["targetAllocation", "acknowledgedSharedInterruption"],
      "config.botHandoff",
    )
  );
};

const diagnostic = (
  code: Diagnostic["code"],
  action: "plan" | "doctor",
  message: string,
  remediation: string,
  dependency?: string,
): Diagnostic =>
  makeDiagnostic(code, message, remediation, {
    mode: "preview",
    action,
    ...(dependency === undefined ? {} : { dependency }),
  });

const isAmbientCredentialEnvironmentName = Predicate.or(
  (key: string) => sensitiveEnvironmentKeys.has(key),
  (key: string) =>
    /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIALS?|SERVICE_ACCOUNT|DATABASE|POSTGRES|REDIS|SIGNING(?:_KEY)?|ENCRYPTION(?:_KEY|_SECRET)?|PRIVATE_KEY|ACCESS_KEY(?:_ID)?|API_KEY|CLIENT_SECRET)(?:_|$)/i.test(
      key,
    ),
);

const isEnvironmentVariableName = (value: string) => /^[A-Z_][A-Z0-9_]*$/.test(value);

const validateAmbientCredentialEnvironment = (
  environment: NodeJS.ProcessEnv,
  action: "plan" | "doctor",
) =>
  Object.entries(environment)
    .filter(([, value]) => value !== undefined && value.trim() !== "")
    .filter(([key]) => isAmbientCredentialEnvironmentName(key))
    .map(([key]) => {
      const displayName = isEnvironmentVariableName(key) ? key : "<invalid>";
      return makeWarning(
        "unsafe-preview-credential",
        `Ambient credential environment variable ${displayName} is not accepted by connected preview`,
        "Remove ambient credential variables and use explicit role-scoped development credential references.",
        { mode: "preview", action, dependency: displayName },
      );
    });

const decodeConfiguration = (
  value: unknown,
):
  | { readonly config: ConnectedPreviewConfig; readonly error?: never }
  | {
      readonly config?: never;
      readonly error: string;
    } => {
  const unexpected = unexpectedConfigurationField(value);
  if (unexpected !== undefined) {
    return { error: "Connected preview configuration contains unsupported fields" };
  }
  try {
    return { config: Schema.decodeUnknownSync(connectedPreviewConfigSchema)(value) };
  } catch {
    return {
      error: "Connected preview configuration is invalid or incomplete for schemaVersion 1",
    };
  }
};

const isSha256 = (value: string) => /^sha256:[a-f0-9]{64}$/.test(value);
const isSourceRevision = (value: string) => /^[a-f0-9]{7,40}$/.test(value);
const hasProductionMarker = (value: string) =>
  /(?:^|[-_.:/@+])(?:prod|production|live)(?:$|[-_.:/@+])/i.test(value);
const isNonEmpty = (value: string | undefined) =>
  Predicate.and(
    (candidate: string | undefined) => Predicate.isString(candidate),
    (candidate: string | undefined) =>
      Predicate.isString(candidate) ? candidate.trim().length > 0 : false,
  )(value);
const negatePredicate = <A>(predicate: (value: A) => boolean) =>
  Predicate.nor(predicate, (_value: A) => false);
const isSafeIdentifier = Predicate.and(
  (value: string) => value.length <= 160,
  Predicate.and(
    (value: string) => /^[A-Za-z0-9][A-Za-z0-9:._/@+-]*$/.test(value),
    Predicate.and(
      negatePredicate(hasProductionMarker),
      Predicate.and(
        negatePredicate((value: string) =>
          /(?:password|token|secret|api[_-]?key)\s*[:=]/i.test(value),
        ),
        negatePredicate((value: string) =>
          /^(?:Bearer\s|(?:sk|ghp|gho|xox[baprs])-|eyJ[A-Za-z0-9_-]+\.)/i.test(value),
        ),
      ),
    ),
  ),
);
const safeIdentifier = (value: string) => (isSafeIdentifier(value) ? value : "<invalid>");
const isPublicDevelopmentHostname = Predicate.or(
  (hostname: string) => hostname === "dev.theerapakg.moe",
  (hostname: string) => hostname.endsWith(".dev.theerapakg.moe"),
);
const isPrivateDevelopmentHostname = (hostname: string) =>
  hostname.endsWith(".tiara-stack-dev.svc.cluster.local");
const isPublicDevelopmentProtocol = Predicate.or(
  (protocol: string) => protocol === "https:",
  (protocol: string) => protocol === "wss:",
);
const isPrivateDevelopmentProtocol = Predicate.or(
  isPublicDevelopmentProtocol,
  Predicate.or(
    Predicate.or(
      (protocol: string) => protocol === "postgres:",
      (protocol: string) => protocol === "postgresql:",
    ),
    Predicate.or(
      (protocol: string) => protocol === "redis:",
      (protocol: string) => protocol === "rediss:",
    ),
  ),
);
const endpointHasCredentials = Predicate.or(
  Predicate.or(
    (endpoint: URL) => endpoint.username !== "",
    (endpoint: URL) => endpoint.password !== "",
  ),
  Predicate.or(
    (endpoint: URL) => endpoint.search !== "",
    (endpoint: URL) => endpoint.hash !== "",
  ),
);
const isSafeDevelopmentEndpoint = (endpoint: URL) => {
  return Predicate.and(
    Predicate.and(
      Predicate.or(
        Predicate.and(
          (candidate: URL) => isPublicDevelopmentHostname(candidate.hostname.toLowerCase()),
          (candidate: URL) => isPublicDevelopmentProtocol(candidate.protocol),
        ),
        Predicate.and(
          (candidate: URL) => isPrivateDevelopmentHostname(candidate.hostname.toLowerCase()),
          (candidate: URL) => isPrivateDevelopmentProtocol(candidate.protocol),
        ),
      ),
      negatePredicate((candidate: URL) => hasProductionMarker(candidate.hostname.toLowerCase())),
    ),
    Predicate.and(
      negatePredicate(endpointHasCredentials),
      Predicate.or(
        (candidate: URL) => candidate.pathname === "",
        (candidate: URL) => candidate.pathname === "/",
      ),
    ),
  )(endpoint);
};

const endpointForReuse = (
  endpoint: string,
): { readonly key: string; readonly normalized: string } | null => {
  try {
    const parsed = new URL(endpoint);
    if (!isSafeDevelopmentEndpoint(parsed)) return null;
    const normalized = parsed.href;
    return { key: parsed.host.toLowerCase(), normalized };
  } catch {
    return null;
  }
};

const groupConfigsById = (groups: readonly PreviewGroupConfig[]) => {
  const result = new Map<ConnectedPreviewGroup, PreviewGroupConfig>();
  for (const group of groups) {
    if (result.has(group.id)) continue;
    result.set(group.id, group);
  }
  return result;
};

const changeKey = (role: ConnectedPreviewRole, contract: string | null | undefined) =>
  `${role}:${contract ?? "<implementation-only>"}`;

const reportOwnedAllocationProfile = (
  group: PreviewGroupConfig,
): Pick<ConnectedPreviewReport["groupPlans"][number], "allocationProfile"> => {
  if (group.ownership !== "owned") return {};
  const allocationProfile = group.allocationProfile;
  if (allocationProfile === undefined) return {};
  return isSafeIdentifier(allocationProfile) ? { allocationProfile } : {};
};

const reportGroupPlan = (
  group: PreviewGroupConfig,
): ConnectedPreviewReport["groupPlans"][number] => {
  const endpoint = group.endpoint === undefined ? null : endpointForReuse(group.endpoint);
  return {
    id: group.id,
    ownership: group.ownership,
    ...(endpoint === null ? {} : { endpoint: endpoint.normalized }),
    ...(group.stateIdentity === undefined || !isSafeIdentifier(group.stateIdentity)
      ? {}
      : { stateIdentity: group.stateIdentity }),
    ...(group.deployedManifestDigest === undefined || !isSha256(group.deployedManifestDigest)
      ? {}
      : { deployedManifestDigest: group.deployedManifestDigest }),
    ...reportOwnedAllocationProfile(group),
  };
};

const reportArtifactDigests = (
  config: ConnectedPreviewConfig,
  selectedRoles: readonly ConnectedPreviewRole[],
): ConnectedPreviewReport["identities"]["artifactDigests"] =>
  Object.fromEntries(
    selectedRoles.flatMap((role) => {
      const digest = config.identities.artifactDigests[role];
      return digest === undefined ? [] : [[role, isSha256(digest) ? digest : "<invalid>"]];
    }),
  );

const reportCompatibility = (
  config: ConnectedPreviewConfig,
): ConnectedPreviewReport["compatibility"] =>
  config.changes.map((change) => {
    const contract = getRuntimeContract(change.contract);
    return {
      role: change.role,
      contract:
        change.contract === null || change.contract === undefined
          ? null
          : isSafeIdentifier(change.contract)
            ? change.contract
            : "<invalid>",
      classification: change.classification,
      requiredCallers: change.classification === "incompatible" ? (contract?.consumers ?? []) : [],
    };
  });

const reportRoleCatalog = (
  roles: readonly ConnectedPreviewRole[],
): ConnectedPreviewReport["roleCatalog"] =>
  roles.map((role) => {
    const definition = runtimeContractCatalog.roles[role];
    const contracts = contractsForRole(role);
    return {
      role,
      providedContracts: contracts.providedContracts,
      consumedContracts: contracts.consumedContracts,
      stateGroups: [...definition.groups],
      requiredRoles: [...definition.requiredRoles],
      externalEffects: [...definition.externalEffects],
      credentialNames: [...definition.credentialNames],
      environmentKeys: [...definition.environmentKeys],
    };
  });

const reportDeclaredIntent = (
  config: ConnectedPreviewConfig,
): ConnectedPreviewReport["declaredIntent"] => ({
  sharedExecution: config.sharedExecution,
  seed: config.seed === undefined ? null : safeIdentifier(config.seed),
  additionalUserGrants: (config.additionalUserGrants ?? []).map(safeIdentifier),
  triggers: (config.triggers ?? []).map((trigger) => ({
    name: safeIdentifier(trigger.name),
    targets: trigger.targets.map(safeIdentifier),
  })),
  externalTargets: (config.externalTargets ?? []).map(safeIdentifier),
  botHandoff:
    config.botHandoff == null
      ? null
      : {
          targetAllocation: safeIdentifier(config.botHandoff.targetAllocation),
          acknowledgedSharedInterruption: config.botHandoff.acknowledgedSharedInterruption,
        },
});

const reportQuotaRequirements = (
  groups: ConnectedPreviewReport["requiredGroups"],
): ConnectedPreviewReport["quotaRequirements"] =>
  groups.map(({ id, ownership }) => ({
    group: id,
    ownership,
    status: "unavailable" as const,
    resourceDimensions: [...quotaResourceDimensions[id]],
    requested: null,
    reserved: null,
    available: null,
    reason:
      "No reservation is held by a plan. Import fresh measurements and verified grants for the exact provider identity; admission remains blocked until every owned-group demand can be reserved.",
  }));

const reportExternalOwnership = (
  config: ConnectedPreviewConfig,
): ConnectedPreviewReport["externalOwnership"] => {
  const purposesByTarget = new Map<string, Set<string>>();
  const addPurpose = (target: string, purpose: string) => {
    const purposes = purposesByTarget.get(target) ?? new Set<string>();
    purposes.add(purpose);
    purposesByTarget.set(target, purposes);
  };
  for (const target of config.externalTargets ?? [])
    addPurpose(target, "declared target allocation");
  for (const trigger of config.triggers ?? []) {
    for (const target of trigger.targets)
      addPurpose(target, `trigger ${safeIdentifier(trigger.name)}`);
  }
  if (config.botHandoff != null) {
    addPurpose(config.botHandoff.targetAllocation, "exclusive bot handoff");
  }
  return [...purposesByTarget.entries()].map(([target, purposes]) => {
    const values = [...purposes];
    const exclusive = values.some(
      (purpose) => purpose === "exclusive bot handoff" || purpose.startsWith("trigger "),
    );
    return {
      target: safeIdentifier(target),
      purposes: values,
      ownership: exclusive ? ("exclusive" as const) : ("declared" as const),
      status: "unavailable" as const,
      reason: "The current external owner and target permissions have not been verified.",
    };
  });
};

const reportExternalEffects = (roles: readonly ConnectedPreviewRole[]) => {
  const effects = new Set<string>();
  for (const role of roles) {
    for (const effect of runtimeContractCatalog.roles[role].externalEffects) effects.add(effect);
  }
  return [...effects];
};

export const isConnectedPreviewCredentialAllowed = (role: ConnectedPreviewRole, name: string) =>
  runtimeContractCatalog.roles[role].credentialNames.some((allowed) => allowed === name);

const reportCredentialName = (role: ConnectedPreviewRole, name: string) =>
  isConnectedPreviewCredentialAllowed(role, name) ? name : "<invalid>";

const reportCredentialReferenceStatus = (
  config: ConnectedPreviewConfig,
  role: ConnectedPreviewRole,
) => {
  const references = config.credentialReferences[role];
  if (references === undefined || Object.keys(references).length === 0)
    return "unavailable" as const;
  return Object.entries(references).every(
    ([name, reference]) =>
      isConnectedPreviewCredentialAllowed(role, name) &&
      isDevelopmentCredentialReference(role, name, reference),
  )
    ? ("declared" as const)
    : ("unavailable" as const);
};

const buildConnectedPreviewReport = (
  config: ConnectedPreviewConfig,
  status: ConnectedPreviewReport["status"],
  requiredRoles: readonly ConnectedPreviewRole[],
  missingRoles: readonly ConnectedPreviewRole[],
  requiredGroups: ConnectedPreviewReport["requiredGroups"],
): ConnectedPreviewReport => {
  const selectedRoles = [...config.roles];
  const credentialReferences = selectedRoles
    .filter((role) => config.credentialReferences[role] !== undefined)
    .map((role) => ({
      role,
      names: Object.keys(config.credentialReferences[role] ?? {})
        .map((name) => reportCredentialName(role, name))
        .sort(),
      status: reportCredentialReferenceStatus(config, role),
    }));
  return {
    status,
    configSchemaVersion: 1,
    catalog: runtimeContractCatalogIdentity,
    environment: config.environment === "tiara-stack-dev" ? config.environment : "<invalid>",
    profile: safeIdentifier(config.profile),
    owner: safeIdentifier(config.owner),
    identities: {
      sourceRevision: isSourceRevision(config.identities.sourceRevision)
        ? config.identities.sourceRevision
        : "<invalid>",
      artifactDigests: reportArtifactDigests(config, selectedRoles),
      deployedManifestDigest: isSha256(config.identities.deployedManifestDigest)
        ? config.identities.deployedManifestDigest
        : "<invalid>",
    },
    environmentFileInputs: config.environmentFileInputs.map(({ role, path: filePath }) => ({
      role,
      path: reportEnvironmentFilePath(filePath),
      digest: null,
      keys: [],
      status: "unavailable" as const,
    })),
    selectedRoles,
    requiredRoles: [...requiredRoles],
    missingRoles: [...missingRoles],
    requiredGroups: [...requiredGroups],
    roleCatalog: reportRoleCatalog(requiredRoles),
    groupPlans: config.groups.map(reportGroupPlan),
    quotaRequirements: reportQuotaRequirements(requiredGroups),
    compatibility: reportCompatibility(config),
    externalEffects: reportExternalEffects(requiredRoles),
    externalOwnership: reportExternalOwnership(config),
    credentialReferences,
    declaredIntent: reportDeclaredIntent(config),
    prerequisites: prerequisites.map(({ id, reason }) => ({
      id,
      reason,
      status: "unavailable" as const,
    })),
    effects: {
      allocations: false,
      migrations: false,
      registrations: false,
      externalEffects: false,
      botHandoffs: false,
    },
    executionAvailable: false,
  };
};

type PreviewValidationAction = "plan" | "doctor";
type PreviewProblemAdder = (
  code: Diagnostic["code"],
  message: string,
  remediation: string,
  dependency?: string,
) => void;

interface PreviewValidationContext {
  readonly config: ConnectedPreviewConfig;
  readonly action: PreviewValidationAction;
  readonly errors: Diagnostic[];
  readonly add: PreviewProblemAdder;
  readonly selectedRoles: Set<ConnectedPreviewRole>;
  readonly groupsById: Map<ConnectedPreviewGroup, PreviewGroupConfig>;
  readonly changesByKey: Map<string, PreviewChangeConfig>;
  readonly requiredRoles: Set<ConnectedPreviewRole>;
  readonly requiredGroups: Set<ConnectedPreviewGroup>;
  readonly forceOwnedGroups: Set<ConnectedPreviewGroup>;
  readonly endpointOwners: Map<string, ConnectedPreviewGroup>;
  readonly stateIdentityOwners: Map<string, ConnectedPreviewGroup>;
  readonly allocationProfileOwners: Map<string, ConnectedPreviewGroup>;
}

const makePreviewValidationContext = (
  config: ConnectedPreviewConfig,
  action: PreviewValidationAction,
): PreviewValidationContext => {
  const errors: Diagnostic[] = [];
  return {
    config,
    action,
    errors,
    add: (code, message, remediation, dependency) => {
      errors.push(diagnostic(code, action, message, remediation, dependency));
    },
    selectedRoles: new Set(config.roles),
    groupsById: groupConfigsById(config.groups),
    changesByKey: new Map(),
    requiredRoles: new Set(config.roles),
    requiredGroups: new Set(),
    forceOwnedGroups: new Set(),
    endpointOwners: new Map(),
    stateIdentityOwners: new Map(),
    allocationProfileOwners: new Map(),
  };
};

const validateRootEnvironment = (context: PreviewValidationContext) => {
  const { config, add } = context;
  if (config.schemaVersion !== 1) {
    add(
      "invalid-preview-config",
      "Connected preview configuration schemaVersion is unsupported",
      "Use schemaVersion 1.",
    );
  }
  if (config.environment !== "tiara-stack-dev" || hasProductionMarker(config.environment)) {
    add(
      "invalid-preview-config",
      "Connected previews require the named tiara-stack-dev environment",
      "Set environment to tiara-stack-dev; production environments are not accepted.",
      "environment",
    );
  }
  if (
    !isNonEmpty(config.profile) ||
    hasProductionMarker(config.profile) ||
    !isSafeIdentifier(config.profile)
  ) {
    add(
      "invalid-preview-config",
      "A safe, non-production connected-preview profile is required",
      "Set profile to the operator-approved development profile identifier.",
      "profile",
    );
  }
  if (!isSafeIdentifier(config.owner)) {
    add(
      "invalid-preview-config",
      "Connected preview owner is missing or malformed",
      "Set owner to the stable developer identity.",
      "owner",
    );
  }
};

const validateRoleSelection = (context: PreviewValidationContext) => {
  const { config, add } = context;
  if (config.roles.length === 0) {
    add(
      "invalid-preview-config",
      "At least one deployed role must be selected",
      "Select one or more of the seven supported connected-preview roles.",
      "roles",
    );
  }
  if (new Set(config.roles).size !== config.roles.length) {
    add(
      "invalid-preview-config",
      "Connected preview roles must be unique",
      "List each selected role once.",
      "roles",
    );
  }
};

const validatePreviewRelayListeners = (context: PreviewValidationContext) => {
  const result = buildPreviewRelayResourcePlan(
    context.config.roles,
    context.config.hostListeners ?? [],
  );
  if ("error" in result)
    context.add(
      "invalid-preview-config",
      result.error,
      "Configure exactly one approved loopback listener with a unique port for every selected host runtime role; remove listeners for roles outside this profile.",
      "hostListeners",
    );
};

const isNormalizedEnvironmentPathSegment = Predicate.and(
  (segment: string) => segment !== "",
  Predicate.and(
    (segment: string) => segment !== ".",
    (segment: string) => segment !== "..",
  ),
);

const isSafeEnvironmentFilePath = Predicate.and(
  Predicate.and(
    (value: string) => isNonEmpty(value),
    (value: string) => value.length <= 512,
  ),
  Predicate.and(
    Predicate.and(
      negatePredicate((value: string) => path.posix.isAbsolute(value)),
      Predicate.and(
        negatePredicate((value: string) => path.win32.isAbsolute(value)),
        negatePredicate((value: string) => value.includes("\\")),
      ),
    ),
    Predicate.and(
      (value: string) => path.posix.normalize(value) === value,
      Predicate.and(
        (value: string) => value.split("/").every(isNormalizedEnvironmentPathSegment),
        negatePredicate(hasProductionMarker),
      ),
    ),
  ),
);

const reportEnvironmentFilePath = (value: string) =>
  isSafeEnvironmentFilePath(value) ? value : "<invalid>";

const validateEnvironmentFileInputDeclarations = (context: PreviewValidationContext) => {
  const declaredRoles = new Set<ConnectedPreviewRole>();
  for (const input of context.config.environmentFileInputs) {
    if (declaredRoles.has(input.role)) {
      context.add(
        "invalid-preview-config",
        `More than one environment file is declared for ${input.role}`,
        "Declare one environment file input per selected role.",
        input.role,
      );
      continue;
    }
    declaredRoles.add(input.role);
    if (!context.selectedRoles.has(input.role)) {
      context.add(
        "invalid-preview-config",
        `Environment file input for unselected role ${input.role} is unused`,
        "Declare environment files only for explicitly selected runtime roles.",
        input.role,
      );
    }
    if (!isSafeEnvironmentFilePath(input.path)) {
      context.add(
        "invalid-preview-config",
        `Environment file path for ${input.role} must be a safe config-relative path`,
        "Use a normalized relative file path within the directory containing the preview config.",
        input.role,
      );
      continue;
    }
  }
  for (const role of context.selectedRoles) {
    if (declaredRoles.has(role)) continue;
    context.add(
      "env-file-not-found",
      `No deterministic environment file input is declared for ${role}`,
      "Declare the role's config-relative environment file input, including an empty file when the role needs no values.",
      role,
    );
  }
};

const environmentFileValueCatalog = {
  NODE_ENV: ["development"],
  LOG_LEVEL: ["debug", "info", "warn", "error"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const decodedEnvironmentFileValue = (value: string) => {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    (trimmed.startsWith('"') || trimmed.startsWith("'")) &&
    trimmed.at(-1) === trimmed[0]
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

interface EnvironmentFileValidationState {
  readonly role: ConnectedPreviewRole;
  readonly action: PreviewValidationAction;
  readonly keys: Set<string>;
  readonly errors: Diagnostic[];
}

const addEnvironmentFileError = (
  state: EnvironmentFileValidationState,
  code: Diagnostic["code"],
  message: string,
  remediation: string,
) => {
  state.errors.push(diagnostic(code, state.action, message, remediation, state.role));
};

type ParsedEnvironmentFileEntry =
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid" }
  | { readonly kind: "assignment"; readonly key: string; readonly value: string };

const parseEnvironmentFileEntry = (rawLine: string): ParsedEnvironmentFileEntry => {
  const line = rawLine.trim();
  if (line === "" || line.startsWith("#")) return { kind: "ignored" };
  const assignment = line.startsWith("export ") ? line.slice("export ".length) : line;
  const separator = assignment.indexOf("=");
  const key = separator > 0 ? assignment.slice(0, separator).trim() : "";
  return isEnvironmentVariableName(key)
    ? { kind: "assignment", key, value: assignment.slice(separator + 1) }
    : { kind: "invalid" };
};

const validateEnvironmentFileKey = (state: EnvironmentFileValidationState, key: string) => {
  const allowedKeys = runtimeContractCatalog.roles[state.role].environmentKeys;
  if (!allowedKeys.some((allowed) => allowed === key)) {
    addEnvironmentFileError(
      state,
      isAmbientCredentialEnvironmentName(key) ? "unsafe-preview-credential" : "invalid-environment",
      `Environment key ${key} is not allowed for ${state.role}`,
      `Use only the role-scoped environment keys in the runtime catalog for ${state.role}; credentials belong in credentialReferences.`,
    );
    return false;
  }
  if (state.keys.has(key)) {
    addEnvironmentFileError(
      state,
      "invalid-environment",
      `Environment key ${key} is duplicated for ${state.role}`,
      "Declare each role environment key once.",
    );
    return false;
  }
  return true;
};

const validateEnvironmentFileValue = (
  state: EnvironmentFileValidationState,
  key: string,
  rawValue: string,
) => {
  const allowedValues = environmentFileValueCatalog[
    key as keyof typeof environmentFileValueCatalog
  ] as readonly string[] | undefined;
  const value = decodedEnvironmentFileValue(rawValue);
  if (allowedValues !== undefined && allowedValues.includes(value)) return true;
  addEnvironmentFileError(
    state,
    "invalid-environment",
    `Environment key ${key} has an unsupported value for ${state.role}`,
    `Use an approved development value for ${key}; values are not included in preview output.`,
  );
  return false;
};

const validateEnvironmentFileEntry = (
  state: EnvironmentFileValidationState,
  rawLine: string,
  lineNumber: number,
) => {
  const entry = parseEnvironmentFileEntry(rawLine);
  if (entry.kind === "ignored") return;
  if (entry.kind === "invalid") {
    addEnvironmentFileError(
      state,
      "invalid-environment",
      `Environment file for ${state.role} has an invalid entry on line ${lineNumber}`,
      "Use KEY=value entries with only the role's cataloged development keys.",
    );
    return;
  }
  if (!validateEnvironmentFileKey(state, entry.key)) return;
  if (!validateEnvironmentFileValue(state, entry.key, entry.value)) return;
  state.keys.add(entry.key);
};

const validateEnvironmentFileContents = (
  role: ConnectedPreviewRole,
  contents: string,
  action: PreviewValidationAction,
) => {
  const state: EnvironmentFileValidationState = {
    role,
    action,
    keys: new Set(),
    errors: [],
  };
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    validateEnvironmentFileEntry(state, line, index + 1);
  }
  return { keys: [...state.keys].sort(), errors: state.errors };
};

const validateSharedIdentities = (context: PreviewValidationContext) => {
  const { config, add } = context;
  if (!isSourceRevision(config.identities.sourceRevision)) {
    add(
      "invalid-preview-config",
      "Source revision identity is missing or malformed",
      "Set identities.sourceRevision to the full or abbreviated lowercase Git commit identity.",
      "sourceRevision",
    );
  }
  if (!isSha256(config.identities.deployedManifestDigest)) {
    add(
      "invalid-preview-config",
      "Deployed-manifest identity is missing or malformed",
      "Set identities.deployedManifestDigest to a sha256 digest from the declared development manifest.",
      "deployedManifestDigest",
    );
  }
  if (config.identities.catalogVersion !== catalogVersion) {
    add(
      "stale-compatibility",
      "The declared runtime contract catalog version is stale",
      "Regenerate compatibility declarations against the current repository-owned runtime contract catalog.",
      "catalog",
    );
  }
};

const validateArtifactIdentities = (context: PreviewValidationContext) => {
  const { config, selectedRoles, requiredRoles, add } = context;
  for (const role of selectedRoles) {
    for (const requiredRole of runtimeContractCatalog.roles[role].requiredRoles)
      requiredRoles.add(requiredRole);
    if (!isSha256(config.identities.artifactDigests[role] ?? "")) {
      add(
        "invalid-preview-config",
        `An artifact digest is required for ${role}`,
        "Provide the selected role's source-built artifact digest.",
        role,
      );
    }
  }
  for (const role of connectedPreviewRoles) {
    if (config.identities.artifactDigests[role] !== undefined && !selectedRoles.has(role)) {
      add(
        "invalid-preview-config",
        `Artifact identity for unselected role ${role} is unused`,
        "Declare artifact identities only for explicitly selected roles.",
        role,
      );
    }
  }
  if (
    Object.keys(config.identities.artifactDigests).some(
      (role) => !(connectedPreviewRoles as readonly string[]).includes(role),
    )
  ) {
    add(
      "invalid-preview-config",
      "Artifact identity uses an unknown role",
      "Declare artifact identities only for the seven supported connected-preview roles.",
      "artifactDigests",
    );
  }
};

const isDevelopmentCredentialReference = (
  role: ConnectedPreviewRole,
  name: string,
  reference: string,
) =>
  Predicate.and(
    (value: string) => value === `secret://tiara-stack-dev/${role}/${name}`,
    negatePredicate(hasProductionMarker),
  )(reference);

const validateUnknownCredentialRoles = (context: PreviewValidationContext) => {
  const knownRoles = Object.keys(context.config.credentialReferences).filter((role) =>
    connectedPreviewRoles.some((candidate) => candidate === role),
  );
  if (knownRoles.length === Object.keys(context.config.credentialReferences).length) return;
  context.add(
    "unsafe-preview-credential",
    "Credential references contain an unknown role",
    "Use only the seven supported connected-preview role identifiers.",
    "credentialReferences",
  );
};

const validateCredentialReferenceEntry = (
  context: PreviewValidationContext,
  role: ConnectedPreviewRole,
  name: string,
  reference: string,
) => {
  const allowedName = isConnectedPreviewCredentialAllowed(role, name);
  const displayName = reportCredentialName(role, name);
  if (!allowedName) {
    context.add(
      "unsafe-preview-credential",
      `Credential reference name ${displayName} is not approved for ${role}`,
      `Use only the role-scoped credential names in the runtime catalog for ${role}.`,
      role,
    );
  }
  if (!isDevelopmentCredentialReference(role, name, reference)) {
    context.add(
      "unsafe-preview-credential",
      `Credential reference name ${displayName} does not match its approved ${role} secret path`,
      `Use secret://tiara-stack-dev/${role}/${displayName} for the declared role-scoped credential; raw credentials and production references are rejected.`,
      role,
    );
  }
};

const validateCredentialReferencesForRole = (
  context: PreviewValidationContext,
  role: ConnectedPreviewRole,
) => {
  const references = context.config.credentialReferences[role];
  if (!context.selectedRoles.has(role)) {
    if (references !== undefined) {
      context.add(
        "invalid-preview-config",
        `Credential references for unselected role ${role} are unused`,
        "Declare references only for explicitly selected roles.",
        role,
      );
    }
    return;
  }
  if (references === undefined || Object.keys(references).length === 0) {
    context.add(
      "unsafe-preview-credential",
      `Credential references for ${role} are missing`,
      "Declare non-secret, per-role development secret references.",
      role,
    );
    return;
  }
  for (const [name, reference] of Object.entries(references)) {
    validateCredentialReferenceEntry(context, role, name, reference);
  }
};

const validateCredentialReferences = (context: PreviewValidationContext) => {
  validateUnknownCredentialRoles(context);
  for (const role of connectedPreviewRoles) validateCredentialReferencesForRole(context, role);
};

const contractLabelFor = (change: PreviewChangeConfig) =>
  change.contract == null ? "implementation-only" : safeIdentifier(change.contract);

const contractAllowsRole = (contract: RuntimeContractDefinition, role: ConnectedPreviewRole) =>
  [...contract.providers, ...contract.consumers].some((candidate) => candidate === role);

const validateContractIdentity = (
  context: PreviewValidationContext,
  change: PreviewChangeConfig,
) => {
  const { config, add } = context;
  const label = contractLabelFor(change);
  if (
    change.sourceRevision !== config.identities.sourceRevision ||
    change.artifactDigest !== config.identities.artifactDigests[change.role] ||
    change.deployedManifestDigest !== config.identities.deployedManifestDigest ||
    change.catalogVersion !== catalogVersion
  ) {
    add(
      "stale-compatibility",
      `Compatibility for ${label} does not match the declared source, artifact, deployed-manifest, and catalog identities`,
      "Refresh the declaration against the current source artifact and development manifest.",
      label,
    );
  }
};

const applyIncompatibleClosure = (
  context: PreviewValidationContext,
  change: PreviewChangeConfig,
  contract: RuntimeContractDefinition,
) => {
  if (change.classification !== "incompatible") return;
  for (const role of new Set([...contract.providers, ...contract.consumers])) {
    context.requiredRoles.add(role);
  }
  for (const group of contract.requiredOwnedGroups) {
    context.requiredGroups.add(group);
    context.forceOwnedGroups.add(group);
  }
};

const validateChangeDeclaration = (
  context: PreviewValidationContext,
  change: PreviewChangeConfig,
) => {
  const { add, selectedRoles, changesByKey } = context;
  const label = contractLabelFor(change);
  const key = changeKey(change.role, change.contract);
  if (changesByKey.has(key)) {
    add(
      "invalid-preview-config",
      `Compatibility declaration for ${change.role} and ${label} is duplicated`,
      "Declare each role and contract pair exactly once.",
      change.role,
    );
    return;
  }
  changesByKey.set(key, change);
  if (!selectedRoles.has(change.role)) {
    add(
      "invalid-preview-config",
      `Compatibility declaration for unselected role ${change.role} is unused`,
      "Select the role explicitly or remove its declaration.",
      change.role,
    );
  }
  if (change.contract == null) {
    validateContractIdentity(context, change);
    if (change.classification !== "implementation-only") {
      add(
        "invalid-preview-config",
        "A contract-free change must be classified implementation-only",
        "Use implementation-only only when no runtime contract changes.",
        change.role,
      );
    }
    return;
  }
  if (change.classification === "implementation-only") {
    add(
      "invalid-preview-config",
      "Implementation-only declarations cannot name a runtime contract",
      "Declare implementation-only work with contract: null; declare contract compatibility separately.",
      change.role,
    );
    return;
  }
  const contract = getRuntimeContract(change.contract);
  if (contract === undefined || !contractAllowsRole(contract, change.role)) {
    add(
      "missing-compatibility",
      `Runtime contract ${label} is not declared for ${change.role}`,
      "Use a contract and role pair from the repository-owned runtime contract catalog.",
      change.role,
    );
    return;
  }
  if (change.classification === "unknown") {
    add(
      "unknown-compatibility",
      `Compatibility for ${label} is unknown`,
      "Declare verified compatibility or select the required owned group and caller closure; unknown evidence blocks admission.",
      label,
    );
  }
  validateContractIdentity(context, change);
  applyIncompatibleClosure(context, change, contract);
};

const validateChangeDeclarations = (context: PreviewValidationContext) => {
  for (const change of context.config.changes) validateChangeDeclaration(context, change);
};

const validateRequiredContractDeclarations = (context: PreviewValidationContext) => {
  const { config, changesByKey, add } = context;
  for (const role of config.roles) {
    const contracts = contractsForRole(role);
    for (const contract of [...contracts.providedContracts, ...contracts.consumedContracts]) {
      if (!changesByKey.has(changeKey(role, contract))) {
        add(
          "missing-compatibility",
          `Compatibility declaration for ${role} and ${contract} is missing`,
          "Declare implementation impact for every selected runtime contract against the current deployed-manifest identity.",
          contract,
        );
      }
    }
  }
};

const addWorkflowGroupRoleRequirements = (context: PreviewValidationContext) => {
  if (!context.requiredGroups.has("workflow-execution")) return;
  const ownership = context.groupsById.get("workflow-execution")?.ownership;
  if (ownership === "owned") {
    context.requiredRoles.add("sheet-workflows-api");
    context.requiredRoles.add("sheet-workflows-runner");
  } else if (ownership === "reused") {
    const webOnlyConsumer =
      context.selectedRoles.size === 1 && context.selectedRoles.has("sheet-web");
    if (!webOnlyConsumer) context.requiredRoles.add("sheet-workflows-api");
  }
};

const expandRequiredRoleClosure = (context: PreviewValidationContext) => {
  const pending = [...context.requiredRoles];
  const visited = new Set<ConnectedPreviewRole>();
  for (let index = 0; index < pending.length; index += 1) {
    const role = pending[index];
    if (role === undefined || visited.has(role)) continue;
    visited.add(role);
    const definition = runtimeContractCatalog.roles[role];
    for (const requiredRole of definition.requiredRoles) {
      if (context.requiredRoles.has(requiredRole)) continue;
      context.requiredRoles.add(requiredRole);
      pending.push(requiredRole);
    }
    for (const group of definition.groups) context.requiredGroups.add(group);
  }
};

const closeRequiredRoleAndGroupSets = (context: PreviewValidationContext) => {
  expandRequiredRoleClosure(context);
  addWorkflowGroupRoleRequirements(context);
  expandRequiredRoleClosure(context);
  for (const group of context.forceOwnedGroups) context.requiredGroups.add(group);
};

const validateMissingRoles = (context: PreviewValidationContext) => {
  const missing = connectedPreviewRoles.filter(
    (role) => context.requiredRoles.has(role) && !context.selectedRoles.has(role),
  );
  for (const role of missing) {
    context.add(
      "required-role-missing",
      `Required caller role ${role} is not explicitly selected`,
      "Add the required role and its credential, artifact, compatibility, and group declarations; closure never selects it implicitly.",
      role,
    );
  }
  return missing;
};

const validateOwnedGroupAllocationProfile = (
  context: PreviewValidationContext,
  group: PreviewGroupConfig,
) => {
  if (!isNonEmpty(group.allocationProfile) || !isSafeIdentifier(group.allocationProfile ?? "")) {
    context.add(
      "required-group-missing",
      `Owned group ${group.id} has no safe allocation profile`,
      "Declare the operator-approved development allocation profile for this owned group.",
      group.id,
    );
  }
};

const validateOwnedGroupAllocatedIdentityFields = (
  context: PreviewValidationContext,
  group: PreviewGroupConfig,
) => {
  if (
    group.endpoint !== undefined ||
    group.stateIdentity !== undefined ||
    group.deployedManifestDigest !== undefined
  ) {
    context.add(
      "invalid-preview-intent",
      `Owned group ${group.id} cannot predeclare an allocated endpoint or state identity`,
      "Owned endpoint and state identities are assigned by the controller after admission.",
      group.id,
    );
  }
};

const validateOwnedGroupProfileUniqueness = (
  context: PreviewValidationContext,
  group: PreviewGroupConfig,
) => {
  if (group.allocationProfile === undefined || !isSafeIdentifier(group.allocationProfile)) return;
  const previous = context.allocationProfileOwners.get(group.allocationProfile);
  if (previous !== undefined && previous !== group.id) {
    context.add(
      "conflicting-preview-endpoint",
      `Owned groups ${previous} and ${group.id} reuse one allocation profile`,
      "Give each owned dependency group a distinct development allocation profile.",
      group.id,
    );
  } else {
    context.allocationProfileOwners.set(group.allocationProfile, group.id);
  }
};

const validateOwnedGroup = (context: PreviewValidationContext, group: PreviewGroupConfig) => {
  validateOwnedGroupAllocationProfile(context, group);
  validateOwnedGroupAllocatedIdentityFields(context, group);
  validateOwnedGroupProfileUniqueness(context, group);
};

const contractRequiresGroup = (
  contractId: string | null | undefined,
  groupId: ConnectedPreviewGroup,
) => {
  if (contractId == null) return false;
  const contract = getRuntimeContract(contractId);
  return contract?.requiredOwnedGroups.some((required) => required === groupId) ?? false;
};

const validateReusedGroupCompatibility = (
  context: PreviewValidationContext,
  groupId: ConnectedPreviewGroup,
) => {
  for (const change of context.config.changes) {
    if (!contractRequiresGroup(change.contract, groupId)) continue;
    const label = contractLabelFor(change);
    if (change.classification === "incompatible") {
      context.add(
        "invalid-preview-intent",
        `Incompatible contract ${label} cannot reuse group ${groupId}`,
        "Select the required owned group explicitly; the planner will not allocate it on your behalf.",
        groupId,
      );
    } else if (change.classification !== "compatible") {
      context.add(
        "unknown-compatibility",
        `Reused group ${groupId} lacks compatible evidence for ${label}`,
        "Provide current compatible evidence or select the required owned group.",
        groupId,
      );
    }
  }
};

const validateReusedGroupFields = (
  context: PreviewValidationContext,
  group: PreviewGroupConfig,
) => {
  if (group.allocationProfile !== undefined) {
    context.add(
      "invalid-preview-intent",
      `Reused group ${group.id} cannot declare an allocation profile`,
      "Remove the owned allocation profile; reused groups identify an existing endpoint and state instead.",
      group.id,
    );
  }
  if (
    !isNonEmpty(group.endpoint) ||
    !isSafeIdentifier(group.stateIdentity ?? "") ||
    !isSha256(group.deployedManifestDigest ?? "")
  ) {
    context.add(
      "required-group-missing",
      `Reused group ${group.id} needs an explicit endpoint, state identity, and deployed-manifest identity`,
      "Declare the exact compatible development service being reused.",
      group.id,
    );
  }
};

const recordReusedGroupEndpoint = (
  context: PreviewValidationContext,
  group: PreviewGroupConfig,
) => {
  const endpoint = group.endpoint === undefined ? null : endpointForReuse(group.endpoint);
  if (endpoint === null) {
    context.add(
      "unsafe-preview-endpoint",
      `Reused group ${group.id} has an invalid, production, or credential-bearing endpoint`,
      "Use an HTTPS or approved private development endpoint with no embedded credentials, query, or fragment.",
      group.id,
    );
  } else {
    const previous = context.endpointOwners.get(endpoint.key);
    if (previous !== undefined && previous !== group.id) {
      context.add(
        "conflicting-preview-endpoint",
        `Reused groups ${previous} and ${group.id} resolve to the same endpoint`,
        "Give each reused service one unambiguous development endpoint.",
        group.id,
      );
    } else {
      context.endpointOwners.set(endpoint.key, group.id);
    }
  }
};

const recordReusedGroupStateIdentity = (
  context: PreviewValidationContext,
  group: PreviewGroupConfig,
) => {
  if (isSafeIdentifier(group.stateIdentity ?? "")) {
    const previous = context.stateIdentityOwners.get(group.stateIdentity ?? "");
    if (previous !== undefined && previous !== group.id) {
      context.add(
        "conflicting-preview-endpoint",
        `Reused groups ${previous} and ${group.id} share a state identity`,
        "Give each dependency group an exact, unambiguous state identity.",
        group.id,
      );
    } else {
      context.stateIdentityOwners.set(group.stateIdentity ?? "", group.id);
    }
  }
};

const validateReusedGroupManifest = (
  context: PreviewValidationContext,
  group: PreviewGroupConfig,
) => {
  if (group.deployedManifestDigest !== context.config.identities.deployedManifestDigest) {
    context.add(
      "stale-compatibility",
      `Reused group ${group.id} does not match the declared deployed-manifest identity`,
      "Refresh the group identity and contract declarations from the same development manifest.",
      group.id,
    );
  }
};

const validateReusedGroup = (context: PreviewValidationContext, group: PreviewGroupConfig) => {
  validateReusedGroupFields(context, group);
  recordReusedGroupEndpoint(context, group);
  recordReusedGroupStateIdentity(context, group);
  validateReusedGroupManifest(context, group);
  validateReusedGroupCompatibility(context, group.id);
};

const validateGroupDeclarations = (context: PreviewValidationContext) => {
  const seen = new Set<ConnectedPreviewGroup>();
  for (const group of context.config.groups) {
    if (seen.has(group.id)) {
      context.add(
        "invalid-preview-config",
        `Dependency group ${group.id} is declared more than once`,
        "Declare each dependency group once with one explicit ownership choice.",
        group.id,
      );
    }
    seen.add(group.id);
    if (!context.requiredGroups.has(group.id)) {
      context.add(
        "invalid-preview-intent",
        `Dependency group ${group.id} is not required by the selected role closure`,
        "Remove the undeclared extra allocation or select a role that requires this group.",
        group.id,
      );
    }
    if (group.ownership === "owned") validateOwnedGroup(context, group);
    else validateReusedGroup(context, group);
  }
};

const validateRequiredGroupDeclarations = (context: PreviewValidationContext) => {
  for (const group of connectedPreviewGroups) {
    if (!context.requiredGroups.has(group)) continue;
    const selection = context.groupsById.get(group);
    if (selection === undefined) {
      context.add(
        "required-group-missing",
        `Required dependency group ${group} has no ownership declaration`,
        "Declare this group as owned or reused and provide its required identity fields.",
        group,
      );
    } else if (context.forceOwnedGroups.has(group) && selection.ownership !== "owned") {
      context.add(
        "invalid-preview-intent",
        `Incompatible changes require ${group} to be owned`,
        "Select the required owned group explicitly; a reused endpoint cannot satisfy incompatible state or contract requirements.",
        group,
      );
    }
  }
};

const hasSelectedRunner = (context: PreviewValidationContext) =>
  context.selectedRoles.has("sheet-workflows-runner") ||
  context.selectedRoles.has("sheet-workflows-browser-runner");

const validateProducerOnlySelection = (context: PreviewValidationContext) => {
  const group = context.groupsById.get("workflow-execution");
  const webOnlyConsumer =
    context.selectedRoles.size === 1 && context.selectedRoles.has("sheet-web");
  const valid =
    context.requiredGroups.has("workflow-execution") &&
    group?.ownership === "reused" &&
    !hasSelectedRunner(context) &&
    (webOnlyConsumer || context.selectedRoles.has("sheet-workflows-api"));
  if (!valid) {
    context.add(
      "invalid-preview-intent",
      "Shared execution requires a reused workflow-execution group and either a sole sheet-web selection or an explicitly compatible producer-only sheet-workflows-api selection",
      "Reuse workflow-execution, omit preview runner roles, and either select only sheet-web or select sheet-workflows-api with compatible workflow contracts.",
      "workflow-execution",
    );
  }
};

const validateProducerOnlyCompatibility = (context: PreviewValidationContext) => {
  for (const contractId of ["workflow.enqueue", "workflow.execution"] as const) {
    const declaration = context.changesByKey.get(changeKey("sheet-workflows-api", contractId));
    if (declaration?.classification !== "compatible") {
      context.add(
        "unknown-compatibility",
        `Shared execution requires compatible ${contractId} evidence`,
        "Provide current compatible declarations; incompatible, missing, stale, or unknown evidence blocks shared execution.",
        contractId,
      );
    }
  }
};

const validateSharedExecutionIntent = (context: PreviewValidationContext) => {
  if (context.config.sharedExecution === "producer-only") {
    validateProducerOnlySelection(context);
    const webOnlyConsumer =
      context.selectedRoles.size === 1 && context.selectedRoles.has("sheet-web");
    if (!webOnlyConsumer) validateProducerOnlyCompatibility(context);
    return;
  }
  if (
    context.requiredGroups.has("workflow-execution") &&
    context.groupsById.get("workflow-execution")?.ownership === "reused"
  ) {
    context.add(
      "invalid-preview-intent",
      "A reused workflow execution group requires explicit producer-only shared-execution intent",
      "Set sharedExecution to producer-only only for a compatible API producer; select an owned group for changed execution.",
      "workflow-execution",
    );
  }
};

const validateSeedIntent = (context: PreviewValidationContext) => {
  const { config, groupsById, add } = context;
  if (
    config.seed !== undefined &&
    (!isSafeIdentifier(config.seed) || config.seed !== syntheticDevelopmentSeedId)
  ) {
    add(
      "invalid-preview-intent",
      "Synthetic seed is not supported",
      `Use the approved ${syntheticDevelopmentSeedId} seed; credentials and arbitrary data do not belong in the preview configuration.`,
      "seed",
    );
  }
  if (config.seed !== undefined && groupsById.get("application-zero")?.ownership !== "owned") {
    add(
      "invalid-preview-intent",
      "A Development Seed requires a newly owned application-zero group",
      "Select an owned application-zero group before declaring a synthetic seed.",
      "application-zero",
    );
  }
};

const validateAdditionalUserGrants = (context: PreviewValidationContext) => {
  const grants = context.config.additionalUserGrants ?? [];
  for (const grant of grants) {
    if (!isSafeIdentifier(grant)) {
      context.add(
        "invalid-preview-intent",
        "Additional user grant must be a safe user identity",
        "Declare approved user IDs only; credential values do not belong in grants.",
        "additionalUserGrants",
      );
    }
  }
  if (new Set(grants).size !== grants.length) {
    context.add(
      "invalid-preview-intent",
      "Additional user grants must be unique",
      "List each additional user once.",
      "additionalUserGrants",
    );
  }
};

const validateExternalTargets = (context: PreviewValidationContext) => {
  const targets = context.config.externalTargets ?? [];
  for (const target of targets) {
    if (!isSafeIdentifier(target)) {
      context.add(
        "invalid-preview-intent",
        "External target must be a safe allocation identifier",
        "Declare non-secret development target IDs; credentials do not belong in target names.",
        "externalTargets",
      );
    }
  }
  if (new Set(targets).size !== targets.length) {
    context.add(
      "invalid-preview-intent",
      "External target allocations must be unique",
      "List each development target once.",
      "externalTargets",
    );
  }
};

const validateTriggerTarget = (
  context: PreviewValidationContext,
  triggerName: string,
  target: string,
  allocatedTargets: ReadonlySet<string>,
) => {
  if (!isSafeIdentifier(target)) {
    context.add(
      "invalid-preview-intent",
      `Trigger ${safeIdentifier(triggerName)} has an invalid target identifier`,
      "Use a non-secret development target ID.",
      "triggers",
    );
  }
  if (!allocatedTargets.has(target)) {
    context.add(
      "invalid-preview-intent",
      `Trigger ${safeIdentifier(triggerName)} references an unallocated external target`,
      "Declare the target in externalTargets; planning records intent but does not allocate it.",
      "triggers",
    );
  }
};

const validateTrigger = (
  context: PreviewValidationContext,
  trigger: { readonly name: string; readonly targets: readonly string[] },
  allocatedTargets: ReadonlySet<string>,
) => {
  if (!isSafeIdentifier(trigger.name)) {
    context.add(
      "invalid-preview-intent",
      "Trigger name must be a safe identifier",
      "Use a non-secret trigger name.",
      "triggers",
    );
  }
  if (trigger.targets.length === 0) {
    context.add(
      "invalid-preview-intent",
      `Enabled trigger ${safeIdentifier(trigger.name)} needs explicit targets`,
      "Keep triggers disabled by omitting them, or name every development target allocation.",
      "triggers",
    );
  }
  for (const target of trigger.targets) {
    validateTriggerTarget(context, trigger.name, target, allocatedTargets);
  }
};

const validateTriggers = (context: PreviewValidationContext) => {
  const triggers = context.config.triggers ?? [];
  const allocatedTargets = new Set(context.config.externalTargets ?? []);
  if (new Set(triggers.map(({ name }) => name)).size !== triggers.length) {
    context.add(
      "invalid-preview-intent",
      "Trigger declarations must be unique",
      "List each enabled trigger once.",
      "triggers",
    );
  }
  for (const trigger of triggers) validateTrigger(context, trigger, allocatedTargets);
  if (triggers.length > 0 && context.groupsById.get("workflow-execution")?.ownership !== "owned") {
    context.add(
      "invalid-preview-intent",
      "Enabled triggers require an owned workflow-execution group",
      "Triggers remain off unless their producer and target allocations are explicitly owned.",
      "workflow-execution",
    );
  }
};

const validateBotHandoffSelection = (
  context: PreviewValidationContext,
  handoff: ConnectedPreviewConfig["botHandoff"],
) => {
  const selected = context.selectedRoles.has("sheet-bot");
  if (selected && handoff == null) {
    context.add(
      "invalid-preview-intent",
      "Selecting sheet-bot requires explicit exclusive handoff intent",
      "Declare the allocated development target and acknowledge that shared bot functionality is interrupted.",
      "bot-storage",
    );
  }
  if (!selected && handoff != null) {
    context.add(
      "invalid-preview-intent",
      "Bot handoff intent is present without selecting sheet-bot",
      "Remove the handoff request or select sheet-bot explicitly.",
      "bot-storage",
    );
  }
};

const validateBotHandoffDetails = (
  context: PreviewValidationContext,
  handoff: NonNullable<ConnectedPreviewConfig["botHandoff"]>,
) => {
  if (!isSafeIdentifier(handoff.targetAllocation)) {
    context.add(
      "invalid-preview-intent",
      "Bot handoff target must be a safe development allocation identifier",
      "Declare the development guild or target ID without credentials.",
      "bot-storage",
    );
  }
  if (!handoff.acknowledgedSharedInterruption) {
    context.add(
      "invalid-preview-intent",
      "Exclusive bot handoff needs acknowledgment of shared bot interruption",
      "Set acknowledgedSharedInterruption to true after recording that shared bot functionality will be unavailable.",
      "bot-storage",
    );
  }
  if (!(context.config.externalTargets ?? []).includes(handoff.targetAllocation)) {
    context.add(
      "invalid-preview-intent",
      "Bot handoff target allocation is not declared in externalTargets",
      "Declare the exact development guild or target allocation.",
      "bot-storage",
    );
  }
  if (context.groupsById.get("bot-storage")?.ownership !== "owned") {
    context.add(
      "invalid-preview-intent",
      "Exclusive bot handoff requires owned bot-storage",
      "Select bot-storage as owned for the preview capability state and key.",
      "bot-storage",
    );
  }
  if (context.groupsById.get("workflow-execution")?.ownership !== "owned") {
    context.add(
      "invalid-preview-intent",
      "Exclusive bot handoff requires an owned workflow-execution group",
      "Select the matching workflow API and runner callers with an owned execution group before handing off the bot.",
      "workflow-execution",
    );
  }
};

const validateBotHandoffIntent = (context: PreviewValidationContext) => {
  const handoff = context.config.botHandoff;
  validateBotHandoffSelection(context, handoff);
  if (handoff != null) validateBotHandoffDetails(context, handoff);
};

const validateConfiguration = (
  config: ConnectedPreviewConfig,
  action: PreviewValidationAction,
): { readonly report: ConnectedPreviewReport; readonly errors: readonly Diagnostic[] } => {
  const context = makePreviewValidationContext(config, action);
  validateRootEnvironment(context);
  validateRoleSelection(context);
  validatePreviewRelayListeners(context);
  validateEnvironmentFileInputDeclarations(context);
  validateSharedIdentities(context);
  validateArtifactIdentities(context);
  validateCredentialReferences(context);
  validateChangeDeclarations(context);
  validateRequiredContractDeclarations(context);
  closeRequiredRoleAndGroupSets(context);
  const missingRoles = validateMissingRoles(context);
  validateGroupDeclarations(context);
  validateRequiredGroupDeclarations(context);
  validateSharedExecutionIntent(context);
  validateSeedIntent(context);
  validateAdditionalUserGrants(context);
  validateExternalTargets(context);
  validateTriggers(context);
  validateBotHandoffIntent(context);
  const requiredGroupDetails = connectedPreviewGroups
    .filter((group) => context.requiredGroups.has(group))
    .map((id) => ({
      id,
      ownership: (context.groupsById.get(id)?.ownership ?? "missing") as GroupOwnership | "missing",
    }));
  const report = buildConnectedPreviewReport(
    config,
    context.errors.length === 0 ? "planned" : "blocked",
    connectedPreviewRoles.filter((role) => context.requiredRoles.has(role)),
    connectedPreviewRoles.filter((role) => missingRoles.includes(role)),
    requiredGroupDetails,
  );
  return { report, errors: context.errors };
};

const parseConfigText = (
  contents: string,
):
  | { readonly config: ConnectedPreviewConfig; readonly error?: never }
  | { readonly config?: never; readonly error: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return { error: "Connected preview configuration must be valid JSON" };
  }
  return decodeConfiguration(parsed);
};

const outputForUnavailableExecution = (
  command: Extract<ParsedCommand, { readonly kind: "preview" }>,
): LauncherOutput => {
  const allocationCleanupAction = command.action === "cleanup" || command.action === "resolve";
  return {
    schemaVersion: 3,
    ok: false,
    command: command.command,
    mode: "preview",
    action: command.action,
    selectedServices: [],
    checkoutState: null,
    plannedProcesses: [],
    urls: [],
    readiness: "blocked",
    warnings: [],
    errors: [
      makeDiagnostic(
        "dependency-unavailable",
        allocationCleanupAction
          ? "Cleanup requires the durable preview session and allocation authorities; no cleanup operation was attempted"
          : `Connected preview ${command.action} is unavailable; no session operation was attempted`,
        allocationCleanupAction
          ? "Configure TIARA_PREVIEW_SESSION_DATABASE and the matching local owner credential store, then retry cleanup."
          : "Configure and authenticate the durable preview session controller before using session actions.",
        { mode: "preview", action: command.action },
      ),
    ],
    changedSurfaces: [],
    parityGates: [],
  };
};

const identityDirectory = (environment: NodeJS.ProcessEnv) => {
  const database = environment.TIARA_PREVIEW_SESSION_DATABASE;
  if (database === undefined || database.trim() === "") return undefined;
  return `${path.resolve(database)}.credentials`;
};

const identityPath = (sessionId: string, environment: NodeJS.ProcessEnv) => {
  const directory = identityDirectory(environment);
  if (directory === undefined) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId))
    return undefined;
  const candidate = path.resolve(directory, sessionId);
  return candidate.startsWith(`${directory}${path.sep}`) ? candidate : undefined;
};

type LocalSessionCredentials = typeof SessionCredentialsSchema.Type;

const persistSessionCredentials = (filePath: string, credentials: LocalSessionCredentials) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* fileSystem.writeFileString(temporaryPath, JSON.stringify(credentials), {
        mode: 0o600,
        flag: "wx",
      });
      yield* fileSystem.chmod(directory, 0o700);
      yield* fileSystem.chmod(temporaryPath, 0o600);
      yield* fileSystem.rename(temporaryPath, filePath);
      yield* fileSystem.chmod(filePath, 0o600);
    }).pipe(
      Effect.onError(() => fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
    );
  }).pipe(Effect.mapError(() => new Error("session-credentials-storage-unavailable")));

const readSessionCredentials = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem.readFileString(filePath);
    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(SessionCredentialsSchema)(JSON.parse(raw) as unknown),
      catch: () => new Error("session-credentials-unavailable"),
    });
  }).pipe(Effect.mapError(() => new Error("session-credentials-unavailable")));

const sessionOutput = (
  command: ConnectedPreviewCommand,
  session: import("./preview-sessions").PreviewSession,
  allocationStatus?: import("./preview-allocations").PreviewAllocationStatus,
): LauncherOutput => ({
  schemaVersion: 3,
  ok: true,
  command: command.command,
  mode: "preview",
  action: command.action,
  selectedServices: [],
  checkoutState: null,
  plannedProcesses: [],
  urls: [],
  readiness:
    session.phase === "ended"
      ? "stopped"
      : session.phase === "expired"
        ? "blocked"
        : session.phase === "active"
          ? "ready"
          : "planned",
  warnings: [],
  errors: [],
  changedSurfaces: [],
  parityGates: [],
  previewSession: {
    id: session.id,
    requestedRevision: session.requestedRevision,
    activeRevision: session.activeRevision,
    phase: session.phase,
    generation: session.generation,
    leaseDeadline: session.leaseDeadline,
    lastRenewedAt: session.lastRenewedAt,
    unsettled: session.unsettled,
    ...(allocationStatus === undefined
      ? {}
      : {
          allocations: {
            reservations: allocationStatus.reservations,
            resources: allocationStatus.allocations,
            cleanup: allocationStatus.cleanup,
          },
        }),
  },
});

const sessionOperationFailure = (
  command: ConnectedPreviewCommand,
  message: string,
): LauncherOutput => ({
  ...outputForUnavailableExecution(command),
  errors: [
    makeDiagnostic(
      "dependency-unavailable",
      `Connected preview ${command.action} could not be authorized by the session controller`,
      message,
      { mode: "preview", action: command.action },
    ),
  ],
});

type StartConfigResult =
  | { readonly config: ConnectedPreviewConfig; readonly output?: never }
  | { readonly config?: never; readonly output: LauncherOutput };

const readStartConfig = (
  command: PreviewStartCommand,
  cwd: string,
): Effect.Effect<StartConfigResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const configPath = path.resolve(cwd, command.options.configFile);
    const contents = yield* Effect.result(fileSystem.readFileString(configPath));
    if (Result.isFailure(contents)) {
      return {
        output: sessionOperationFailure(
          command,
          "Read the explicit preview configuration before creating a session.",
        ),
      };
    }
    const decoded = parseConfigText(contents.success);
    if ("error" in decoded) return { output: outputForInvalidConfig(command, decoded.error) };
    const validation = validateConfiguration(decoded.config, "plan");
    const environmentFiles = yield* inspectEnvironmentFileInputs(
      decoded.config,
      configPath,
      "plan",
    );
    const report = { ...validation.report, environmentFileInputs: environmentFiles.inputs };
    const errors = [...validation.errors, ...environmentFiles.errors];
    if (errors.length > 0) {
      return { output: outputForPreviewReport(command, report, errors) };
    }
    return { config: decoded.config };
  });

const failedPendingSessionOutput = (
  command: ConnectedPreviewCommand,
  session: import("./preview-sessions").PreviewSession,
  remediation: string,
): LauncherOutput => ({
  ...sessionOutput(command, session),
  ok: false,
  readiness: "blocked",
  errors: [
    makeDiagnostic("dependency-unavailable", "Session identity could not be stored", remediation),
  ],
});

type CreatedPreviewSessionResult =
  | { readonly created: import("./preview-sessions").SessionCredentials; readonly output?: never }
  | { readonly created?: never; readonly output: LauncherOutput };

const createPendingPreviewSession = (
  command: PreviewStartCommand,
  config: ConnectedPreviewConfig,
  cwd: string,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
): Effect.Effect<CreatedPreviewSessionResult> =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      dispatchPreviewSessionProtocol(controller, {
        _tag: "Create",
        input: {
          owner: config.owner,
          checkout: path.resolve(cwd),
          manifests: {
            ...config.identities.artifactDigests,
            "deployed-manifest": config.identities.deployedManifestDigest,
          },
          requestedRevision: config.identities.sourceRevision,
          groups: config.groups.map(({ id }) => id),
          endpoints: config.groups.flatMap((group) =>
            group.ownership === "reused" && group.endpoint ? [group.endpoint] : [],
          ),
          targets: [
            ...new Set([
              ...(config.externalTargets ?? []),
              ...(config.triggers ?? []).flatMap(({ targets }) => targets),
              ...(config.botHandoff === null || config.botHandoff === undefined
                ? []
                : [config.botHandoff.targetAllocation]),
            ]),
          ],
        },
      }),
    );
    if (Result.isFailure(result)) {
      return {
        output: sessionOperationFailure(command, "The durable session authority is unavailable."),
      };
    }
    if (result.success._tag !== "Created") {
      return {
        output: sessionOperationFailure(
          command,
          "The controller returned an invalid create response.",
        ),
      };
    }
    return { created: result.success };
  });

const stopSessionWithoutCredentials = (
  command: PreviewStartCommand,
  created: import("./preview-sessions").SessionCredentials,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
) =>
  Effect.gen(function* () {
    const stopped = yield* Effect.result(
      dispatchPreviewSessionProtocol(controller, {
        _tag: "Stop",
        id: created.session.id,
        ownerIdentity: created.ownerIdentity,
      }),
    );
    const session =
      Result.isSuccess(stopped) && stopped.success._tag === "Session"
        ? stopped.success.session
        : created.session;
    return failedPendingSessionOutput(
      command,
      session,
      "The session ID was retained for inspection, but its owner credentials could not be stored.",
    );
  });

const persistPreviewSessionCredentials = (
  command: PreviewStartCommand,
  created: import("./preview-sessions").SessionCredentials,
  tokenPath: string,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
) =>
  Effect.gen(function* () {
    const persisted = yield* Effect.result(
      persistSessionCredentials(tokenPath, {
        ownerIdentity: created.ownerIdentity,
        supervisorIdentity: created.supervisorIdentity,
      }),
    );
    return Result.isFailure(persisted)
      ? yield* stopSessionWithoutCredentials(command, created, controller)
      : sessionOutput(command, created.session);
  });

type PreparedPreviewStart = {
  readonly config: ConnectedPreviewConfig;
  readonly cwd: string;
  readonly plan: import("./preview-allocations").PreviewProfileDemandPlan;
  readonly relayPlan: PreviewRelayResourcePlan;
  readonly environment: NodeJS.ProcessEnv;
};

type PreviewDemandPreparation =
  | { readonly plan: import("./preview-allocations").PreviewProfileDemandPlan }
  | { readonly output: LauncherOutput };

const ownedGroupIds = (config: ConnectedPreviewConfig) =>
  config.groups.filter(({ ownership }) => ownership === "owned").map(({ id }) => id);

const prepareConnectedProfileDemand = (
  command: PreviewStartCommand,
  config: ConnectedPreviewConfig,
  allocations: import("./preview-allocations").PreviewAllocationApi | undefined,
): Effect.Effect<PreviewDemandPreparation> =>
  Effect.gen(function* () {
    if (allocations === undefined)
      return {
        output: sessionOperationFailure(
          command,
          "The durable capacity reservation and ownership ledger is unavailable; no session or resource was created.",
        ),
      };
    const input = {
      profile: config.profile,
      selectedRoles: config.roles,
      ownedGroups: ownedGroupIds(config),
    };
    const planned = yield* Effect.result(allocations.planProfile(input));
    if (Result.isFailure(planned))
      return {
        output: sessionOperationFailure(
          command,
          `No connected profile demand and provider adapter is available (${allocationFailureMessage(planned.failure)}); no session was created and no allocation was attempted.`,
        ),
      };
    const capacity = yield* Effect.result(allocations.checkCapacity(planned.success.demands));
    if (Result.isFailure(capacity))
      return {
        output: {
          ...outputForUnavailableExecution(command),
          errors: [capacityObservationReadFailure("start")],
        },
      };
    const capacityDiagnostics = capacity.success.flatMap((check) =>
      capacityCheckDiagnostic(check, "start"),
    );
    if (capacityDiagnostics.length > 0)
      return {
        output: {
          ...outputForUnavailableExecution(command),
          errors: capacityDiagnostics,
        },
      };
    const supported = yield* Effect.result(allocations.validateProfileAllocation(input));
    if (Result.isFailure(supported))
      return {
        output: sessionOperationFailure(
          command,
          `The configured adapter cannot allocate the selected connected profile (${allocationFailureMessage(supported.failure)}); no session was created and no allocation was attempted.`,
        ),
      };
    return planned.success.demands.length > 0 && planned.success.resources.length > 0
      ? { plan: planned.success }
      : {
          output: sessionOperationFailure(
            command,
            "The selected profile produced no verified resource demand; no session was created.",
          ),
        };
  });

const preparePreviewRelayPlan = (
  config: ConnectedPreviewConfig,
): { readonly plan: PreviewRelayResourcePlan } | { readonly error: string } => {
  const plan = buildPreviewRelayResourcePlan(config.roles, config.hostListeners ?? []);
  return "error" in plan
    ? { error: `${plan.error} No session or resources were created.` }
    : { plan: plan.plan };
};

const validatePreviewRelayStartReadiness = (
  provider: LauncherOptions["previewRelayProvider"],
  config: ConnectedPreviewConfig,
  plan: PreviewRelayResourcePlan,
): Effect.Effect<string | undefined> => {
  if (plan.resources.length === 0) return Effect.succeed(undefined);
  if (provider === undefined || !provider.configured)
    return Effect.succeed("The session relay provider is unavailable.");
  return Effect.gen(function* () {
    const checked = yield* Effect.result(
      provider.checkPreparedWorkspace({
        profile: config.profile,
        roles: config.roles,
        listeners: config.hostListeners ?? [],
      }),
    );
    if (checked._tag === "Failure")
      return "Prepared-workspace relay authorization could not be verified.";
    const checksById = new Map(checked.success.map((check) => [check.id, check]));
    const unavailable = previewRelayDoctorCheckIds.filter(
      (id) => checksById.get(id)?.status !== "ready",
    );
    return unavailable.length === 0
      ? undefined
      : `Prepared-workspace relay checks are not ready (${unavailable.join(", ")}).`;
  });
};

const sheetWebDependencyGroups = [
  "application-zero",
  "auth",
  "workflow-execution",
  "search",
] as const;
const sheetWebDependencyGroupSet: ReadonlySet<string> = new Set(sheetWebDependencyGroups);
const sheetWebCredentialReferences = (config: ConnectedPreviewConfig) => {
  const credentials = config.credentialReferences["sheet-web"] ?? {};
  return {
    "application-zero": credentials["application-integration"],
    auth: credentials["preview-admission"],
    "workflow-execution": credentials["preview-admission"],
    search: credentials["search-query"],
  } satisfies Record<(typeof sheetWebDependencyGroups)[number], string | undefined>;
};

const validateSheetWebDependencies = (
  config: ConnectedPreviewConfig,
  provider: LauncherOptions["previewRelayProvider"],
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    if (provider === undefined)
      return "No mediated development endpoint checker is configured for sheet-web.";
    const required = sheetWebDependencyGroups;
    const groups = new Map(config.groups.map((group) => [group.id, group]));
    const endpoints = required.map((id) => groups.get(id)?.endpoint);
    if (endpoints.some((endpoint) => endpoint === undefined))
      return "Every sheet-web shared dependency needs an explicitly reused endpoint.";
    const approvedHostnames = endpoints.flatMap((endpoint) => {
      try {
        const url = new URL(endpoint!);
        return url.protocol === "https:" ? [url.hostname] : [];
      } catch {
        return [];
      }
    });
    if (approvedHostnames.length !== required.length)
      return "A sheet-web shared dependency endpoint is not an approved HTTPS origin.";
    const listener = config.hostListeners?.find(({ role }) => role === "sheet-web");
    if (listener === undefined) return "A reserved sheet-web host listener is required.";
    const credentialByGroup = sheetWebCredentialReferences(config);
    const checks = yield* Effect.forEach(
      required,
      (groupId) =>
        Effect.gen(function* () {
          const url = new URL(groups.get(groupId)!.endpoint!);
          const probe = yield* Effect.result(
            provider
              .checkDevelopmentDependency({
                approvedHostnames,
                request: {
                  sessionId: "preview-admission-check",
                  role: "sheet-web",
                  processId: listener.processId,
                  hostname: url.hostname,
                  ...(url.port === "" ? {} : { port: Number(url.port) }),
                  protocol: "https",
                  probePath: "/ready",
                  tlsServerName: url.hostname,
                  credentialReference: credentialByGroup[groupId],
                },
              })
              .pipe(Effect.timeoutOption("5 seconds")),
          );
          return Result.isFailure(probe) ||
            Option.isNone(probe.success) ||
            !probe.success.value.authenticated ||
            probe.success.value.status < 200 ||
            probe.success.value.status >= 300
            ? `The selected sheet-web dependency ${groupId} did not pass its authenticated /ready probe.`
            : undefined;
        }),
      { concurrency: "unbounded" },
    );
    return checks.find((failure) => failure !== undefined);
  });

const preparePreviewStart = (
  command: PreviewStartCommand,
  options: LauncherOptions,
  allocations: import("./preview-allocations").PreviewAllocationApi | undefined,
): Effect.Effect<
  PreparedPreviewStart | { readonly output: LauncherOutput },
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const cwd = options.cwd ?? process.cwd();
    const setup = yield* readStartConfig(command, cwd);
    if (setup.output !== undefined) return { output: setup.output };
    const profile = preparePreviewProfile(command, setup.config, options);
    if (!profile.ok) return { output: profile.output };
    const preparedDemand = yield* preparePreviewDemand(command, setup.config, allocations, options);
    if ("output" in preparedDemand) return preparedDemand;
    const readinessFailure = yield* validatePreviewStartDependencies(
      command,
      setup.config,
      profile.relayPlan,
      options,
    );
    if (readinessFailure !== undefined) return { output: readinessFailure };
    return {
      config: setup.config,
      cwd,
      plan: preparedDemand.plan,
      relayPlan: profile.relayPlan,
      environment: preparedDemand.environment,
    };
  });

const preparePreviewProfile = (
  command: PreviewStartCommand,
  config: ConnectedPreviewConfig,
  options: LauncherOptions,
):
  | { readonly ok: true; readonly relayPlan: PreviewRelayResourcePlan }
  | { readonly ok: false; readonly output: LauncherOutput } => {
  const webUnavailable =
    config.roles.includes("sheet-web") &&
    (config.roles.length !== 1 ||
      options.previewWebRuntime === undefined ||
      options.previewGateway?.configured !== true ||
      options.previewSupervisorScheduler === undefined ||
      config.groups.some(
        (group) =>
          sheetWebDependencyGroupSet.has(group.id) &&
          (group.ownership !== "reused" || group.endpoint === undefined),
      ));
  if (webUnavailable)
    return {
      ok: false,
      output: {
        ...outputForUnavailableExecution(command),
        errors: [
          makeDiagnostic(
            "dependency-unavailable",
            "The sheet-web preview runtime is unavailable; no session or resources were created.",
            "A web start requires only the implemented sheet-web role, a host supervisor with a live controller scope, a configured session application gateway, and explicit HTTPS endpoints for all four compatible reused service groups. Keep the profile unavailable until those adapters and endpoint contracts are supplied.",
            { mode: "preview", action: "start", dependency: "sheet-web" },
          ),
        ],
      },
    };
  const relay = preparePreviewRelayPlan(config);
  return "error" in relay
    ? { ok: false, output: sessionOperationFailure(command, relay.error) }
    : { ok: true, relayPlan: relay.plan };
};

const preparePreviewDemand = (
  command: PreviewStartCommand,
  config: ConnectedPreviewConfig,
  allocations: import("./preview-allocations").PreviewAllocationApi | undefined,
  options: LauncherOptions,
) =>
  Effect.gen(function* () {
    const demand = yield* prepareConnectedProfileDemand(command, config, allocations);
    if ("output" in demand) return demand;
    const environment = options.env ?? process.env;
    if (identityDirectory(environment) === undefined)
      return {
        output: sessionOperationFailure(
          command,
          "TIARA_PREVIEW_SESSION_DATABASE must name the configured controller store before creating a session.",
        ),
      };
    return { plan: demand.plan, environment };
  });

const validateSheetWebGatewayReadiness = (
  command: PreviewStartCommand,
  config: ConnectedPreviewConfig,
  gateway: LauncherOptions["previewGateway"],
) =>
  Effect.gen(function* () {
    if (gateway === undefined || !gateway.configured)
      return sessionOperationFailure(
        command,
        "The session application gateway is unavailable; no session or resources were created.",
      );
    const gatewayReady = yield* Effect.result(gateway.checkApplicationSetup());
    if (Result.isFailure(gatewayReady))
      return sessionOperationFailure(
        command,
        "The session application gateway has not verified DNS, TLS, admission fencing, and per-user application identity mediation; no session or resources were created.",
      );
    const dependencyIdentities = sheetWebDependencyIdentities(config);
    if (dependencyIdentities === undefined)
      return sessionOperationFailure(
        command,
        "The selected sheet-web profile is missing an explicit dependency identity; no session or resources were created.",
      );
    const dependencyReadiness = yield* Effect.result(
      gateway.checkApplicationDependencies(dependencyIdentities),
    );
    return Result.isFailure(dependencyReadiness)
      ? sessionOperationFailure(
          command,
          "The gateway could not verify the selected dependency identities and lifecycle mediation; no session or resources were created.",
        )
      : undefined;
  });

const validatePreviewStartDependencies = (
  command: PreviewStartCommand,
  config: ConnectedPreviewConfig,
  relayPlan: PreviewRelayResourcePlan,
  options: LauncherOptions,
) =>
  Effect.gen(function* () {
    if (config.roles.includes("sheet-web")) {
      const gatewayFailure = yield* validateSheetWebGatewayReadiness(
        command,
        config,
        options.previewGateway,
      );
      if (gatewayFailure !== undefined) return gatewayFailure;
    }
    const relayReadiness = yield* validatePreviewRelayStartReadiness(
      options.previewRelayProvider,
      config,
      relayPlan,
    );
    if (relayReadiness !== undefined)
      return sessionOperationFailure(
        command,
        `${relayReadiness} No session or resources were created.`,
      );
    if (!config.roles.includes("sheet-web")) return undefined;
    const dependencyFailure = yield* validateSheetWebDependencies(
      config,
      options.previewRelayProvider,
    );
    return dependencyFailure === undefined
      ? undefined
      : sessionOperationFailure(
          command,
          `${dependencyFailure} No session or resource reservation was created.`,
        );
  });

const allocationFailureMessage = (failure: unknown) => {
  if (!(failure instanceof PreviewAllocationError))
    return failure instanceof Error
      ? failure.message
      : "The allocation authority failed before profile admission.";
  if (failure.reason !== "capacity-exhausted") return failure.reason;
  return `Capacity exhausted for ${failure.dimension ?? "unknown dimension"}: requested ${failure.requested ?? "unknown"}, reserved ${failure.reserved ?? "unknown"}, available ${failure.available ?? "unknown"}.`;
};

const finishPreviewStart = (
  command: PreviewStartCommand,
  prepared: PreparedPreviewStart,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  allocations: import("./preview-allocations").PreviewAllocationApi,
  options: LauncherOptions,
): Effect.Effect<LauncherOutput, never, FileSystem.FileSystem | HttpClient.HttpClient> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const creation = yield* createPendingPreviewSession(
        command,
        prepared.config,
        prepared.cwd,
        controller,
      );
      if (creation.output !== undefined) return creation.output;
      const tokenPath = identityPath(creation.created.session.id, prepared.environment);
      if (tokenPath === undefined)
        return yield* stopSessionWithoutCredentials(command, creation.created, controller);
      const persisted = yield* persistPreviewSessionCredentials(
        command,
        creation.created,
        tokenPath,
        controller,
      );
      if (!persisted.ok) return persisted;
      const resourceMetadata = {
        ...prepared.relayPlan.metadata,
        ...(prepared.config.seed === undefined
          ? {}
          : {
              [ownedApplicationResource]: {
                ...prepared.relayPlan.metadata[ownedApplicationResource],
                seedId: prepared.config.seed,
              },
            }),
      };
      const allocation = allocations.reserveAndAllocate({
        sessionId: creation.created.session.id,
        demands: prepared.plan.demands,
        // Establish callbacks before an owned application group runs readiness checks.
        resources: [...new Set([...prepared.relayPlan.resources, ...prepared.plan.resources])],
        resourceMetadata,
      });
      const reserved = yield* Effect.result(
        restore(allocation).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              const stopped = yield* Effect.result(
                controller.stop(creation.created.session.id, creation.created.ownerIdentity),
              );
              yield* Console.error(
                Result.isSuccess(stopped)
                  ? `Preview start was interrupted. Session ${creation.created.session.id} was stopped; inspect it with preview status --session ${creation.created.session.id}, then retry cleanup when eligible.`
                  : `Preview start was interrupted and stopping could not be confirmed. Inspect session ${creation.created.session.id} in the durable controller store before retrying cleanup.`,
              );
            }),
          ),
        ),
      );
      if (Result.isFailure(reserved))
        return yield* failPreviewStartAfterAllocation(
          command,
          creation.created,
          reserved.failure,
          controller,
          allocations,
        );
      const allocationState = yield* Effect.result(
        allocations.inspect(creation.created.session.id),
      );
      const sessionState = yield* Effect.result(controller.status(creation.created.session.id));
      if (!Result.isSuccess(allocationState) || !Result.isSuccess(sessionState))
        return yield* failPreviewStartAfterAllocation(
          command,
          creation.created,
          new Error("Resources were allocated but durable status could not be read"),
          controller,
          allocations,
        );
      if (prepared.config.roles.includes("sheet-web"))
        return yield* restore(
          startSheetWebRuntime(
            command,
            prepared,
            creation.created,
            allocationState.success,
            controller,
            allocations,
            options,
          ),
        ).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              yield* Effect.result(
                controller.stop(creation.created.session.id, creation.created.ownerIdentity),
              );
              if (options.previewGateway !== undefined)
                yield* Effect.result(
                  options.previewGateway.cleanupSession(
                    creation.created.session.id,
                    creation.created.ownerIdentity,
                  ),
                );
              if (options.previewWebRuntime !== undefined)
                yield* Effect.result(options.previewWebRuntime.stop(creation.created.session.id));
            }),
          ),
        );
      return sessionOutput(command, sessionState.success, allocationState.success);
    }),
  );

const stopAndCleanupFailedPreviewStart = (
  created: import("./preview-sessions").SessionCredentials,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  webCleanup?: {
    readonly runtime: NonNullable<LauncherOptions["previewWebRuntime"]>;
    readonly gateway: NonNullable<LauncherOptions["previewGateway"]>;
  },
) =>
  Effect.gen(function* () {
    const stopped = yield* Effect.result(
      controller.stop(created.session.id, created.ownerIdentity),
    );
    if (webCleanup === undefined) return { stopped, cleanupConfirmed: Result.isSuccess(stopped) };
    const routeCleanup = Result.isSuccess(stopped)
      ? yield* Effect.result(
          webCleanup.gateway.cleanupSession(created.session.id, created.ownerIdentity),
        )
      : undefined;
    const runtimeCleanup = yield* Effect.result(webCleanup.runtime.stop(created.session.id));
    return {
      stopped,
      cleanupConfirmed:
        Result.isSuccess(stopped) &&
        routeCleanup !== undefined &&
        Result.isSuccess(routeCleanup) &&
        Result.isSuccess(runtimeCleanup),
    };
  });

const failPreviewStartAfterAllocation = (
  command: PreviewStartCommand,
  created: import("./preview-sessions").SessionCredentials,
  failure: unknown,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  allocations: import("./preview-allocations").PreviewAllocationApi,
  webCleanup?: {
    readonly runtime: NonNullable<LauncherOptions["previewWebRuntime"]>;
    readonly gateway: NonNullable<LauncherOptions["previewGateway"]>;
  },
) =>
  Effect.gen(function* () {
    const { stopped, cleanupConfirmed } = yield* stopAndCleanupFailedPreviewStart(
      created,
      controller,
      webCleanup,
    );
    const session = Result.isSuccess(stopped) ? stopped.success : created.session;
    const allocationState = yield* Effect.result(allocations.inspect(created.session.id));
    return {
      ...sessionOutput(
        command,
        session,
        Result.isSuccess(allocationState) ? allocationState.success : undefined,
      ),
      ok: false,
      readiness: "blocked" as const,
      errors: [
        makeDiagnostic(
          cleanupConfirmed ? "prerequisite-unavailable" : "cleanup-failed",
          `Connected preview startup did not become ready: ${allocationFailureMessage(failure)}`,
          cleanupConfirmed
            ? "No connected application remains available. Inspect the durable allocation ledger and retry cleanup if partial resources were recorded."
            : "The session is fenced where the controller confirmed stop, but route or process cleanup could not be confirmed. Keep it unavailable and retry exact session cleanup after its authorities are reachable.",
          { mode: "preview", action: "start" },
        ),
      ],
    };
  });

const failApplicationRevision = (
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  gateway: import("./preview-gateway").PreviewGatewayApi,
  created: import("./preview-sessions").SessionCredentials,
  authority: SheetWebSupervisorAuthority,
  error: Error,
): Effect.Effect<never, Error> =>
  Effect.gen(function* () {
    const stopped = yield* Effect.result(
      controller.stopSupervised(
        created.session.id,
        authority.supervisorIdentity,
        authority.generation,
      ),
    );
    if (Result.isSuccess(stopped))
      yield* Effect.result(gateway.cleanupSession(created.session.id, created.ownerIdentity));
    return yield* Effect.fail(error);
  });

type SheetWebSupervisorAuthority = {
  supervisorIdentity: string;
  generation: number;
  retired?: boolean;
};

type SheetWebRuntimeStartContext = {
  readonly runtime: NonNullable<LauncherOptions["previewWebRuntime"]>;
  readonly gateway: NonNullable<LauncherOptions["previewGateway"]>;
  readonly listener: NonNullable<PreparedPreviewStart["config"]["hostListeners"]>[number];
  readonly origin: string;
  readonly environment: Record<string, string>;
  readonly target: import("./preview-gateway").PreviewGatewayTarget;
  readonly dependencies: readonly import("./preview-gateway").PreviewGatewayDependencyTarget[];
};

const sheetWebEnvironmentFor = (
  prepared: PreparedPreviewStart,
  gateway: NonNullable<LauncherOptions["previewGateway"]>,
  sessionId: string,
) => {
  const groups = new Set(prepared.config.groups.map(({ id }) => id));
  const required = sheetWebDependencyGroups;
  if (required.some((group) => !groups.has(group))) return undefined;
  const origins = new Map(
    required.map((group) => [
      group,
      gateway.applicationDependencyOrigin(sessionId, "sheet-web", group),
    ]),
  );
  if (required.some((group) => origins.get(group) === undefined)) return undefined;
  return {
    AUTH_BASE_URL: origins.get("auth")!,
    SHEET_ZERO_BASE_URL: origins.get("application-zero")!,
    SHEET_WORKFLOWS_BASE_URL: origins.get("workflow-execution")!,
    SEARCH_BASE_URL: origins.get("search")!,
  };
};

const sheetWebDependencyIdentities = (
  config: ConnectedPreviewConfig,
): readonly import("./preview-gateway").PreviewGatewayDependencyIdentity[] | undefined => {
  const groupIds = sheetWebDependencyGroups;
  const credentialByGroup = sheetWebCredentialReferences(config);
  const groups = new Map(config.groups.map((group) => [group.id, group]));
  const dependencies = groupIds.map((group) => {
    const selected = groups.get(group);
    const credentialReference = credentialByGroup[group];
    if (
      selected?.ownership !== "reused" ||
      selected.endpoint === undefined ||
      selected.stateIdentity === undefined ||
      selected.deployedManifestDigest === undefined ||
      credentialReference === undefined
    )
      return undefined;
    return {
      role: "sheet-web" as const,
      group,
      endpoint: selected.endpoint,
      stateIdentity: selected.stateIdentity,
      deployedManifestDigest: selected.deployedManifestDigest,
      catalogDigest: runtimeContractCatalogIdentity.digest,
      credentialReference,
    };
  });
  return dependencies.some((dependency) => dependency === undefined)
    ? undefined
    : (dependencies as readonly import("./preview-gateway").PreviewGatewayDependencyIdentity[]);
};

const sheetWebDependencyTargets = (
  config: ConnectedPreviewConfig,
  sessionId: string,
  generation: number,
  revision: string,
): readonly import("./preview-gateway").PreviewGatewayDependencyTarget[] | undefined => {
  const identities = sheetWebDependencyIdentities(config);
  return identities?.map((identity) => ({
    ...identity,
    sessionId,
    generation,
    revision,
  }));
};

const sheetWebRelayResources = (
  allocationStatus: import("./preview-allocations").PreviewAllocationStatus,
) => {
  const resourceId = (key: string) =>
    allocationStatus.allocations.find(({ resource }) => resource === key)?.providerResourceId;
  const serviceResourceId = resourceId("preview-relay-service-sheet-web");
  const attachmentResourceId = resourceId("preview-relay-attachment-sheet-web");
  return serviceResourceId == null || attachmentResourceId == null
    ? undefined
    : { serviceResourceId, attachmentResourceId };
};

const makeSheetWebRuntimeTarget = (
  prepared: PreparedPreviewStart,
  created: import("./preview-sessions").SessionCredentials,
  listener: NonNullable<PreparedPreviewStart["config"]["hostListeners"]>[number],
  artifactDigest: string,
  resources: { readonly serviceResourceId: string; readonly attachmentResourceId: string },
): import("./preview-gateway").PreviewGatewayTarget => ({
  sessionId: created.session.id,
  generation: created.session.generation,
  role: "sheet-web",
  processId: listener.processId,
  revision: prepared.config.identities.sourceRevision,
  artifactDigest,
  catalogDigest: runtimeContractCatalogIdentity.digest,
  stateGroup: "application-zero",
  kind: "application",
  serviceFqdn: `${relayNameFor(created.session.id, "sheet-web")}.preview-relays.svc.cluster.local`,
  port: listener.port,
  ...resources,
});

const makeSheetWebRuntimeDependencies = (
  prepared: PreparedPreviewStart,
  gateway: NonNullable<LauncherOptions["previewGateway"]>,
  created: import("./preview-sessions").SessionCredentials,
  allocationStatus: import("./preview-allocations").PreviewAllocationStatus,
) => {
  const environment = sheetWebEnvironmentFor(prepared, gateway, created.session.id);
  if (environment === undefined)
    return new Error("one or more compatible reused web dependency endpoints are missing");
  const resources = sheetWebRelayResources(allocationStatus);
  if (resources === undefined) return new Error("the web listener relay was not recorded as owned");
  const dependencies = sheetWebDependencyTargets(
    prepared.config,
    created.session.id,
    created.session.generation,
    prepared.config.identities.sourceRevision,
  );
  if (dependencies === undefined)
    return new Error("the sheet-web profile is missing a mediated shared dependency identity");
  return { environment, resources, dependencies };
};

const prepareSheetWebRuntimeStart = (
  prepared: PreparedPreviewStart,
  created: import("./preview-sessions").SessionCredentials,
  allocationStatus: import("./preview-allocations").PreviewAllocationStatus,
  options: LauncherOptions,
): SheetWebRuntimeStartContext | Error => {
  const runtime = options.previewWebRuntime;
  const gateway = options.previewGateway;
  const listener = prepared.config.hostListeners?.find(({ role }) => role === "sheet-web");
  const origin = gateway?.applicationOrigin(created.session.id, "sheet-web");
  const artifactDigest = prepared.config.identities.artifactDigests["sheet-web"];
  if (runtime === undefined || gateway === undefined || !gateway.configured)
    return new Error("sheet-web runtime or session gateway is unavailable");
  if (listener === undefined || origin === undefined || artifactDigest === undefined)
    return new Error("sheet-web listener or selected artifact identity is unavailable");
  const dependencies = makeSheetWebRuntimeDependencies(
    prepared,
    gateway,
    created,
    allocationStatus,
  );
  if (dependencies instanceof Error) return dependencies;
  const target = makeSheetWebRuntimeTarget(
    prepared,
    created,
    listener,
    artifactDigest,
    dependencies.resources,
  );
  return { runtime, gateway, listener, origin, target, ...dependencies };
};

/** @internal */
export const makeSheetWebRevisionHandler =
  (
    target: import("./preview-gateway").PreviewGatewayTarget,
    dependencies: readonly import("./preview-gateway").PreviewGatewayDependencyTarget[],
    created: import("./preview-sessions").SessionCredentials,
    authority: SheetWebSupervisorAuthority,
    controller: import("./preview-sessions").PreviewSessionControllerApi,
    gateway: import("./preview-gateway").PreviewGatewayApi,
  ) =>
  (revision: string) =>
    Effect.gen(function* () {
      const active = yield* waitForSheetWebSessionActivation(created.session.id, controller);
      if (!active)
        return yield* failRevisionIfSessionIsActive(
          controller,
          gateway,
          created,
          authority,
          "the selected source revision could not wait for session activation",
        );
      const requested = yield* Effect.result(
        controller.requestRevision(
          created.session.id,
          authority.generation,
          authority.supervisorIdentity,
          revision,
        ),
      );
      if (Result.isFailure(requested)) {
        return yield* failRevisionIfSessionIsActive(
          controller,
          gateway,
          created,
          authority,
          "the selected source revision was rejected by the session authority",
        );
      }
      if (requested.success.phase === "active" && requested.success.activeRevision === revision)
        return;
      const refreshedRoute = yield* Effect.result(
        gateway.register({ ...target, revision }, created.ownerIdentity),
      );
      if (Result.isFailure(refreshedRoute))
        return yield* failApplicationRevision(
          controller,
          gateway,
          created,
          authority,
          new Error("the changed web revision failed actual session route readiness"),
        );
      const refreshedDependencies = yield* Effect.result(
        gateway.registerApplicationDependencies(
          { ...target, revision },
          dependencies.map((dependency) => ({ ...dependency, revision })),
          created.ownerIdentity,
        ),
      );
      if (Result.isFailure(refreshedDependencies))
        return yield* failApplicationRevision(
          controller,
          gateway,
          created,
          authority,
          new Error("the changed web dependency routes could not be rebound to its revision"),
        );
      const activatedRevision = yield* Effect.result(
        controller.activate(
          created.session.id,
          authority.generation,
          authority.supervisorIdentity,
          revision,
        ),
      );
      if (Result.isFailure(activatedRevision))
        return yield* failApplicationRevision(
          controller,
          gateway,
          created,
          authority,
          new Error("the changed web revision could not be activated"),
        );
    });

// Allow Vite readiness and the bounded gateway-registration checks to finish before this
// revision callback treats a session that is still pending as unavailable.
const sheetWebSessionActivationTimeoutMs = 60_000;
const sheetWebSessionActivationPollMs = 100;

const waitForSheetWebSessionActivation = (
  id: string,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
) =>
  Effect.gen(function* () {
    for (
      let elapsed = 0;
      elapsed < sheetWebSessionActivationTimeoutMs;
      elapsed += sheetWebSessionActivationPollMs
    ) {
      const state = yield* Effect.result(controller.status(id));
      if (Result.isSuccess(state)) {
        if (state.success.phase === "ended" || state.success.phase === "expired") return false;
        if (state.success.phase === "active") return true;
      }
      yield* Effect.sleep(Duration.millis(sheetWebSessionActivationPollMs));
    }
    return false;
  });

const failRevisionIfSessionIsActive = (
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  gateway: import("./preview-gateway").PreviewGatewayApi,
  created: import("./preview-sessions").SessionCredentials,
  authority: SheetWebSupervisorAuthority,
  message: string,
) =>
  Effect.gen(function* () {
    const current = yield* Effect.result(controller.status(created.session.id));
    if (Result.isSuccess(current)) {
      if (current.success.phase === "pending")
        return yield* Effect.fail(
          new Error(`${message}; the session is still pending and remains unchanged`),
        );
      if (current.success.phase === "ended" || current.success.phase === "expired") return;
    }
    return yield* failApplicationRevision(
      controller,
      gateway,
      created,
      authority,
      new Error(message),
    );
  });

const activateSheetWebRuntime = (
  input: SheetWebRuntimeStartContext,
  created: import("./preview-sessions").SessionCredentials,
  prepared: PreparedPreviewStart,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  onSourceRevision: (revision: string) => Effect.Effect<void, Error>,
  onSupervisorAdopt: (supervisorIdentity: string, generation: number) => Effect.Effect<void, Error>,
) =>
  Effect.gen(function* () {
    const started = yield* Effect.result(
      input.runtime.start({
        sessionId: created.session.id,
        revision: prepared.config.identities.sourceRevision,
        checkout: prepared.cwd,
        port: input.listener.port,
        publicOrigin: input.origin,
        environment: input.environment,
        onSourceRevision,
        onSupervisorAdopt,
      }),
    );
    if (Result.isFailure(started)) return yield* Effect.fail(started.failure);
    const route = yield* Effect.result(input.gateway.register(input.target, created.ownerIdentity));
    if (Result.isFailure(route)) {
      yield* Effect.result(input.runtime.stop(created.session.id));
      return yield* Effect.fail(route.failure);
    }
    const dependencyRoutes = yield* Effect.result(
      input.gateway.registerApplicationDependencies(
        input.target,
        input.dependencies,
        created.ownerIdentity,
      ),
    );
    if (Result.isFailure(dependencyRoutes)) {
      yield* Effect.result(input.runtime.stop(created.session.id));
      return yield* Effect.fail(dependencyRoutes.failure);
    }
    const activated = yield* Effect.result(
      controller.activate(
        created.session.id,
        created.session.generation,
        created.supervisorIdentity,
        prepared.config.identities.sourceRevision,
      ),
    );
    if (Result.isFailure(activated)) {
      yield* Effect.result(controller.stop(created.session.id, created.ownerIdentity));
      yield* Effect.result(input.gateway.cleanup(route.success.hostname, created.ownerIdentity));
      yield* Effect.result(input.runtime.stop(created.session.id));
      return yield* Effect.fail(activated.failure);
    }
    return {
      session: activated.success,
      routeHostname: route.success.hostname,
      process: started.success,
    };
  });

type SupervisedSheetWebPreviewInput = {
  readonly sessionId: string;
  readonly ownerIdentity: string;
  readonly supervisorIdentity: string;
  readonly generation: number;
  readonly authority?: SheetWebSupervisorAuthority;
  readonly controller: import("./preview-sessions").PreviewSessionControllerApi;
  readonly gateway: import("./preview-gateway").PreviewGatewayApi;
  readonly runtime: NonNullable<LauncherOptions["previewWebRuntime"]>;
  readonly checkDependencies?: () => Effect.Effect<string | undefined, unknown>;
};

const claimSupervisedCleanup = (
  input: SupervisedSheetWebPreviewInput,
  authority: SheetWebSupervisorAuthority,
) =>
  Effect.gen(function* () {
    const stopped = yield* Effect.result(
      input.controller.stopSupervised(
        input.sessionId,
        authority.supervisorIdentity,
        authority.generation,
      ),
    );
    if (Result.isSuccess(stopped)) return true;
    const current = yield* Effect.result(input.controller.status(input.sessionId));
    return Result.isSuccess(current) && current.success.endedAt !== null;
  });

const stopSupervisedSheetWebPreview = (input: SupervisedSheetWebPreviewInput) =>
  Effect.gen(function* () {
    const authority = input.authority ?? {
      supervisorIdentity: input.supervisorIdentity,
      generation: input.generation,
    };
    if (authority.retired === true) return;
    if (!(yield* claimSupervisedCleanup(input, authority))) {
      yield* Console.error(
        `Preview session ${safeIdentifier(input.sessionId)} changed owners or its state is unavailable; cleanup was not attempted because supervisor ownership could not be confirmed. Retry preview cleanup after the controller is available.`,
      );
      return;
    }
    for (let attempt = 0; attempt < supervisedWebCleanupRetryCount; attempt += 1) {
      const route = yield* Effect.result(
        input.gateway.cleanupSession(input.sessionId, input.ownerIdentity),
      );
      const process = yield* Effect.result(input.runtime.stop(input.sessionId));
      if (Result.isSuccess(route) && Result.isSuccess(process)) return;
      if (attempt + 1 < supervisedWebCleanupRetryCount) yield* Effect.sleep(Duration.seconds(1));
    }
    yield* Console.error(
      `Preview session ${safeIdentifier(input.sessionId)} ended, but route or process cleanup was not confirmed after ${supervisedWebCleanupRetryCount} attempts. Retry preview cleanup.`,
    );
  });

const checkSupervisedSheetWebProcess = (
  input: SupervisedSheetWebPreviewInput,
): Effect.Effect<
  "ready" | "transient-failure" | "missing",
  never,
  FileSystem.FileSystem | HttpClient.HttpClient
> =>
  input.runtime.availability === undefined
    ? Effect.gen(function* () {
        const status = yield* Effect.result(input.runtime.status(input.sessionId));
        if (Result.isSuccess(status) && status.success) return "ready" as const;
        const measurements = yield* Effect.result(input.runtime.measurements(input.sessionId));
        return Result.isSuccess(measurements) && measurements.success !== undefined
          ? ("transient-failure" as const)
          : ("missing" as const);
      })
    : input.runtime.availability(input.sessionId);

const checkSupervisedSheetWebDependencies = (
  input: SupervisedSheetWebPreviewInput,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (input.checkDependencies === undefined) return true;
    const result = yield* Effect.result(input.checkDependencies());
    return Result.isSuccess(result) && result.success === undefined;
  });

/** @internal Keeps a resumed host supervisor's durable session lease renewed. */
const renewSupervisedSheetSession = (
  input: SupervisedSheetWebPreviewInput,
  authority: SheetWebSupervisorAuthority,
  counters: { heartbeatFailures: number },
) =>
  Effect.gen(function* () {
    const renewed = yield* Effect.result(
      input.controller.heartbeat(
        input.sessionId,
        authority.supervisorIdentity,
        authority.generation,
      ),
    );
    if (Result.isFailure(renewed)) {
      const state = yield* Effect.result(input.controller.status(input.sessionId));
      if (Result.isSuccess(state) && state.success.endedAt !== null) {
        yield* stopSupervisedSheetWebPreview(input);
        return false;
      }
      counters.heartbeatFailures += 1;
      if (counters.heartbeatFailures < 3) return true;
      yield* stopSupervisedSheetWebPreview(input);
      return false;
    }
    counters.heartbeatFailures = 0;
    return true;
  });

const checkSupervisedProcessHealth = (
  input: SupervisedSheetWebPreviewInput,
  counters: { processFailures: number },
) =>
  Effect.gen(function* () {
    const process = yield* checkSupervisedSheetWebProcess(input);
    if (process === "missing") {
      yield* stopSupervisedSheetWebPreview(input);
      return false;
    }
    counters.processFailures = process === "ready" ? 0 : counters.processFailures + 1;
    if (counters.processFailures >= 3) {
      yield* stopSupervisedSheetWebPreview(input);
      return false;
    }
    return true;
  });

const checkSupervisedDependencyHealth = (
  input: SupervisedSheetWebPreviewInput,
  counters: { dependencyFailures: number },
) =>
  Effect.gen(function* () {
    const dependenciesReady = yield* checkSupervisedSheetWebDependencies(input);
    if (dependenciesReady) {
      counters.dependencyFailures = 0;
      return true;
    }
    const session = yield* Effect.result(input.controller.status(input.sessionId));
    // A requested revision temporarily invalidates the exact-revision route while it is rebound.
    if (Result.isSuccess(session) && session.success.phase === "starting") return true;
    counters.dependencyFailures += 1;
    if (counters.dependencyFailures >= 3) {
      yield* stopSupervisedSheetWebPreview(input);
      return false;
    }
    return true;
  });

/** @internal Keeps one host supervisor turn fenced and health checked. */
const superviseSheetWebPreviewTurn = (
  input: SupervisedSheetWebPreviewInput,
  counters: {
    processFailures: number;
    dependencyFailures: number;
    heartbeatFailures: number;
  },
) =>
  Effect.gen(function* () {
    const authority = input.authority ?? {
      supervisorIdentity: input.supervisorIdentity,
      generation: input.generation,
    };
    if (authority.retired === true)
      return (yield* checkSupervisedSheetWebProcess(input)) !== "missing";
    if (!(yield* renewSupervisedSheetSession(input, authority, counters))) return false;
    if (!(yield* checkSupervisedProcessHealth(input, counters))) return false;
    return yield* checkSupervisedDependencyHealth(input, counters);
  });

/** @internal Keeps a resumed host supervisor's durable session lease renewed. */
export const superviseSheetWebPreview = (input: SupervisedSheetWebPreviewInput) =>
  Effect.gen(function* () {
    const counters = { processFailures: 0, dependencyFailures: 0, heartbeatFailures: 0 };
    while (true) {
      yield* Effect.sleep(Duration.millis(previewSessionHeartbeatMs));
      if (!(yield* superviseSheetWebPreviewTurn(input, counters))) return;
    }
  }).pipe(
    Effect.onInterrupt(() => stopSupervisedSheetWebPreview(input)),
    Effect.catch(() => stopSupervisedSheetWebPreview(input)),
  );

const maintainSheetWebPreview = (
  created: import("./preview-sessions").SessionCredentials,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  runtime: NonNullable<LauncherOptions["previewWebRuntime"]>,
  gateway: NonNullable<LauncherOptions["previewGateway"]>,
  authority: SheetWebSupervisorAuthority,
) =>
  superviseSheetWebPreview({
    sessionId: created.session.id,
    ownerIdentity: created.ownerIdentity,
    supervisorIdentity: authority.supervisorIdentity,
    generation: authority.generation,
    authority,
    controller,
    gateway,
    runtime,
    checkDependencies: () =>
      gateway
        .checkRegisteredApplicationDependencies(
          created.session.id,
          "sheet-web",
          created.ownerIdentity,
        )
        .pipe(Effect.as(undefined)),
  });

const launchSheetWebPreviewSupervisor = (
  sessionId: string,
  options: LauncherOptions,
  supervisor: Effect.Effect<void, never, FileSystem.FileSystem | HttpClient.HttpClient>,
) => {
  const schedule = options.previewSupervisorScheduler;
  return schedule === undefined ? Effect.void : Effect.sync(() => schedule(sessionId, supervisor));
};

const startSheetWebRuntime = (
  command: PreviewStartCommand,
  prepared: PreparedPreviewStart,
  created: import("./preview-sessions").SessionCredentials,
  allocationStatus: import("./preview-allocations").PreviewAllocationStatus,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  allocations: import("./preview-allocations").PreviewAllocationApi,
  options: LauncherOptions,
): Effect.Effect<LauncherOutput, never, FileSystem.FileSystem | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const startContext = prepareSheetWebRuntimeStart(prepared, created, allocationStatus, options);
    if (startContext instanceof Error)
      return yield* failPreviewStartAfterAllocation(
        command,
        created,
        startContext,
        controller,
        allocations,
      );
    const authority: SheetWebSupervisorAuthority = {
      supervisorIdentity: created.supervisorIdentity,
      generation: created.session.generation,
      retired: false,
    };
    const onSourceRevision = makeSheetWebRevisionHandler(
      startContext.target,
      startContext.dependencies,
      created,
      authority,
      controller,
      startContext.gateway,
    );
    const activation = yield* Effect.result(
      activateSheetWebRuntime(
        startContext,
        created,
        prepared,
        controller,
        onSourceRevision,
        (supervisorIdentity, generation) =>
          Effect.sync(() => {
            authority.supervisorIdentity = supervisorIdentity;
            authority.generation = generation;
            authority.retired = true;
          }),
      ),
    );
    if (Result.isFailure(activation))
      return yield* failPreviewStartAfterAllocation(
        command,
        created,
        activation.failure,
        controller,
        allocations,
        { runtime: startContext.runtime, gateway: startContext.gateway },
      );
    const webMeasurements = yield* startContext.runtime.measurements(created.session.id);
    if (webMeasurements === undefined)
      return yield* failPreviewStartAfterAllocation(
        command,
        created,
        new Error("the web process measurements endpoint is unavailable"),
        controller,
        allocations,
        { runtime: startContext.runtime, gateway: startContext.gateway },
      );
    yield* launchSheetWebPreviewSupervisor(
      created.session.id,
      options,
      maintainSheetWebPreview(
        created,
        controller,
        startContext.runtime,
        startContext.gateway,
        authority,
      ),
    );
    const output = sessionOutput(command, activation.success.session, allocationStatus);
    return {
      ...output,
      ...(output.previewSession === undefined
        ? {}
        : {
            previewSession: {
              ...output.previewSession,
              webProcess: {
                pid: webMeasurements.pid,
                startedAt: webMeasurements.startedAt,
                readyAt: webMeasurements.readyAt,
                startupDurationMs: webMeasurements.startupDurationMs,
                editCount: webMeasurements.editCount,
                lastEditDurationMs: webMeasurements.lastEditDurationMs,
                processTree: webMeasurements.processTree,
              },
            },
          }),
      urls: [{ name: "sheet-web", url: `https://${activation.success.routeHostname}` }],
    };
  });

const runSessionStart = (
  command: PreviewStartCommand,
  options: LauncherOptions,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  allocations: import("./preview-allocations").PreviewAllocationApi | undefined,
): Effect.Effect<LauncherOutput, never, FileSystem.FileSystem | HttpClient.HttpClient> =>
  Effect.flatMap(preparePreviewStart(command, options, allocations), (prepared) =>
    "output" in prepared
      ? Effect.succeed(prepared.output)
      : allocations === undefined
        ? Effect.succeed(
            sessionOperationFailure(command, "The durable allocation authority is unavailable."),
          )
        : finishPreviewStart(command, prepared, controller, allocations, options),
  );

const withWebProcessMeasurements = (
  output: LauncherOutput,
  session: import("./preview-sessions").PreviewSession,
  id: string,
  runtime: LauncherOptions["previewWebRuntime"],
) =>
  Effect.gen(function* () {
    if (session.manifests["sheet-web"] === undefined || session.phase !== "active") return output;
    const unavailable = () => ({
      ...output,
      ok: false as const,
      readiness: "blocked" as const,
      errors: [
        makeDiagnostic(
          "dependency-unavailable",
          "The active sheet-web session has no ready host process.",
          "The web process or its loopback readiness endpoint is unavailable. Resume only after the same session's compatible process is healthy.",
          { mode: "preview", action: "status", dependency: "sheet-web" },
        ),
      ],
    });
    if (runtime === undefined || !(yield* runtime.status(id))) return unavailable();
    const webProcess = yield* runtime.measurements(id);
    if (webProcess === undefined) return unavailable();
    if (output.previewSession === undefined) return output;
    return {
      ...output,
      previewSession: {
        ...output.previewSession,
        webProcess: {
          pid: webProcess.pid ?? null,
          startedAt: webProcess.startedAt,
          readyAt: webProcess.readyAt,
          startupDurationMs: webProcess.startupDurationMs,
          editCount: webProcess.editCount,
          lastEditDurationMs: webProcess.lastEditDurationMs,
          processTree: webProcess.processTree,
        },
      },
    };
  });

const runSessionStatus = (
  command: ConnectedPreviewCommand,
  id: string,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  allocations: import("./preview-allocations").PreviewAllocationApi | undefined,
  options: LauncherOptions,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      dispatchPreviewSessionProtocol(controller, { _tag: "Status", id }),
    );
    if (Result.isFailure(result)) {
      return sessionOperationFailure(
        command,
        "The session is unknown, expired, or the authority store is unavailable.",
      );
    }
    if (result.success._tag !== "Session")
      return sessionOperationFailure(
        command,
        "The controller returned an invalid status response.",
      );
    if (allocations === undefined)
      return {
        ...sessionOutput(command, result.success.session),
        ok: false,
        readiness: "blocked" as const,
        errors: [
          makeDiagnostic(
            "dependency-unavailable",
            "The session record is readable, but its allocation ledger is unavailable",
            "Restore the configured allocation authority before treating resource ownership or capacity as known.",
            { mode: "preview", action: "status" },
          ),
        ],
      };
    const allocationState = yield* Effect.result(allocations.inspect(id));
    if (Result.isFailure(allocationState))
      return sessionOperationFailure(
        command,
        "The durable allocation ledger could not be read; ownership is unknown.",
      );
    const output = sessionOutput(command, result.success.session, allocationState.success);
    return yield* withWebProcessMeasurements(
      output,
      result.success.session,
      id,
      options.previewWebRuntime,
    );
  });

const runSessionCleanup = (
  command: ConnectedPreviewCommand,
  id: string,
  credentials: LocalSessionCredentials,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  allocations: import("./preview-allocations").PreviewAllocationApi,
  gateway: LauncherOptions["previewGateway"],
) =>
  Effect.flatMap(validateCleanupOwnership(command, id, credentials, controller), (validated) =>
    Effect.gen(function* () {
      if ("output" in validated) return validated.output;
      if (gateway !== undefined) {
        const cleaned = yield* Effect.result(gateway.cleanupSession(id, credentials.ownerIdentity));
        if (Result.isFailure(cleaned))
          return sessionOperationFailure(
            command,
            "Gateway route cleanup could not be verified; owned relay cleanup was not attempted.",
          );
      }
      if (command.action !== "resolve")
        return yield* runOwnedAllocationCleanup(
          command,
          id,
          validated.session,
          controller,
          allocations,
        );
      const resource = command.options.resource;
      if (resource === null)
        return yield* Effect.succeed(
          sessionOperationFailure(command, "Resolve requires one allocation resource key."),
        );
      return yield* Effect.flatMap(
        Effect.result(allocations.resolveUnknownAllocation({ sessionId: id, resource })),
        (resolved) =>
          Result.isFailure(resolved)
            ? Effect.succeed(
                sessionOperationFailure(
                  command,
                  `Provider ownership resolution failed (${allocationFailureMessage(resolved.failure)}); reservations remain held.`,
                ),
              )
            : runOwnedAllocationCleanup(command, id, validated.session, controller, allocations),
      );
    }),
  );

const validateCleanupOwnership = (
  command: ConnectedPreviewCommand,
  id: string,
  credentials: LocalSessionCredentials,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
) =>
  Effect.gen(function* () {
    const status = yield* Effect.result(controller.status(id));
    if (Result.isFailure(status))
      return {
        output: sessionOperationFailure(
          command,
          "The session state is unavailable; cleanup was not attempted.",
        ),
      };
    if (status.success.endedAt === null)
      return {
        output: sessionOperationFailure(
          command,
          "Live-session destruction is refused; stop the session before cleanup.",
        ),
      };
    const authorized = yield* Effect.result(controller.stop(id, credentials.ownerIdentity));
    return Result.isFailure(authorized)
      ? { output: sessionOperationFailure(command, "Cleanup requires the session owner identity.") }
      : { session: authorized.success };
  });

const runOwnedAllocationCleanup = (
  command: ConnectedPreviewCommand,
  id: string,
  session: import("./preview-sessions").PreviewSession,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  allocations: import("./preview-allocations").PreviewAllocationApi,
) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.result(allocations.cleanup({ sessionId: id }));
    if (Result.isFailure(outcome))
      return sessionOperationFailure(
        command,
        "Allocation cleanup authority failed; reservations remain held.",
      );
    const state = yield* Effect.result(allocations.inspect(id));
    if (Result.isFailure(state))
      return sessionOperationFailure(
        command,
        "Cleanup outcome was recorded, but the allocation ledger cannot be inspected.",
      );
    const currentSession = yield* Effect.result(controller.status(id));
    const cleanupOutput = renderCleanupOutcome(
      command,
      Result.isSuccess(currentSession) ? currentSession.success : session,
      state.success,
      outcome.success,
    );
    if (command.action !== "resolve" || outcome.success !== "waiting") return cleanupOutput;
    return {
      ...cleanupOutput,
      ok: true,
      readiness: "completed" as const,
      warnings: [
        ...cleanupOutput.warnings,
        ...cleanupOutput.errors.map((error) =>
          makeWarning(error.code, error.message, error.remediation, {
            mode: error.mode,
            action: error.action,
            dependency: error.dependency,
            origin: error.origin,
            port: error.port,
          }),
        ),
      ],
      errors: [],
    };
  });

const renderCleanupOutcome = (
  command: ConnectedPreviewCommand,
  session: import("./preview-sessions").PreviewSession,
  state: import("./preview-allocations").PreviewAllocationStatus,
  outcome: "waiting" | "cleaned" | "quarantined",
): LauncherOutput => {
  const output = sessionOutput(command, session, state);
  if (outcome === "cleaned") return output;
  const quarantined = outcome === "quarantined";
  const unresolvedOwnership = state.allocations.filter(
    ({ providerResourceId, state: allocationState }) =>
      providerResourceId === null &&
      allocationState !== "deleted" &&
      allocationState !== "not-allocated",
  );
  const quarantineRemediation =
    unresolvedOwnership.length > 0
      ? `Run preview resolve --session ${safeIdentifier(session.id)} --resource <key> for a fresh provider ownership lookup, then retry cleanup.`
      : "Inspect the durable owner/resource ledger, resolve the provider deletion issue, then retry cleanup.";
  return {
    ...output,
    ok: false,
    readiness: "blocked",
    errors: [
      makeDiagnostic(
        quarantined ? "cleanup-failed" : "prerequisite-unavailable",
        quarantined
          ? "Owned allocations are quarantined and their capacity reservations remain held"
          : "Cleanup is waiting for settlement proof or the five-minute deletion window",
        quarantined
          ? quarantineRemediation
          : "Wait for accepted work to settle and retry cleanup after the recorded delay.",
        { mode: "preview", action: command.action },
      ),
    ],
  };
};

const canResumeWebPreview = (id: string, options: LauncherOptions) =>
  Effect.gen(function* () {
    const runtime = options.previewWebRuntime;
    return (
      runtime !== undefined &&
      options.previewGateway?.configured === true &&
      options.previewSupervisorScheduler !== undefined &&
      (yield* runtime.status(id))
    );
  });

const persistResumedSupervisor = (
  tokenPath: string,
  credentials: LocalSessionCredentials,
  supervisorIdentity: string,
) =>
  Effect.gen(function* () {
    const persisted = yield* Effect.result(
      persistSessionCredentials(tokenPath, {
        ownerIdentity: credentials.ownerIdentity,
        supervisorIdentity,
      }),
    );
    return Result.isSuccess(persisted);
  });

export const stopResumedWebSession = (
  id: string,
  supervisorIdentity: string,
  generation: number,
  credentials: LocalSessionCredentials,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  gateway?: LauncherOptions["previewGateway"],
  runtime?: LauncherOptions["previewWebRuntime"],
) =>
  Effect.gen(function* () {
    const stopped = yield* Effect.result(
      controller.stopSupervised(id, supervisorIdentity, generation),
    );
    if (Result.isFailure(stopped)) return false;
    const routeCleanup =
      gateway === undefined
        ? Result.succeed(undefined)
        : yield* Effect.result(gateway.cleanupSession(id, credentials.ownerIdentity));
    const runtimeCleanup =
      runtime === undefined ? Result.succeed(undefined) : yield* Effect.result(runtime.stop(id));
    return Result.isSuccess(routeCleanup) && Result.isSuccess(runtimeCleanup);
  });

const stopAfterFailedWebResume = (
  command: ConnectedPreviewCommand,
  id: string,
  supervisorIdentity: string,
  generation: number,
  credentials: LocalSessionCredentials,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  gateway: LauncherOptions["previewGateway"],
  runtime: LauncherOptions["previewWebRuntime"],
  message: string,
) =>
  Effect.gen(function* () {
    const cleanupConfirmed = yield* stopResumedWebSession(
      id,
      supervisorIdentity,
      generation,
      credentials,
      controller,
      gateway,
      runtime,
    );
    return sessionOperationFailure(
      command,
      cleanupConfirmed
        ? `${message} The resumed session was ended and its route/process cleanup was confirmed.`
        : `${message} The current supervisor could not confirm complete cleanup; inspect this exact session and keep it unavailable.`,
    );
  });

const resumeWebApplication = (
  command: ConnectedPreviewCommand,
  id: string,
  session: import("./preview-sessions").PreviewSession,
  supervisorIdentity: string,
  credentials: LocalSessionCredentials,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  options: LauncherOptions,
) =>
  Effect.gen(function* () {
    const runtime = options.previewWebRuntime;
    const gateway = options.previewGateway;
    if (
      runtime === undefined ||
      gateway === undefined ||
      options.previewSupervisorScheduler === undefined
    )
      return sessionOperationFailure(
        command,
        "The web runtime or application route is unavailable.",
      );
    if (runtime.adoptSupervisor === undefined) {
      return yield* stopAfterFailedWebResume(
        command,
        id,
        supervisorIdentity,
        session.generation,
        credentials,
        controller,
        gateway,
        runtime,
        "The running web supervisor cannot adopt the resumed session identity, so the session was stopped safely.",
      );
    }
    const adopted = yield* Effect.result(
      runtime.adoptSupervisor(id, supervisorIdentity, session.generation),
    );
    if (Result.isFailure(adopted)) {
      return yield* stopAfterFailedWebResume(
        command,
        id,
        supervisorIdentity,
        session.generation,
        credentials,
        controller,
        gateway,
        runtime,
        "The running web supervisor did not confirm the resumed identity; the session was stopped safely.",
      );
    }
    const resumedRoute = yield* Effect.result(
      gateway.resumeApplication(id, "sheet-web", credentials.ownerIdentity),
    );
    if (Result.isFailure(resumedRoute)) {
      return yield* stopAfterFailedWebResume(
        command,
        id,
        supervisorIdentity,
        session.generation,
        credentials,
        controller,
        gateway,
        runtime,
        "The resumed web route failed its fresh session readiness check.",
      );
    }
    const activated = yield* Effect.result(
      controller.activate(id, session.generation, supervisorIdentity, session.requestedRevision),
    );
    if (Result.isFailure(activated)) {
      return yield* stopAfterFailedWebResume(
        command,
        id,
        supervisorIdentity,
        session.generation,
        credentials,
        controller,
        gateway,
        runtime,
        "The web revision could not be activated after resume.",
      );
    }
    yield* launchSheetWebPreviewSupervisor(
      id,
      options,
      superviseSheetWebPreview({
        sessionId: id,
        ownerIdentity: credentials.ownerIdentity,
        supervisorIdentity,
        generation: activated.success.generation,
        authority: { supervisorIdentity, generation: activated.success.generation },
        controller,
        gateway,
        runtime,
        checkDependencies: () =>
          gateway
            .checkRegisteredApplicationDependencies(id, "sheet-web", credentials.ownerIdentity)
            .pipe(Effect.as(undefined)),
      }),
    );
    return sessionOutput(command, activated.success);
  });

const completeSessionResume = (
  command: ConnectedPreviewCommand,
  id: string,
  tokenPath: string,
  credentials: LocalSessionCredentials,
  webSession: boolean,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  options: LauncherOptions,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      dispatchPreviewSessionProtocol(controller, {
        _tag: "Resume",
        id,
        ownerIdentity: credentials.ownerIdentity,
        supervisorIdentity: credentials.supervisorIdentity,
      }),
    );
    if (Result.isFailure(result)) {
      return sessionOperationFailure(
        command,
        "Resume requires the original owner identity, an unexpired lease, and no active supervisor.",
      );
    }
    if (result.success._tag !== "Resumed") {
      return sessionOperationFailure(
        command,
        "The controller returned an invalid resume response.",
      );
    }
    const credentialPersisted = yield* persistResumedSupervisor(
      tokenPath,
      credentials,
      result.success.supervisorIdentity,
    );
    if (!credentialPersisted)
      return yield* stopAfterFailedWebResume(
        command,
        id,
        result.success.supervisorIdentity,
        result.success.session.generation,
        credentials,
        controller,
        webSession ? options.previewGateway : undefined,
        webSession ? options.previewWebRuntime : undefined,
        "The resumed supervisor credential could not be stored; the session was stopped to avoid leaving it without usable owner credentials.",
      );
    if (webSession)
      return yield* resumeWebApplication(
        command,
        id,
        result.success.session,
        result.success.supervisorIdentity,
        credentials,
        controller,
        options,
      );
    return sessionOutput(command, result.success.session);
  });

const runSessionResume = (
  command: ConnectedPreviewCommand,
  id: string,
  tokenPath: string,
  credentials: LocalSessionCredentials,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  options: LauncherOptions,
) =>
  Effect.gen(function* () {
    const before = yield* Effect.result(controller.status(id));
    if (Result.isFailure(before))
      return sessionOperationFailure(command, "Resume requires fresh durable session state.");
    const webSession = before.success.manifests["sheet-web"] !== undefined;
    if (webSession && !(yield* canResumeWebPreview(id, options)))
      return sessionOperationFailure(
        command,
        "The compatible web process and application route are not available to resume this session.",
      );
    return yield* completeSessionResume(
      command,
      id,
      tokenPath,
      credentials,
      webSession,
      controller,
      options,
    );
  });

const runSessionHeartbeat = (
  command: ConnectedPreviewCommand,
  id: string,
  credentials: LocalSessionCredentials,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
) =>
  Effect.gen(function* () {
    const generation = command.options.generation;
    if (generation === null || generation === undefined)
      return outputForUnavailableExecution(command);
    const result = yield* Effect.result(
      dispatchPreviewSessionProtocol(controller, {
        _tag: "Heartbeat",
        id,
        supervisorIdentity: credentials.supervisorIdentity,
        generation,
      }),
    );
    if (Result.isFailure(result)) {
      return sessionOperationFailure(
        command,
        "Heartbeat was rejected because the lease expired or the supervisor generation is stale.",
      );
    }
    return result.success._tag === "Session"
      ? sessionOutput(command, result.success.session)
      : sessionOperationFailure(command, "The controller returned an invalid heartbeat response.");
  });

const runSessionStop = (
  command: ConnectedPreviewCommand,
  id: string,
  credentials: LocalSessionCredentials,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  options: LauncherOptions,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      dispatchPreviewSessionProtocol(controller, {
        _tag: "Stop",
        id,
        ownerIdentity: credentials.ownerIdentity,
      }),
    );
    if (Result.isFailure(result)) {
      return sessionOperationFailure(
        command,
        "Stop requires the owner identity; the controller could not verify this session.",
      );
    }
    if (result.success._tag !== "Session")
      return sessionOperationFailure(command, "The controller returned an invalid stop response.");
    const session = result.success.session;
    if (session.manifests["sheet-web"] !== undefined) {
      const stopped =
        options.previewWebRuntime === undefined
          ? Result.fail(new Error("web-supervisor-unavailable"))
          : yield* Effect.result(options.previewWebRuntime.stop(id));
      const routeCleanup =
        options.previewGateway === undefined
          ? Result.fail(new Error("application-gateway-unavailable"))
          : yield* Effect.result(
              options.previewGateway.cleanupSession(id, credentials.ownerIdentity),
            );
      if (Result.isFailure(stopped) || Result.isFailure(routeCleanup))
        return {
          ...sessionOutput(command, session),
          ok: false,
          readiness: "blocked" as const,
          errors: [
            makeDiagnostic(
              "cleanup-failed",
              "The session ended, but web process or route cleanup could not be confirmed.",
              "Keep the session unavailable and retry exact session cleanup after the web supervisor and gateway authorities are reachable.",
              { mode: "preview", action: "stop", dependency: "sheet-web" },
            ),
          ],
        };
    }
    return sessionOutput(command, session);
  });

const runSessionWithCredentials = (
  command: ConnectedPreviewCommand,
  id: string,
  options: LauncherOptions,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  allocations: import("./preview-allocations").PreviewAllocationApi | undefined,
) => {
  const read = Effect.gen(function* () {
    const environment = options.env ?? process.env;
    if (identityDirectory(environment) === undefined) {
      return {
        output: sessionOperationFailure(
          command,
          "TIARA_PREVIEW_SESSION_DATABASE must name the configured controller store.",
        ),
      } as const;
    }
    const tokenPath = identityPath(id, environment);
    if (tokenPath === undefined) {
      return {
        output: sessionOperationFailure(
          command,
          "The --session value must be the session ID returned by preview start.",
        ),
      } as const;
    }
    const credentials = yield* Effect.result(readSessionCredentials(tokenPath));
    if (Result.isFailure(credentials)) {
      return {
        output: sessionOperationFailure(
          command,
          "The private session identity is unavailable; verify this checkout and local credential store.",
        ),
      } as const;
    }
    return { credentials: credentials.success, tokenPath } as const;
  });
  return read.pipe(
    Effect.flatMap((result) => {
      if ("output" in result) return Effect.succeed(result.output);
      return Match.value(command.action).pipe(
        Match.when("resume", () =>
          runSessionResume(command, id, result.tokenPath, result.credentials, controller, options),
        ),
        Match.when("heartbeat", () =>
          runSessionHeartbeat(command, id, result.credentials, controller),
        ),
        Match.when("stop", () =>
          runSessionStop(command, id, result.credentials, controller, options),
        ),
        Match.when("cleanup", () =>
          allocations === undefined
            ? Effect.succeed(outputForUnavailableExecution(command))
            : runSessionCleanup(
                command,
                id,
                result.credentials,
                controller,
                allocations,
                options.previewGateway,
              ),
        ),
        Match.when("resolve", () =>
          allocations === undefined
            ? Effect.succeed(outputForUnavailableExecution(command))
            : runSessionCleanup(
                command,
                id,
                result.credentials,
                controller,
                allocations,
                options.previewGateway,
              ),
        ),
        Match.orElse(() => Effect.succeed(outputForUnavailableExecution(command))),
      );
    }),
  );
};

const runSessionCommand = (
  command: ConnectedPreviewCommand,
  options: LauncherOptions,
  controller: import("./preview-sessions").PreviewSessionControllerApi,
  allocations: import("./preview-allocations").PreviewAllocationApi | undefined,
): Effect.Effect<LauncherOutput, never, FileSystem.FileSystem | HttpClient.HttpClient> => {
  if (command.action === "start") return runSessionStart(command, options, controller, allocations);
  const id = command.options.sessionId;
  if (id === null) return Effect.succeed(outputForUnavailableExecution(command));
  return command.action === "status"
    ? runSessionStatus(command, id, controller, allocations, options)
    : runSessionWithCredentials(command, id, options, controller, allocations);
};

const outputForInvalidConfig = (
  command: ConnectedPreviewCommand,
  message: string,
): LauncherOutput => ({
  schemaVersion: 3,
  ok: false,
  command: command.command,
  mode: "preview",
  action: command.action,
  selectedServices: [],
  checkoutState: null,
  plannedProcesses: [],
  urls: [],
  readiness: "blocked",
  warnings: [],
  errors: [
    diagnostic(
      "invalid-preview-config",
      command.action === "doctor" ? "doctor" : "plan",
      message,
      "Read the connected-preview schema documentation and provide a versioned development-only configuration.",
    ),
  ],
  changedSurfaces: [],
  parityGates: [],
});

type BaselineReadResult =
  | { readonly baseline: typeof PreviewCapacityBaselineSchema.Type; readonly output?: never }
  | { readonly baseline?: never; readonly output: LauncherOutput };

const capacityBaselineNotImported = (
  command: ConnectedPreviewCommand,
  reason: string,
  remediation: string,
): LauncherOutput => ({
  ...outputForUnavailableExecution(command),
  errors: [
    makeDiagnostic(
      "dependency-unavailable",
      `Capacity baseline was not imported: ${reason}`,
      remediation,
      { mode: "preview", action: "baseline" },
    ),
  ],
});

const readCapacityBaseline = (
  command: Extract<ConnectedPreviewCommand, { readonly action: "baseline" }>,
  options: LauncherOptions,
  fileSystem: FileSystem.FileSystem,
): Effect.Effect<BaselineReadResult> =>
  Effect.gen(function* () {
    const baselineFile = (options.env ?? process.env).TIARA_PREVIEW_CAPACITY_BASELINE_FILE;
    if (baselineFile === undefined || baselineFile.trim() === "")
      return {
        output: capacityBaselineNotImported(
          command,
          "the operator-collected JSON file is not configured",
          "Set TIARA_PREVIEW_CAPACITY_BASELINE_FILE to an operator-collected JSON baseline; no capacity is inferred.",
        ),
      };
    const baselinePath = path.resolve(options.cwd ?? process.cwd(), baselineFile);
    const contents = yield* Effect.result(fileSystem.readFileString(baselinePath));
    if (Result.isFailure(contents))
      return {
        output: capacityBaselineNotImported(
          command,
          "the configured operator file could not be read",
          "The operator capacity baseline file could not be read; no observations were imported.",
        ),
      };
    try {
      const baseline = Schema.decodeUnknownSync(PreviewCapacityBaselineSchema)(
        JSON.parse(contents.success) as unknown,
      );
      return { baseline };
    } catch {
      return {
        output: capacityBaselineNotImported(
          command,
          "its schema or profile demand plan is invalid",
          "The capacity baseline is invalid; include measured provider identity, dimension, observation time, total, in-use amount, grant verification, and profile demand plans.",
        ),
      };
    }
  });

type BaselineConfigResult =
  | {
      readonly config: ConnectedPreviewConfig;
      readonly report: ConnectedPreviewReport;
      readonly output?: never;
    }
  | { readonly config?: never; readonly report?: never; readonly output: LauncherOutput };

const readBaselineConfig = (
  command: Extract<ConnectedPreviewCommand, { readonly action: "baseline" }>,
  options: LauncherOptions,
  fileSystem: FileSystem.FileSystem,
): Effect.Effect<BaselineConfigResult> =>
  Effect.gen(function* () {
    const configFile = path.resolve(options.cwd ?? process.cwd(), command.options.configFile);
    const contents = yield* Effect.result(fileSystem.readFileString(configFile));
    if (Result.isFailure(contents))
      return {
        output: outputForInvalidConfig(
          command,
          "Connected preview configuration could not be read from the explicit --config path",
        ),
      };
    const decoded = parseConfigText(contents.success);
    if ("error" in decoded) return { output: outputForInvalidConfig(command, decoded.error) };
    const validated = validateConfiguration(decoded.config, "plan");
    if (validated.errors.length > 0)
      return { output: outputForPreviewReport(command, validated.report, validated.errors) };
    return { config: decoded.config, report: validated.report };
  });

const baselineMatchesConfig = (
  baseline: typeof PreviewCapacityBaselineSchema.Type,
  config: ConnectedPreviewConfig,
  report: ConnectedPreviewReport,
) => {
  const ownedGroups = report.requiredGroups
    .filter(({ ownership }) => ownership === "owned")
    .map(({ id }) => id)
    .sort();
  return baseline.profiles.some(
    (profile) =>
      profile.profile === config.profile &&
      JSON.stringify([...profile.selectedRoles].sort()) ===
        JSON.stringify([...config.roles].sort()) &&
      JSON.stringify([...profile.ownedGroups].sort()) === JSON.stringify(ownedGroups),
  );
};

const baselineImportOutput = (
  command: ConnectedPreviewCommand,
  config: ConnectedPreviewConfig,
  report: ConnectedPreviewReport,
  counts: { readonly measurements: number; readonly profiles: number },
): LauncherOutput => ({
  schemaVersion: 3,
  ok: true,
  command: command.command,
  mode: "preview",
  action: "baseline",
  selectedServices: [...config.roles],
  checkoutState: null,
  plannedProcesses: [],
  urls: [],
  readiness: "completed",
  warnings: [],
  errors: [],
  changedSurfaces: [],
  parityGates: [],
  connectedPreview: {
    ...report,
    status: "planned",
    effects: {
      allocations: false,
      migrations: false,
      registrations: false,
      externalEffects: false,
      botHandoffs: false,
    },
    executionAvailable: false,
  },
  baseline: counts,
});

const runCapacityBaselineImport = (
  command: Extract<ConnectedPreviewCommand, { readonly action: "baseline" }>,
  options: LauncherOptions,
  allocations: import("./preview-allocations").PreviewAllocationApi | undefined,
): Effect.Effect<LauncherOutput, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (allocations === undefined)
      return capacityBaselineNotImported(
        command,
        "durable capacity baseline storage is unavailable",
        "Capacity baseline storage is unavailable; no baseline was imported.",
      );
    const fileSystem = yield* FileSystem.FileSystem;
    const baselineResult = yield* readCapacityBaseline(command, options, fileSystem);
    if (baselineResult.output !== undefined) return baselineResult.output;
    const configResult = yield* readBaselineConfig(command, options, fileSystem);
    if (configResult.output !== undefined) return configResult.output;
    if (!baselineMatchesConfig(baselineResult.baseline, configResult.config, configResult.report))
      return capacityBaselineNotImported(
        command,
        "no demand plan matches this exact profile, role set, and owned groups",
        "The baseline has no demand plan matching this exact profile, role set, and owned groups; no observations were imported.",
      );
    const imported = yield* Effect.result(allocations.importBaseline(baselineResult.baseline));
    if (Result.isFailure(imported))
      return capacityBaselineNotImported(
        command,
        "validation or durable import failed",
        "Baseline validation or durable import failed; the profile remains unavailable.",
      );
    return baselineImportOutput(
      command,
      configResult.config,
      configResult.report,
      imported.success,
    );
  });

const doctorFailureCodes: Partial<
  Record<(typeof prerequisites)[number]["id"], Diagnostic["code"]>
> = {
  "managed-service-tls": "tls-unavailable",
  "application-authentication": "application-authentication-unavailable",
  "workspace-dns": "dns-unavailable",
  "managed-service-dns": "dns-unavailable",
  "development-network": "network-unavailable",
};

const doctorUnavailableErrors = (action: "doctor") =>
  prerequisites
    .filter(
      ({ id }) =>
        id !== "state-grants-and-capacity" &&
        !previewRelayDoctorCheckIds.some((implemented) => implemented === id),
    )
    .map(({ id, reason }) =>
      diagnostic(
        doctorFailureCodes[id] ?? "prerequisite-unavailable",
        action,
        `Connected preview prerequisite ${id} is unavailable because its read-only check is not implemented`,
        `${reason} Keep the profile unavailable until this check has verifiable live evidence.`,
        id,
      ),
    );

const doctorProbeDiagnostics = (checks: readonly PreviewRelayDoctorCheck[]) =>
  checks
    .filter((check) => check.status !== "ready")
    .map((check) => {
      const prerequisite = prerequisites.find(({ id }) => id === check.id);
      return diagnostic(
        doctorFailureCodes[check.id as keyof typeof doctorFailureCodes] ??
          "prerequisite-unavailable",
        "doctor",
        `Connected preview prerequisite ${check.id} is ${check.status}: ${check.detail}`,
        prerequisite?.reason ??
          "Keep the connected preview profile unavailable until this check passes.",
        check.id,
      );
    });

const reportWithDoctorChecks = (
  report: ConnectedPreviewReport,
  checks: readonly PreviewRelayDoctorCheck[],
): ConnectedPreviewReport => {
  const byId = new Map(checks.map((check) => [check.id, check]));
  return {
    ...report,
    prerequisites: report.prerequisites.map((prerequisite) => {
      const check = byId.get(prerequisite.id);
      return check === undefined ? prerequisite : { ...prerequisite, status: check.status };
    }),
  };
};

const inspectPreparedWorkspace = (
  options: LauncherOptions,
  config: ConnectedPreviewConfig,
  shouldCheck: boolean,
) =>
  Effect.gen(function* () {
    if (!shouldCheck) return [] as const;
    const result = yield* Effect.result(
      (options.previewRelayProvider ?? PreviewRelayProviderUnavailable()).checkPreparedWorkspace({
        profile: config.profile,
        roles: config.roles,
        listeners: config.hostListeners ?? [],
      }),
    );
    if (Result.isSuccess(result)) return result.success;
    return previewRelayDoctorCheckIds.map((id) => ({
      id,
      status: "unavailable" as const,
      detail: "The configured read-only check could not be completed.",
    }));
  });

const inspectDoctorPrerequisites = (
  command: ConnectedPreviewCommand,
  options: LauncherOptions,
  config: ConnectedPreviewConfig,
  validationErrors: readonly Diagnostic[],
  allocations: import("./preview-allocations").PreviewAllocationApi | undefined,
) =>
  Effect.gen(function* () {
    if (command.action !== "doctor" || validationErrors.length > 0)
      return { capacityErrors: [], checks: [] as readonly PreviewRelayDoctorCheck[] };
    const capacityErrors = yield* inspectCapacityForDoctor(config, allocations);
    const checks = yield* inspectPreparedWorkspace(options, config, true);
    return { capacityErrors, checks };
  });

const ownedCapacityDimensions = (config: ConnectedPreviewConfig) => [
  ...new Set(ownedGroupIds(config).flatMap((id) => previewCapacityDimensionsByGroup[id])),
];

const missingCapacityDiagnostics = (config: ConnectedPreviewConfig, hasDatabase: boolean) =>
  ownedCapacityDimensions(config).map((dimension) =>
    diagnostic(
      "prerequisite-unavailable",
      "doctor",
      `Capacity dimension ${dimension} has no profile demand or exact provider identity configured`,
      hasDatabase
        ? "Import an operator baseline with a complete measured profile demand plan and observations for this provider dimension."
        : "Set TIARA_PREVIEW_SESSION_DATABASE to an existing controller store, then import a matching operator baseline. No capacity is assumed.",
      dimension,
    ),
  );

const inspectCapacityForDoctor = (
  config: ConnectedPreviewConfig,
  allocations: import("./preview-allocations").PreviewAllocationApi | undefined,
) =>
  Effect.gen(function* () {
    if (allocations === undefined) return missingCapacityDiagnostics(config, false);
    const plan = yield* Effect.result(
      allocations.planProfile({
        profile: config.profile,
        selectedRoles: config.roles,
        ownedGroups: ownedGroupIds(config),
      }),
    );
    if (Result.isFailure(plan)) return missingCapacityDiagnostics(config, true);
    const checks = yield* Effect.result(allocations.checkCapacity(plan.success.demands));
    if (Result.isFailure(checks)) return [capacityObservationReadFailure("doctor")];
    return checks.success.flatMap((check) => capacityCheckDiagnostic(check, "doctor"));
  });

const capacityObservationReadFailure = (action: "doctor" | "start") =>
  makeDiagnostic(
    "prerequisite-unavailable",
    "Provider capacity observations could not be read",
    "Retry after restoring access to the durable capacity baseline store.",
    { mode: "preview", action, dependency: "state-grants-and-capacity" },
  );

const capacityCheckDiagnostic = (
  check: import("./preview-allocations").CapacityCheckResult,
  action: "doctor" | "start",
): readonly Diagnostic[] => {
  if (check.status === "ready") return [];
  if (check.status === "exhausted")
    return [
      makeDiagnostic(
        "capacity-exhausted",
        `Capacity exhausted for ${check.dimension}: requested ${check.amount}, reserved ${check.reserved}, available ${check.available}`,
        "Reduce this profile's measured demand or collect a fresh provider baseline after safely increasing development capacity, then retry.",
        { mode: "preview", action, dependency: check.dimension },
      ),
    ];
  const condition =
    check.status === "missing"
      ? "no measurement was collected"
      : check.status === "provider-mismatch"
        ? `no observation matches the configured provider identity; observed ${check.observedProviders.map(safeIdentifier).join(", ")}`
        : check.status === "stale"
          ? "the provider measurement is stale"
          : "required provider grants were not verified";
  return [
    makeDiagnostic(
      "prerequisite-unavailable",
      `Capacity dimension ${check.dimension} for provider ${check.provider}/${safeIdentifier(check.identity)} is unavailable: ${condition}`,
      "Collect a fresh observation for this exact provider identity and verify its grants. The affected allocation remains blocked.",
      { mode: "preview", action, dependency: check.dimension },
    ),
  ];
};

const outputForPreviewReport = (
  command: ConnectedPreviewCommand,
  report: ConnectedPreviewReport,
  validationErrors: readonly Diagnostic[],
  validationWarnings: readonly Diagnostic[] = [],
  capacityDiagnostics: readonly Diagnostic[] = [],
  probeDiagnostics: readonly Diagnostic[] = [],
  doctorChecks: readonly PreviewRelayDoctorCheck[] = [],
): LauncherOutput => {
  const isDoctor = command.action === "doctor";
  const errors = [
    ...validationErrors,
    ...capacityDiagnostics,
    ...probeDiagnostics,
    ...(isDoctor && validationErrors.length === 0 ? doctorUnavailableErrors("doctor") : []),
  ];
  const requiredGroupIds = new Set(report.requiredGroups.map(({ id }) => id));
  const groupPlans = report.groupPlans.filter(({ id }) => requiredGroupIds.has(id));
  return {
    schemaVersion: 3,
    ok: errors.length === 0,
    command: command.command,
    mode: "preview",
    action: command.action,
    selectedServices: [...report.selectedRoles],
    checkoutState: null,
    plannedProcesses: [],
    urls: groupPlans.flatMap((group) =>
      group.endpoint === undefined ? [] : [{ name: group.id, url: group.endpoint }],
    ),
    readiness: errors.length > 0 ? "blocked" : "planned",
    warnings: validationWarnings,
    errors,
    changedSurfaces: [],
    parityGates: [],
    connectedPreview: {
      ...report,
      prerequisites:
        doctorChecks.length === 0
          ? report.prerequisites
          : reportWithDoctorChecks(report, doctorChecks).prerequisites,
      groupPlans,
      status: validationErrors.length > 0 ? "blocked" : isDoctor ? "unavailable" : "planned",
    },
  };
};

const isWithinDirectory = (directory: string, candidate: string) => {
  const relative = path.relative(directory, candidate);
  const isParentTraversal = Predicate.or(
    (value: string) => value === "..",
    (value: string) => value.startsWith(`..${path.sep}`),
  );
  return Predicate.and(
    Predicate.and((value: string) => value !== "", negatePredicate(isParentTraversal)),
    negatePredicate((value: string) => path.isAbsolute(value)),
  )(relative);
};

type EnvironmentFileInspection = {
  readonly input: ConnectedPreviewReport["environmentFileInputs"][number];
  readonly errors: readonly Diagnostic[];
};

const unavailableEnvironmentFileInput = (
  input: ConnectedPreviewConfig["environmentFileInputs"][number],
): ConnectedPreviewReport["environmentFileInputs"][number] => ({
  role: input.role,
  path: reportEnvironmentFilePath(input.path),
  digest: null,
  keys: [],
  status: "unavailable",
});

const environmentFileDiagnostic = (
  input: ConnectedPreviewConfig["environmentFileInputs"][number],
  action: PreviewValidationAction,
  code: Diagnostic["code"],
  message: string,
  remediation: string,
) => diagnostic(code, action, message, remediation, input.role);

const environmentFileInspectionFailure = (
  input: ConnectedPreviewConfig["environmentFileInputs"][number],
  action: PreviewValidationAction,
  code: Diagnostic["code"],
  message: string,
  remediation: string,
): EnvironmentFileInspection => ({
  input: unavailableEnvironmentFileInput(input),
  errors: [environmentFileDiagnostic(input, action, code, message, remediation)],
});

const inspectEnvironmentFileAtPath = (
  fileSystem: FileSystem.FileSystem,
  rootDirectory: string,
  input: ConnectedPreviewConfig["environmentFileInputs"][number],
  action: PreviewValidationAction,
): Effect.Effect<EnvironmentFileInspection> =>
  Effect.gen(function* () {
    if (!isSafeEnvironmentFilePath(input.path)) {
      return { input: unavailableEnvironmentFileInput(input), errors: [] };
    }
    const resolvedPath = path.resolve(rootDirectory, ...input.path.split("/"));
    if (!isWithinDirectory(rootDirectory, resolvedPath)) {
      return environmentFileInspectionFailure(
        input,
        action,
        "invalid-preview-config",
        `Environment file path for ${input.role} escapes the config directory`,
        "Use a config-relative environment path that resolves inside the config directory.",
      );
    }
    const realPathResult = yield* Effect.result(fileSystem.realPath(resolvedPath));
    if (Result.isFailure(realPathResult)) {
      return environmentFileInspectionFailure(
        input,
        action,
        "env-file-not-found",
        `Environment file input for ${input.role} could not be read`,
        "Create the declared file and keep non-secret environment values in its role allowlist.",
      );
    }
    const environmentPath = realPathResult.success;
    if (!isWithinDirectory(rootDirectory, environmentPath)) {
      return environmentFileInspectionFailure(
        input,
        action,
        "invalid-preview-config",
        `Environment file for ${input.role} resolves outside the config directory`,
        "Do not use environment-file symlinks outside the preview config directory.",
      );
    }
    const contentsResult = yield* Effect.result(fileSystem.readFileString(environmentPath));
    if (Result.isFailure(contentsResult)) {
      return environmentFileInspectionFailure(
        input,
        action,
        "env-file-not-found",
        `Environment file input for ${input.role} could not be read`,
        "Create the declared file and keep non-secret environment values in its role allowlist.",
      );
    }
    const parsed = validateEnvironmentFileContents(input.role, contentsResult.success, action);
    return {
      input: {
        role: input.role,
        path: reportEnvironmentFilePath(input.path),
        digest:
          parsed.errors.length === 0
            ? `sha256:${createHash("sha256").update(contentsResult.success).digest("hex")}`
            : null,
        keys: parsed.keys,
        status: parsed.errors.length === 0 ? ("declared" as const) : ("unavailable" as const),
      },
      errors: parsed.errors,
    };
  });

const inspectEnvironmentFileInputs = (
  config: ConnectedPreviewConfig,
  configPath: string,
  action: PreviewValidationAction,
): Effect.Effect<
  {
    readonly inputs: ConnectedPreviewReport["environmentFileInputs"];
    readonly errors: readonly Diagnostic[];
  },
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rootResult = yield* Effect.result(fileSystem.realPath(path.dirname(configPath)));
    if (Result.isFailure(rootResult)) {
      const failures = config.environmentFileInputs.map((input) =>
        environmentFileInspectionFailure(
          input,
          action,
          "env-file-not-found",
          `Environment input directory for ${input.role} could not be resolved`,
          "Place the preview config and declared environment files in a readable workspace directory.",
        ),
      );
      return {
        inputs: failures.map(({ input }) => input),
        errors: failures.flatMap(({ errors }) => errors),
      };
    }
    const inspections = yield* Effect.forEach(config.environmentFileInputs, (input) =>
      inspectEnvironmentFileAtPath(fileSystem, rootResult.success, input, action),
    );
    return {
      inputs: inspections.map(({ input }) => input),
      errors: inspections.flatMap(({ errors }) => errors),
    };
  });

export const connectedPreviewOutput = (
  command: ConnectedPreviewCommand,
  options: LauncherOptions,
): Effect.Effect<LauncherOutput, never, FileSystem.FileSystem | HttpClient.HttpClient> => {
  if (command.action === "baseline") {
    if (options.previewAllocationController !== undefined)
      return runCapacityBaselineImport(command, options, options.previewAllocationController);
    return Effect.serviceOption(PreviewAllocationController).pipe(
      Effect.flatMap((allocations) =>
        runCapacityBaselineImport(command, options, Option.getOrUndefined(allocations)),
      ),
    );
  }
  if (command.action !== "plan" && command.action !== "doctor") {
    const dispatch = (
      controller: import("./preview-sessions").PreviewSessionControllerApi | undefined,
      allocations: import("./preview-allocations").PreviewAllocationApi | undefined,
    ) =>
      controller === undefined
        ? Effect.succeed(outputForUnavailableExecution(command))
        : runSessionCommand(command, options, controller, allocations);
    const sessionController = options.previewSessionController;
    const allocationController = options.previewAllocationController;
    if (sessionController !== undefined && allocationController !== undefined)
      return dispatch(sessionController, allocationController);
    return Effect.serviceOption(PreviewSessionController).pipe(
      Effect.flatMap((controller) =>
        Effect.serviceOption(PreviewAllocationController).pipe(
          Effect.map((allocations) =>
            dispatch(
              sessionController ?? Option.getOrUndefined(controller),
              allocationController ?? Option.getOrUndefined(allocations),
            ),
          ),
        ),
      ),
      Effect.flatten,
    );
  }
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const configPath = path.resolve(options.cwd ?? process.cwd(), command.options.configFile);
    const read = yield* Effect.result(fileSystem.readFileString(configPath));
    if (Result.isFailure(read)) {
      return outputForInvalidConfig(
        command,
        "Connected preview configuration could not be read from the explicit --config path",
      );
    }
    const decoded = parseConfigText(read.success);
    if ("error" in decoded) return outputForInvalidConfig(command, decoded.error);
    const validated = validateConfiguration(decoded.config, command.action);
    const environmentFiles = yield* inspectEnvironmentFileInputs(
      decoded.config,
      configPath,
      command.action,
    );
    const report = { ...validated.report, environmentFileInputs: environmentFiles.inputs };
    const ambientCredentialErrors = validateAmbientCredentialEnvironment(
      options.env ?? process.env,
      command.action,
    );
    const allocationService =
      options.previewAllocationController ??
      Option.getOrUndefined(yield* Effect.serviceOption(PreviewAllocationController));
    const doctor = yield* inspectDoctorPrerequisites(
      command,
      options,
      decoded.config,
      validated.errors,
      allocationService,
    );
    const doctorReport = reportWithDoctorChecks(report, doctor.checks);
    return outputForPreviewReport(
      command,
      doctorReport,
      [...validated.errors, ...environmentFiles.errors],
      ambientCredentialErrors,
      doctor.capacityErrors,
      doctorProbeDiagnostics(doctor.checks),
      doctor.checks,
    );
  });
};
