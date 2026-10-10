import { describe, expect, it } from "@effect/vitest";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import {
  issuePreviewWorkloadCredential,
  kubernetesProjectedTokenMountFor,
  makePreviewWorkloadCredentialRequest,
  previewWorkloadCredentialRenewalAt,
  previewWorkloadCredentialRequestedLifetimeSeconds,
  PreviewWorkloadCredentialIssuer,
  PreviewWorkloadCredentialIssuerLive,
  PreviewWorkloadCredentialError,
  PreviewWorkloadCredentialProvider,
  PreviewOAuthClientProvisioner,
  KubernetesProjectedWorkloadClient,
  KubernetesWorkloadIdentityProvisioner,
  KubernetesWorkloadIdentityProvisionerLive,
  SheetAuthOAuthClientProvisionerLive,
  type PreviewWorkloadCredentialProviderApi,
  renewPreviewWorkloadCredential,
  validatePreviewWorkloadCredentialGrant,
  type PreviewWorkloadCredentialGrant,
} from "./preview-workload-credentials";
import {
  PreviewSessionController,
  PreviewSessionError,
  type PreviewSession,
  type PreviewSessionControllerApi,
} from "./preview-sessions";
import {
  KubernetesServiceAccountClient,
  KubernetesServiceAccountClientError,
} from "./kubernetes-token-request";
import type { OAuthClientDetails, SheetAuthClient } from "sheet-auth/client";

const request = makePreviewWorkloadCredentialRequest({
  sessionId: "session-a",
  generation: 3,
  role: "sheet-workflows-runner",
  kind: "projected",
  credentialName: "workload-identity",
  audience: "sheet-auth-subject-token",
  serviceAccount: "tiara-stack-dev/preview-session-a-runner",
});

const grant: PreviewWorkloadCredentialGrant = {
  ...request,
  oauthClientId: "preview-client",
  credentialFile: "/private/session-a/runner/token",
  issuedAt: 10_000,
  expiresAt: 610_000,
};
const hostRequest = makePreviewWorkloadCredentialRequest({
  ...request,
  kind: "host-token-request",
});

describe("preview workload credentials", () => {
  it("requests ten minutes and schedules renewal halfway through the actual grant", () => {
    expect(request.expirationSeconds).toBe(previewWorkloadCredentialRequestedLifetimeSeconds);
    expect(previewWorkloadCredentialRenewalAt(grant)).toBe(310_000);

    const shorterGrant = { ...grant, expiresAt: 250_000 };
    expect(previewWorkloadCredentialRenewalAt(shorterGrant)).toBe(130_000);
  });

  it.each([
    ["sessionId", "session-b"],
    ["generation", 4],
    ["role", "sheet-bot"],
    ["credentialName", "google-service-account"],
    ["audience", "wrong-audience"],
    ["serviceAccount", "tiara-stack-dev/other"],
  ] as const)("rejects a grant with mismatched %s", (field, value) => {
    const invalid = { ...grant, [field]: value } as PreviewWorkloadCredentialGrant;
    expect(
      Effect.runSyncExit(validatePreviewWorkloadCredentialGrant(request, invalid, 10_100))._tag,
    ).toBe("Failure");
  });

  it("rejects expired grants", () => {
    expect(
      Effect.runSyncExit(validatePreviewWorkloadCredentialGrant(request, grant, grant.expiresAt))
        ._tag,
    ).toBe("Failure");
  });

  it("accepts an API-server-issued start time ahead of the local clock", () => {
    const clockSkewedGrant = { ...grant, issuedAt: 20_000, expiresAt: 620_000 };
    expect(
      Effect.runSyncExit(validatePreviewWorkloadCredentialGrant(request, clockSkewedGrant, 10_000))
        ._tag,
    ).toBe("Success");
  });

  it("rejects a grant longer than the requested ten minutes", () => {
    const overlong = { ...grant, expiresAt: grant.issuedAt + 600_001 };
    expect(
      Effect.runSyncExit(validatePreviewWorkloadCredentialGrant(request, overlong, 10_100))._tag,
    ).toBe("Failure");
  });

  it.live("removes a newly provisioned identity when host token issuance fails", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), "preview-credential-rollback-"))),
        (directory) =>
          Effect.tryPromise(() => rm(directory, { recursive: true, force: true })).pipe(
            Effect.orDie,
          ),
      );
      let deletions = 0;
      const providerApi: PreviewWorkloadCredentialProviderApi = {
        createRoleIdentity: (input) =>
          Effect.succeed({
            serviceAccount: input.serviceAccount,
            oauthClientId: "fresh-preview-client",
            serviceAccountUid: "service-account-uid",
            createdServiceAccount: true,
            createdOAuthClient: true,
          }),
        requestHostToken: () =>
          Effect.fail(new PreviewWorkloadCredentialError({ reason: "token-request-failed" })),
        requestProjectedToken: () => Effect.die("unused"),
        deleteRoleIdentity: (input) => {
          deletions += 1;
          expect(input.sessionId).toBe(hostRequest.sessionId);
          expect(input.oauthClientId).toBe("fresh-preview-client");
          expect(input.createdResources).toEqual({
            serviceAccount: true,
            serviceAccountUid: "service-account-uid",
            oauthClient: true,
            projectedWorkload: false,
          });
          return Effect.void;
        },
      };
      const provider = Layer.succeed(PreviewWorkloadCredentialProvider, providerApi);
      const issuerLayer = PreviewWorkloadCredentialIssuerLive(root).pipe(
        Layer.provideMerge(Layer.mergeAll(provider, NodeServices.layer)),
      );
      const issuer = yield* PreviewWorkloadCredentialIssuer.pipe(Effect.provide(issuerLayer));
      const result = yield* Effect.exit(issuer.issue(hostRequest));
      expect(result._tag).toBe("Failure");
      expect(deletions).toBe(1);
      expect(
        yield* Effect.tryPromise(() =>
          access(
            path.join(
              root,
              hostRequest.sessionId,
              String(hostRequest.generation),
              hostRequest.role,
              `${hostRequest.credentialName}.token`,
            ),
          ),
        ).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("preserves an existing credential file when exclusive creation fails", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), "preview-credential-existing-"))),
        (directory) =>
          Effect.tryPromise(() => rm(directory, { recursive: true, force: true })).pipe(
            Effect.orDie,
          ),
      );
      const credentialFile = path.join(
        root,
        hostRequest.sessionId,
        String(hostRequest.generation),
        hostRequest.role,
        `${hostRequest.credentialName}.token`,
      );
      yield* Effect.tryPromise(() => mkdir(path.dirname(credentialFile), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(credentialFile, "previous-owner-token", { mode: 0o600 }),
      );
      let cleanupResources: unknown;
      const providerApi: PreviewWorkloadCredentialProviderApi = {
        createRoleIdentity: (input) =>
          Effect.succeed({
            serviceAccount: input.serviceAccount,
            oauthClientId: "existing-preview-client",
            serviceAccountUid: "existing-service-account-uid",
            createdServiceAccount: false,
            createdOAuthClient: false,
          }),
        requestHostToken: () =>
          Effect.succeed({
            token: "new-host-token",
            issuedAt: 10_000,
            expiresAt: 610_000,
          }),
        requestProjectedToken: () => Effect.die("unused"),
        deleteRoleIdentity: (input) => {
          cleanupResources = input.createdResources;
          return Effect.void;
        },
      };
      const layer = PreviewWorkloadCredentialIssuerLive(root).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(PreviewWorkloadCredentialProvider, providerApi),
            NodeServices.layer,
          ),
        ),
      );
      const issuer = yield* PreviewWorkloadCredentialIssuer.pipe(Effect.provide(layer));
      const result = yield* Effect.exit(issuer.issue(hostRequest));
      expect(result._tag).toBe("Failure");
      expect(yield* Effect.tryPromise(() => readFile(credentialFile, "utf8"))).toBe(
        "previous-owner-token",
      );
      expect(cleanupResources).toEqual({
        serviceAccount: false,
        serviceAccountUid: "existing-service-account-uid",
        oauthClient: false,
        projectedWorkload: false,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("removes identity resources created by a renewal with a changed client ID", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), "preview-credential-renewal-"))),
        (directory) =>
          Effect.tryPromise(() => rm(directory, { recursive: true, force: true })).pipe(
            Effect.orDie,
          ),
      );
      let cleanupResources: unknown;
      const providerApi: PreviewWorkloadCredentialProviderApi = {
        createRoleIdentity: (input) =>
          Effect.succeed({
            serviceAccount: input.serviceAccount,
            oauthClientId: "rotated-preview-client",
            serviceAccountUid: "existing-service-account-uid",
            createdServiceAccount: false,
            createdOAuthClient: true,
          }),
        requestHostToken: () => Effect.die("unused"),
        requestProjectedToken: () => Effect.die("changed identity must fail before token request"),
        deleteRoleIdentity: (input) => {
          cleanupResources = input.createdResources;
          return Effect.void;
        },
      };
      const layer = PreviewWorkloadCredentialIssuerLive(root).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(PreviewWorkloadCredentialProvider, providerApi),
            NodeServices.layer,
          ),
        ),
      );
      const issuer = yield* PreviewWorkloadCredentialIssuer.pipe(Effect.provide(layer));
      const result = yield* Effect.exit(issuer.renew(request, grant));
      expect(result._tag).toBe("Failure");
      expect(cleanupResources).toEqual({
        serviceAccount: false,
        serviceAccountUid: "existing-service-account-uid",
        oauthClient: true,
        projectedWorkload: false,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("rejects credential names outside the role allowlist", () => {
    expect(() =>
      makePreviewWorkloadCredentialRequest({
        sessionId: "session-a",
        generation: 3,
        role: "sheet-workflows-browser-runner",
        kind: "projected",
        credentialName: "google-service-account",
        audience: "sheet-auth-subject-token",
        serviceAccount: "tiara-stack-dev/preview-session-a-browser-runner",
      }),
    ).toThrow();
  });

  it.effect("issues and renews only the owned credential file", () =>
    Effect.gen(function* () {
      let value = 10_000;
      let renewedFrom: PreviewWorkloadCredentialGrant | undefined;
      let registeredClient: string | undefined;
      let issuedGrant = grant;
      let removedGrants = 0;
      let failRegistration = false;
      const issuer = Layer.succeed(PreviewWorkloadCredentialIssuer, {
        issue: () => Effect.succeed(issuedGrant),
        renew: (_request, previous) => {
          renewedFrom = previous;
          return Effect.succeed({ ...previous, issuedAt: value, expiresAt: value + 240_000 });
        },
        remove: () => {
          removedGrants += 1;
          return Effect.void;
        },
      });
      const controllerApi: PreviewSessionControllerApi = {
        watchFences: () => Effect.void,
        create: () => Effect.die("unused"),
        status: () => Effect.die("unused"),
        heartbeat: () => Effect.die("unused"),
        resume: () => Effect.die("unused"),
        requestRevision: () => Effect.die("unused"),
        activate: () => Effect.die("unused"),
        stop: () => Effect.die("unused"),
        stopSupervised: () => Effect.die("unused"),
        admit: () => Effect.die("unused"),
        settle: () => Effect.die("unused"),
        authorizeCredential: () => Effect.succeed(authorizedSession),
        authorizeCredentialIssue: () =>
          Effect.succeed({ session: authorizedSession, reservationId: "issue-reservation-a" }),
        releaseCredentialIssue: () => Effect.void,
        authorizeWorkload: () => Effect.die("unused"),
        isPreviewOAuthClient: () => Effect.die("unused"),
        admitWorkload: () => Effect.die("unused"),
        settleWorkload: () => Effect.die("unused"),
        authorizeCredentialRemoval: () => Effect.die("unused"),
        removeCredentialIdentity: () => Effect.die("unused"),
        isCredentialIdentityRegistered: () => Effect.succeed(false),
        registerCredentialIdentity: (input) => {
          if (failRegistration)
            return Effect.fail(new PreviewSessionError({ reason: "registry-unavailable" }));
          registeredClient = input.oauthClientId;
          return Effect.void;
        },
      };
      const controller = Layer.succeed(PreviewSessionController, controllerApi);
      const dependencies = Layer.mergeAll(issuer, controller);
      const created = yield* issuePreviewWorkloadCredential(request, () => value).pipe(
        Effect.provide(dependencies),
      );
      value = previewWorkloadCredentialRenewalAt(created);
      const renewed = yield* renewPreviewWorkloadCredential(request, created, () => value).pipe(
        Effect.provide(dependencies),
      );
      expect(renewedFrom).toBe(created);
      expect(renewed.credentialFile).toBe(created.credentialFile);
      expect(registeredClient).toBe("preview-client");
      expect(renewed.expiresAt - renewed.issuedAt).toBe(240_000);

      issuedGrant = { ...grant, expiresAt: grant.issuedAt + 600_001 };
      const validationFailure = yield* Effect.exit(
        issuePreviewWorkloadCredential(request, () => value).pipe(Effect.provide(dependencies)),
      );
      expect(validationFailure._tag).toBe("Failure");
      expect(removedGrants).toBe(1);

      issuedGrant = grant;
      failRegistration = true;
      const registrationFailure = yield* Effect.exit(
        issuePreviewWorkloadCredential(request, () => value).pipe(Effect.provide(dependencies)),
      );
      expect(registrationFailure._tag).toBe("Failure");
      expect(removedGrants).toBe(2);
    }),
  );

  it.live(
    "writes host TokenRequest tokens with owner-only permissions and builds projected-token specs",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), "preview-credentials-"))),
          (directory) =>
            Effect.tryPromise(() => rm(directory, { recursive: true, force: true })).pipe(
              Effect.orDie,
            ),
        );
        let now = 20_000;
        let tokenVersion = 0;
        const providerApi: PreviewWorkloadCredentialProviderApi = {
          createRoleIdentity: (input) =>
            Effect.succeed({
              serviceAccount: input.serviceAccount,
              oauthClientId: `client-${input.sessionId}-${input.role}`,
              serviceAccountUid: "service-account-uid",
              createdServiceAccount: true,
              createdOAuthClient: true,
            }),
          requestHostToken: () => {
            tokenVersion += 1;
            return Effect.succeed({
              token: `host-token-${tokenVersion}`,
              issuedAt: now,
              expiresAt: now + 600_000,
            });
          },
          requestProjectedToken: () =>
            Effect.succeed({ issuedAt: now, expiresAt: now + 600_000, created: true }),
          deleteRoleIdentity: () => Effect.void,
        };
        const provider = Layer.succeed(PreviewWorkloadCredentialProvider, providerApi);
        const issuerLayer = PreviewWorkloadCredentialIssuerLive(root).pipe(
          Layer.provideMerge(Layer.mergeAll(provider, NodeServices.layer)),
        );
        const issuer = yield* PreviewWorkloadCredentialIssuer.pipe(Effect.provide(issuerLayer));
        const host = yield* issuer.issue(hostRequest);
        expect(yield* Effect.tryPromise(() => readFile(host.credentialFile, "utf8"))).toBe(
          "host-token-1",
        );
        expect((yield* Effect.tryPromise(() => stat(host.credentialFile))).mode & 0o777).toBe(
          0o600,
        );
        now = previewWorkloadCredentialRenewalAt(host);
        const renewedHost = yield* issuer.renew(hostRequest, host);
        expect(yield* Effect.tryPromise(() => readFile(host.credentialFile, "utf8"))).toBe(
          "host-token-2",
        );
        expect(renewedHost.credentialFile).toBe(host.credentialFile);

        const projectedRequest = makePreviewWorkloadCredentialRequest({
          sessionId: "sess-k8s",
          generation: 2,
          role: "sheet-workflows-browser-runner",
          kind: "projected",
          credentialName: "workload-identity",
          audience: "sheet-auth-subject-token",
          serviceAccount: "tiara-stack-dev/session-k8s-browser",
        });
        const projected = yield* issuer.issue(projectedRequest);
        expect(projected.projectedVolume).toEqual({
          name: "preview-sess-k8s-sheet-workflows-browser-runner",
          audience: "sheet-auth-subject-token",
          expirationSeconds: 600,
          mountPath: "/var/run/tiara-preview/sess-k8s/sheet-workflows-browser-runner",
          tokenPath: "token",
        });
        expect(projected.credentialFile).toBe(
          "/var/run/tiara-preview/sess-k8s/sheet-workflows-browser-runner/token",
        );
        expect(kubernetesProjectedTokenMountFor(projected)).toEqual({
          namespace: "tiara-stack-dev",
          serviceAccountName: "session-k8s-browser",
          volume: {
            name: "preview-sess-k8s-sheet-workflows-browser-runner",
            projected: {
              sources: [
                {
                  serviceAccountToken: {
                    audience: "sheet-auth-subject-token",
                    expirationSeconds: 600,
                    path: "token",
                  },
                },
              ],
            },
          },
          mount: {
            name: "preview-sess-k8s-sheet-workflows-browser-runner",
            mountPath: "/var/run/tiara-preview/sess-k8s/sheet-workflows-browser-runner",
            readOnly: true,
          },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("creates, reuses, and deletes only the exact session-owned OAuth client", () =>
    Effect.gen(function* () {
      const clients: OAuthClientDetails[] = [];
      const calls: string[] = [];
      const client = {
        oauth2: {
          getClients: async () => ({ data: [...clients] }),
          createClient: async (input: {
            readonly client_name?: string;
            readonly scope?: string;
          }) => {
            calls.push("create");
            const detail: OAuthClientDetails = {
              client_id: "oauth-client-session-a",
              client_name: input.client_name,
              scope: input.scope,
            };
            clients.push(detail);
            return { data: detail };
          },
          deleteClient: async (input: { readonly client_id: string }) => {
            calls.push(`delete:${input.client_id}`);
            const index = clients.findIndex((candidate) => candidate.client_id === input.client_id);
            if (index >= 0) clients.splice(index, 1);
            return { data: null };
          },
        },
      } as unknown as SheetAuthClient;
      const headers = { Authorization: "Bearer operator-auth-client-token" };
      const provisioner = yield* PreviewOAuthClientProvisioner.pipe(
        Effect.provide(SheetAuthOAuthClientProvisionerLive(client, headers)),
      );
      const first = yield* provisioner.ensure(request);
      const second = yield* provisioner.ensure(request);
      expect(first).toEqual({ oauthClientId: "oauth-client-session-a", created: true });
      expect(second).toEqual({ oauthClientId: "oauth-client-session-a", created: false });
      expect(calls).toEqual(["create"]);
      yield* provisioner.remove({ request, oauthClientId: first.oauthClientId });
      expect(calls).toEqual(["create", "delete:oauth-client-session-a"]);
      expect(clients).toEqual([]);
    }),
  );

  it.effect(
    "provisions and removes the matching service account, OAuth client, and projected workload",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        let appliedProjection: unknown;
        const dependencies = Layer.mergeAll(
          Layer.succeed(KubernetesServiceAccountClient, {
            ensureOwned: () => {
              calls.push("ensure-service-account");
              return Effect.succeed({ uid: "service-account-uid", created: true });
            },
            deleteOwned: () => {
              calls.push("delete-service-account");
              return Effect.void;
            },
          }),
          Layer.succeed(PreviewOAuthClientProvisioner, {
            ensure: () => {
              calls.push("ensure-oauth-client");
              return Effect.succeed({ oauthClientId: "oauth-client-a", created: true });
            },
            remove: () => {
              calls.push("delete-oauth-client");
              return Effect.void;
            },
          }),
          Layer.succeed(KubernetesProjectedWorkloadClient, {
            ensureProjection: (input) => {
              calls.push("apply-projection");
              appliedProjection = input.projection;
              return Effect.succeed({ issuedAt: 10_000, expiresAt: 610_000, created: true });
            },
            removeProjection: () => {
              calls.push("delete-projection");
              return Effect.void;
            },
          }),
        );
        const provisionerLayer = KubernetesWorkloadIdentityProvisionerLive.pipe(
          Layer.provideMerge(dependencies),
        );
        const provisioner = yield* KubernetesWorkloadIdentityProvisioner.pipe(
          Effect.provide(provisionerLayer),
        );
        const identity = yield* provisioner.ensureRoleIdentity(request);
        const projection = {
          name: "preview-session-a-sheet-workflows-runner",
          audience: request.audience,
          expirationSeconds: 600 as const,
          mountPath: "/var/run/tiara-preview/session-a/sheet-workflows-runner",
          tokenPath: "token" as const,
        };
        yield* provisioner.provisionProjectedWorkload({ request, identity, projection });
        yield* provisioner.deleteRoleIdentity({
          sessionId: request.sessionId,
          generation: request.generation,
          role: request.role,
          serviceAccount: identity.serviceAccount,
          oauthClientId: identity.oauthClientId,
        });
        expect(appliedProjection).toEqual(projection);
        expect(calls).toEqual([
          "ensure-service-account",
          "ensure-oauth-client",
          "apply-projection",
          "delete-projection",
          "delete-service-account",
          "delete-oauth-client",
        ]);
      }),
  );

  it.effect("orders owner-checked service-account, OAuth-client, and projection operations", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const apiLayers = Layer.mergeAll(
        Layer.succeed(KubernetesServiceAccountClient, {
          ensureOwned: () => {
            events.push("ensure-service-account");
            return Effect.succeed({ uid: "service-account-uid", created: true });
          },
          deleteOwned: () => {
            events.push("delete-service-account");
            return Effect.void;
          },
        }),
        Layer.succeed(PreviewOAuthClientProvisioner, {
          ensure: () => {
            events.push("ensure-oauth-client");
            return Effect.succeed({ oauthClientId: "oauth-client-a", created: true });
          },
          remove: ({ oauthClientId }) => {
            events.push(`delete-oauth-client:${oauthClientId}`);
            return Effect.void;
          },
        }),
        Layer.succeed(KubernetesProjectedWorkloadClient, {
          ensureProjection: ({ request: issuedRequest, identity, projection }) => {
            events.push(
              `apply:${issuedRequest.sessionId}:${identity.oauthClientId}:${projection.audience}`,
            );
            return Effect.succeed({ issuedAt: 10_000, expiresAt: 610_000, created: true });
          },
          removeProjection: ({ sessionId, generation, role }) => {
            events.push(`remove-projection:${sessionId}:${generation}:${role}`);
            return Effect.void;
          },
        }),
      );
      const provisionerLayer = KubernetesWorkloadIdentityProvisionerLive.pipe(
        Layer.provideMerge(apiLayers),
      );
      const provisioner = yield* KubernetesWorkloadIdentityProvisioner.pipe(
        Effect.provide(provisionerLayer),
      );
      const identity = yield* provisioner.ensureRoleIdentity(request);
      const projection = {
        name: "preview-session-a-sheet-workflows-runner",
        audience: request.audience,
        expirationSeconds: 600 as const,
        mountPath: "/var/run/tiara-preview/session-a/sheet-workflows-runner",
        tokenPath: "token" as const,
      };
      yield* provisioner.provisionProjectedWorkload({ request, identity, projection });
      yield* provisioner.deleteRoleIdentity({
        sessionId: request.sessionId,
        generation: request.generation,
        role: request.role,
        serviceAccount: identity.serviceAccount,
        oauthClientId: identity.oauthClientId,
      });
      expect(events).toEqual([
        "ensure-service-account",
        "ensure-oauth-client",
        "apply:session-a:oauth-client-a:sheet-auth-subject-token",
        "remove-projection:session-a:3:sheet-workflows-runner",
        "delete-service-account",
        "delete-oauth-client:oauth-client-a",
      ]);
    }),
  );

  it.effect("reports failure when rolling back a new service account also fails", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const dependencies = Layer.mergeAll(
        Layer.succeed(KubernetesServiceAccountClient, {
          ensureOwned: () => Effect.succeed({ uid: "new-service-account-uid", created: true }),
          deleteOwned: (_input, expectedUid?: string) => {
            events.push(`delete-service-account:${expectedUid}`);
            return Effect.fail(
              new KubernetesServiceAccountClientError({ reason: "cleanup failed" }),
            );
          },
        }),
        Layer.succeed(PreviewOAuthClientProvisioner, {
          ensure: () => {
            events.push("ensure-oauth-client");
            return Effect.fail(
              new PreviewWorkloadCredentialError({ reason: "oauth-client-create-failed" }),
            );
          },
          remove: () => Effect.void,
        }),
        Layer.succeed(KubernetesProjectedWorkloadClient, {
          ensureProjection: () =>
            Effect.succeed({ issuedAt: 10_000, expiresAt: 610_000, created: true }),
          removeProjection: () => Effect.void,
        }),
      );
      const layer = KubernetesWorkloadIdentityProvisionerLive.pipe(
        Layer.provideMerge(dependencies),
      );
      const provisioner = yield* KubernetesWorkloadIdentityProvisioner.pipe(Effect.provide(layer));
      const error = yield* Effect.flip(provisioner.ensureRoleIdentity(request));
      expect(error.reason).toBe("partial-service-account-cleanup-failed");
      expect(events).toEqual([
        "ensure-oauth-client",
        "delete-service-account:new-service-account-uid",
      ]);
    }),
  );

  it.effect("preserves the OAuth error when new service account rollback succeeds", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const dependencies = Layer.mergeAll(
        Layer.succeed(KubernetesServiceAccountClient, {
          ensureOwned: () => Effect.succeed({ uid: "new-service-account-uid", created: true }),
          deleteOwned: (_input, expectedUid?: string) => {
            events.push(`delete-service-account:${expectedUid}`);
            return Effect.void;
          },
        }),
        Layer.succeed(PreviewOAuthClientProvisioner, {
          ensure: () =>
            Effect.fail(
              new PreviewWorkloadCredentialError({ reason: "oauth-client-create-failed" }),
            ),
          remove: () => Effect.void,
        }),
        Layer.succeed(KubernetesProjectedWorkloadClient, {
          ensureProjection: () =>
            Effect.succeed({ issuedAt: 10_000, expiresAt: 610_000, created: true }),
          removeProjection: () => Effect.void,
        }),
      );
      const layer = KubernetesWorkloadIdentityProvisionerLive.pipe(
        Layer.provideMerge(dependencies),
      );
      const provisioner = yield* KubernetesWorkloadIdentityProvisioner.pipe(Effect.provide(layer));
      const error = yield* Effect.flip(provisioner.ensureRoleIdentity(request));
      expect(error.reason).toBe("oauth-client-create-failed");
      expect(events).toEqual(["delete-service-account:new-service-account-uid"]);
    }),
  );

  it.effect("preserves an existing service account when OAuth identity provisioning fails", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const dependencies = Layer.mergeAll(
        Layer.succeed(KubernetesServiceAccountClient, {
          ensureOwned: () =>
            Effect.succeed({ uid: "existing-service-account-uid", created: false }),
          deleteOwned: () => {
            events.push("delete-service-account");
            return Effect.void;
          },
        }),
        Layer.succeed(PreviewOAuthClientProvisioner, {
          ensure: () =>
            Effect.fail(
              new PreviewWorkloadCredentialError({ reason: "oauth-client-create-failed" }),
            ),
          remove: () => Effect.void,
        }),
        Layer.succeed(KubernetesProjectedWorkloadClient, {
          ensureProjection: () =>
            Effect.succeed({ issuedAt: 10_000, expiresAt: 610_000, created: true }),
          removeProjection: () => Effect.void,
        }),
      );
      const layer = KubernetesWorkloadIdentityProvisionerLive.pipe(
        Layer.provideMerge(dependencies),
      );
      const provisioner = yield* KubernetesWorkloadIdentityProvisioner.pipe(Effect.provide(layer));
      const error = yield* Effect.flip(provisioner.ensureRoleIdentity(request));
      expect(error.reason).toBe("oauth-client-create-failed");
      expect(events).toEqual([]);
    }),
  );
});

const authorizedSession: PreviewSession = {
  id: "session-a",
  owner: "owner",
  checkout: "/checkout",
  resources: {},
  manifests: { "sheet-workflows-runner": "sha256:runner" },
  requestedRevision: "rev-a",
  activeRevision: null,
  phase: "pending",
  generation: 3,
  leaseDeadline: Number.MAX_SAFE_INTEGER,
  lastRenewedAt: 0,
  unsettled: 0,
  endedAt: null,
};
