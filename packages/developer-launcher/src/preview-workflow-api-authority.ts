import { Context, Effect, FileSystem, Option, Schema } from "effect";
import { createPublicKey, verify } from "node:crypto";
import path from "node:path";
import {
  isConnectedPreviewCredentialAllowed,
  type ConnectedPreviewConfig,
} from "./connected-preview";
import {
  PreviewWorkflowApiHostError,
  PreviewWorkflowApiRuntimeArtifactAttestationsSchema,
  type PreviewWorkflowApiCredentialProviderApi,
} from "./preview-workflow-api-host";
import { isApprovedDevelopmentGatewayDomain } from "./preview-gateway";
import {
  isApprovedDevelopmentPostgresEndpoint,
  isApprovedDevelopmentHttpsOrigin,
  previewWorkflowApiCredentialMatchesDatabaseTarget,
  previewWorkflowApiDatabaseEndpointIdentity,
  type PreviewWorkflowApiDatabaseTarget,
} from "./preview-workflow-api-supervisor";
import type { PreviewSharedWorkflowGroup } from "./preview-shared-workflow";
import { isPreviewPathWithin as isPathWithin } from "./preview-path-containment";

const sha256Identity = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));
const environmentKeySchema = Schema.Literals([
  "POSTGRES_URL",
  "SHEET_AUTH_OAUTH_CLIENT_ID",
  "SHEET_AUTH_OAUTH_CLIENT_SECRET",
  "SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS",
  "SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID",
]);
const PreviewWorkflowApiCredentialEnvironmentBindingSchema = Schema.Struct({
  environmentKey: environmentKeySchema,
  referenceName: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/)),
  environmentName: Schema.String.check(Schema.isPattern(/^TIARA_PREVIEW_WORKFLOW_API_[A-Z0-9_]+$/)),
});
const PreviewWorkflowApiAuthorityGroupSchema = Schema.Struct({
  workflowApiEndpoint: Schema.NonEmptyString,
  databaseEndpoint: Schema.NonEmptyString,
  databaseEndpointIdentity: sha256Identity,
  stateIdentity: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)),
  deployedManifestDigest: sha256Identity,
  schemaArtifactDigest: sha256Identity,
  workflowContractCatalogDigest: sha256Identity,
  authIssuer: Schema.NonEmptyString,
  credentialEnvironmentBindings: Schema.Array(PreviewWorkflowApiCredentialEnvironmentBindingSchema),
});
const PreviewWorkflowApiAuthorityPayloadSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  issuedAt: Schema.Int.check(Schema.isGreaterThan(0)),
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  gatewayDomain: Schema.NonEmptyString,
  workflowExecution: PreviewWorkflowApiAuthorityGroupSchema,
  runtimeArtifactAttestations: PreviewWorkflowApiRuntimeArtifactAttestationsSchema,
});
const PreviewWorkflowApiAuthorityEnvelopeSchema = Schema.Struct({
  algorithm: Schema.Literal("Ed25519"),
  payload: Schema.String,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/)),
});

export type PreviewWorkflowApiAuthorityPayload = Schema.Schema.Type<
  typeof PreviewWorkflowApiAuthorityPayloadSchema
>;
type PreviewWorkflowApiTrustedGroup = PreviewWorkflowApiAuthorityPayload["workflowExecution"];

class PreviewWorkflowApiAuthorityError extends Schema.TaggedErrorClass<PreviewWorkflowApiAuthorityError>()(
  "PreviewWorkflowApiAuthorityError",
  {
    reason: Schema.Literals([
      "authority-input-unavailable",
      "authority-path-invalid",
      "authority-file-unavailable",
      "authority-envelope-invalid",
      "authority-signature-invalid",
      "authority-expired",
      "authority-target-invalid",
      "authority-credential-binding-invalid",
    ]),
  },
) {}

const authorityFailure = (reason: PreviewWorkflowApiAuthorityError["reason"]) =>
  new PreviewWorkflowApiAuthorityError({ reason });
const hostFailure = (phase: string) =>
  new PreviewWorkflowApiHostError({ reason: "workflow-source-unavailable", phase });

const isWorkflowApiCredentialSecretReference = (name: string, reference: string) =>
  isConnectedPreviewCredentialAllowed("sheet-workflows-api", name) &&
  reference === `secret://tiara-stack-dev/sheet-workflows-api/${name}`;

const isAuthorityTargetValid = (target: PreviewWorkflowApiTrustedGroup) =>
  isApprovedDevelopmentHttpsOrigin(target.workflowApiEndpoint) &&
  isApprovedDevelopmentPostgresEndpoint(target.databaseEndpoint) &&
  previewWorkflowApiDatabaseEndpointIdentity(target.databaseEndpoint) ===
    target.databaseEndpointIdentity &&
  isApprovedDevelopmentHttpsOrigin(target.authIssuer);

const expectedCredentialEnvironmentKeys = [
  "POSTGRES_URL",
  "SHEET_AUTH_OAUTH_CLIENT_ID",
  "SHEET_AUTH_OAUTH_CLIENT_SECRET",
  "SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS",
  "SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID",
] as const;

const expectedCredentialBindings: ReadonlyArray<{
  readonly environmentKey: (typeof expectedCredentialEnvironmentKeys)[number];
  readonly referenceName: string;
  readonly environmentName: string;
}> = [
  {
    environmentKey: "POSTGRES_URL",
    referenceName: "workflow-database",
    environmentName: "TIARA_PREVIEW_WORKFLOW_API_POSTGRES_URL",
  },
  {
    environmentKey: "SHEET_AUTH_OAUTH_CLIENT_ID",
    referenceName: "internal-oauth-client",
    environmentName: "TIARA_PREVIEW_WORKFLOW_API_OAUTH_CLIENT_ID",
  },
  {
    environmentKey: "SHEET_AUTH_OAUTH_CLIENT_SECRET",
    referenceName: "internal-oauth-client",
    environmentName: "TIARA_PREVIEW_WORKFLOW_API_OAUTH_CLIENT_SECRET",
  },
  {
    environmentKey: "SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS",
    referenceName: "workload-identity",
    environmentName: "TIARA_PREVIEW_WORKFLOW_API_DELEGATION_CLIENT_IDS",
  },
  {
    environmentKey: "SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID",
    referenceName: "workload-identity",
    environmentName: "TIARA_PREVIEW_WORKFLOW_API_BOT_CLIENT_ID",
  },
];

const validateCredentialBindings = (
  bindings: PreviewWorkflowApiTrustedGroup["credentialEnvironmentBindings"],
) => {
  return (
    bindings.length === expectedCredentialBindings.length &&
    expectedCredentialBindings.every((expected) =>
      bindings.some(
        (binding) =>
          binding.environmentKey === expected.environmentKey &&
          binding.referenceName === expected.referenceName &&
          binding.environmentName === expected.environmentName &&
          isConnectedPreviewCredentialAllowed("sheet-workflows-api", binding.referenceName),
      ),
    )
  );
};

const validateAuthorityPayload = (payload: PreviewWorkflowApiAuthorityPayload, now: number) => {
  const maximumLifetimeMs = 24 * 60 * 60 * 1_000;
  if (
    !Number.isSafeInteger(now) ||
    payload.issuedAt > now + 30_000 ||
    payload.expiresAt <= now ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > maximumLifetimeMs
  )
    throw authorityFailure("authority-expired");
  if (!isAuthorityTargetValid(payload.workflowExecution))
    throw authorityFailure("authority-target-invalid");
  if (!isApprovedDevelopmentGatewayDomain(payload.gatewayDomain))
    throw authorityFailure("authority-target-invalid");
  if (!validateCredentialBindings(payload.workflowExecution.credentialEnvironmentBindings))
    throw authorityFailure("authority-credential-binding-invalid");
};

/** Verifies the exact signed payload text before decoding or using any contained identity. */
export const verifyPreviewWorkflowApiAuthorityEnvelope = (
  rawEnvelope: unknown,
  trustedPublicKeyPem: string,
  now: number = Date.now(),
): PreviewWorkflowApiAuthorityPayload => {
  let envelope: Schema.Schema.Type<typeof PreviewWorkflowApiAuthorityEnvelopeSchema>;
  try {
    envelope = Schema.decodeUnknownSync(PreviewWorkflowApiAuthorityEnvelopeSchema)(rawEnvelope);
  } catch {
    throw authorityFailure("authority-envelope-invalid");
  }

  let payloadBytes: Buffer;
  let signature: Buffer;
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    payloadBytes = Buffer.from(envelope.payload, "utf8");
    signature = Buffer.from(envelope.signature, "base64");
    publicKey = createPublicKey(trustedPublicKeyPem);
  } catch {
    throw authorityFailure("authority-signature-invalid");
  }
  if (!verify(null, payloadBytes, publicKey, signature))
    throw authorityFailure("authority-signature-invalid");

  let payload: PreviewWorkflowApiAuthorityPayload;
  try {
    payload = Schema.decodeUnknownSync(PreviewWorkflowApiAuthorityPayloadSchema)(
      JSON.parse(payloadBytes.toString("utf8")) as unknown,
    );
  } catch {
    throw authorityFailure("authority-envelope-invalid");
  }
  validateAuthorityPayload(payload, now);
  return payload;
};

export class PreviewWorkflowApiTrustedAuthority extends Context.Service<
  PreviewWorkflowApiTrustedAuthority,
  Option.Option<PreviewWorkflowApiAuthorityPayload>
>()("developer-launcher/PreviewWorkflowApiTrustedAuthority") {}

const previewWorkflowApiTrustedPublicKeyPath =
  "/etc/tiara-stack/preview-development/workflow-api-authority.pub";

const isRootOwnedAndNotWritable = (metadata: {
  readonly uid: Option.Option<number>;
  readonly mode: number;
}) => Option.getOrElse(metadata.uid, () => -1) === 0 && (metadata.mode & 0o022) === 0;

const isTrustedAuthorityDirectory = (metadata: FileSystem.File.Info) =>
  metadata.type === "Directory" && isRootOwnedAndNotWritable(metadata);

const isTrustedAuthorityPublicKey = (metadata: FileSystem.File.Info) =>
  metadata.type === "File" && isRootOwnedAndNotWritable(metadata) && metadata.size <= 16 * 1024;

/** The signing key must come from a root-owned, non-group/world-writable host trust path. */
const loadPreviewWorkflowApiTrustedPublicKey = () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const trustedDirectoryPath = path.dirname(previewWorkflowApiTrustedPublicKeyPath);
    const canonicalDirectory = yield* fileSystem
      .realPath(trustedDirectoryPath)
      .pipe(Effect.mapError(() => authorityFailure("authority-file-unavailable")));
    const directoryMetadata = yield* fileSystem
      .stat(canonicalDirectory)
      .pipe(Effect.mapError(() => authorityFailure("authority-file-unavailable")));
    const canonicalPath = yield* fileSystem
      .realPath(previewWorkflowApiTrustedPublicKeyPath)
      .pipe(Effect.mapError(() => authorityFailure("authority-file-unavailable")));
    const metadata = yield* fileSystem
      .stat(canonicalPath)
      .pipe(Effect.mapError(() => authorityFailure("authority-file-unavailable")));
    if (
      canonicalDirectory !== trustedDirectoryPath ||
      !isTrustedAuthorityDirectory(directoryMetadata) ||
      canonicalPath !== previewWorkflowApiTrustedPublicKeyPath ||
      !isTrustedAuthorityPublicKey(metadata)
    )
      return yield* Effect.fail(authorityFailure("authority-path-invalid"));
    const key = yield* fileSystem
      .readFileString(canonicalPath)
      .pipe(Effect.mapError(() => authorityFailure("authority-file-unavailable")));
    return Option.some(key);
  }).pipe(Effect.catch(() => Effect.succeed(Option.none())));

const resolveAuthorityFile = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  configuredPath: string | undefined,
) =>
  Effect.gen(function* () {
    if (
      configuredPath === undefined ||
      configuredPath.trim().length === 0 ||
      !path.isAbsolute(configuredPath)
    )
      return yield* Effect.fail(authorityFailure("authority-input-unavailable"));
    const normalizedPath = path.resolve(configuredPath);
    const canonicalPath = yield* fileSystem
      .realPath(normalizedPath)
      .pipe(Effect.mapError(() => authorityFailure("authority-file-unavailable")));
    const canonicalCheckout = yield* fileSystem
      .realPath(path.resolve(checkoutRoot))
      .pipe(Effect.mapError(() => authorityFailure("authority-path-invalid")));
    if (
      canonicalPath !== normalizedPath ||
      isPathWithin(canonicalCheckout, canonicalPath) ||
      (yield* fileSystem
        .stat(canonicalPath)
        .pipe(Effect.mapError(() => authorityFailure("authority-file-unavailable")))).type !==
        "File"
    )
      return yield* Effect.fail(authorityFailure("authority-path-invalid"));
    return canonicalPath;
  });

/** Loads operator-issued trust bytes only from explicit paths outside the mutable checkout. */
const loadPreviewWorkflowApiTrustedAuthorityOrFail = (
  input: {
    readonly checkout: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly now?: number;
  },
  trustedPublicKey: string,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const bundlePath = yield* resolveAuthorityFile(
      fileSystem,
      input.checkout,
      input.environment.TIARA_PREVIEW_WORKFLOW_API_AUTHORITY_FILE,
    );
    const bundleText = yield* fileSystem
      .readFileString(bundlePath)
      .pipe(Effect.mapError(() => authorityFailure("authority-file-unavailable")));
    const envelope = yield* Effect.try({
      try: () => JSON.parse(bundleText) as unknown,
      catch: () => authorityFailure("authority-envelope-invalid"),
    });
    return yield* Effect.try({
      try: () => verifyPreviewWorkflowApiAuthorityEnvelope(envelope, trustedPublicKey, input.now),
      catch: (error) =>
        error instanceof PreviewWorkflowApiAuthorityError
          ? error
          : authorityFailure("authority-envelope-invalid"),
    });
  });

/** Missing or invalid signed policy leaves the producer API unconfigured. */
export const loadPreviewWorkflowApiTrustedAuthorityWithKey = (
  input: {
    readonly checkout: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly now?: number;
  },
  trustedPublicKey: string,
) =>
  loadPreviewWorkflowApiTrustedAuthorityOrFail(input, trustedPublicKey).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none())),
  );

/** Missing host key or policy leaves the producer API unconfigured. */
export const loadPreviewWorkflowApiTrustedAuthority = (input: {
  readonly checkout: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly now?: number;
}) =>
  Effect.gen(function* () {
    const trustedPublicKey = yield* loadPreviewWorkflowApiTrustedPublicKey();
    if (Option.isNone(trustedPublicKey)) return Option.none();
    return yield* loadPreviewWorkflowApiTrustedAuthorityWithKey(input, trustedPublicKey.value);
  }).pipe(Effect.catch(() => Effect.succeed(Option.none())));

const sameTarget = (
  left: PreviewWorkflowApiTrustedGroup,
  right: PreviewWorkflowApiDatabaseTarget,
) =>
  left.databaseEndpoint === right.endpoint &&
  left.databaseEndpointIdentity === previewWorkflowApiDatabaseEndpointIdentity(right.endpoint) &&
  left.stateIdentity === right.stateIdentity &&
  left.deployedManifestDigest === right.deployedManifestDigest &&
  left.schemaArtifactDigest === right.schemaArtifactDigest &&
  left.workflowContractCatalogDigest === right.workflowContractCatalogDigest;

const trustedTargetMatchesConfig = (
  target: PreviewWorkflowApiTrustedGroup,
  config: ConnectedPreviewConfig,
) => {
  const selectedGroup = config.groups.find(({ id }) => id === "workflow-execution");
  return (
    config.sharedExecution === "producer-only" &&
    config.roles.includes("sheet-workflows-api") &&
    selectedWorkflowExecutionMatchesAuthority(target, selectedGroup) &&
    configuredWorkflowArtifactsMatchAuthority(target, config)
  );
};

const selectedWorkflowExecutionMatchesAuthority = (
  target: PreviewWorkflowApiTrustedGroup,
  selectedGroup: ConnectedPreviewConfig["groups"][number] | undefined,
) =>
  selectedGroup?.ownership === "reused" &&
  selectedGroup.endpoint === target.workflowApiEndpoint &&
  selectedGroup.databaseEndpointIdentity === target.databaseEndpointIdentity &&
  selectedGroup.stateIdentity === target.stateIdentity &&
  selectedGroup.deployedManifestDigest === target.deployedManifestDigest &&
  selectedGroup.schemaArtifactDigest === target.schemaArtifactDigest &&
  selectedGroup.workflowContractCatalogDigest === target.workflowContractCatalogDigest;

const configuredWorkflowArtifactsMatchAuthority = (
  target: PreviewWorkflowApiTrustedGroup,
  config: ConnectedPreviewConfig,
) =>
  config.identities.deployedManifestDigest === target.deployedManifestDigest &&
  config.identities.schemaArtifactDigest === target.schemaArtifactDigest &&
  config.identities.workflowContractCatalogDigest === target.workflowContractCatalogDigest;

const trustedTargetMatchesRuntimeGroup = (
  target: PreviewWorkflowApiTrustedGroup,
  group: PreviewSharedWorkflowGroup,
) =>
  group.groupId === "workflow-execution" &&
  group.endpoint === target.workflowApiEndpoint &&
  group.databaseEndpointIdentity === target.databaseEndpointIdentity &&
  group.stateIdentity === target.stateIdentity &&
  group.deployedManifestDigest === target.deployedManifestDigest &&
  group.schemaArtifactDigest === target.schemaArtifactDigest &&
  group.workflowContractCatalogDigest === target.workflowContractCatalogDigest;

const credentialReferencesMatchAuthority = (
  target: PreviewWorkflowApiTrustedGroup,
  references: Readonly<Record<string, string>>,
) => {
  const referenceNames = [
    ...new Set(target.credentialEnvironmentBindings.map(({ referenceName }) => referenceName)),
  ].sort();
  const providedReferenceNames = Object.keys(references).sort();
  return (
    referenceNames.length === providedReferenceNames.length &&
    referenceNames.every((name, index) => name === providedReferenceNames[index]) &&
    Object.entries(references).every(([name, reference]) =>
      isWorkflowApiCredentialSecretReference(name, reference),
    )
  );
};

const readCredentialBindingValue = (
  binding: PreviewWorkflowApiTrustedGroup["credentialEnvironmentBindings"][number],
  readEnvironment: (name: string) => string | undefined,
  assertAuthorityCurrent: () => Effect.Effect<void, PreviewWorkflowApiHostError>,
) =>
  Effect.gen(function* () {
    yield* assertAuthorityCurrent();
    if (!isConnectedPreviewCredentialAllowed("sheet-workflows-api", binding.referenceName))
      return yield* Effect.fail(hostFailure("workflow-api-credential-binding-unavailable"));
    const value = readEnvironment(binding.environmentName);
    if (value === undefined || value.trim().length === 0 || value.includes("\0"))
      return yield* Effect.fail(hostFailure("workflow-api-credential-value-unavailable"));
    yield* assertAuthorityCurrent();
    return value;
  });

const credentialEnvironmentMatchesTarget = (
  environment: Readonly<Record<string, string>>,
  target: PreviewWorkflowApiTrustedGroup,
) =>
  Object.keys(environment).length === expectedCredentialEnvironmentKeys.length &&
  expectedCredentialEnvironmentKeys.every((key) => environment[key] !== undefined) &&
  previewWorkflowApiCredentialMatchesDatabaseTarget(
    environment.POSTGRES_URL ?? "",
    target.databaseEndpoint,
  );

const readCredentialEnvironment = (
  target: PreviewWorkflowApiTrustedGroup,
  readEnvironment: (name: string) => string | undefined,
  assertAuthorityCurrent: () => Effect.Effect<void, PreviewWorkflowApiHostError>,
) =>
  Effect.gen(function* () {
    const environment: Record<string, string> = {};
    for (const binding of target.credentialEnvironmentBindings) {
      const value = yield* readCredentialBindingValue(
        binding,
        readEnvironment,
        assertAuthorityCurrent,
      );
      environment[binding.environmentKey] = value;
    }
    yield* assertAuthorityCurrent();
    if (!credentialEnvironmentMatchesTarget(environment, target))
      return yield* Effect.fail(hostFailure("workflow-api-credential-target-mismatch"));
    return environment;
  });

export const makePreviewWorkflowApiAuthorityExpiryAssertion =
  (input: { readonly expiresAt: number; readonly now?: () => number }) =>
  (): Effect.Effect<void, PreviewWorkflowApiHostError> =>
    Effect.gen(function* () {
      const now = yield* Effect.try({
        try: () => (input.now ?? Date.now)(),
        catch: () => hostFailure("workflow-api-authority-expired"),
      });
      if (!Number.isSafeInteger(now) || now >= input.expiresAt)
        return yield* Effect.fail(hostFailure("workflow-api-authority-expired"));
    });

export const makePreviewWorkflowApiCredentialProvider = (input: {
  readonly authority: PreviewWorkflowApiAuthorityPayload;
  readonly readEnvironment: (name: string) => string | undefined;
  readonly now?: () => number;
}): PreviewWorkflowApiCredentialProviderApi => {
  const trustedTarget = input.authority.workflowExecution;
  const authorityNow = input.now ?? Date.now;
  const assertAuthorityCurrent = makePreviewWorkflowApiAuthorityExpiryAssertion({
    expiresAt: input.authority.expiresAt,
    now: authorityNow,
  });
  const failTarget = () => hostFailure("workflow-api-trusted-group-unavailable");
  const resolveDatabaseTarget: PreviewWorkflowApiCredentialProviderApi["resolveDatabaseTarget"] = (
    request,
  ) =>
    Effect.gen(function* () {
      yield* assertAuthorityCurrent();
      if (
        request.session.id !== request.group.sessionId ||
        request.session.generation !== request.group.generation ||
        !trustedTargetMatchesConfig(trustedTarget, request.config) ||
        !trustedTargetMatchesRuntimeGroup(trustedTarget, request.group)
      )
        return yield* Effect.fail(failTarget());
      yield* assertAuthorityCurrent();
      return {
        endpoint: trustedTarget.databaseEndpoint,
        stateIdentity: trustedTarget.stateIdentity,
        deployedManifestDigest: trustedTarget.deployedManifestDigest,
        schemaArtifactDigest: trustedTarget.schemaArtifactDigest,
        workflowContractCatalogDigest: trustedTarget.workflowContractCatalogDigest,
      };
    });

  const resolve: PreviewWorkflowApiCredentialProviderApi["resolve"] = (request) =>
    Effect.gen(function* () {
      yield* assertAuthorityCurrent();
      // The signed selected-group target and the caller-supplied target must agree before secrets
      // are read. This also prevents direct adapter callers from bypassing the host's first check.
      if (
        !sameTarget(trustedTarget, request.databaseTarget) ||
        !trustedTargetMatchesConfig(trustedTarget, request.config) ||
        request.session.generation <= 0
      )
        return yield* Effect.fail(failTarget());
      if (!credentialReferencesMatchAuthority(trustedTarget, request.references))
        return yield* Effect.fail(hostFailure("workflow-api-credential-references-unavailable"));
      const environment = yield* readCredentialEnvironment(
        trustedTarget,
        input.readEnvironment,
        assertAuthorityCurrent,
      );
      yield* assertAuthorityCurrent();
      return { authIssuer: trustedTarget.authIssuer, environment };
    });

  return {
    assertCurrent: assertAuthorityCurrent,
    authorityExpiresAt: input.authority.expiresAt,
    authorityNow,
    resolveDatabaseTarget,
    resolve,
  };
};
