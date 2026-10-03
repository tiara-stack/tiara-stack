import { randomUUID } from "node:crypto";
import path from "node:path";
import { Context, Effect, Exit, FileSystem, Layer, Redacted, Schema } from "effect";
import { NodeHttpClient } from "@effect/platform-node";
import { HttpClient } from "effect/unstable/http";
import {
  createOAuthClient,
  deleteOAuthClient,
  listOAuthClients,
  type OAuthClientDetails,
  type SheetAuthClient,
} from "sheet-auth/client";
import { isConnectedPreviewCredentialAllowed } from "./connected-preview";
import { KubernetesTokenRequestClient } from "./kubernetes-token-request";
import {
  KubernetesServiceAccountClient,
  KubernetesServiceAccountClientLive,
  KubernetesTokenRequestClientLive,
} from "./kubernetes-token-request";
import { PreviewSessionController, type PreviewSessionControllerApi } from "./preview-sessions";
import { connectedPreviewRoles, type ConnectedPreviewRole } from "./types";

export const previewWorkloadCredentialRequestedLifetimeSeconds = 600;
const previewWorkloadCredentialRequestedLifetimeMs =
  previewWorkloadCredentialRequestedLifetimeSeconds * 1_000;

export const PreviewWorkloadCredentialKind = Schema.Literals(["host-token-request", "projected"]);
export type PreviewWorkloadCredentialKind = typeof PreviewWorkloadCredentialKind.Type;

const workloadCredentialNames: Readonly<Record<ConnectedPreviewRole, string>> = {
  "sheet-web": "preview-admission",
  "sheet-auth": "workload-proof",
  "sheet-db-server": "verifier",
  "sheet-bot": "bot-delegation-proof",
  "sheet-workflows-api": "workload-identity",
  "sheet-workflows-runner": "workload-identity",
  "sheet-workflows-browser-runner": "workload-identity",
};

const workloadCredentialNameFor = (role: ConnectedPreviewRole) => workloadCredentialNames[role];

export const PreviewWorkloadCredentialRequestSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: Schema.Number,
  role: Schema.Literals(connectedPreviewRoles),
  kind: PreviewWorkloadCredentialKind,
  credentialName: Schema.NonEmptyString,
  audience: Schema.NonEmptyString,
  serviceAccount: Schema.NonEmptyString,
  expirationSeconds: Schema.Literals([previewWorkloadCredentialRequestedLifetimeSeconds]),
});
export type PreviewWorkloadCredentialRequest = typeof PreviewWorkloadCredentialRequestSchema.Type;

export const PreviewWorkloadCredentialGrantSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: Schema.Number,
  role: Schema.Literals(connectedPreviewRoles),
  kind: PreviewWorkloadCredentialKind,
  credentialName: Schema.NonEmptyString,
  audience: Schema.NonEmptyString,
  serviceAccount: Schema.NonEmptyString,
  oauthClientId: Schema.NonEmptyString,
  credentialFile: Schema.NonEmptyString,
  projectedVolume: Schema.optionalKey(
    Schema.Struct({
      name: Schema.NonEmptyString,
      audience: Schema.NonEmptyString,
      expirationSeconds: Schema.Literals([previewWorkloadCredentialRequestedLifetimeSeconds]),
      mountPath: Schema.NonEmptyString,
      tokenPath: Schema.Literals(["token"]),
    }),
  ),
  issuedAt: Schema.Number,
  expiresAt: Schema.Number,
});
export type PreviewWorkloadCredentialGrant = typeof PreviewWorkloadCredentialGrantSchema.Type;

export class PreviewWorkloadCredentialError extends Schema.TaggedErrorClass<PreviewWorkloadCredentialError>()(
  "PreviewWorkloadCredentialError",
  { reason: Schema.String },
) {}

export interface PreviewWorkloadCredentialIssuerApi {
  /** The adapter must create only the named session/role identity and a private managed file. */
  readonly issue: (
    request: PreviewWorkloadCredentialRequest,
  ) => Effect.Effect<PreviewWorkloadCredentialGrant, PreviewWorkloadCredentialError>;
  /** Replaces only the exact owned identity and file from the prior grant. */
  readonly renew: (
    request: PreviewWorkloadCredentialRequest,
    previous: PreviewWorkloadCredentialGrant,
  ) => Effect.Effect<PreviewWorkloadCredentialGrant, PreviewWorkloadCredentialError>;
  /** Removes only the named session/role identity and its private managed file. */
  readonly remove: (
    grant: PreviewWorkloadCredentialGrant,
  ) => Effect.Effect<void, PreviewWorkloadCredentialError>;
}

export class PreviewWorkloadCredentialIssuer extends Context.Service<
  PreviewWorkloadCredentialIssuer,
  PreviewWorkloadCredentialIssuerApi
>()("developer-launcher/PreviewWorkloadCredentialIssuer") {}

type PreviewCredentialCreatedResources = {
  readonly serviceAccount: boolean;
  readonly serviceAccountUid: string;
  readonly oauthClient: boolean;
  readonly projectedWorkload: boolean;
};
type PreviewRoleIdentity = {
  readonly serviceAccount: string;
  readonly oauthClientId: string;
};
type PreviewProjectedWorkloadGrant = {
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly created: boolean;
};

export interface PreviewWorkloadCredentialProviderApi {
  readonly createRoleIdentity: (request: PreviewWorkloadCredentialRequest) => Effect.Effect<
    {
      readonly serviceAccount: string;
      readonly oauthClientId: string;
      readonly serviceAccountUid: string;
      readonly createdServiceAccount: boolean;
      readonly createdOAuthClient: boolean;
    },
    PreviewWorkloadCredentialError
  >;
  readonly requestHostToken: (
    request: PreviewWorkloadCredentialRequest,
  ) => Effect.Effect<
    { readonly token: string; readonly issuedAt: number; readonly expiresAt: number },
    PreviewWorkloadCredentialError
  >;
  readonly requestProjectedToken: (
    request: PreviewWorkloadCredentialRequest,
    identity: PreviewRoleIdentity,
    projection: NonNullable<PreviewWorkloadCredentialGrant["projectedVolume"]>,
  ) => Effect.Effect<PreviewProjectedWorkloadGrant, PreviewWorkloadCredentialError>;
  readonly deleteRoleIdentity: (input: {
    readonly sessionId: string;
    readonly generation: number;
    readonly role: ConnectedPreviewRole;
    readonly serviceAccount: string;
    readonly oauthClientId: string;
    readonly createdResources?: PreviewCredentialCreatedResources;
  }) => Effect.Effect<void, PreviewWorkloadCredentialError>;
}

export class PreviewWorkloadCredentialProvider extends Context.Service<
  PreviewWorkloadCredentialProvider,
  PreviewWorkloadCredentialProviderApi
>()("developer-launcher/PreviewWorkloadCredentialProvider") {}

const mapCredentialFileError = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.mapError(
      () =>
        new PreviewWorkloadCredentialError({ reason: "managed-credential-file-operation-failed" }),
    ),
  );

export interface KubernetesWorkloadIdentityProvisionerApi {
  readonly ensureRoleIdentity: (request: PreviewWorkloadCredentialRequest) => Effect.Effect<
    {
      readonly serviceAccount: string;
      readonly oauthClientId: string;
      readonly serviceAccountUid: string;
      readonly createdServiceAccount: boolean;
      readonly createdOAuthClient: boolean;
    },
    PreviewWorkloadCredentialError
  >;
  readonly provisionProjectedWorkload: (input: {
    readonly request: PreviewWorkloadCredentialRequest;
    readonly identity: PreviewRoleIdentity;
    readonly projection: NonNullable<PreviewWorkloadCredentialGrant["projectedVolume"]>;
  }) => Effect.Effect<PreviewProjectedWorkloadGrant, PreviewWorkloadCredentialError>;
  readonly deleteRoleIdentity: (input: {
    readonly sessionId: string;
    readonly generation: number;
    readonly role: ConnectedPreviewRole;
    readonly serviceAccount: string;
    readonly oauthClientId: string;
    readonly createdResources?: PreviewCredentialCreatedResources;
  }) => Effect.Effect<void, PreviewWorkloadCredentialError>;
}

export class KubernetesWorkloadIdentityProvisioner extends Context.Service<
  KubernetesWorkloadIdentityProvisioner,
  KubernetesWorkloadIdentityProvisionerApi
>()("developer-launcher/KubernetesWorkloadIdentityProvisioner") {}

export interface PreviewOAuthClientProvisionerApi {
  readonly ensure: (
    request: PreviewWorkloadCredentialRequest,
  ) => Effect.Effect<
    { readonly oauthClientId: string; readonly created: boolean },
    PreviewWorkloadCredentialError
  >;
  readonly remove: (input: {
    readonly request: PreviewWorkloadCredentialRequest;
    readonly oauthClientId: string;
  }) => Effect.Effect<void, PreviewWorkloadCredentialError>;
}

export class PreviewOAuthClientProvisioner extends Context.Service<
  PreviewOAuthClientProvisioner,
  PreviewOAuthClientProvisionerApi
>()("developer-launcher/PreviewOAuthClientProvisioner") {}

const oauthClientNameFor = (request: PreviewWorkloadCredentialRequest) =>
  `tiara-preview:${request.sessionId}:${request.generation}:${request.role}`;

const previewOAuthScopeFor = (request: PreviewWorkloadCredentialRequest) =>
  request.credentialName === "workload-identity" ||
  request.credentialName === "bot-delegation-proof"
    ? "token.exchange"
    : "";

const assertOwnedOAuthClient = (
  request: PreviewWorkloadCredentialRequest,
  client: OAuthClientDetails,
) => {
  if (
    client.client_name !== oauthClientNameFor(request) ||
    (client.scope ?? "") !== previewOAuthScopeFor(request)
  ) {
    return Effect.fail(
      new PreviewWorkloadCredentialError({ reason: "oauth-client-owner-mismatch" }),
    );
  }
  return Effect.succeed(client.client_id);
};

/** Uses the existing Sheet Auth client-management routes with an explicit operator header. */
export const SheetAuthOAuthClientProvisionerLive = (
  client: SheetAuthClient,
  operatorHeaders: Readonly<Record<string, string>>,
) =>
  Layer.succeed(PreviewOAuthClientProvisioner, {
    ensure: (request) =>
      Effect.gen(function* () {
        const clients = yield* listOAuthClients(client, operatorHeaders).pipe(
          Effect.mapError(
            () => new PreviewWorkloadCredentialError({ reason: "oauth-client-list-failed" }),
          ),
        );
        const matches = clients.filter(
          (candidate) => candidate.client_name === oauthClientNameFor(request),
        );
        if (matches.length > 1)
          return yield* Effect.fail(
            new PreviewWorkloadCredentialError({ reason: "duplicate-owned-oauth-clients" }),
          );
        const existing = matches[0];
        if (existing)
          return {
            oauthClientId: yield* assertOwnedOAuthClient(request, existing),
            created: false,
          };
        const created = yield* createOAuthClient(
          client,
          {
            redirect_uris: [],
            client_name: oauthClientNameFor(request),
            scope: previewOAuthScopeFor(request),
            grant_types: ["client_credentials"],
            response_types: [],
            type: "native",
          },
          operatorHeaders,
        ).pipe(
          Effect.mapError(
            () => new PreviewWorkloadCredentialError({ reason: "oauth-client-create-failed" }),
          ),
        );
        return {
          oauthClientId: yield* assertOwnedOAuthClient(request, created),
          created: true,
        };
      }),
    remove: ({ request, oauthClientId }) =>
      Effect.gen(function* () {
        const clients = yield* listOAuthClients(client, operatorHeaders).pipe(
          Effect.mapError(
            () => new PreviewWorkloadCredentialError({ reason: "oauth-client-list-failed" }),
          ),
        );
        const matches = clients.filter((candidate) => candidate.client_id === oauthClientId);
        if (matches.length === 0) return;
        if (matches.length !== 1)
          return yield* Effect.fail(
            new PreviewWorkloadCredentialError({ reason: "duplicate-oauth-client-id" }),
          );
        yield* assertOwnedOAuthClient(request, matches[0]!);
        yield* deleteOAuthClient(client, oauthClientId, operatorHeaders).pipe(
          Effect.mapError(
            () => new PreviewWorkloadCredentialError({ reason: "oauth-client-delete-failed" }),
          ),
        );
      }),
  });

export interface KubernetesProjectedWorkloadClientApi {
  readonly ensureProjection: (input: {
    readonly request: PreviewWorkloadCredentialRequest;
    readonly identity: PreviewRoleIdentity;
    readonly projection: NonNullable<PreviewWorkloadCredentialGrant["projectedVolume"]>;
  }) => Effect.Effect<PreviewProjectedWorkloadGrant, PreviewWorkloadCredentialError>;
  readonly removeProjection: (input: {
    readonly sessionId: string;
    readonly generation: number;
    readonly role: ConnectedPreviewRole;
    readonly serviceAccount: string;
  }) => Effect.Effect<void, PreviewWorkloadCredentialError>;
}

export class KubernetesProjectedWorkloadClient extends Context.Service<
  KubernetesProjectedWorkloadClient,
  KubernetesProjectedWorkloadClientApi
>()("developer-launcher/KubernetesProjectedWorkloadClient") {}

/** Configured implementation for exact owned service accounts, OAuth clients, and Pod projections. */
export const KubernetesWorkloadIdentityProvisionerLive = Layer.effect(
  KubernetesWorkloadIdentityProvisioner,
  Effect.gen(function* () {
    const serviceAccounts = yield* KubernetesServiceAccountClient;
    const oauthClients = yield* PreviewOAuthClientProvisioner;
    const projectedWorkloads = yield* KubernetesProjectedWorkloadClient;
    return {
      ensureRoleIdentity: (request) =>
        Effect.gen(function* () {
          const serviceAccount = yield* serviceAccounts.ensureOwned(request).pipe(
            Effect.mapError(
              () =>
                new PreviewWorkloadCredentialError({
                  reason: "service-account-provision-failed",
                }),
            ),
          );
          const oauthClientExit = yield* Effect.exit(oauthClients.ensure(request));
          if (Exit.isFailure(oauthClientExit)) {
            if (serviceAccount.created) {
              const cleanup = yield* Effect.exit(
                serviceAccounts.deleteOwned(request, serviceAccount.uid),
              );
              if (Exit.isFailure(cleanup)) {
                return yield* Effect.fail(
                  new PreviewWorkloadCredentialError({
                    reason: "partial-service-account-cleanup-failed",
                  }),
                );
              }
            }
            return yield* Effect.failCause(oauthClientExit.cause);
          }
          const oauthClient = oauthClientExit.value;
          return {
            serviceAccount: request.serviceAccount,
            oauthClientId: oauthClient.oauthClientId,
            serviceAccountUid: serviceAccount.uid,
            createdServiceAccount: serviceAccount.created,
            createdOAuthClient: oauthClient.created,
          };
        }),
      provisionProjectedWorkload: ({ request, identity, projection }) =>
        projectedWorkloads.ensureProjection({ request, identity, projection }),
      deleteRoleIdentity: (input) =>
        Effect.gen(function* () {
          const request = Schema.decodeUnknownSync(PreviewWorkloadCredentialRequestSchema)({
            sessionId: input.sessionId,
            generation: input.generation,
            role: input.role,
            kind: "projected",
            credentialName: workloadCredentialNameFor(input.role),
            audience: "preview-cleanup-only",
            serviceAccount: input.serviceAccount,
            expirationSeconds: previewWorkloadCredentialRequestedLifetimeSeconds,
          });
          const createdResources = input.createdResources;
          if (!createdResources || createdResources.projectedWorkload) {
            yield* projectedWorkloads.removeProjection({
              sessionId: input.sessionId,
              generation: input.generation,
              role: input.role,
              serviceAccount: input.serviceAccount,
            });
          }
          if (!createdResources || createdResources.serviceAccount) {
            yield* serviceAccounts
              .deleteOwned(request, createdResources?.serviceAccountUid)
              .pipe(
                Effect.mapError(
                  () =>
                    new PreviewWorkloadCredentialError({ reason: "service-account-delete-failed" }),
                ),
              );
          }
          if (!createdResources || createdResources.oauthClient) {
            yield* oauthClients.remove({ request, oauthClientId: input.oauthClientId });
          }
        }),
    } satisfies KubernetesWorkloadIdentityProvisionerApi;
  }),
);

export const KubernetesWorkloadIdentityProvisionerUnavailable = Layer.effect(
  KubernetesWorkloadIdentityProvisioner,
  Effect.fail(new PreviewWorkloadCredentialError({ reason: "identity-provisioner-unavailable" })),
);

const projectedVolumeFor = (
  request: PreviewWorkloadCredentialRequest,
): NonNullable<PreviewWorkloadCredentialGrant["projectedVolume"]> => {
  const mountPath = `/var/run/tiara-preview/${request.sessionId}/${request.role}`;
  return {
    name: `preview-${request.sessionId.slice(0, 8)}-${request.role}`,
    audience: request.audience,
    expirationSeconds: request.expirationSeconds,
    mountPath,
    tokenPath: "token",
  };
};

export const KubernetesWorkloadIdentityProvisionerConfigured = (options: {
  readonly apiServerUrl: string;
  readonly controllerToken: Redacted.Redacted<string>;
  readonly allowInsecureLoopbackForTests?: boolean;
  readonly sheetAuthClient: SheetAuthClient;
  readonly oauthAdminHeaders: Readonly<Record<string, string>>;
  readonly projectedWorkloadClient: KubernetesProjectedWorkloadClientApi;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
}) => {
  const httpLayer = options.httpClientLayer ?? NodeHttpClient.layerNodeHttp;
  const identityApiLayers = Layer.mergeAll(
    KubernetesServiceAccountClientLive({
      apiServerUrl: options.apiServerUrl,
      controllerToken: options.controllerToken,
      ...(options.allowInsecureLoopbackForTests === undefined
        ? {}
        : { allowInsecureLoopbackForTests: options.allowInsecureLoopbackForTests }),
    }),
    SheetAuthOAuthClientProvisionerLive(options.sheetAuthClient, options.oauthAdminHeaders),
    Layer.succeed(KubernetesProjectedWorkloadClient, options.projectedWorkloadClient),
  ).pipe(Layer.provideMerge(httpLayer));
  const provisioner = KubernetesWorkloadIdentityProvisionerLive.pipe(
    Layer.provideMerge(identityApiLayers),
  );
  const providerWithTokenRequest = KubernetesPreviewWorkloadCredentialProviderLive.pipe(
    Layer.provideMerge(
      Layer.merge(
        KubernetesTokenRequestClientLive({
          apiServerUrl: options.apiServerUrl,
          controllerToken: options.controllerToken,
          ...(options.allowInsecureLoopbackForTests === undefined
            ? {}
            : { allowInsecureLoopbackForTests: options.allowInsecureLoopbackForTests }),
        }),
        provisioner,
      ),
    ),
  );
  return providerWithTokenRequest.pipe(Layer.provide(httpLayer));
};

export const KubernetesPreviewWorkloadCredentialProviderLive = Layer.effect(
  PreviewWorkloadCredentialProvider,
  Effect.gen(function* () {
    const tokenRequests = yield* KubernetesTokenRequestClient;
    const identities = yield* KubernetesWorkloadIdentityProvisioner;
    return {
      createRoleIdentity: identities.ensureRoleIdentity,
      requestHostToken: (request) =>
        tokenRequests
          .request(request)
          .pipe(
            Effect.mapError(
              (error) => new PreviewWorkloadCredentialError({ reason: error.reason }),
            ),
          ),
      requestProjectedToken: (request, identity, projection) => {
        return identities.provisionProjectedWorkload({ request, identity, projection });
      },
      deleteRoleIdentity: identities.deleteRoleIdentity,
    } satisfies PreviewWorkloadCredentialProviderApi;
  }),
);

const credentialDirectoryFor = (root: string, request: PreviewWorkloadCredentialRequest) => {
  const directory = path.resolve(root, request.sessionId, String(request.generation), request.role);
  const relative = path.relative(path.resolve(root), directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PreviewWorkloadCredentialError({ reason: "credential-path-outside-owner-root" });
  }
  return directory;
};

const validateProviderIdentity = (
  request: PreviewWorkloadCredentialRequest,
  identity: { readonly serviceAccount: string; readonly oauthClientId: string },
) => {
  if (identity.serviceAccount !== request.serviceAccount || identity.oauthClientId.length === 0) {
    return Effect.fail(
      new PreviewWorkloadCredentialError({ reason: "provider-identity-scope-mismatch" }),
    );
  }
  return Effect.succeed(identity);
};

/** Host TokenRequest files and projected Kubernetes tokens share the provider's exact role identity. */
export const PreviewWorkloadCredentialIssuerLive = (credentialRoot: string) =>
  Layer.effect(
    PreviewWorkloadCredentialIssuer,
    Effect.gen(function* () {
      const provider = yield* PreviewWorkloadCredentialProvider;
      const fileSystem = yield* FileSystem.FileSystem;

      const issue = (request: PreviewWorkloadCredentialRequest) =>
        Effect.gen(function* () {
          yield* mapCredentialFileError(
            fileSystem.makeDirectory(credentialRoot, { recursive: true, mode: 0o700 }),
          );
          yield* mapCredentialFileError(fileSystem.chmod(credentialRoot, 0o700));
          const identity = yield* provider.createRoleIdentity(request);
          const grantIdentity = {
            serviceAccount: identity.serviceAccount,
            oauthClientId: identity.oauthClientId,
          };
          let credentialFileCreated = false;
          const createdResources = {
            serviceAccount: identity.createdServiceAccount,
            serviceAccountUid: identity.serviceAccountUid,
            oauthClient: identity.createdOAuthClient,
            projectedWorkload: false,
          };
          const issueGrant = Effect.gen(function* () {
            yield* validateProviderIdentity(request, identity);
            if (request.kind === "host-token-request") {
              const token = yield* provider.requestHostToken(request);
              const directory = credentialDirectoryFor(credentialRoot, request);
              const credentialFile = path.join(directory, `${request.credentialName}.token`);
              yield* mapCredentialFileError(
                fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }),
              );
              yield* mapCredentialFileError(fileSystem.chmod(directory, 0o700));
              yield* mapCredentialFileError(
                Effect.scoped(
                  Effect.gen(function* () {
                    const file = yield* fileSystem.open(credentialFile, {
                      flag: "wx",
                      mode: 0o600,
                    });
                    credentialFileCreated = true;
                    yield* file.writeAll(new TextEncoder().encode(token.token));
                    yield* file.sync;
                  }),
                ),
              );
              yield* mapCredentialFileError(fileSystem.chmod(credentialFile, 0o600));
              return {
                ...request,
                ...grantIdentity,
                credentialFile,
                issuedAt: token.issuedAt,
                expiresAt: token.expiresAt,
              } satisfies PreviewWorkloadCredentialGrant;
            }

            const projectedVolume = projectedVolumeFor(request);
            const grant = yield* provider.requestProjectedToken(request, identity, projectedVolume);
            createdResources.projectedWorkload = grant.created;
            return {
              ...request,
              ...grantIdentity,
              credentialFile: path.posix.join(projectedVolume.mountPath, projectedVolume.tokenPath),
              projectedVolume,
              issuedAt: grant.issuedAt,
              expiresAt: grant.expiresAt,
            } satisfies PreviewWorkloadCredentialGrant;
          });
          const cleanupPartialIssue = Effect.gen(function* () {
            if (request.kind === "host-token-request" && credentialFileCreated) {
              const credentialFile = path.join(
                credentialDirectoryFor(credentialRoot, request),
                `${request.credentialName}.token`,
              );
              yield* fileSystem.remove(credentialFile);
            }
            yield* provider.deleteRoleIdentity({
              sessionId: request.sessionId,
              generation: request.generation,
              role: request.role,
              serviceAccount: identity.serviceAccount,
              oauthClientId: identity.oauthClientId,
              createdResources,
            });
          }).pipe(
            Effect.mapError(
              () =>
                new PreviewWorkloadCredentialError({ reason: "partial-credential-cleanup-failed" }),
            ),
          );
          return yield* issueGrant.pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) ? cleanupPartialIssue : Effect.void)),
          );
        });

      const renew = (
        request: PreviewWorkloadCredentialRequest,
        previous: PreviewWorkloadCredentialGrant,
      ) =>
        Effect.gen(function* () {
          const identity = yield* provider.createRoleIdentity(request);
          const createdResources = {
            serviceAccount: identity.createdServiceAccount,
            serviceAccountUid: identity.serviceAccountUid,
            oauthClient: identity.createdOAuthClient,
            projectedWorkload: false,
          };
          let temporaryCredentialFile: string | undefined;
          let temporaryFileCreated = false;
          const renewGrant = Effect.gen(function* () {
            yield* validateProviderIdentity(request, identity);
            if (identity.oauthClientId !== previous.oauthClientId) {
              return yield* Effect.fail(
                new PreviewWorkloadCredentialError({ reason: "renewal-client-identity-changed" }),
              );
            }
            if (request.kind === "host-token-request") {
              const expectedFile = path.join(
                credentialDirectoryFor(credentialRoot, request),
                `${request.credentialName}.token`,
              );
              if (path.resolve(previous.credentialFile) !== expectedFile) {
                return yield* Effect.fail(
                  new PreviewWorkloadCredentialError({ reason: "renewal-file-ownership-mismatch" }),
                );
              }
              const token = yield* provider.requestHostToken(request);
              const temporaryFile = `${previous.credentialFile}.${randomUUID()}.tmp`;
              temporaryCredentialFile = temporaryFile;
              const directory = path.dirname(previous.credentialFile);
              yield* mapCredentialFileError(
                fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }),
              );
              yield* mapCredentialFileError(
                Effect.scoped(
                  Effect.gen(function* () {
                    const file = yield* fileSystem.open(temporaryFile, {
                      flag: "wx",
                      mode: 0o600,
                    });
                    temporaryFileCreated = true;
                    yield* file.writeAll(new TextEncoder().encode(token.token));
                    yield* file.sync;
                  }),
                ),
              );
              yield* mapCredentialFileError(fileSystem.chmod(temporaryFile, 0o600));
              yield* mapCredentialFileError(
                fileSystem.rename(temporaryFile, previous.credentialFile),
              );
              temporaryFileCreated = false;
              return {
                ...request,
                serviceAccount: identity.serviceAccount,
                oauthClientId: identity.oauthClientId,
                credentialFile: previous.credentialFile,
                issuedAt: token.issuedAt,
                expiresAt: token.expiresAt,
              } satisfies PreviewWorkloadCredentialGrant;
            }
            const grant = yield* provider.requestProjectedToken(
              request,
              identity,
              projectedVolumeFor(request),
            );
            createdResources.projectedWorkload = grant.created;
            return { ...previous, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt };
          });
          const result = yield* Effect.exit(renewGrant);
          if (Exit.isFailure(result)) {
            if (temporaryFileCreated && temporaryCredentialFile !== undefined) {
              yield* Effect.exit(
                mapCredentialFileError(fileSystem.remove(temporaryCredentialFile)),
              );
            }
            yield* Effect.exit(
              provider.deleteRoleIdentity({
                sessionId: request.sessionId,
                generation: request.generation,
                role: request.role,
                serviceAccount: identity.serviceAccount,
                oauthClientId: identity.oauthClientId,
                createdResources,
              }),
            );
            return yield* Effect.failCause(result.cause);
          }
          return result.value;
        });

      return {
        issue,
        renew,
        remove: (grant: PreviewWorkloadCredentialGrant) =>
          Effect.gen(function* () {
            if (grant.kind === "host-token-request") {
              const request = Schema.decodeUnknownSync(PreviewWorkloadCredentialRequestSchema)({
                sessionId: grant.sessionId,
                generation: grant.generation,
                role: grant.role,
                kind: grant.kind,
                credentialName: grant.credentialName,
                audience: grant.audience,
                serviceAccount: grant.serviceAccount,
                expirationSeconds: previewWorkloadCredentialRequestedLifetimeSeconds,
              });
              const expectedFile = path.join(
                credentialDirectoryFor(credentialRoot, request),
                `${request.credentialName}.token`,
              );
              if (path.resolve(grant.credentialFile) !== expectedFile) {
                return yield* Effect.fail(
                  new PreviewWorkloadCredentialError({ reason: "remove-file-ownership-mismatch" }),
                );
              }
              if (yield* mapCredentialFileError(fileSystem.exists(expectedFile))) {
                yield* mapCredentialFileError(fileSystem.remove(expectedFile));
              }
            }
            yield* provider.deleteRoleIdentity({
              sessionId: grant.sessionId,
              generation: grant.generation,
              role: grant.role,
              serviceAccount: grant.serviceAccount,
              oauthClientId: grant.oauthClientId,
            });
          }),
      } satisfies PreviewWorkloadCredentialIssuerApi;
    }),
  );

export const previewWorkloadCredentialRenewalAt = (grant: PreviewWorkloadCredentialGrant) =>
  grant.issuedAt + Math.floor((grant.expiresAt - grant.issuedAt) / 2);

export const kubernetesProjectedTokenMountFor = (grant: PreviewWorkloadCredentialGrant) => {
  if (grant.kind !== "projected" || !grant.projectedVolume) {
    throw new PreviewWorkloadCredentialError({ reason: "projected-token-grant-required" });
  }
  const [namespace, serviceAccountName, extra] = grant.serviceAccount.split("/");
  if (!namespace || !serviceAccountName || extra !== undefined) {
    throw new PreviewWorkloadCredentialError({ reason: "invalid-service-account-name" });
  }
  const projection = grant.projectedVolume;
  return {
    namespace,
    serviceAccountName,
    volume: {
      name: projection.name,
      projected: {
        sources: [
          {
            serviceAccountToken: {
              audience: projection.audience,
              expirationSeconds: projection.expirationSeconds,
              path: projection.tokenPath,
            },
          },
        ],
      },
    },
    mount: {
      name: projection.name,
      mountPath: projection.mountPath,
      readOnly: true,
    },
  } as const;
};

export const validatePreviewWorkloadCredentialGrant = (
  request: PreviewWorkloadCredentialRequest,
  grant: PreviewWorkloadCredentialGrant,
  now: number,
) => {
  if (
    grant.sessionId !== request.sessionId ||
    grant.generation !== request.generation ||
    grant.role !== request.role ||
    grant.kind !== request.kind ||
    grant.credentialName !== request.credentialName ||
    grant.audience !== request.audience ||
    grant.serviceAccount !== request.serviceAccount
  ) {
    return Effect.fail(new PreviewWorkloadCredentialError({ reason: "grant-scope-mismatch" }));
  }
  if (
    grant.expiresAt <= now ||
    grant.expiresAt <= grant.issuedAt ||
    grant.expiresAt - grant.issuedAt > previewWorkloadCredentialRequestedLifetimeMs
  ) {
    return Effect.fail(new PreviewWorkloadCredentialError({ reason: "invalid-grant-lifetime" }));
  }
  return Effect.succeed(grant);
};

const credentialGrantMatchesRequest = (
  request: PreviewWorkloadCredentialRequest,
  grant: PreviewWorkloadCredentialGrant,
) =>
  grant.sessionId === request.sessionId &&
  grant.generation === request.generation &&
  grant.role === request.role &&
  grant.kind === request.kind &&
  grant.credentialName === request.credentialName &&
  grant.audience === request.audience &&
  grant.serviceAccount === request.serviceAccount;

const cleanupUnregisteredCredential = (
  sessions: PreviewSessionControllerApi,
  issuer: PreviewWorkloadCredentialIssuerApi,
  request: PreviewWorkloadCredentialRequest,
  grant: PreviewWorkloadCredentialGrant,
) =>
  Effect.gen(function* () {
    if (!credentialGrantMatchesRequest(request, grant)) return;
    const registered = yield* Effect.exit(
      sessions.isCredentialIdentityRegistered(request.sessionId, request.generation, request.role),
    );
    if (Exit.isFailure(registered) || registered.value) return;
    const cleanup = yield* Effect.exit(issuer.remove(grant));
    if (Exit.isFailure(cleanup))
      return yield* Effect.fail(
        new PreviewWorkloadCredentialError({ reason: "partial-credential-cleanup-failed" }),
      );
  });

export const issuePreviewWorkloadCredential = (
  request: PreviewWorkloadCredentialRequest,
  now: () => number,
) =>
  Effect.gen(function* () {
    const sessions = yield* PreviewSessionController;
    const issuer = yield* PreviewWorkloadCredentialIssuer;
    const reservation = yield* sessions.authorizeCredentialIssue(
      request.sessionId,
      request.generation,
      request.role,
    );
    return yield* Effect.gen(function* () {
      const grant = yield* issuer.issue(request);
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          const validated = yield* validatePreviewWorkloadCredentialGrant(request, grant, now());
          yield* sessions.registerCredentialIdentity({
            id: request.sessionId,
            generation: request.generation,
            role: request.role,
            reservationId: reservation.reservationId,
            credentialName: request.credentialName,
            serviceAccount: request.serviceAccount,
            oauthClientId: grant.oauthClientId,
            credentialFile: grant.credentialFile,
          });
          return validated;
        }),
      );
      if (Exit.isFailure(result)) {
        yield* cleanupUnregisteredCredential(sessions, issuer, request, grant);
        return yield* Effect.failCause(result.cause);
      }
      return result.value;
    }).pipe(
      Effect.onExit(() =>
        sessions.releaseCredentialIssue({
          id: request.sessionId,
          generation: request.generation,
          role: request.role,
          reservationId: reservation.reservationId,
        }),
      ),
    );
  });

export const renewPreviewWorkloadCredential = (
  request: PreviewWorkloadCredentialRequest,
  previous: PreviewWorkloadCredentialGrant,
  now: () => number,
) =>
  Effect.gen(function* () {
    const sessions = yield* PreviewSessionController;
    const issuer = yield* PreviewWorkloadCredentialIssuer;
    const currentTime = now();
    yield* sessions.authorizeCredential(request.sessionId, request.generation, request.role);
    yield* validatePreviewWorkloadCredentialGrant(request, previous, currentTime);
    if (currentTime < previewWorkloadCredentialRenewalAt(previous)) {
      return yield* Effect.fail(new PreviewWorkloadCredentialError({ reason: "renewal-not-due" }));
    }
    const next = yield* issuer.renew(request, previous);
    yield* validatePreviewWorkloadCredentialGrant(request, next, now());
    if (
      next.credentialFile !== previous.credentialFile ||
      next.oauthClientId !== previous.oauthClientId
    ) {
      return yield* Effect.fail(
        new PreviewWorkloadCredentialError({ reason: "renewal-identity-ownership-mismatch" }),
      );
    }
    return next;
  });

export const removePreviewWorkloadCredential = (grant: PreviewWorkloadCredentialGrant) =>
  Effect.gen(function* () {
    const sessions = yield* PreviewSessionController;
    const issuer = yield* PreviewWorkloadCredentialIssuer;
    const identity = {
      id: grant.sessionId,
      generation: grant.generation,
      role: grant.role,
      oauthClientId: grant.oauthClientId,
      serviceAccount: grant.serviceAccount,
    };
    yield* sessions.authorizeCredentialRemoval(identity);
    yield* issuer.remove(grant);
    yield* sessions.removeCredentialIdentity(identity);
  });

export const makePreviewWorkloadCredentialRequest = (input: {
  readonly sessionId: string;
  readonly generation: number;
  readonly role: ConnectedPreviewRole;
  readonly kind: PreviewWorkloadCredentialKind;
  readonly credentialName: string;
  readonly audience: string;
  readonly serviceAccount: string;
}): PreviewWorkloadCredentialRequest => {
  if (!isConnectedPreviewCredentialAllowed(input.role, input.credentialName)) {
    throw new PreviewWorkloadCredentialError({ reason: "credential-not-allowed-for-role" });
  }
  if (input.credentialName !== workloadCredentialNameFor(input.role)) {
    throw new PreviewWorkloadCredentialError({ reason: "role-workload-identity-name-mismatch" });
  }
  return Schema.decodeUnknownSync(PreviewWorkloadCredentialRequestSchema)({
    ...input,
    expirationSeconds: previewWorkloadCredentialRequestedLifetimeSeconds,
  });
};

/** Profiles stay unavailable until an operator supplies and verifies this issuer adapter. */
export const PreviewWorkloadCredentialIssuerUnavailable = Layer.effect(
  PreviewWorkloadCredentialIssuer,
  Effect.fail(new PreviewWorkloadCredentialError({ reason: "issuer-adapter-unavailable" })),
);
