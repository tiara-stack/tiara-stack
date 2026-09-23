import { createHash } from "node:crypto";
import path from "node:path";
import { Effect, FileSystem, Predicate, Result, Schema } from "effect";
import { sensitiveEnvironmentKeys } from "./config";
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
    id: "workspace-preparation",
    reason:
      "Prepared workspace authorization and outbound development destinations have not been checked.",
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

const quotaResourceDimensions = {
  "application-zero": [
    "PostgreSQL slots, senders, connections, WAL, and initial sync",
    "Zero Cache CPU, memory, and storage",
  ],
  "workflow-execution": [
    "Workflow API and runner CPU, memory, and storage",
    "PostgreSQL connections and WAL",
    "Redis capacity",
    "Kubernetes runner and browser workload capacity",
  ],
  auth: ["PostgreSQL connections", "Redis capacity", "OAuth registration and issuer capacity"],
  "bot-storage": [
    "Redis capacity",
    "Exclusive Discord gateway ownership",
    "Google Sheets target ownership",
  ],
  search: ["Meilisearch capacity", "Search index and rebuild storage"],
} as const satisfies Readonly<Record<ConnectedPreviewGroup, readonly string[]>>;

type ContractId = keyof typeof runtimeContractCatalog.contracts;
type GroupOwnership = "owned" | "reused";
type ConnectedPreviewCommand = Extract<ParsedCommand, { readonly kind: "preview" }>;
type ReadOnlyConnectedPreviewCommand =
  | Extract<ParsedCommand, { readonly kind: "preview"; readonly action: "plan" }>
  | Extract<ParsedCommand, { readonly kind: "preview"; readonly action: "doctor" }>;

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
      "Capacity measurements and atomic reservation are not implemented; do not treat this plan as a quota reservation.",
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

const isCredentialNameAllowed = (role: ConnectedPreviewRole, name: string) =>
  runtimeContractCatalog.roles[role].credentialNames.some((allowed) => allowed === name);

const reportCredentialName = (role: ConnectedPreviewRole, name: string) =>
  isCredentialNameAllowed(role, name) ? name : "<invalid>";

const reportCredentialReferenceStatus = (
  config: ConnectedPreviewConfig,
  role: ConnectedPreviewRole,
) => {
  const references = config.credentialReferences[role];
  if (references === undefined || Object.keys(references).length === 0)
    return "unavailable" as const;
  return Object.entries(references).every(
    ([name, reference]) =>
      isCredentialNameAllowed(role, name) &&
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
  const allowedName = isCredentialNameAllowed(role, name);
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
    context.requiredRoles.add("sheet-workflows-api");
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
  const valid =
    context.requiredGroups.has("workflow-execution") &&
    group?.ownership === "reused" &&
    !hasSelectedRunner(context) &&
    context.selectedRoles.has("sheet-workflows-api");
  if (!valid) {
    context.add(
      "invalid-preview-intent",
      "Shared execution requires an explicitly compatible producer-only workflow API and a reused execution group",
      "Select sheet-workflows-api, reuse workflow-execution, and omit preview runner roles.",
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
    validateProducerOnlyCompatibility(context);
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
  if (config.seed !== undefined && !isSafeIdentifier(config.seed)) {
    add(
      "invalid-preview-intent",
      "Synthetic seed must be a safe seed identifier",
      "Use a named synthetic seed; credentials and arbitrary data do not belong in the preview configuration.",
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
    makeDiagnostic(
      "not-implemented",
      `Connected preview ${command.action} is unavailable; no session or execution operation was attempted`,
      "Only read-only preview planning and prerequisite reporting are available in this implementation slice.",
      { mode: "preview", action: command.action },
    ),
  ],
  changedSurfaces: [],
  parityGates: [],
});

const outputForInvalidConfig = (
  command: ReadOnlyConnectedPreviewCommand,
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
      command.action,
      message,
      "Read the connected-preview schema documentation and provide a versioned development-only configuration.",
    ),
  ],
  changedSurfaces: [],
  parityGates: [],
});

const doctorUnavailableErrors = (action: "doctor") =>
  prerequisites.map(({ id, reason }) =>
    diagnostic(
      "prerequisite-unavailable",
      action,
      `Connected preview prerequisite ${id} is unavailable because its read-only check is not implemented`,
      `${reason} Keep the profile unavailable until this check has verifiable live evidence.`,
      id,
    ),
  );

const outputForPreviewReport = (
  command: Extract<ParsedCommand, { readonly kind: "preview" }>,
  report: ConnectedPreviewReport,
  validationErrors: readonly Diagnostic[],
  validationWarnings: readonly Diagnostic[] = [],
): LauncherOutput => {
  const isDoctor = command.action === "doctor";
  const errors = [
    ...validationErrors,
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
): Effect.Effect<LauncherOutput, never, FileSystem.FileSystem> => {
  if (command.action !== "plan" && command.action !== "doctor") {
    return Effect.succeed(outputForUnavailableExecution(command));
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
    return outputForPreviewReport(
      command,
      report,
      [...validated.errors, ...environmentFiles.errors],
      ambientCredentialErrors,
    );
  });
};
