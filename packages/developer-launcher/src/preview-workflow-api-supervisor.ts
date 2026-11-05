import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";
import { createHash } from "node:crypto";
import path from "node:path";
import type { PreviewSession, PreviewSessionControllerApi } from "./preview-sessions";
import type { ConnectedPreviewConfig } from "./connected-preview";
import type { ProcessRequest } from "./types";
import type { PreviewWorkflowApiRouteRemovalInput } from "./preview-workflow-api-host";
import {
  previewSharedWorkflowGroupTarget,
  type PreviewSharedWorkflowGroup,
} from "./preview-shared-workflow";

const Revision = Schema.NonEmptyString;
const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));

/** Facts from a fresh request to the candidate API process, not its launcher plan. */
export const PreviewWorkflowApiReadinessSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/i)),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  revision: Revision,
  endpoint: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  workflowGroupTarget: Schema.NonEmptyString,
  apiArtifactDigest: Sha256,
  deployedManifestDigest: Sha256,
  schemaArtifactDigest: Sha256,
  workflowContractCatalogDigest: Sha256,
  role: Schema.Literal("producer"),
  producerOnly: Schema.Literal(true),
  workflowRunner: Schema.Literal(false),
  reconciliationConsumer: Schema.Literal(false),
  autonomousTriggers: Schema.Array(Schema.String),
  smokeEnqueue: Schema.Literal(false),
});
export type PreviewWorkflowApiReadiness = typeof PreviewWorkflowApiReadinessSchema.Type;

export interface PreviewWorkflowApiProcess {
  readonly id: string;
  readonly endpoint: string;
  readonly opaque: unknown;
}

/** Non-secret endpoint identity returned by the trusted credential resolver. */
export interface PreviewWorkflowApiDatabaseTarget {
  readonly stateIdentity: string;
  readonly deployedManifestDigest: string;
  /** Trusted migration/schema compatibility identity resolved with the database target. */
  readonly schemaArtifactDigest: string;
  /** Trusted Workflow Contract catalog identity observed for the selected shared group. */
  readonly workflowContractCatalogDigest: string;
  /** URL without credentials, query parameters, or fragment. */
  readonly endpoint: string;
}

export class PreviewWorkflowApiSupervisorError extends Schema.TaggedErrorClass<PreviewWorkflowApiSupervisorError>()(
  "PreviewWorkflowApiSupervisorError",
  {
    reason: Schema.Literals([
      "adapter-unavailable",
      "process-start-failed",
      "process-exited",
      "readiness-failed",
      "revision-failed",
      "route-failed",
      "session-fenced",
      "source-watch-ended",
      "process-stop-failed",
      "workflow-source-unavailable",
      "workflow-checkout-unavailable",
      "workflow-api-listener-unavailable",
      "workflow-api-credentials-unavailable",
      "workflow-api-authority-expired",
      "workflow-api-route-unavailable",
      "workflow-api-process-start-failed",
      "workflow-catalog-incompatible",
      "workflow-database-target-incompatible",
      "workflow-schema-artifact-incompatible",
      "workflow-api-process-not-found",
      "workflow-api-process-exited",
      "workflow-api-readiness-timeout",
      "workflow-api-route-removal-failed",
      "cleanup-unconfirmed",
    ]),
    sessionId: Schema.optionalKey(Schema.String),
    generation: Schema.optionalKey(Schema.Number),
    requestedRevision: Schema.optionalKey(Schema.String),
    sourceStage: Schema.optionalKey(Schema.String),
    cleanup: Schema.optionalKey(
      Schema.Struct({
        route: Schema.Literals(["confirmed", "unconfirmed"]),
        process: Schema.Literals(["confirmed", "unconfirmed"]),
        sessionFence: Schema.Literals(["confirmed", "unconfirmed", "not-required"]),
      }),
    ),
  },
) {}

const credentialEnvironmentKeys = [
  "POSTGRES_URL",
  "SHEET_AUTH_OAUTH_CLIENT_ID",
  "SHEET_AUTH_OAUTH_CLIENT_SECRET",
  "SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS",
  "SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID",
] as const;
const allowedCredentialEnvironmentKeys: ReadonlySet<string> = new Set(credentialEnvironmentKeys);
const lockedProducerEnvironmentKeys = new Set([
  "PORT",
  "HOST",
  "SHEET_WORKFLOWS_ROLE",
  "WORKFLOWS_STATE_PLANE_POLICY",
  "WORKFLOWS_AUTONOMOUS_TRIGGER_NAMES",
  "WORKFLOWS_SMOKE_WORKFLOW_ENABLED",
  "WORKFLOWS_TRIGGER_TARGET_OWNER",
  "WORKFLOWS_SOURCE_REVISION",
  "WORKFLOWS_PREVIEW_SESSION_ID",
  "WORKFLOWS_PREVIEW_GENERATION",
  "WORKFLOWS_PREVIEW_API_ENDPOINT",
  "WORKFLOWS_PREVIEW_GROUP_TARGET",
  "WORKFLOWS_PREVIEW_API_ARTIFACT_DIGEST",
  "WORKFLOWS_PREVIEW_MANIFEST_DIGEST",
  "WORKFLOWS_PREVIEW_SCHEMA_ARTIFACT_DIGEST",
  "WORKFLOWS_PREVIEW_CATALOG_DIGEST",
  "NODE_OPTIONS",
]);
const safeDevelopmentHttpsOrigin = (value: string) => {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    const developmentSuffix = [
      ".dev.tiara-stack.moe",
      ".tiara-stack-dev",
      ".tiara-stack-dev.svc",
      ".tiara-stack-dev.svc.cluster.local",
    ].some((suffix) => hostname.endsWith(suffix));
    return (
      parsed.protocol === "https:" &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.pathname === "/" &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0 &&
      developmentSuffix &&
      !/(^|[.-])(prod|production|live)([.-]|$)/.test(hostname)
    );
  } catch {
    return false;
  }
};
export const isApprovedDevelopmentHttpsOrigin = safeDevelopmentHttpsOrigin;

interface PreviewWorkflowApiProcessRequestInput {
  readonly checkout: string;
  readonly session: PreviewSession;
  readonly config: ConnectedPreviewConfig;
  readonly group: PreviewSharedWorkflowGroup;
  readonly listener: { readonly host: "127.0.0.1" | "::1"; readonly port: number };
  readonly authIssuer: string;
  readonly applicationOrigin: string;
  readonly revision: string;
  readonly credentialEnvironment: Readonly<Record<string, string>>;
  readonly databaseTarget: PreviewWorkflowApiDatabaseTarget;
}

const previewWorkflowApiRequestError = (input: PreviewWorkflowApiProcessRequestInput) =>
  makePreviewWorkflowApiSupervisorError("adapter-unavailable", input.session, input.revision);

const isProducerOnlyWorkflowApiProfile = (config: ConnectedPreviewConfig) =>
  config.sharedExecution === "producer-only" &&
  config.roles.length === 1 &&
  config.roles[0] === "sheet-workflows-api";

const isWorkflowApiGroupBoundToSession = (input: PreviewWorkflowApiProcessRequestInput) =>
  input.group.sessionId === input.session.id && input.group.generation === input.session.generation;

const isConfiguredWorkflowApiListener = (input: PreviewWorkflowApiProcessRequestInput) =>
  input.config.hostListeners?.some(
    ({ role, host, port }) =>
      role === "sheet-workflows-api" &&
      host === input.listener.host &&
      port === input.listener.port,
  ) === true;

const isValidWorkflowApiProcessRequest = (input: PreviewWorkflowApiProcessRequestInput) =>
  isProducerOnlyWorkflowApiProfile(input.config) &&
  isWorkflowApiGroupBoundToSession(input) &&
  input.revision.length > 0 &&
  safeDevelopmentHttpsOrigin(input.authIssuer) &&
  safeDevelopmentHttpsOrigin(input.applicationOrigin) &&
  Number.isInteger(input.listener.port) &&
  input.listener.port >= 1 &&
  input.listener.port <= 65535 &&
  isConfiguredWorkflowApiListener(input);

const hasOnlyPreviewWorkflowCredentials = (credentials: Readonly<Record<string, string>>) =>
  Object.keys(credentials).every(
    (key) => !lockedProducerEnvironmentKeys.has(key) && allowedCredentialEnvironmentKeys.has(key),
  ) &&
  credentialEnvironmentKeys.every(
    (key) => credentials[key] !== undefined && credentials[key] !== "",
  );

const isPostgresUrl = (url: URL) => url.protocol === "postgres:" || url.protocol === "postgresql:";
const developmentPostgresHostSuffixes = [
  ".dev.tiara-stack.moe",
  ".tiara-stack-dev",
  ".tiara-stack-dev.svc",
  ".tiara-stack-dev.svc.cluster.local",
] as const;
const isDevelopmentPostgresTarget = (url: URL) =>
  isPostgresUrl(url) &&
  url.hostname.length > 0 &&
  developmentPostgresHostSuffixes.some((suffix) => url.hostname.toLowerCase().endsWith(suffix)) &&
  url.pathname.length > 1 &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  url.search.length === 0 &&
  url.hash.length === 0 &&
  !/(^|[.-])(prod|production|live)([.-]|$)/i.test(url.hostname);
const canonicalApprovedDevelopmentPostgresEndpoint = (endpoint: string) => {
  try {
    const url = new URL(endpoint);
    if (!isDevelopmentPostgresTarget(url)) return undefined;
    const canonical = url.toString();
    return canonical === endpoint ? canonical : undefined;
  } catch {
    return undefined;
  }
};
export const previewWorkflowApiDatabaseEndpointIdentity = (endpoint: string) => {
  const canonical = canonicalApprovedDevelopmentPostgresEndpoint(endpoint);
  return canonical === undefined
    ? undefined
    : `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
};
export const isApprovedDevelopmentPostgresEndpoint = (endpoint: string) =>
  previewWorkflowApiDatabaseEndpointIdentity(endpoint) !== undefined;
const postgresEndpointOverrideParameters = [
  "db",
  "database",
  "dbname",
  "host",
  "hostaddr",
  "port",
  "service",
  "servicefile",
] as const;
const hasPostgresEndpointOverride = (url: URL) =>
  postgresEndpointOverrideParameters.some((parameter) => url.searchParams.has(parameter));
const hasSafePostgresOptions = (url: URL) => {
  const parameters = [...url.searchParams.entries()];
  return (
    parameters.length === 1 &&
    parameters[0]?.[0] === "sslmode" &&
    parameters[0][1] === "verify-full"
  );
};
const usesSamePostgresProtocol = (credentialUrl: URL, targetUrl: URL) =>
  isPostgresUrl(credentialUrl) && credentialUrl.protocol === targetUrl.protocol;
const usesSamePostgresAuthority = (credentialUrl: URL, targetUrl: URL) =>
  credentialUrl.hostname.toLowerCase() === targetUrl.hostname.toLowerCase() &&
  (credentialUrl.port || "5432") === (targetUrl.port || "5432");
const usesSamePostgresDatabase = (credentialUrl: URL, targetUrl: URL) =>
  credentialUrl.pathname === targetUrl.pathname;
const hasSafePostgresCredentialTarget = (credentialUrl: URL) =>
  !hasPostgresEndpointOverride(credentialUrl) &&
  hasSafePostgresOptions(credentialUrl) &&
  credentialUrl.hash.length === 0 &&
  !/(^|[.-])(prod|production|live)([.-]|$)/i.test(credentialUrl.hostname);
const databaseEndpointMatches = (credentialUrl: URL, targetUrl: URL) =>
  usesSamePostgresProtocol(credentialUrl, targetUrl) &&
  usesSamePostgresAuthority(credentialUrl, targetUrl) &&
  usesSamePostgresDatabase(credentialUrl, targetUrl) &&
  hasSafePostgresCredentialTarget(credentialUrl);

/** Reuses the supervisor's endpoint/query/TLS checks before any route or process call. */
export const previewWorkflowApiCredentialMatchesDatabaseTarget = (
  credentialValue: string,
  targetEndpoint: string,
) => {
  try {
    const credentialUrl = new URL(credentialValue);
    const targetUrl = new URL(targetEndpoint);
    return (
      isDevelopmentPostgresTarget(targetUrl) && databaseEndpointMatches(credentialUrl, targetUrl)
    );
  } catch {
    return false;
  }
};

const assertDevelopmentDatabaseEndpoint = (url: URL) => {
  if (!isDevelopmentPostgresTarget(url))
    throw new Error("workflow database target is not an approved development endpoint");
};

const assertCredentialUsesDatabaseEndpoint = (credentialUrl: URL, targetUrl: URL) => {
  if (!databaseEndpointMatches(credentialUrl, targetUrl))
    throw new Error("workflow database credential does not match the approved endpoint");
};

const assertDatabaseTargetIdentity = (input: PreviewWorkflowApiProcessRequestInput) => {
  const { databaseTarget, group, config } = input;
  if (databaseTarget.stateIdentity !== group.stateIdentity)
    throw new Error("workflow database target is not bound to the selected group");
  if (
    previewWorkflowApiDatabaseEndpointIdentity(databaseTarget.endpoint) !==
    group.databaseEndpointIdentity
  )
    throw new Error("workflow database endpoint is not bound to the selected group");
  const matchesGroup = [
    databaseTarget.deployedManifestDigest === group.deployedManifestDigest,
    databaseTarget.schemaArtifactDigest === group.schemaArtifactDigest,
    databaseTarget.workflowContractCatalogDigest === group.workflowContractCatalogDigest,
    config.identities.deployedManifestDigest === group.deployedManifestDigest,
    config.identities.schemaArtifactDigest === group.schemaArtifactDigest,
    config.identities.workflowContractCatalogDigest === group.workflowContractCatalogDigest,
  ].every(Boolean);
  if (!matchesGroup)
    throw new Error("workflow database target is not bound to the selected shared group identity");
};

const assertDatabaseTargetMatchesGroup = (
  input: PreviewWorkflowApiProcessRequestInput,
  credentialUrl: URL,
  targetUrl: URL,
) => {
  assertDevelopmentDatabaseEndpoint(targetUrl);
  assertCredentialUsesDatabaseEndpoint(credentialUrl, targetUrl);
  assertDatabaseTargetIdentity(input);
};

const validatePreviewWorkflowDatabase = (input: PreviewWorkflowApiProcessRequestInput) => {
  const failure = () => previewWorkflowApiRequestError(input);
  return Effect.try({
    try: () => new URL(input.credentialEnvironment.POSTGRES_URL!),
    catch: failure,
  }).pipe(
    Effect.flatMap((url) =>
      Effect.try({
        try: () =>
          assertDatabaseTargetMatchesGroup(input, url, new URL(input.databaseTarget.endpoint)),
        catch: failure,
      }),
    ),
  );
};

const validatePreviewWorkflowApiProcessRequest = (input: PreviewWorkflowApiProcessRequestInput) =>
  Effect.gen(function* () {
    const failure = () => previewWorkflowApiRequestError(input);
    if (!isValidWorkflowApiProcessRequest(input)) return yield* Effect.fail(failure());
    if (!hasOnlyPreviewWorkflowCredentials(input.credentialEnvironment))
      return yield* Effect.fail(failure());
    yield* validatePreviewWorkflowDatabase(input);
  });

const previewWorkflowApiEnvironment = (input: PreviewWorkflowApiProcessRequestInput) => ({
  ...input.credentialEnvironment,
  NODE_ENV: "development",
  LOG_LEVEL: "info",
  PORT: String(input.listener.port),
  HOST: input.listener.host,
  POD_NAMESPACE: "tiara-stack-dev",
  SHEET_AUTH_ISSUER: input.authIssuer,
  SHEET_AUTH_OAUTH_AUDIENCE: "sheet-workflows",
  SHEET_AUTH_WORKFLOW_HTTP_AUDIENCE: "sheet-workflows-http",
  SHEET_WEB_BASE_URL: input.applicationOrigin,
  NODE_OPTIONS: "--conditions=development",
  SHEET_WORKFLOWS_ROLE: "producer",
  WORKFLOWS_STATE_PLANE_POLICY: "shared-admission",
  WORKFLOWS_AUTONOMOUS_TRIGGER_NAMES: "",
  WORKFLOWS_SMOKE_WORKFLOW_ENABLED: "false",
  WORKFLOWS_TRIGGER_TARGET_OWNER: "",
  WORKFLOWS_SOURCE_REVISION: input.revision,
  WORKFLOWS_PREVIEW_SESSION_ID: input.session.id,
  WORKFLOWS_PREVIEW_GENERATION: String(input.session.generation),
  WORKFLOWS_PREVIEW_API_ENDPOINT: input.applicationOrigin,
  WORKFLOWS_PREVIEW_GROUP_TARGET: previewSharedWorkflowGroupTarget(input.group),
  WORKFLOWS_PREVIEW_API_ARTIFACT_DIGEST: input.group.apiArtifactDigest,
  WORKFLOWS_PREVIEW_MANIFEST_DIGEST: input.group.deployedManifestDigest,
  WORKFLOWS_PREVIEW_SCHEMA_ARTIFACT_DIGEST: input.group.schemaArtifactDigest,
  WORKFLOWS_PREVIEW_CATALOG_DIGEST: input.group.workflowContractCatalogDigest,
});

/** Constructs the only producer process environment supported for shared API previews. */
export const previewWorkflowApiProcessRequest = (
  input: PreviewWorkflowApiProcessRequestInput,
): Effect.Effect<ProcessRequest, PreviewWorkflowApiSupervisorError> =>
  validatePreviewWorkflowApiProcessRequest(input).pipe(
    Effect.as({
      command: process.execPath,
      args: [
        "--conditions=development",
        "--import",
        path.join(input.checkout, "node_modules/tsx/dist/loader.mjs"),
        "packages/sheet-workflows/src/index.ts",
      ],
      cwd: input.checkout,
      env: previewWorkflowApiEnvironment(input),
      environmentInheritance: "web-preview",
      timeoutMs: 30_000,
      kind: "runtime",
      readOnly: false,
      output: "stderr",
    } satisfies ProcessRequest),
  );

export const makePreviewWorkflowApiSupervisorError = (
  reason: PreviewWorkflowApiSupervisorError["reason"],
  session: PreviewSession,
  requestedRevision?: string,
  cleanup?: PreviewWorkflowApiSupervisorError["cleanup"],
) =>
  new PreviewWorkflowApiSupervisorError({
    reason,
    sessionId: session.id,
    generation: session.generation,
    ...(requestedRevision === undefined ? {} : { requestedRevision }),
    ...(cleanup === undefined ? {} : { cleanup }),
  });

export interface PreviewWorkflowApiSupervisorAdapters {
  /** Revalidates the signed producer authority at supervisor lifecycle boundaries. */
  readonly assertAuthorityCurrent?: () => Effect.Effect<void, PreviewWorkflowApiSupervisorError>;
  /** Absolute expiry from the verified signed authority envelope. */
  readonly authorityExpiresAt?: number;
  /** Uses the same clock as the signed authority verifier. */
  readonly authorityNow?: () => number;
  readonly currentSourceRevision: (
    checkout: string,
  ) => Effect.Effect<string, PreviewWorkflowApiSupervisorError>;
  /** Resolves only the credential references named by this selected producer profile. */
  readonly startProcess: (input: {
    readonly checkout: string;
    readonly session: PreviewSession;
    readonly revision: string;
    readonly config: ConnectedPreviewConfig;
    readonly group: PreviewSharedWorkflowGroup;
  }) => Effect.Effect<PreviewWorkflowApiProcess, PreviewWorkflowApiSupervisorError>;
  /** Must probe this exact candidate endpoint and return its session/revision/group evidence. */
  readonly probe: (input: {
    readonly process: PreviewWorkflowApiProcess;
    readonly session: PreviewSession;
    readonly revision: string;
    readonly group: PreviewSharedWorkflowGroup;
  }) => Effect.Effect<unknown, PreviewWorkflowApiSupervisorError>;
  /** Checks identity through the published session route before it can activate. */
  readonly probePublishedRoute: (input: {
    readonly process: PreviewWorkflowApiProcess;
    readonly sessionEndpoint: string;
    readonly session: PreviewSession;
    readonly revision: string;
    readonly group: PreviewSharedWorkflowGroup;
  }) => Effect.Effect<unknown, PreviewWorkflowApiSupervisorError>;
  readonly sourceRevisions: (
    checkout: string,
  ) => Stream.Stream<string, PreviewWorkflowApiSupervisorError>;
  /** Adapter owned by the common session application gateway; no shared route fallback. */
  readonly publishRoute: (input: {
    readonly session: PreviewSession;
    readonly ownerIdentity: string;
    readonly revision: string;
    readonly group: PreviewSharedWorkflowGroup;
    readonly endpoint: string;
    readonly controller: PreviewSessionControllerApi;
  }) => Effect.Effect<string, PreviewWorkflowApiSupervisorError>;
  readonly removeRoute: (
    input: PreviewWorkflowApiRouteRemovalInput,
  ) => Effect.Effect<void, PreviewWorkflowApiSupervisorError>;
  readonly awaitExit: (
    process: PreviewWorkflowApiProcess,
  ) => Effect.Effect<unknown, PreviewWorkflowApiSupervisorError>;
  readonly stopProcess: (
    process: PreviewWorkflowApiProcess,
  ) => Effect.Effect<void, PreviewWorkflowApiSupervisorError>;
}

export interface PreviewWorkflowApiSupervisorApi {
  /** Keeps the exact pending generation leased while host-side startup work runs before `run`. */
  readonly withSessionLease: <A, E, R>(
    input: {
      readonly session: PreviewSession;
      readonly ownerIdentity: string;
      readonly supervisorIdentity: string;
      readonly controller: PreviewSessionControllerApi;
    },
    use: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PreviewWorkflowApiSupervisorError, R>;
  /** Starts or resumes the API, gates its route until two matching readiness observations pass, and remains attached. */
  readonly run: (input: {
    readonly checkout: string;
    readonly session: PreviewSession;
    readonly ownerIdentity: string;
    readonly supervisorIdentity: string;
    readonly config: ConnectedPreviewConfig;
    readonly group: PreviewSharedWorkflowGroup;
    readonly controller: PreviewSessionControllerApi;
    readonly onReady?: (session: PreviewSession, applicationOrigin: string) => Effect.Effect<void>;
  }) => Effect.Effect<PreviewSession, PreviewWorkflowApiSupervisorError>;
}

export class PreviewWorkflowApiSupervisor extends Context.Service<
  PreviewWorkflowApiSupervisor,
  PreviewWorkflowApiSupervisorApi
>()("developer-launcher/PreviewWorkflowApiSupervisor") {}

interface PreviewWorkflowApiSessionLeaseIdentity {
  readonly session: PreviewSession;
  readonly sessionId: string;
  readonly sessionOwner: string;
  readonly generation: number;
  readonly ownerIdentity: string;
  readonly supervisorIdentity: string;
  readonly controller: PreviewSessionControllerApi;
}

class PreviewWorkflowApiSessionLease extends Context.Service<
  PreviewWorkflowApiSessionLease,
  PreviewWorkflowApiSessionLeaseIdentity
>()("developer-launcher/PreviewWorkflowApiSessionLease") {}

const readinessMatchesSession = (
  evidence: PreviewWorkflowApiReadiness,
  session: PreviewSession,
  revision: string,
  process: PreviewWorkflowApiProcess,
) =>
  evidence.sessionId === session.id &&
  evidence.generation === session.generation &&
  evidence.revision === revision &&
  evidence.endpoint === process.endpoint;

const readinessMatchesWorkflowGroup = (
  evidence: PreviewWorkflowApiReadiness,
  group: PreviewSharedWorkflowGroup,
) =>
  evidence.workflowGroupTarget === previewSharedWorkflowGroupTarget(group) &&
  evidence.apiArtifactDigest === group.apiArtifactDigest &&
  evidence.deployedManifestDigest === group.deployedManifestDigest &&
  evidence.schemaArtifactDigest === group.schemaArtifactDigest &&
  evidence.workflowContractCatalogDigest === group.workflowContractCatalogDigest;

const readinessIsProducerOnly = (evidence: PreviewWorkflowApiReadiness) =>
  evidence.role === "producer" &&
  evidence.producerOnly &&
  !evidence.workflowRunner &&
  !evidence.reconciliationConsumer &&
  evidence.autonomousTriggers.length === 0 &&
  !evidence.smokeEnqueue;

const readinessMatches = (
  evidence: PreviewWorkflowApiReadiness,
  session: PreviewSession,
  revision: string,
  group: PreviewSharedWorkflowGroup,
  process: PreviewWorkflowApiProcess,
) =>
  readinessMatchesSession(evidence, session, revision, process) &&
  readinessMatchesWorkflowGroup(evidence, group) &&
  readinessIsProducerOnly(evidence);

const recoverablePreSpawnRevisionFailureReasons: ReadonlySet<
  PreviewWorkflowApiSupervisorError["reason"]
> = new Set([
  "adapter-unavailable",
  "workflow-source-unavailable",
  "workflow-checkout-unavailable",
  "workflow-api-listener-unavailable",
  "workflow-api-credentials-unavailable",
  "workflow-api-route-unavailable",
  "workflow-api-process-start-failed",
  "process-start-failed",
  "workflow-catalog-incompatible",
  "workflow-database-target-incompatible",
  "workflow-schema-artifact-incompatible",
]);

const isRecoverablePreSpawnRevisionFailure = (error: PreviewWorkflowApiSupervisorError) =>
  recoverablePreSpawnRevisionFailureReasons.has(error.reason);

const checkCandidateReadiness = (
  adapters: PreviewWorkflowApiSupervisorAdapters,
  process: PreviewWorkflowApiProcess,
  session: PreviewSession,
  revision: string,
  group: PreviewSharedWorkflowGroup,
) =>
  Effect.gen(function* () {
    const rawFirst = yield* adapters.probe({ process, session, revision, group });
    const first = yield* Schema.decodeUnknownEffect(PreviewWorkflowApiReadinessSchema)(
      rawFirst,
    ).pipe(
      Effect.mapError(() =>
        makePreviewWorkflowApiSupervisorError("readiness-failed", session, revision),
      ),
    );
    if (!readinessMatches(first, session, revision, group, process))
      return yield* Effect.fail(
        makePreviewWorkflowApiSupervisorError("readiness-failed", session, revision),
      );
    yield* Effect.sleep(Duration.millis(250));
    const rawSecond = yield* adapters.probe({ process, session, revision, group });
    const second = yield* Schema.decodeUnknownEffect(PreviewWorkflowApiReadinessSchema)(
      rawSecond,
    ).pipe(
      Effect.mapError(() =>
        makePreviewWorkflowApiSupervisorError("readiness-failed", session, revision),
      ),
    );
    if (!readinessMatches(second, session, revision, group, process))
      return yield* Effect.fail(
        makePreviewWorkflowApiSupervisorError("readiness-failed", session, revision),
      );
  });

const checkPublishedRouteReadiness = (
  adapters: PreviewWorkflowApiSupervisorAdapters,
  process: PreviewWorkflowApiProcess,
  sessionEndpoint: string,
  session: PreviewSession,
  revision: string,
  group: PreviewSharedWorkflowGroup,
) =>
  Effect.gen(function* () {
    if (sessionEndpoint !== process.endpoint)
      return yield* Effect.fail(
        makePreviewWorkflowApiSupervisorError("readiness-failed", session, revision),
      );
    for (const observation of [1, 2]) {
      const raw = yield* adapters.probePublishedRoute({
        process,
        sessionEndpoint,
        session,
        revision,
        group,
      });
      const evidence = yield* Schema.decodeUnknownEffect(PreviewWorkflowApiReadinessSchema)(
        raw,
      ).pipe(
        Effect.mapError(() =>
          makePreviewWorkflowApiSupervisorError("readiness-failed", session, revision),
        ),
      );
      if (!readinessMatches(evidence, session, revision, group, process))
        return yield* Effect.fail(
          makePreviewWorkflowApiSupervisorError("readiness-failed", session, revision),
        );
      if (observation === 1) yield* Effect.sleep(Duration.millis(250));
    }
  });

const verifyCurrentSourceRevision = (
  adapters: PreviewWorkflowApiSupervisorAdapters,
  input: Parameters<PreviewWorkflowApiSupervisorApi["run"]>[0],
  revision: string,
) =>
  adapters.currentSourceRevision(input.checkout).pipe(
    Effect.mapError(() =>
      makePreviewWorkflowApiSupervisorError("workflow-source-unavailable", input.session, revision),
    ),
    Effect.flatMap((currentRevision) =>
      currentRevision === revision
        ? Effect.void
        : Effect.fail(
            makePreviewWorkflowApiSupervisorError("revision-failed", input.session, revision),
          ),
    ),
  );

const assertWorkflowApiAuthorityCurrent = (
  adapters: PreviewWorkflowApiSupervisorAdapters,
  session: PreviewSession,
  revision: string,
) =>
  adapters.assertAuthorityCurrent === undefined
    ? Effect.void
    : adapters
        .assertAuthorityCurrent()
        .pipe(
          Effect.mapError(() =>
            makePreviewWorkflowApiSupervisorError(
              "workflow-api-authority-expired",
              session,
              revision,
            ),
          ),
        );

const previewWorkflowApiSessionLeaseInput = (
  input: Parameters<PreviewWorkflowApiSupervisorApi["run"]>[0],
): PreviewWorkflowApiSessionLeaseIdentity => ({
  session: input.session,
  sessionId: input.session.id,
  sessionOwner: input.session.owner,
  generation: input.session.generation,
  ownerIdentity: input.ownerIdentity,
  supervisorIdentity: input.supervisorIdentity,
  controller: input.controller,
});

const samePreviewWorkflowApiSessionLease = (
  lease: PreviewWorkflowApiSessionLeaseIdentity,
  input: Parameters<PreviewWorkflowApiSupervisorApi["run"]>[0],
) =>
  lease.sessionId === input.session.id &&
  lease.sessionOwner === input.session.owner &&
  lease.generation === input.session.generation &&
  lease.ownerIdentity === input.ownerIdentity &&
  lease.supervisorIdentity === input.supervisorIdentity &&
  lease.controller === input.controller;

const maintainPreviewWorkflowApiSessionLease = <A, E, R>(
  adapters: PreviewWorkflowApiSupervisorAdapters,
  input: PreviewWorkflowApiSessionLeaseIdentity,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PreviewWorkflowApiSupervisorError, R> =>
  Effect.gen(function* () {
    const session = input.session;
    const revision = session.activeRevision ?? session.requestedRevision;
    const failFenced = () =>
      makePreviewWorkflowApiSupervisorError("session-fenced", session, revision);

    if (
      session.owner !== input.sessionOwner ||
      session.generation !== input.generation ||
      session.endedAt !== null ||
      (session.phase !== "pending" && session.phase !== "starting" && session.phase !== "active")
    )
      return yield* Effect.fail(failFenced());

    const fenceSignal = yield* Deferred.make<void>();
    const fenceWatcherReady = yield* Deferred.make<void>();
    const fenceWatcher = input.controller
      .watchFences(input.sessionId, Deferred.succeed(fenceSignal, undefined).pipe(Effect.asVoid))
      .pipe(
        Effect.andThen(Deferred.succeed(fenceWatcherReady, undefined)),
        Effect.andThen(Deferred.await(fenceSignal)),
        Effect.andThen(Effect.fail(failFenced())),
      );

    const renew = () =>
      input.controller.heartbeat(input.sessionId, input.supervisorIdentity, input.generation).pipe(
        Effect.mapError(failFenced),
        Effect.flatMap((renewed) =>
          renewed.id === input.sessionId &&
          renewed.owner === input.sessionOwner &&
          renewed.generation === input.generation &&
          renewed.endedAt === null &&
          (renewed.phase === "pending" ||
            renewed.phase === "starting" ||
            renewed.phase === "active")
            ? Effect.void
            : Effect.fail(failFenced()),
        ),
      );

    const heartbeat = Effect.gen(function* () {
      yield* Deferred.await(fenceWatcherReady);
      return yield* Effect.forever(
        Effect.sleep(Duration.seconds(15)).pipe(
          Effect.andThen(assertWorkflowApiAuthorityCurrent(adapters, session, revision)),
          Effect.andThen(renew()),
        ),
      );
    });
    const authorityExpiry =
      adapters.authorityExpiresAt === undefined
        ? Effect.never
        : Effect.gen(function* () {
            const expiresAt = adapters.authorityExpiresAt;
            if (expiresAt === undefined) return yield* Effect.never;
            const currentTime = yield* Effect.try({
              try: () => (adapters.authorityNow ?? Date.now)(),
              catch: () =>
                makePreviewWorkflowApiSupervisorError(
                  "workflow-api-authority-expired",
                  session,
                  revision,
                ),
            });
            if (!Number.isSafeInteger(currentTime))
              return yield* Effect.fail(
                makePreviewWorkflowApiSupervisorError(
                  "workflow-api-authority-expired",
                  session,
                  revision,
                ),
              );
            const remainingMs = expiresAt - currentTime;
            if (remainingMs > 0) yield* Effect.sleep(Duration.millis(remainingMs));
            yield* assertWorkflowApiAuthorityCurrent(adapters, session, revision);
            return yield* Effect.fail(
              makePreviewWorkflowApiSupervisorError(
                "workflow-api-authority-expired",
                session,
                revision,
              ),
            );
          });
    const leaseFailure = Effect.raceFirst(
      heartbeat,
      Effect.raceFirst(fenceWatcher, authorityExpiry),
    );
    const scopedUse = use.pipe(Effect.provideService(PreviewWorkflowApiSessionLease, input));
    const useAfterFenceRegistration = Effect.gen(function* () {
      yield* Deferred.await(fenceWatcherReady);
      yield* assertWorkflowApiAuthorityCurrent(adapters, session, revision);
      yield* renew();
      return yield* scopedUse;
    });
    return yield* Effect.scoped(Effect.raceFirst(useAfterFenceRegistration, leaseFailure));
  });

const verifyCurrentAuthorityAndSourceRevision = (
  adapters: PreviewWorkflowApiSupervisorAdapters,
  input: Parameters<PreviewWorkflowApiSupervisorApi["run"]>[0],
  revision: string,
) =>
  Effect.gen(function* () {
    yield* assertWorkflowApiAuthorityCurrent(adapters, input.session, revision);
    yield* verifyCurrentSourceRevision(adapters, input, revision);
    yield* assertWorkflowApiAuthorityCurrent(adapters, input.session, revision);
  });

const readyAndPublish = (
  adapters: PreviewWorkflowApiSupervisorAdapters,
  input: Parameters<PreviewWorkflowApiSupervisorApi["run"]>[0],
  process: PreviewWorkflowApiProcess,
  revision: string,
) => {
  return Effect.gen(function* () {
    yield* checkCandidateReadiness(adapters, process, input.session, revision, input.group);
    // Readiness carries an expected revision, so re-read the selected checkout
    // after the child has loaded its modules before publishing its route.
    yield* verifyCurrentAuthorityAndSourceRevision(adapters, input, revision);
    const sessionEndpoint = yield* adapters.publishRoute({
      session: input.session,
      ownerIdentity: input.ownerIdentity,
      revision,
      group: input.group,
      endpoint: process.endpoint,
      controller: input.controller,
    });
    yield* assertWorkflowApiAuthorityCurrent(adapters, input.session, revision);
    yield* input.controller
      .authorizeWorkEndpoint(
        input.session.id,
        input.session.generation,
        input.supervisorIdentity,
        sessionEndpoint,
      )
      .pipe(
        Effect.mapError(() =>
          makePreviewWorkflowApiSupervisorError("route-failed", input.session, revision),
        ),
      );
    yield* assertWorkflowApiAuthorityCurrent(adapters, input.session, revision);
    yield* checkPublishedRouteReadiness(
      adapters,
      process,
      sessionEndpoint,
      input.session,
      revision,
      input.group,
    );
    yield* assertWorkflowApiAuthorityCurrent(adapters, input.session, revision);
    // Keep the session pending unless the checkout still matches after both
    // published-route readiness observations.
    yield* verifyCurrentAuthorityAndSourceRevision(adapters, input, revision);
    const activated = yield* input.controller
      .activate(input.session.id, input.session.generation, input.supervisorIdentity, revision)
      .pipe(
        Effect.mapError(() =>
          makePreviewWorkflowApiSupervisorError("session-fenced", input.session, revision),
        ),
      );
    yield* assertWorkflowApiAuthorityCurrent(adapters, activated, revision);
    return activated;
  });
};

const cleanupWorkflowApiRouteAndProcess = (
  adapters: PreviewWorkflowApiSupervisorAdapters,
  input: Parameters<PreviewWorkflowApiSupervisorApi["run"]>[0],
  process: PreviewWorkflowApiProcess | undefined,
  expectedRevision: string | undefined,
) =>
  Effect.gen(function* () {
    const route =
      expectedRevision === undefined
        ? Exit.succeed(undefined)
        : yield* Effect.exit(
            adapters.removeRoute({
              sessionId: input.session.id,
              generation: input.session.generation,
              ownerIdentity: input.ownerIdentity,
              expectedRevision,
            }),
          );
    const processStop =
      process === undefined
        ? Exit.succeed(undefined)
        : yield* Effect.exit(adapters.stopProcess(process));
    return { route, process: processStop };
  });

const cleanupStatus = (succeeded: boolean): "confirmed" | "unconfirmed" =>
  succeeded ? "confirmed" : "unconfirmed";

const makeUnconfirmedCleanupError = (
  session: PreviewSession,
  revision: string,
  route: "confirmed" | "unconfirmed",
  process: "confirmed" | "unconfirmed",
  sessionFence: "confirmed" | "unconfirmed" | "not-required",
) =>
  makePreviewWorkflowApiSupervisorError("cleanup-unconfirmed", session, revision, {
    route,
    process,
    sessionFence,
  });

const cleanupWorkflowApiSupervisorAfterExit = <E, A>(input: {
  readonly adapters: PreviewWorkflowApiSupervisorAdapters;
  readonly sessionInput: Parameters<PreviewWorkflowApiSupervisorApi["run"]>[0];
  readonly exit: Exit.Exit<E, A>;
  readonly session: PreviewSession;
  readonly process: PreviewWorkflowApiProcess | undefined;
  readonly routeRevisionForCleanup: string | undefined;
  readonly expectedRevision: string;
}) =>
  Effect.gen(function* () {
    const cleanup = yield* cleanupWorkflowApiRouteAndProcess(
      input.adapters,
      input.sessionInput,
      input.process,
      input.routeRevisionForCleanup,
    );
    const sessionFence = Exit.isFailure(input.exit)
      ? yield* Effect.exit(
          stopFailedPreviewWorkflowApiSupervisorSession(
            input.sessionInput.controller,
            input.sessionInput.session.id,
            input.sessionInput.supervisorIdentity,
            input.sessionInput.session.generation,
            {
              route: cleanupStatus(Exit.isSuccess(cleanup.route)),
              process: cleanupStatus(Exit.isSuccess(cleanup.process)),
            },
          ),
        )
      : Exit.succeed(undefined);
    if (
      Exit.isFailure(cleanup.route) ||
      Exit.isFailure(cleanup.process) ||
      Exit.isFailure(sessionFence)
    ) {
      let sessionFenceStatus: "confirmed" | "unconfirmed" | "not-required" = "not-required";
      if (Exit.isFailure(input.exit))
        sessionFenceStatus = cleanupStatus(Exit.isSuccess(sessionFence));
      return yield* Effect.fail(
        makeUnconfirmedCleanupError(
          input.session,
          input.expectedRevision,
          cleanupStatus(Exit.isSuccess(cleanup.route)),
          cleanupStatus(Exit.isSuccess(cleanup.process)),
          sessionFenceStatus,
        ),
      );
    }
  });

export const stopFailedPreviewWorkflowApiSupervisorSession = (
  controller: PreviewSessionControllerApi,
  sessionId: string,
  supervisorIdentity: string,
  generation: number,
  cleanup: {
    readonly route: "confirmed" | "unconfirmed";
    readonly process: "confirmed" | "unconfirmed";
  } = { route: "unconfirmed", process: "unconfirmed" },
) =>
  Effect.gen(function* () {
    const failure = () =>
      new PreviewWorkflowApiSupervisorError({
        reason: "cleanup-unconfirmed",
        sessionId,
        generation,
        cleanup: { ...cleanup, sessionFence: "unconfirmed" },
      });
    const current = yield* controller.status(sessionId).pipe(Effect.mapError(failure));
    if (current.generation !== generation || current.endedAt !== null) return;
    yield* controller
      .stopSupervised(sessionId, supervisorIdentity, generation)
      .pipe(Effect.mapError(failure), Effect.asVoid);
  });

export const makePreviewWorkflowApiSupervisor = (
  adapters: PreviewWorkflowApiSupervisorAdapters,
): PreviewWorkflowApiSupervisorApi => ({
  withSessionLease: (input, use) =>
    maintainPreviewWorkflowApiSessionLease(
      adapters,
      {
        session: input.session,
        sessionId: input.session.id,
        sessionOwner: input.session.owner,
        generation: input.session.generation,
        ownerIdentity: input.ownerIdentity,
        supervisorIdentity: input.supervisorIdentity,
        controller: input.controller,
      },
      use,
    ),
  run: (input) => {
    let currentSession = input.session;
    let currentProcess: PreviewWorkflowApiProcess | undefined;
    let currentRevision = input.session.activeRevision ?? input.session.requestedRevision;
    // The exact revision associated with the current started process; cleanup
    // may be required even when readiness fails before publication completes.
    let currentRouteCleanupRevision: string | undefined;
    let runStarted = false;
    const runWithLease = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        runStarted = true;
        const initialRevision = yield* restore(adapters.currentSourceRevision(input.checkout));
        currentRevision = initialRevision;
        if (initialRevision !== currentSession.requestedRevision)
          currentSession = yield* input.controller
            .requestRevision(
              currentSession.id,
              currentSession.generation,
              input.supervisorIdentity,
              initialRevision,
            )
            .pipe(
              Effect.mapError(() =>
                makePreviewWorkflowApiSupervisorError(
                  "session-fenced",
                  currentSession,
                  initialRevision,
                ),
              ),
            );
        yield* assertWorkflowApiAuthorityCurrent(adapters, currentSession, initialRevision);
        const firstProcess = yield* restore(
          adapters.startProcess({
            checkout: input.checkout,
            session: currentSession,
            revision: initialRevision,
            config: input.config,
            group: input.group,
          }),
        );
        currentProcess = firstProcess;
        currentRouteCleanupRevision = initialRevision;
        currentSession = yield* restore(
          readyAndPublish(adapters, input, firstProcess, initialRevision),
        );
        yield* input.onReady?.(currentSession, firstProcess.endpoint) ?? Effect.void;
        const processExit = yield* Deferred.make<void>();
        const intentionallyStoppingProcesses = new WeakSet<PreviewWorkflowApiProcess>();
        const signalUnexpectedProcessExit = (process: PreviewWorkflowApiProcess) =>
          Effect.suspend(() =>
            intentionallyStoppingProcesses.has(process)
              ? Effect.void
              : Deferred.succeed(processExit, undefined),
          );
        const watchProcessExit = (process: PreviewWorkflowApiProcess) =>
          Effect.forkChild(
            adapters.awaitExit(process).pipe(
              Effect.andThen(signalUnexpectedProcessExit(process)),
              Effect.catchCause(() => signalUnexpectedProcessExit(process)),
            ),
          );
        let processExitFiber = yield* watchProcessExit(firstProcess);
        const cleanupBeforeRevision = (fenced: PreviewSession, revision: string) =>
          Effect.gen(function* () {
            const processBeingReplaced = currentProcess;
            const routeRevisionBeingReplaced = currentRouteCleanupRevision;
            if (processBeingReplaced !== undefined) {
              intentionallyStoppingProcesses.add(processBeingReplaced);
              // Retire the exit observer before stopping the old revision. Its
              // expected exit must not win the supervisor's process-failure race.
              yield* Fiber.interrupt(processExitFiber);
            }
            const cleanup = yield* cleanupWorkflowApiRouteAndProcess(
              adapters,
              input,
              processBeingReplaced,
              routeRevisionBeingReplaced,
            );
            if (Exit.isSuccess(cleanup.process)) currentProcess = undefined;
            if (Exit.isSuccess(cleanup.route)) currentRouteCleanupRevision = undefined;
            if (Exit.isFailure(cleanup.route) || Exit.isFailure(cleanup.process)) {
              currentSession = fenced;
              return yield* Effect.fail(
                makeUnconfirmedCleanupError(
                  fenced,
                  revision,
                  cleanupStatus(Exit.isSuccess(cleanup.route)),
                  cleanupStatus(Exit.isSuccess(cleanup.process)),
                  "not-required",
                ),
              );
            }
          });
        const recoverPreSpawnStartFailure = (
          fenced: PreviewSession,
          error: Parameters<typeof isRecoverablePreSpawnRevisionFailure>[0],
        ) => {
          currentSession = fenced;
          return isRecoverablePreSpawnRevisionFailure(error) ? Effect.void : Effect.fail(error);
        };
        const cleanupUnreadyRevision = (
          fenced: PreviewSession,
          revision: string,
          process: PreviewWorkflowApiProcess,
        ) =>
          Effect.gen(function* () {
            const cleanup = yield* cleanupWorkflowApiRouteAndProcess(
              adapters,
              input,
              process,
              currentRouteCleanupRevision,
            );
            if (Exit.isSuccess(cleanup.process)) currentProcess = undefined;
            if (Exit.isSuccess(cleanup.route)) currentRouteCleanupRevision = undefined;
            currentSession = fenced;
            if (Exit.isFailure(cleanup.route) || Exit.isFailure(cleanup.process))
              return yield* Effect.fail(
                makeUnconfirmedCleanupError(
                  fenced,
                  revision,
                  cleanupStatus(Exit.isSuccess(cleanup.route)),
                  cleanupStatus(Exit.isSuccess(cleanup.process)),
                  "not-required",
                ),
              );
          });
        const startRevision = (fenced: PreviewSession, revision: string) =>
          Effect.gen(function* () {
            currentRevision = revision;
            yield* assertWorkflowApiAuthorityCurrent(adapters, fenced, revision);
            const started = yield* Effect.result(
              restore(
                adapters.startProcess({
                  checkout: input.checkout,
                  session: fenced,
                  revision,
                  config: input.config,
                  group: input.group,
                }),
              ),
            );
            if (Result.isFailure(started))
              return yield* recoverPreSpawnStartFailure(fenced, started.failure);
            const next = started.success;
            currentProcess = next;
            currentRouteCleanupRevision = revision;
            const ready = yield* Effect.result(
              restore(readyAndPublish(adapters, { ...input, session: fenced }, next, revision)),
            );
            if (Result.isFailure(ready))
              return yield* cleanupUnreadyRevision(fenced, revision, next);
            currentSession = ready.success;
            processExitFiber = yield* watchProcessExit(next);
            yield* input.onReady?.(currentSession, next.endpoint) ?? Effect.void;
          });
        const restartForSourceRevision = (revision: string) =>
          Effect.gen(function* () {
            if (revision === currentSession.activeRevision && currentProcess !== undefined) return;
            const fenced = yield* input.controller
              .requestRevision(
                input.session.id,
                input.session.generation,
                input.supervisorIdentity,
                revision,
              )
              .pipe(
                Effect.mapError(() =>
                  makePreviewWorkflowApiSupervisorError("session-fenced", currentSession, revision),
                ),
              );
            currentSession = fenced;
            yield* cleanupBeforeRevision(fenced, revision);
            yield* startRevision(fenced, revision);
          });
        const watch = Stream.runForEach(
          adapters.sourceRevisions(input.checkout),
          restartForSourceRevision,
        ).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              makePreviewWorkflowApiSupervisorError("source-watch-ended", currentSession),
            ),
          ),
        );
        const attached = Effect.raceFirst(
          watch,
          Deferred.await(processExit).pipe(
            Effect.andThen(
              Effect.fail(makePreviewWorkflowApiSupervisorError("process-exited", currentSession)),
            ),
          ),
        );
        return yield* restore(attached).pipe(Effect.ensuring(Fiber.interrupt(processExitFiber)));
      }),
    );
    const runEffect = Effect.gen(function* () {
      const lease = yield* Effect.serviceOption(PreviewWorkflowApiSessionLease);
      if (Option.isSome(lease)) {
        if (!samePreviewWorkflowApiSessionLease(lease.value, input))
          return yield* Effect.fail(
            makePreviewWorkflowApiSupervisorError(
              "session-fenced",
              input.session,
              input.session.activeRevision ?? input.session.requestedRevision,
            ),
          );
        return yield* runWithLease;
      }
      return yield* maintainPreviewWorkflowApiSessionLease(
        adapters,
        previewWorkflowApiSessionLeaseInput(input),
        runWithLease,
      );
    });
    return runEffect.pipe(
      Effect.onExit((exit) => {
        if (!runStarted) return Effect.void;
        // A started process may still need route removal before readiness publishes it.
        const routeRevisionForCleanup =
          currentRouteCleanupRevision ??
          (currentProcess === undefined ? undefined : currentRevision);
        return cleanupWorkflowApiSupervisorAfterExit({
          adapters,
          sessionInput: input,
          exit,
          session: currentSession,
          process: currentProcess,
          routeRevisionForCleanup,
          expectedRevision: currentRevision,
        });
      }),
    );
  },
});

export const PreviewWorkflowApiSupervisorLayer = (adapters: PreviewWorkflowApiSupervisorAdapters) =>
  Layer.succeed(PreviewWorkflowApiSupervisor, makePreviewWorkflowApiSupervisor(adapters));
