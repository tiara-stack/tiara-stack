import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Duration, Effect, Fiber, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  buildSessionRelayNetworkPolicy,
  classifyDependencyHttpFailure,
  makePreviewRelayResourceAdapter,
  makePreviewRelayProvider,
  makeConfiguredPreviewRelayPlatformClient,
  normalizeDevelopmentHostname,
  parsePreviewRelayProviderConfig,
  PreviewRelayProviderError,
  previewRelayDoctorCheckIds,
  previewRelayOwnerLabels,
  type PreviewRelayHostListener,
  type PreviewRelayPlatformClient,
  type PreviewRelayProviderConfig,
  type PreviewRelayScopedAttachmentTarget,
} from "./preview-relay-provider";
import { makeLocalFilesystemPreviewResourceAdapter } from "./preview-allocations";

const digest = (char: string) => `sha256:${char.repeat(64)}`;

const providerConfig: PreviewRelayProviderConfig = {
  environment: "tiara-stack-dev",
  clusterContext: "tiara-stack-dev",
  apiServer: "https://api.tiara-stack-dev",
  tokenEnvironmentName: "TIARA_DEV_CLUSTER_TOKEN",
  namespace: "preview-relays",
  telepresenceContext: "tiara-stack-dev",
  telepresenceVersion: "v2.18.2",
  trafficManager: {
    namespace: "ambassador",
    podLabels: { app: "traffic-manager" },
    apiPort: 8081,
  },
  relayImage: `registry.dev/preview-relay@${digest("a")}`,
  approvedDevelopmentHosts: ["pg.dev.tiara-stack.moe", "redis.dev.tiara-stack.moe"],
  approvedCallerSources: [
    {
      namespace: "tiara-stack-dev",
      podLabels: { app: "sheet-bot" },
      port: 443,
    },
  ],
  approvedDevelopmentDestinations: [
    {
      hostname: "pg.dev.tiara-stack.moe",
      namespace: "tiara-stack-dev",
      podLabels: { app: "postgres-development" },
      port: 5432,
    },
    {
      hostname: "pg.dev.tiara-stack.moe",
      namespace: "tiara-stack-dev",
      podLabels: { app: "postgres-development" },
      port: 443,
    },
    {
      hostname: "redis.dev.tiara-stack.moe",
      namespace: "tiara-stack-dev",
      podLabels: { app: "redis-development" },
      port: 443,
    },
  ],
};

type FakeKubernetesCall = {
  readonly method: string;
  readonly url: string;
  readonly bearerToken: string;
  readonly body?: unknown;
};

const labelsInKubernetesBody = (body: unknown) => {
  if (typeof body !== "object" || body === null || !("metadata" in body)) return {};
  const metadata = (body as { metadata?: { labels?: Record<string, string> } }).metadata;
  return metadata?.labels ?? {};
};

const fakeKubernetesGetResponse = (url: string, calls: readonly FakeKubernetesCall[]) => {
  if (url.endsWith("preview-relays-default-deny"))
    return { spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] } };
  if (url.endsWith("preview-relays-dns-egress"))
    return {
      spec: {
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
                podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
        ],
      },
    };
  const serviceCreate = calls
    .filter((call) => call.method === "POST" && call.url.endsWith("/services"))
    .at(-1);
  return { metadata: { labels: labelsInKubernetesBody(serviceCreate?.body) } };
};

const respondToFakeKubernetesRead = (
  input: FakeKubernetesCall,
  calls: readonly FakeKubernetesCall[],
  resources: Map<string, unknown>,
): Effect.Effect<unknown, PreviewRelayProviderError> | undefined => {
  if (input.method !== "GET") return undefined;
  const resource = resources.get(input.url);
  if (resource !== undefined) return Effect.succeed(resource);
  if (input.url.includes("/leases?labelSelector="))
    return Effect.succeed({
      items: [...resources.entries()]
        .filter(([url]) => url.includes("/leases/"))
        .map(([, value]) => value),
    });
  if (
    input.url.includes("preview-relays-default-deny") ||
    input.url.includes("preview-relays-dns-egress")
  )
    return Effect.succeed(fakeKubernetesGetResponse(input.url, calls));
  return Effect.fail(new PreviewRelayProviderError({ reason: "owner-label-mismatch" }));
};

const shouldFailDeploymentCreate = (
  input: FakeKubernetesCall,
  failDeploymentCreate: () => boolean,
) => input.method === "POST" && input.url.endsWith("/deployments") && failDeploymentCreate();

const fakeKubernetesResourceUid = (resource: unknown) => {
  if (typeof resource !== "object" || resource === null || !("metadata" in resource))
    return undefined;
  const uid = (resource as { metadata?: { uid?: unknown } }).metadata?.uid;
  return typeof uid === "string" ? uid : undefined;
};

const deleteFakeKubernetesResource = (
  input: FakeKubernetesCall,
  resources: Map<string, unknown>,
): Effect.Effect<void, PreviewRelayProviderError> => {
  const expectedUid = (
    input.body as { readonly preconditions?: { readonly uid?: string } } | undefined
  )?.preconditions?.uid;
  const currentUid = fakeKubernetesResourceUid(resources.get(input.url));
  if (expectedUid !== undefined && expectedUid !== currentUid)
    return Effect.fail(new PreviewRelayProviderError({ reason: "listener-collision" }));
  return Effect.sync(() => {
    resources.delete(input.url);
  });
};

const storeFakeKubernetesResource = (
  input: FakeKubernetesCall,
  resources: Map<string, unknown>,
) => {
  const resourceBody = input.body as { metadata?: { name?: string } } | undefined;
  const name = resourceBody?.metadata?.name;
  const metadata = resourceBody?.metadata;
  if (name === undefined || metadata === undefined) return undefined;
  const resourceUrl = `${input.url}/${name}`;
  const stored = {
    ...(input.body as Record<string, unknown>),
    metadata: { ...metadata, uid: `fake-uid-${name}` },
  };
  resources.set(resourceUrl, stored);
  return stored;
};

const respondToFakeKubernetesWrite = (
  input: FakeKubernetesCall,
  failDeploymentCreate: () => boolean,
  resources: Map<string, unknown>,
): Effect.Effect<unknown, PreviewRelayProviderError> => {
  if (shouldFailDeploymentCreate(input, failDeploymentCreate))
    return Effect.fail(new PreviewRelayProviderError({ reason: "resource-create-failed" }));
  if (input.method === "DELETE") return deleteFakeKubernetesResource(input, resources);
  if (input.method === "POST" && input.url.endsWith("/leases"))
    return createFakeLease(input, resources);
  return Effect.succeed(storeFakeKubernetesResource(input, resources) ?? {});
};

const createFakeLease = (
  input: FakeKubernetesCall,
  resources: Map<string, unknown>,
): Effect.Effect<unknown, PreviewRelayProviderError> => {
  const metadata = (input.body as { metadata: { name: string } }).metadata;
  const resourceUrl = `${input.url}/${metadata.name}`;
  if (resources.has(resourceUrl))
    return Effect.fail(new PreviewRelayProviderError({ reason: "listener-collision" }));
  const stored = {
    ...(input.body as Record<string, unknown>),
    metadata: { ...metadata, uid: `fake-uid-${metadata.name}` },
  };
  resources.set(resourceUrl, stored);
  return Effect.succeed(stored);
};

const makeFakeKubernetesRequest = (
  calls: FakeKubernetesCall[],
  failDeploymentCreate: () => boolean,
  resources = new Map<string, unknown>(),
  beforeDelete?: (input: FakeKubernetesCall, resources: Map<string, unknown>) => void,
) => {
  return (input: FakeKubernetesCall) => {
    calls.push(input);
    if (input.method === "DELETE") beforeDelete?.(input, resources);
    return (
      respondToFakeKubernetesRead(input, calls, resources) ??
      respondToFakeKubernetesWrite(input, failDeploymentCreate, resources)
    );
  };
};

const makeConfiguredRelayFixture = () =>
  Effect.gen(function* () {
    const calls: FakeKubernetesCall[] = [];
    const resources = new Map<string, unknown>();
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const identity = {
      sessionId: "session-a",
      role: "sheet-auth" as const,
      processId: "auth-a",
    };
    const listener = {
      role: identity.role,
      processId: identity.processId,
      host: "127.0.0.1" as const,
      port: 8443,
    };
    const labels = previewRelayOwnerLabels(identity, "owned-service-token");
    const serviceName = `relay-${createHash("sha256").update(identity.sessionId).digest("hex").slice(0, 12)}-${identity.role}`;
    const client = makeConfiguredPreviewRelayPlatformClient(undefined, providerConfig, {
      token: "fake-token",
      hostIdentity: "relay-test-host",
      unknownResolutionSettleDelayMs: 0,
      kubernetesRequest: makeFakeKubernetesRequest(calls, () => false, resources),
      executor: async (request) => {
        commands.push({ command: request.command, args: request.args });
        return { exitCode: 0, stdout: "Client: v2.18.2" };
      },
    });
    const manifest = {
      serviceName,
      serviceFqdn: `${serviceName}.preview-relays.svc.cluster.local`,
      namespace: "preview-relays" as const,
      image: providerConfig.relayImage,
      applicationPort: listener.port,
      hostListener: listener,
      labels,
      networkPolicy: buildSessionRelayNetworkPolicy({
        sessionId: identity.sessionId,
        role: identity.role,
        namespace: "preview-relays",
        applicationPort: listener.port,
        relayLabels: labels,
        agentLabels: {},
        trafficManager: providerConfig.trafficManager,
        ingressSources: providerConfig.approvedCallerSources,
        developmentDestinations: providerConfig.approvedDevelopmentDestinations,
      }),
    };
    const service = yield* client.createServiceAndRelayWorkload({
      config: providerConfig,
      identity,
      manifest,
    });
    const reservation = yield* client.reserveHostListener({ identity, listener, labels });
    return { calls, resources, commands, client, identity, listener, labels, service, reservation };
  });

it("keeps absent and invalid provider configuration unavailable and accepts an explicit dev config", () => {
  expect(parsePreviewRelayProviderConfig(undefined)).toBeUndefined();
  expect(parsePreviewRelayProviderConfig("not-json")).toBeUndefined();
  expect(
    parsePreviewRelayProviderConfig(
      JSON.stringify({ ...providerConfig, apiServer: "https://api.production.example" }),
    ),
  ).toBeUndefined();
  expect(parsePreviewRelayProviderConfig(JSON.stringify(providerConfig))).toEqual(providerConfig);
  const trafficManagerWithoutPort = {
    namespace: providerConfig.trafficManager.namespace,
    podLabels: providerConfig.trafficManager.podLabels,
  };
  expect(
    parsePreviewRelayProviderConfig(
      JSON.stringify({
        ...providerConfig,
        trafficManager: trafficManagerWithoutPort,
      }),
    )?.trafficManager.apiPort,
  ).toBeUndefined();
  expect(makePreviewRelayProvider(undefined, undefined).configured).toBe(false);
  const invalidConfigs = [
    { ...providerConfig, approvedDevelopmentHosts: ["api.production.example"] },
    { ...providerConfig, trafficManager: { ...providerConfig.trafficManager, podLabels: {} } },
    {
      ...providerConfig,
      trafficManager: { ...providerConfig.trafficManager, podLabels: { "invalid key": "manager" } },
    },
    {
      ...providerConfig,
      approvedDevelopmentDestinations: providerConfig.approvedDevelopmentDestinations.map(
        (destination) => ({ ...destination, podLabels: {} }),
      ),
    },
  ];
  for (const config of invalidConfigs) {
    expect(parsePreviewRelayProviderConfig(JSON.stringify(config))).toBeUndefined();
    expect(makePreviewRelayProvider(config, undefined).configured).toBe(false);
  }
});

it("keeps the owner digest within Kubernetes label-value limits", () => {
  const labels = previewRelayOwnerLabels(
    { sessionId: "session-a", role: "sheet-auth", processId: "auth-a" },
    "a-long-owner-token-for-label-validation",
  );
  expect(labels["tiara-stack.io/owner-token-sha256"]).toHaveLength(63);
});

it.effect("recovers only exact owner-labeled unknown relay allocations", () =>
  Effect.gen(function* () {
    const fixture = yield* makeConfiguredRelayFixture();
    const service = yield* fixture.client.resolveUnknownResource({
      config: providerConfig,
      sessionId: fixture.identity.sessionId,
      role: fixture.identity.role,
      ownerToken: "owned-service-token",
      kind: "service",
    });
    expect(service?.providerResourceId).toBe(fixture.service.providerResourceId);
    expect(service?.processId).toBe(fixture.identity.processId);
    const attachment = yield* fixture.client.resolveUnknownResource({
      config: providerConfig,
      sessionId: fixture.identity.sessionId,
      role: fixture.identity.role,
      ownerToken: "owned-service-token",
      kind: "attachment",
    });
    expect(attachment?.providerResourceId).toBe(
      `${providerConfig.namespace}/attachment/${fixture.service.serviceName}/${fixture.listener.port}/${fixture.reservation.reservationId.split("/lease/")[1]}`,
    );
    expect(attachment?.processId).toBe(fixture.identity.processId);
    const wrongOwner = yield* Effect.result(
      fixture.client.resolveUnknownResource({
        config: providerConfig,
        sessionId: fixture.identity.sessionId,
        role: fixture.identity.role,
        ownerToken: "different-owner-token",
        kind: "attachment",
      }),
    );
    expect(wrongOwner).toMatchObject({
      _tag: "Failure",
      failure: { reason: "owner-label-mismatch" },
    });
    yield* fixture.client.detachOwnedAttachment({
      config: providerConfig,
      providerResourceId: attachment!.providerResourceId,
      labels: fixture.labels,
    });
    yield* fixture.client.deleteOwnedServiceAndWorkload({
      config: providerConfig,
      providerResourceId: service!.providerResourceId,
      labels: fixture.labels,
    });
    const serviceLookupStart = fixture.calls.filter((call) => call.method === "GET").length;
    expect(
      yield* fixture.client.resolveUnknownResource({
        config: providerConfig,
        sessionId: fixture.identity.sessionId,
        role: fixture.identity.role,
        ownerToken: "owned-service-token",
        kind: "service",
      }),
    ).toBeUndefined();
    expect(fixture.calls.filter((call) => call.method === "GET").length - serviceLookupStart).toBe(
      6,
    );
    const attachmentLookupStart = fixture.calls.filter((call) => call.method === "GET").length;
    expect(
      yield* fixture.client.resolveUnknownResource({
        config: providerConfig,
        sessionId: fixture.identity.sessionId,
        role: fixture.identity.role,
        ownerToken: "owned-service-token",
        kind: "attachment",
      }),
    ).toBeUndefined();
    expect(
      fixture.calls.filter((call) => call.method === "GET").length - attachmentLookupStart,
    ).toBe(2);
  }),
);

it.effect("stores recovered relay identities in the ledger format used by cleanup", () =>
  Effect.gen(function* () {
    const fake = makeFakePlatformClient();
    const identity = { sessionId: "session-a", role: "sheet-auth" as const, processId: "auth-a" };
    const listener = {
      role: identity.role,
      processId: identity.processId,
      host: "127.0.0.1" as const,
      port: 8443,
    };
    const ownerToken = "relay-allocation-owner";
    const service = yield* fake.client.createServiceAndRelayWorkload({
      config: providerConfig,
      identity,
      manifest: {
        serviceName: `relay-${createHash("sha256").update(identity.sessionId).digest("hex").slice(0, 12)}-${identity.role}`,
        serviceFqdn: `relay-${createHash("sha256").update(identity.sessionId).digest("hex").slice(0, 12)}-${identity.role}.preview-relays.svc.cluster.local`,
        namespace: "preview-relays",
        image: providerConfig.relayImage,
        applicationPort: listener.port,
        hostListener: listener,
        labels: previewRelayOwnerLabels(identity, ownerToken),
        networkPolicy: buildSessionRelayNetworkPolicy({
          sessionId: identity.sessionId,
          role: identity.role,
          namespace: "preview-relays",
          applicationPort: listener.port,
          relayLabels: previewRelayOwnerLabels(identity, ownerToken),
          agentLabels: {},
          trafficManager: providerConfig.trafficManager,
          ingressSources: providerConfig.approvedCallerSources,
          developmentDestinations: providerConfig.approvedDevelopmentDestinations,
        }),
      },
    });
    const provider = makePreviewRelayProvider(providerConfig, {
      ...fake.client,
      resolveUnknownResource: () =>
        Effect.succeed({
          providerResourceId: service.providerResourceId,
          processId: identity.processId,
        }),
    });
    const adapter = makePreviewRelayResourceAdapter(
      makeLocalFilesystemPreviewResourceAdapter("/tmp/relay-unknown-recovery"),
      provider,
    );
    const resource = "preview-relay-service-sheet-auth";
    const resolution = yield* adapter.resolveUnknown!({
      sessionId: identity.sessionId,
      resource,
      ownerToken,
      providerIdentities: [{ provider: "test", identity: "development" }],
    });
    if (resolution.result.status !== "found") throw new Error("expected owned relay reference");
    const reference = resolution.result.providerResourceId;
    expect(JSON.parse(reference)).toMatchObject({
      kind: "service",
      sessionId: identity.sessionId,
      role: identity.role,
      processId: identity.processId,
      providerResourceId: service.providerResourceId,
    });
    yield* adapter.deleteOwned({
      sessionId: identity.sessionId,
      resource,
      ownerToken,
      providerResourceId: reference,
    });
    expect(fake.services.has(service.providerResourceId)).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses forged service receipts and live Services owned by another token", () =>
  Effect.gen(function* () {
    const fixture = yield* makeConfiguredRelayFixture();
    const forged = yield* Effect.result(
      fixture.client.attachHostListener({
        config: providerConfig,
        identity: fixture.identity,
        service: { ...fixture.service, providerResourceId: "preview-relays/service/other" },
        listener: fixture.listener,
        reservation: fixture.reservation,
        labels: fixture.labels,
      }),
    );
    expect(forged).toMatchObject({ _tag: "Failure", failure: { reason: "unsafe-target" } });
    const serviceUrl = `https://api.tiara-stack-dev/api/v1/namespaces/preview-relays/services/${fixture.service.serviceName}`;
    const ownedService = fixture.resources.get(serviceUrl);
    fixture.resources.set(serviceUrl, {
      metadata: {
        name: fixture.service.serviceName,
        labels: previewRelayOwnerLabels(fixture.identity, "different-service-owner"),
      },
    });
    const wrongOwner = yield* Effect.result(
      fixture.client.attachHostListener({
        config: providerConfig,
        identity: fixture.identity,
        service: fixture.service,
        listener: fixture.listener,
        reservation: fixture.reservation,
        labels: fixture.labels,
      }),
    );
    expect(wrongOwner).toMatchObject({
      _tag: "Failure",
      failure: { reason: "owner-label-mismatch" },
    });
    fixture.resources.set(serviceUrl, ownedService);
    expect(fixture.commands.some(({ args }) => args.includes("intercept"))).toBe(false);
  }),
);

it.effect(
  "uses owner-labeled Kubernetes resources and exact pinned Telepresence target arguments",
  () =>
    Effect.gen(function* () {
      const calls: FakeKubernetesCall[] = [];
      const resources = new Map<string, unknown>();
      const commands: Array<{ command: string; args: readonly string[] }> = [];
      const commandSignals: Array<AbortSignal | undefined> = [];
      let failDeploymentCreate = false;
      const client = makeConfiguredPreviewRelayPlatformClient(undefined, providerConfig, {
        token: "fake-token",
        hostIdentity: "relay-test-host",
        kubernetesRequest: makeFakeKubernetesRequest(calls, () => failDeploymentCreate, resources),
        executor: async (request, signal) => {
          commands.push({ command: request.command, args: request.args });
          commandSignals.push(signal);
          return { exitCode: 0, stdout: "Client: v2.18.2" };
        },
      });
      const identity = { sessionId: "session-a", role: "sheet-auth" as const, processId: "auth-a" };
      const listener = {
        role: identity.role,
        processId: identity.processId,
        host: "127.0.0.1" as const,
        port: 8443,
      };
      const serviceLabels = previewRelayOwnerLabels(identity, "owned-service-token");
      const attachmentLabels = previewRelayOwnerLabels(identity, "owned-attachment-token");
      const serviceName = `relay-${createHash("sha256").update(identity.sessionId).digest("hex").slice(0, 12)}-${identity.role}`;
      const manifest = {
        serviceName,
        serviceFqdn: `${serviceName}.preview-relays.svc.cluster.local`,
        namespace: "preview-relays" as const,
        image: providerConfig.relayImage,
        applicationPort: listener.port,
        hostListener: listener,
        labels: serviceLabels,
        networkPolicy: buildSessionRelayNetworkPolicy({
          sessionId: identity.sessionId,
          role: identity.role,
          namespace: "preview-relays",
          applicationPort: listener.port,
          relayLabels: serviceLabels,
          agentLabels: {},
          trafficManager: providerConfig.trafficManager,
          ingressSources: providerConfig.approvedCallerSources,
          developmentDestinations: providerConfig.approvedDevelopmentDestinations,
        }),
      };
      const service = yield* client.createServiceAndRelayWorkload({
        config: providerConfig,
        identity,
        manifest,
      });
      expect(calls.filter((call) => call.method === "POST").map((call) => call.url)).toEqual([
        "https://api.tiara-stack-dev/api/v1/namespaces/preview-relays/services",
        "https://api.tiara-stack-dev/apis/apps/v1/namespaces/preview-relays/deployments",
        "https://api.tiara-stack-dev/apis/networking.k8s.io/v1/namespaces/preview-relays/networkpolicies",
      ]);
      expect(calls.every((call) => call.bearerToken === "fake-token")).toBe(true);
      expect(commandSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
      const posts = calls.filter((call) => call.method === "POST");
      expect(posts).toHaveLength(3);
      const serviceBody = posts[0]?.body;
      const workloadBody = posts[1]?.body;
      expect(serviceBody).toMatchObject({ metadata: { labels: serviceLabels } });
      expect(workloadBody).toMatchObject({
        spec: {
          template: {
            spec: {
              containers: [
                {
                  args: ["serve", "--listen", ":8443"],
                  securityContext: { seccompProfile: { type: "RuntimeDefault" } },
                },
              ],
            },
          },
        },
      });
      const reservation = yield* client.reserveHostListener({
        identity,
        listener,
        labels: attachmentLabels,
      });
      const attachment = yield* client.attachHostListener({
        config: providerConfig,
        identity,
        service,
        listener,
        reservation,
        labels: attachmentLabels,
      });
      const wrongOwnerDetach = yield* Effect.result(
        client.detachOwnedAttachment({
          config: providerConfig,
          providerResourceId: attachment.providerResourceId,
          labels: previewRelayOwnerLabels(identity, "different-attachment-owner"),
        }),
      );
      expect(wrongOwnerDetach).toMatchObject({
        _tag: "Failure",
        failure: { reason: "owner-label-mismatch" },
      });
      expect(commands.filter(({ args }) => args.includes("leave"))).toHaveLength(0);
      expect(
        yield* client.verifyOwnedResource({
          config: providerConfig,
          providerResourceId: attachment.providerResourceId,
          labels: attachmentLabels,
        }),
      ).toBe(true);
      expect(
        yield* client.verifyOwnedResource({
          config: providerConfig,
          providerResourceId: attachment.providerResourceId,
          labels: previewRelayOwnerLabels(identity, "different-attachment-owner"),
        }),
      ).toBe(false);
      expect(commands[0]?.args).toEqual([
        "--context",
        providerConfig.telepresenceContext,
        "version",
        "--client",
      ]);
      expect(commands[2]?.args).toEqual([
        "--context",
        providerConfig.telepresenceContext,
        "intercept",
        service.serviceName,
        "--namespace",
        "preview-relays",
        "--workload",
        service.serviceName,
        "--service",
        service.serviceName,
        "--port",
        "8443:8443",
      ]);
      yield* client.detachOwnedAttachment({
        config: providerConfig,
        providerResourceId: attachment.providerResourceId,
        labels: attachmentLabels,
      });
      yield* client.detachOwnedAttachment({
        config: providerConfig,
        providerResourceId: attachment.providerResourceId,
        labels: attachmentLabels,
      });
      expect(commands[3]?.args).toEqual([
        "--context",
        providerConfig.telepresenceContext,
        "leave",
        service.serviceName,
      ]);
      const leaseName = `preview-listener-${createHash("sha256").update("relay-test-host").digest("hex").slice(0, 12)}-8443`;
      const leaseDeleteUrl = `https://api.tiara-stack-dev/apis/coordination.k8s.io/v1/namespaces/preview-relays/leases/${leaseName}`;
      expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toContain(
        leaseDeleteUrl,
      );
      yield* client.deleteOwnedServiceAndWorkload({
        config: providerConfig,
        providerResourceId: service.providerResourceId,
        labels: serviceLabels,
      });
      expect(
        yield* client.verifyOwnedResource({
          config: providerConfig,
          providerResourceId: service.providerResourceId,
          labels: serviceLabels,
        }),
      ).toBe(true);
      expect(
        yield* client.verifyOwnedResource({
          config: providerConfig,
          providerResourceId: attachment.providerResourceId,
          labels: attachmentLabels,
        }),
      ).toBe(true);
      yield* client.deleteOwnedServiceAndWorkload({
        config: providerConfig,
        providerResourceId: service.providerResourceId,
        labels: serviceLabels,
      });
      expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual([
        leaseDeleteUrl,
        `https://api.tiara-stack-dev/apis/networking.k8s.io/v1/namespaces/preview-relays/networkpolicies/${manifest.serviceName}-session-route`,
        `https://api.tiara-stack-dev/apis/apps/v1/namespaces/preview-relays/deployments/${manifest.serviceName}`,
        `https://api.tiara-stack-dev/api/v1/namespaces/preview-relays/services/${manifest.serviceName}`,
      ]);
      failDeploymentCreate = true;
      const failedCreate = yield* Effect.result(
        client.createServiceAndRelayWorkload({ config: providerConfig, identity, manifest }),
      );
      expect(failedCreate._tag).toBe("Failure");
      expect(calls.filter((call) => call.method === "DELETE").at(-1)?.url).toBe(
        `https://api.tiara-stack-dev/api/v1/namespaces/preview-relays/services/${manifest.serviceName}`,
      );
      failDeploymentCreate = false;
      const foreign = yield* Effect.result(
        client.deleteOwnedServiceAndWorkload({
          config: providerConfig,
          providerResourceId: "preview-relays/service/other",
          labels: previewRelayOwnerLabels(identity, "foreign"),
        }),
      );
      expect(foreign._tag).toBe("Failure");
    }),
);

it.effect("uses a Kubernetes UID precondition when deleting an exact-owned relay", () =>
  Effect.gen(function* () {
    const calls: FakeKubernetesCall[] = [];
    const resources = new Map<string, unknown>();
    const identity = {
      sessionId: "session-uid",
      role: "sheet-auth" as const,
      processId: "auth-uid",
    };
    const listener = {
      role: identity.role,
      host: "127.0.0.1" as const,
      port: 8443,
      processId: identity.processId,
    };
    const labels = previewRelayOwnerLabels(identity, "owner-uid");
    const serviceName = `relay-${createHash("sha256").update(identity.sessionId).digest("hex").slice(0, 12)}-${identity.role}`;
    const serviceUrl = `https://api.tiara-stack-dev/api/v1/namespaces/preview-relays/services/${serviceName}`;
    let replaced = false;
    const api = makeFakeKubernetesRequest(
      calls,
      () => false,
      resources,
      (input, store) => {
        if (input.url !== serviceUrl || replaced) return;
        const current = store.get(serviceUrl);
        if (typeof current !== "object" || current === null || !("metadata" in current)) return;
        const resource = current as { metadata?: Record<string, unknown> };
        store.set(serviceUrl, {
          ...current,
          metadata: { ...resource.metadata, uid: "replacement-uid" },
        });
        replaced = true;
      },
    );
    const client = makeConfiguredPreviewRelayPlatformClient(undefined, providerConfig, {
      token: "fake-token",
      hostIdentity: "uid-test-host",
      unknownResolutionSettleDelayMs: 0,
      kubernetesRequest: api,
      executor: async () => ({ exitCode: 0, stdout: "Client: v2.18.2" }),
    });
    const manifest = {
      serviceName,
      serviceFqdn: `${serviceName}.preview-relays.svc.cluster.local`,
      namespace: "preview-relays" as const,
      image: providerConfig.relayImage,
      applicationPort: listener.port,
      hostListener: listener,
      labels,
      networkPolicy: buildSessionRelayNetworkPolicy({
        sessionId: identity.sessionId,
        role: identity.role,
        namespace: "preview-relays",
        applicationPort: listener.port,
        relayLabels: labels,
        agentLabels: {},
        trafficManager: providerConfig.trafficManager,
        ingressSources: providerConfig.approvedCallerSources,
        developmentDestinations: providerConfig.approvedDevelopmentDestinations,
      }),
    };
    yield* client.createServiceAndRelayWorkload({ config: providerConfig, identity, manifest });
    const deleted = yield* Effect.result(
      client.deleteOwnedServiceAndWorkload({
        config: providerConfig,
        providerResourceId: `preview-relays/service/${serviceName}`,
        labels,
      }),
    );
    expect(deleted).toMatchObject({
      _tag: "Failure",
      failure: { reason: "listener-collision" },
    });
    expect(replaced).toBe(true);
    expect(resources.get(serviceUrl)).toMatchObject({
      metadata: { uid: "replacement-uid", labels },
    });
    expect(
      calls.find((call) => call.method === "DELETE" && call.url === serviceUrl)?.body,
    ).toMatchObject({
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: `fake-uid-${serviceName}` },
    });
  }),
);

it.effect(
  "doctor checks pinned runtimes, local capabilities, DNS and exact scoped attach authorization",
  () =>
    Effect.gen(function* () {
      const calls: FakeKubernetesCall[] = [];
      const commands: string[][] = [];
      const resolvedHosts: string[] = [];
      let allowSharedWorkload = false;
      let tunAvailable = true;
      let dnsAvailable = true;
      const doctorOptions: NonNullable<
        Parameters<typeof makeConfiguredPreviewRelayPlatformClient>[2]
      > = {
        token: "fake-token",
        hostIdentity: "doctor-workstation",
        workspaceCapabilitiesProbe: () => Effect.succeed({ tunAvailable, netAdmin: true }),
        dnsLookup: async (hostname) => {
          resolvedHosts.push(hostname);
          return dnsAvailable ? { address: "192.0.2.10", family: 4 } : [];
        },
        executor: async (request) => {
          commands.push([...request.args]);
          return request.args.includes("status")
            ? {
                exitCode: 0,
                stdout: "Traffic Manager: v2.18.2\nTraffic Agent Image: v2.18.2\n",
              }
            : { exitCode: 0, stdout: "Client: v2.18.2" };
        },
        kubernetesRequest: (input) => {
          calls.push(input);
          if (input.method === "GET" && input.url.endsWith("/namespaces/preview-relays"))
            return Effect.succeed({ metadata: { name: "preview-relays" } });
          if (input.method === "GET" && input.url.includes("networkpolicies"))
            return Effect.succeed(fakeKubernetesGetResponse(input.url, calls));
          if (input.method === "POST") {
            const attributes = (
              input.body as {
                spec: { resourceAttributes: { namespace: string; name: string } };
              }
            ).spec.resourceAttributes;
            const allowed = attributes.namespace === "preview-relays" || allowSharedWorkload;
            return Effect.succeed({ status: { allowed } });
          }
          return Effect.fail(
            new PreviewRelayProviderError({ reason: "provider-client-unavailable" }),
          );
        },
      };
      const client = makeConfiguredPreviewRelayPlatformClient(
        undefined,
        providerConfig,
        doctorOptions,
      );
      const doctorInput = {
        profile: "workspace-doctor",
        roles: ["sheet-web", "sheet-auth"] as const,
        listeners: [
          listener("sheet-web", 4101, "web-process"),
          listener("sheet-auth", 4102, "auth-process"),
        ],
      };
      const checks = yield* client.checkPreparedWorkspace(doctorInput);
      expect(checks).toHaveLength(6);
      expect(checks.filter((check) => check.status === "ready")).toHaveLength(5);
      expect(checks.find((check) => check.id === "scoped-relay-attachment")).toMatchObject({
        status: "unavailable",
        detail: expect.stringContaining("No adapter verified an actual Telepresence attachment"),
      });
      expect(commands).toEqual([
        ["--context", "tiara-stack-dev", "version", "--client"],
        ["--context", "tiara-stack-dev", "status"],
      ]);
      expect(resolvedHosts).toEqual(providerConfig.approvedDevelopmentHosts);
      expect(
        calls.some(
          ({ method, url }) =>
            method === "GET" &&
            url === "https://api.tiara-stack-dev/api/v1/namespaces/preview-relays",
        ),
      ).toBe(false);
      const profileSession = `doctor-${createHash("sha256").update("doctor-workstation/workspace-doctor").digest("hex").slice(0, 12)}`;
      const authorizationTarget = (processId: string, role: "sheet-web" | "sheet-auth") => {
        const session = `doctor-${createHash("sha256").update(`${profileSession}/${processId}`).digest("hex").slice(0, 12)}`;
        const nameHash = createHash("sha256").update(session).digest("hex").slice(0, 12);
        return `relay-${nameHash}-${role}`;
      };
      expect(calls.some((call) => call.method === "POST")).toBe(false);
      const scopedTargets: PreviewRelayScopedAttachmentTarget[] = [];
      const injectedClient = makeConfiguredPreviewRelayPlatformClient(undefined, providerConfig, {
        ...doctorOptions,
        scopedAttachmentAuthorizationProbe: (target) =>
          Effect.sync(() => {
            scopedTargets.push(target);
            return { targetAllowed: true, sharedWorkloadDenied: !allowSharedWorkload };
          }),
      });
      const injectedChecks = yield* injectedClient.checkPreparedWorkspace(doctorInput);
      expect(injectedChecks.find((check) => check.id === "scoped-relay-attachment")?.status).toBe(
        "ready",
      );
      expect(
        scopedTargets.map(
          ({ identity, listener, namespace, serviceName, serviceFqdn, sharedWorkload }) => ({
            identity,
            listener: { role: listener.role, processId: listener.processId },
            namespace,
            serviceName,
            serviceFqdn,
            sharedWorkload,
          }),
        ),
      ).toEqual([
        {
          identity: {
            sessionId: `doctor-${createHash("sha256").update(`${profileSession}/web-process`).digest("hex").slice(0, 12)}`,
            role: "sheet-web",
            processId: "web-process",
          },
          listener: { role: "sheet-web", processId: "web-process" },
          namespace: "preview-relays",
          serviceName: authorizationTarget("web-process", "sheet-web"),
          serviceFqdn: `${authorizationTarget("web-process", "sheet-web")}.preview-relays.svc.cluster.local`,
          sharedWorkload: { namespace: "default", name: "shared-workload-control" },
        },
        {
          identity: {
            sessionId: `doctor-${createHash("sha256").update(`${profileSession}/auth-process`).digest("hex").slice(0, 12)}`,
            role: "sheet-auth",
            processId: "auth-process",
          },
          listener: { role: "sheet-auth", processId: "auth-process" },
          namespace: "preview-relays",
          serviceName: authorizationTarget("auth-process", "sheet-auth"),
          serviceFqdn: `${authorizationTarget("auth-process", "sheet-auth")}.preview-relays.svc.cluster.local`,
          sharedWorkload: { namespace: "default", name: "shared-workload-control" },
        },
      ]);
      allowSharedWorkload = true;
      const unsafeChecks = yield* injectedClient.checkPreparedWorkspace(doctorInput);
      expect(unsafeChecks.find((check) => check.id === "scoped-relay-attachment")?.status).toBe(
        "failed",
      );
      allowSharedWorkload = false;
      tunAvailable = false;
      dnsAvailable = false;
      const unavailableChecks = yield* client.checkPreparedWorkspace(doctorInput);
      expect(
        unavailableChecks.find((check) => check.id === "workspace-tun-capabilities")?.status,
      ).toBe("failed");
      expect(unavailableChecks.find((check) => check.id === "workspace-dns")?.status).toBe(
        "failed",
      );
    }),
);

const listener = (
  role: PreviewRelayHostListener["role"],
  port: number,
  processId: string,
): PreviewRelayHostListener => ({ role, host: "127.0.0.1", port, processId });

const makeFakePlatformClient = (dependencyPort?: number) => {
  const services = new Map<string, { readonly labels: Readonly<Record<string, string>> }>();
  const attachments = new Map<
    string,
    {
      readonly labels: Readonly<Record<string, string>>;
      readonly reservationId: string;
      readonly port: number;
    }
  >();
  const reservedPorts = new Map<number, string>();
  const dependencies: Array<{ hostname: string; tlsServerName: string; sessionId: string }> = [];
  const sharedManager = { running: true };
  let nextAttachment = 0;

  const client: PreviewRelayPlatformClient = {
    createServiceAndRelayWorkload: (input) =>
      Effect.sync(() => {
        const providerResourceId = `preview-relays/service/${input.manifest.serviceName}`;
        services.set(providerResourceId, { labels: input.manifest.labels });
        return {
          providerResourceId,
          serviceName: input.manifest.serviceName,
          serviceFqdn: input.manifest.serviceFqdn,
          labels: input.manifest.labels,
        };
      }),
    reserveHostListener: ({ identity, listener: target, labels }) =>
      Effect.gen(function* () {
        if (reservedPorts.has(target.port))
          return yield* Effect.fail(
            new PreviewRelayProviderError({ reason: "listener-collision" }),
          );
        const reservationId = `host-listener/${identity.sessionId}/${identity.role}`;
        reservedPorts.set(target.port, reservationId);
        return {
          reservationId,
          sessionId: identity.sessionId,
          role: identity.role,
          processId: identity.processId,
          host: target.host,
          port: target.port,
          labels,
        };
      }),
    releaseHostListener: ({ reservationId }) =>
      Effect.sync(() => {
        for (const [port, owner] of reservedPorts) {
          if (owner === reservationId) reservedPorts.delete(port);
        }
      }),
    attachHostListener: ({ identity, service, listener: target, reservation, labels }) =>
      Effect.gen(function* () {
        const serviceResource = services.get(service.providerResourceId);
        if (
          serviceResource === undefined ||
          serviceResource.labels["tiara-stack.io/session-id"] !== identity.sessionId ||
          serviceResource.labels["tiara-stack.io/role"] !== identity.role ||
          serviceResource.labels["tiara-stack.io/process-id"] !== identity.processId ||
          reservedPorts.get(target.port) !== reservation.reservationId ||
          reservation.processId !== identity.processId
        )
          return yield* Effect.fail(new PreviewRelayProviderError({ reason: "attachment-failed" }));
        const providerResourceId = `attachments/${++nextAttachment}`;
        attachments.set(providerResourceId, {
          labels,
          reservationId: reservation.reservationId,
          port: target.port,
        });
        return {
          providerResourceId,
          listenerReservationId: reservation.reservationId,
          sessionId: identity.sessionId,
          role: identity.role,
          processId: identity.processId,
          host: target.host,
          port: target.port,
          serviceFqdn: service.serviceFqdn,
          labels,
        };
      }),
    detachOwnedAttachment: ({ providerResourceId, labels }) =>
      Effect.gen(function* () {
        const resource = attachments.get(providerResourceId);
        if (resource === undefined) return;
        if (JSON.stringify(resource.labels) !== JSON.stringify(labels))
          return yield* Effect.fail(
            new PreviewRelayProviderError({ reason: "owner-label-mismatch" }),
          );
        attachments.delete(providerResourceId);
        if (reservedPorts.get(resource.port) === resource.reservationId)
          reservedPorts.delete(resource.port);
      }),
    deleteOwnedServiceAndWorkload: ({ providerResourceId, labels }) =>
      Effect.gen(function* () {
        const resource = services.get(providerResourceId);
        if (resource === undefined) return;
        if (JSON.stringify(resource.labels) !== JSON.stringify(labels))
          return yield* Effect.fail(
            new PreviewRelayProviderError({ reason: "owner-label-mismatch" }),
          );
        services.delete(providerResourceId);
      }),
    verifyOwnedResource: ({ providerResourceId }) =>
      Effect.succeed(services.has(providerResourceId) || attachments.has(providerResourceId)),
    resolveUnknownResource: () => Effect.succeed(undefined),
    checkPreparedWorkspace: () =>
      Effect.succeed(
        previewRelayDoctorCheckIds.map((id) => ({
          id,
          status: "ready" as const,
          detail: "fake check passed",
        })),
      ),
    probeDevelopmentDependency: (input) =>
      Effect.tryPromise({
        try: async () => {
          dependencies.push({
            hostname: input.hostname,
            tlsServerName: input.tlsServerName,
            sessionId: input.sessionId,
          });
          if (dependencyPort === undefined) return { status: 200, authenticated: true };
          const response = await fetch(`http://127.0.0.1:${dependencyPort}/probe`, {
            headers: {
              host: input.hostname,
              "x-preview-session": input.sessionId,
              "x-preview-role": input.role,
            },
          });
          return {
            status: response.status,
            authenticated: response.status !== 401 && response.status !== 403,
          };
        },
        catch: () => new PreviewRelayProviderError({ reason: "dependency-network-failed" }),
      }),
  };
  return { client, services, attachments, reservedPorts, dependencies, sharedManager };
};

const makeReadyProvider = () => {
  const fake = makeFakePlatformClient();
  return { ...fake, provider: makePreviewRelayProvider(providerConfig, fake.client) };
};

it.effect("reserves each host listener port across sessions with session-owned Leases", () =>
  Effect.gen(function* () {
    const calls: FakeKubernetesCall[] = [];
    const resources = new Map<string, unknown>();
    const fakeApi = makeFakeKubernetesRequest(calls, () => false, resources);
    const firstHostClient = makeConfiguredPreviewRelayPlatformClient(undefined, providerConfig, {
      token: "fake-token",
      hostIdentity: "workstation-a",
      kubernetesRequest: fakeApi,
    });
    const secondHostClient = makeConfiguredPreviewRelayPlatformClient(undefined, providerConfig, {
      token: "fake-token",
      hostIdentity: "workstation-b",
      kubernetesRequest: fakeApi,
    });
    const firstListener = listener("sheet-auth", 4401, "auth-process-a");
    const secondListener = listener("sheet-auth", 4401, "auth-process-b");
    const firstIdentity = {
      sessionId: "session-a",
      role: firstListener.role,
      processId: firstListener.processId,
    };
    const secondIdentity = {
      sessionId: "session-b",
      role: secondListener.role,
      processId: secondListener.processId,
    };
    const firstLabels = previewRelayOwnerLabels(firstIdentity, "owner-a");
    const secondLabels = previewRelayOwnerLabels(secondIdentity, "owner-b");
    const firstReservation = yield* firstHostClient.reserveHostListener({
      identity: firstIdentity,
      listener: firstListener,
      labels: firstLabels,
    });
    const firstLeaseName = `preview-listener-${createHash("sha256").update("workstation-a").digest("hex").slice(0, 12)}-4401`;
    expect(firstReservation.reservationId).toBe(`preview-relays/lease/${firstLeaseName}`);
    const otherHostReservation = yield* secondHostClient.reserveHostListener({
      identity: secondIdentity,
      listener: secondListener,
      labels: secondLabels,
    });
    expect(otherHostReservation.reservationId).not.toBe(firstReservation.reservationId);
    const secondSameHostIdentity = { ...secondIdentity, sessionId: "session-c" };
    const secondSameHostLabels = previewRelayOwnerLabels(secondSameHostIdentity, "owner-c");
    const collision = yield* Effect.result(
      firstHostClient.reserveHostListener({
        identity: secondSameHostIdentity,
        listener: { ...secondListener, processId: secondSameHostIdentity.processId },
        labels: secondSameHostLabels,
      }),
    );
    expect(collision._tag).toBe("Failure");
    if (collision._tag === "Failure") expect(collision.failure.reason).toBe("listener-collision");
    const wrongOwnerRelease = yield* Effect.result(
      firstHostClient.releaseHostListener({
        reservationId: firstReservation.reservationId,
        labels: secondSameHostLabels,
      }),
    );
    expect(wrongOwnerRelease._tag).toBe("Failure");
    yield* firstHostClient.releaseHostListener({
      reservationId: firstReservation.reservationId,
      labels: firstLabels,
    });
    const sameHostReservation = yield* firstHostClient.reserveHostListener({
      identity: secondSameHostIdentity,
      listener: { ...secondListener, processId: secondSameHostIdentity.processId },
      labels: secondSameHostLabels,
    });
    yield* firstHostClient.releaseHostListener({
      reservationId: sameHostReservation.reservationId,
      labels: secondSameHostLabels,
    });
    yield* secondHostClient.releaseHostListener({
      reservationId: otherHostReservation.reservationId,
      labels: secondLabels,
    });
    expect(
      calls.filter((call) => call.method === "POST" && call.url.endsWith("/leases")),
    ).toHaveLength(3);
    expect(
      calls.filter((call) => call.method === "DELETE" && call.url.includes("/leases/")),
    ).toHaveLength(3);
  }),
);

it.effect("creates and cleans only exact session-owned relay resources", () =>
  Effect.gen(function* () {
    const fake = makeReadyProvider();
    const firstListener = listener("sheet-auth", 4101, "process-session-a");
    const secondListener = listener("sheet-auth", 4102, "process-session-b");
    const firstIdentity = {
      sessionId: "session-a",
      role: firstListener.role,
      processId: firstListener.processId,
    };
    const secondIdentity = {
      sessionId: "session-b",
      role: secondListener.role,
      processId: secondListener.processId,
    };
    const firstService = yield* fake.provider.createService({
      ownerToken: "owner-secret-a",
      identity: firstIdentity,
      listener: firstListener,
    });
    const secondService = yield* fake.provider.createService({
      ownerToken: "owner-secret-b",
      identity: secondIdentity,
      listener: secondListener,
    });
    expect(firstService.serviceFqdn).toContain("preview-relays.svc.cluster.local");
    expect(JSON.stringify(firstService.labels)).not.toContain("owner-secret-a");

    const firstAttachment = yield* fake.provider.attach({
      ownerToken: "owner-secret-a",
      identity: firstIdentity,
      listener: firstListener,
      service: firstService,
    });
    const secondAttachment = yield* fake.provider.attach({
      ownerToken: "owner-secret-b",
      identity: secondIdentity,
      listener: secondListener,
      service: secondService,
    });
    expect(fake.services.size).toBe(2);
    expect(fake.attachments.size).toBe(2);
    expect(fake.reservedPorts.has(4101)).toBe(true);
    expect(fake.reservedPorts.has(4102)).toBe(true);

    const wrongOwnerDelete = yield* Effect.result(
      fake.provider.deleteAttachment({
        ownerToken: "owner-secret-b",
        identity: firstIdentity,
        providerResourceId: firstAttachment.providerResourceId,
      }),
    );
    expect(wrongOwnerDelete._tag).toBe("Failure");
    expect(fake.attachments.has(firstAttachment.providerResourceId)).toBe(true);

    yield* fake.provider.deleteAttachment({
      ownerToken: "owner-secret-a",
      identity: firstIdentity,
      providerResourceId: firstAttachment.providerResourceId,
    });
    yield* fake.provider.deleteService({
      ownerToken: "owner-secret-a",
      identity: firstIdentity,
      providerResourceId: firstService.providerResourceId,
    });
    expect(fake.attachments.has(firstAttachment.providerResourceId)).toBe(false);
    expect(fake.services.has(firstService.providerResourceId)).toBe(false);
    expect(fake.attachments.has(secondAttachment.providerResourceId)).toBe(true);
    expect(fake.services.has(secondService.providerResourceId)).toBe(true);
    expect(fake.reservedPorts.has(4101)).toBe(false);
    expect(fake.reservedPorts.has(4102)).toBe(true);
    expect(fake.sharedManager.running).toBe(true);
  }),
);

it.effect("rejects host listener collisions and identity mismatches before attachment", () =>
  Effect.gen(function* () {
    const fake = makeReadyProvider();
    const firstListener = listener("sheet-auth", 4101, "process-a");
    const firstIdentity = {
      sessionId: "session-a",
      role: firstListener.role,
      processId: "process-a",
    };
    const firstService = yield* fake.provider.createService({
      ownerToken: "owner-a",
      identity: firstIdentity,
      listener: firstListener,
    });
    const secondListener = listener("sheet-auth", 4101, "process-b");
    const secondIdentity = {
      sessionId: "session-b",
      role: secondListener.role,
      processId: "process-b",
    };
    const secondService = yield* fake.provider.createService({
      ownerToken: "owner-b",
      identity: secondIdentity,
      listener: secondListener,
    });
    const firstAttachment = yield* fake.provider.attach({
      ownerToken: "owner-a",
      identity: firstIdentity,
      listener: firstListener,
      service: firstService,
    });
    const collision = yield* Effect.result(
      fake.provider.attach({
        ownerToken: "owner-b",
        identity: secondIdentity,
        listener: secondListener,
        service: secondService,
      }),
    );
    expect(collision._tag).toBe("Failure");
    if (collision._tag === "Failure") expect(collision.failure.reason).toBe("listener-collision");

    const wrongProcess = yield* Effect.result(
      fake.provider.attach({
        ownerToken: "owner-a",
        identity: { ...firstIdentity, processId: "other-process" },
        listener: firstListener,
        service: firstService,
      }),
    );
    expect(wrongProcess._tag).toBe("Failure");
    if (wrongProcess._tag === "Failure")
      expect(wrongProcess.failure.reason).toBe("identity-mismatch");
    expect(fake.attachments.has(firstAttachment.providerResourceId)).toBe(true);
    expect(fake.attachments.size).toBe(1);
  }),
);

it.effect("probes only approved development FQDNs and preserves DNS/TLS identity", () =>
  Effect.gen(function* () {
    const fake = makeReadyProvider();
    const input = {
      approvedHostnames: ["PG.DEV.TIARA-STACK.MOE."],
      request: {
        sessionId: "session-a",
        role: "sheet-auth" as const,
        processId: "process-a",
        hostname: "PG.DEV.TIARA-STACK.MOE.",
        protocol: "https" as const,
        probePath: "/ready",
        tlsServerName: "PG.DEV.TIARA-STACK.MOE.",
        credentialReference: "secret://tiara-stack-dev/sheet-auth/database",
      },
    };
    const result = yield* fake.provider.checkDevelopmentDependency(input);
    expect(result).toEqual({ status: 200, authenticated: true });
    expect(fake.dependencies).toEqual([
      {
        hostname: "PG.DEV.TIARA-STACK.MOE.",
        tlsServerName: "PG.DEV.TIARA-STACK.MOE.",
        sessionId: "session-a",
      },
    ]);

    const unapproved = yield* Effect.result(
      fake.provider.checkDevelopmentDependency({
        ...input,
        request: {
          ...input.request,
          hostname: "db.production.example.com",
          tlsServerName: "db.production.example.com",
        },
      }),
    );
    expect(unapproved._tag).toBe("Failure");
    if (unapproved._tag === "Failure")
      expect(unapproved.failure.reason).toBe("dependency-not-allowlisted");
    expect(fake.dependencies).toHaveLength(1);
    const unapprovedPort = yield* Effect.result(
      fake.provider.checkDevelopmentDependency({
        ...input,
        request: { ...input.request, port: 8443 },
      }),
    );
    expect(unapprovedPort._tag).toBe("Failure");
    if (unapprovedPort._tag === "Failure")
      expect(unapprovedPort.failure.reason).toBe("dependency-not-allowlisted");
    expect(fake.dependencies).toHaveLength(1);
  }),
);

it.effect("keeps dependency failure classes distinct", () =>
  Effect.gen(function* () {
    const failureCases = [
      ["dependency-dns-failed", "dependency-dns-failed"],
      ["dependency-network-failed", "dependency-network-failed"],
      ["dependency-tls-failed", "dependency-tls-failed"],
      [
        "dependency-application-authentication-failed",
        "dependency-application-authentication-failed",
      ],
    ] as const;
    for (const [reason, expected] of failureCases) {
      const fake = makeFakePlatformClient();
      const provider = makePreviewRelayProvider(providerConfig, {
        ...fake.client,
        probeDevelopmentDependency: () => Effect.fail(new PreviewRelayProviderError({ reason })),
      });
      const result = yield* Effect.result(
        provider.checkDevelopmentDependency({
          approvedHostnames: providerConfig.approvedDevelopmentHosts,
          request: {
            sessionId: "session-a",
            role: "sheet-auth",
            processId: "process-a",
            hostname: "pg.dev.tiara-stack.moe",
            protocol: "https",
            probePath: "/ready",
            tlsServerName: "pg.dev.tiara-stack.moe",
            credentialReference: "secret://tiara-stack-dev/sheet-auth/database",
          },
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.reason).toBe(expected);
    }
  }),
);

it.effect("maps a stalled development dependency request to a bounded network failure", () =>
  Effect.gen(function* () {
    const httpClient = HttpClient.make(() => Effect.never);
    const client = makeConfiguredPreviewRelayPlatformClient(httpClient, providerConfig, {
      resolveCredential: () => Effect.succeed(undefined),
      developmentDependencyProbeTimeout: Duration.millis(1),
    });
    const probe = yield* Effect.result(
      client.probeDevelopmentDependency({
        sessionId: "session-a",
        role: "sheet-auth",
        processId: "process-a",
        hostname: "pg.dev.tiara-stack.moe",
        credentialReference: undefined,
        protocol: "https",
        probePath: "/ready",
        tlsServerName: "pg.dev.tiara-stack.moe",
      }),
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(1));
    const result = yield* Fiber.join(probe);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("dependency-network-failed");
  }),
);

it.effect("resolves injected dependency credentials and rejects unresolved references", () =>
  Effect.gen(function* () {
    const authorizationHeaders: boolean[] = [];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        authorizationHeaders.push(request.headers.authorization !== undefined);
        return HttpClientResponse.fromWeb(request, new Response("ready", { status: 200 }));
      }),
    );
    const client = makeConfiguredPreviewRelayPlatformClient(httpClient, providerConfig, {
      resolveCredential: (reference) =>
        reference === "secret://tiara-stack-dev/sheet-auth/database"
          ? Effect.succeed(Redacted.make("test-secret"))
          : Effect.fail(
              new PreviewRelayProviderError({ reason: "provider-configuration-invalid" }),
            ),
    });
    const request = {
      sessionId: "session-a",
      role: "sheet-auth" as const,
      processId: "process-a",
      hostname: "pg.dev.tiara-stack.moe",
      port: 443,
      protocol: "https" as const,
      probePath: "/ready",
      tlsServerName: "pg.dev.tiara-stack.moe",
      credentialReference: "secret://tiara-stack-dev/sheet-auth/database",
    };
    expect(yield* client.probeDevelopmentDependency(request)).toMatchObject({ status: 200 });
    expect(authorizationHeaders).toEqual([true]);

    const defaultResolverClient = makeConfiguredPreviewRelayPlatformClient(
      httpClient,
      providerConfig,
    );
    const unresolved = yield* Effect.result(
      defaultResolverClient.probeDevelopmentDependency(request),
    );
    expect(unresolved._tag).toBe("Failure");
    if (unresolved._tag === "Failure")
      expect(unresolved.failure.reason).toBe("provider-configuration-invalid");
    expect(authorizationHeaders).toHaveLength(1);
  }),
);

it.effect("rejects development dependency redirects", () =>
  Effect.gen(function* () {
    const fake = makeFakePlatformClient();
    const provider = makePreviewRelayProvider(providerConfig, {
      ...fake.client,
      probeDevelopmentDependency: () => Effect.succeed({ status: 302, authenticated: true }),
    });
    const result = yield* Effect.result(
      provider.checkDevelopmentDependency({
        approvedHostnames: providerConfig.approvedDevelopmentHosts,
        request: {
          sessionId: "session-a",
          role: "sheet-auth",
          processId: "process-a",
          hostname: "pg.dev.tiara-stack.moe",
          protocol: "https",
          probePath: "/ready",
          tlsServerName: "pg.dev.tiara-stack.moe",
          credentialReference: undefined,
        },
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("dependency-probe-failed");
  }),
);

it("classifies HTTP transport failures by DNS, TLS, authentication and network cause", () => {
  expect(classifyDependencyHttpFailure(new Error("getaddrinfo ENOTFOUND service"))).toMatchObject({
    reason: "dependency-dns-failed",
  });
  expect(classifyDependencyHttpFailure(new Error("certificate verify failed"))).toMatchObject({
    reason: "dependency-tls-failed",
  });
  expect(classifyDependencyHttpFailure(new Error("HTTP 403 forbidden"))).toMatchObject({
    reason: "dependency-application-authentication-failed",
  });
  expect(classifyDependencyHttpFailure(new Error("connection reset"))).toMatchObject({
    reason: "dependency-network-failed",
  });
});

it.live("routes two host dependency probes through an injected loopback HTTP client", () =>
  Effect.gen(function* () {
    const received: Array<{ readonly urlHost: string; readonly sessionId: string }> = [];
    const server = createServer((request, response) => {
      received.push({
        urlHost: String(request.headers.host),
        sessionId: String(request.headers["x-preview-session"]),
      });
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("development dependency ready");
    });
    yield* Effect.tryPromise({
      try: () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      catch: () => new Error("loopback test server failed to start"),
    });
    const address = server.address() as AddressInfo;
    const fake = makeFakePlatformClient(address.port);
    const provider = makePreviewRelayProvider(providerConfig, fake.client);
    try {
      const first = yield* provider.checkDevelopmentDependency({
        approvedHostnames: providerConfig.approvedDevelopmentHosts,
        request: {
          sessionId: "session-a",
          role: "sheet-auth",
          processId: "process-a",
          hostname: "pg.dev.tiara-stack.moe",
          protocol: "https",
          probePath: "/probe",
          tlsServerName: "pg.dev.tiara-stack.moe",
          credentialReference: "secret://tiara-stack-dev/sheet-auth/database",
        },
      });
      const second = yield* provider.checkDevelopmentDependency({
        approvedHostnames: providerConfig.approvedDevelopmentHosts,
        request: {
          sessionId: "session-b",
          role: "sheet-auth",
          processId: "process-b",
          hostname: "redis.dev.tiara-stack.moe",
          protocol: "https",
          probePath: "/probe",
          tlsServerName: "redis.dev.tiara-stack.moe",
          credentialReference: "secret://tiara-stack-dev/sheet-auth/redis",
        },
      });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(received).toEqual([
        { urlHost: `127.0.0.1:${address.port}`, sessionId: "session-a" },
        { urlHost: `127.0.0.1:${address.port}`, sessionId: "session-b" },
      ]);
      expect(fake.dependencies).toEqual([
        {
          hostname: "pg.dev.tiara-stack.moe",
          tlsServerName: "pg.dev.tiara-stack.moe",
          sessionId: "session-a",
        },
        {
          hostname: "redis.dev.tiara-stack.moe",
          tlsServerName: "redis.dev.tiara-stack.moe",
          sessionId: "session-b",
        },
      ]);
    } finally {
      yield* Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
        catch: () => new Error("loopback test server failed to close"),
      });
    }
  }),
);

it.effect("fails closed when provider config or the platform client is absent", () =>
  Effect.gen(function* () {
    const provider = makePreviewRelayProvider(undefined, undefined);
    expect(provider.configured).toBe(false);
    const result = yield* Effect.result(
      provider.createService({
        ownerToken: "owner",
        identity: { sessionId: "session-a", role: "sheet-auth", processId: "process-a" },
        listener: listener("sheet-auth", 4101, "process-a"),
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure.reason).toBe("provider-configuration-missing");
  }),
);

it.live(
  "routes allocation-ledger relay resources through the provider without local-file fallback",
  () =>
    Effect.gen(function* () {
      const fake = makeReadyProvider();
      const adapter = makePreviewRelayResourceAdapter(
        makeLocalFilesystemPreviewResourceAdapter("/tmp/preview-relay-provider-test"),
        fake.provider,
      );
      const target = listener("sheet-auth", 4101, "process-a");
      const identity = { sessionId: "session-a", role: target.role, processId: target.processId };
      const serviceKey = "preview-relay-service-sheet-auth";
      const attachmentKey = "preview-relay-attachment-sheet-auth";
      const serviceRef = yield* adapter.allocate({
        sessionId: identity.sessionId,
        ownerToken: "owner-a",
        resource: serviceKey,
        metadata: { kind: "preview-relay-service", ...target },
      });
      const attachmentRef = yield* adapter.allocate({
        sessionId: identity.sessionId,
        ownerToken: "owner-a",
        resource: attachmentKey,
        metadata: { kind: "preview-relay-attachment", ...target },
        priorResources: { [serviceKey]: serviceRef },
      });
      const serviceEntry = JSON.parse(serviceRef) as { readonly providerResourceId: string };
      const attachmentEntry = JSON.parse(attachmentRef) as { readonly providerResourceId: string };
      expect(fake.services.has(serviceEntry.providerResourceId)).toBe(true);
      expect(fake.attachments.has(attachmentEntry.providerResourceId)).toBe(true);

      yield* adapter.deleteOwned({
        sessionId: identity.sessionId,
        ownerToken: "owner-a",
        resource: attachmentKey,
        providerResourceId: attachmentRef,
      });
      yield* adapter.deleteOwned({
        sessionId: identity.sessionId,
        ownerToken: "owner-a",
        resource: serviceKey,
        providerResourceId: serviceRef,
      });
      expect(fake.attachments.has(attachmentEntry.providerResourceId)).toBe(false);
      expect(fake.services.has(serviceEntry.providerResourceId)).toBe(false);
      expect(fake.sharedManager.running).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
);

const readPolicyManifest = async (name: string) => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  return JSON.parse(
    await readFile(
      fileURLToPath(new URL(`../../../deploy/kubernetes/preview-relays/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as Record<string, unknown>;
};

it.live("ships the operator policy contract consumed by the configured API adapter", () =>
  Effect.promise(async () => {
    const [
      namespace,
      controllerRole,
      controllerBinding,
      workspaceRole,
      workspaceBinding,
      defaultDeny,
      dnsEgress,
    ] = await Promise.all([
      readPolicyManifest("namespace.json"),
      readPolicyManifest("controller-role.json"),
      readPolicyManifest("controller-rolebinding.json"),
      readPolicyManifest("workspace-attachment-role.json"),
      readPolicyManifest("workspace-attachment-rolebinding.json"),
      readPolicyManifest("default-deny-networkpolicy.json"),
      readPolicyManifest("dns-egress-networkpolicy.json"),
    ]);
    expect(namespace).toMatchObject({ kind: "Namespace", metadata: { name: "preview-relays" } });
    expect(controllerRole).toMatchObject({
      kind: "Role",
      metadata: { namespace: "preview-relays" },
    });
    expect(workspaceRole).toMatchObject({
      kind: "Role",
      metadata: { namespace: "preview-relays" },
    });
    expect(controllerRole.kind).not.toBe("ClusterRole");
    expect(workspaceRole.kind).not.toBe("ClusterRole");
    expect(controllerBinding).toMatchObject({
      kind: "RoleBinding",
      roleRef: { kind: "Role", name: "preview-relay-controller" },
    });
    expect(workspaceBinding).toMatchObject({
      kind: "RoleBinding",
      roleRef: { kind: "Role", name: "preview-relay-workspace-attachment" },
    });
    expect(JSON.stringify(controllerRole)).toContain("networkpolicies");
    expect(JSON.stringify(controllerRole)).toContain("leases");
    expect(JSON.stringify(workspaceRole)).not.toMatch(/secrets|pods\/exec|deployments/);
    expect(defaultDeny).toMatchObject({
      kind: "NetworkPolicy",
      spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"], ingress: [], egress: [] },
    });
    expect(dnsEgress).toMatchObject({ kind: "NetworkPolicy", spec: { policyTypes: ["Egress"] } });
    expect(JSON.stringify(dnsEgress)).toContain("kube-dns");
    expect(JSON.stringify(dnsEgress)).toContain('"port":53');
  }),
);

it("generates per-session policies that allow only session peers and approved development destinations", () => {
  const sessionPolicy = (sessionId: string, trafficManager = providerConfig.trafficManager) =>
    buildSessionRelayNetworkPolicy({
      sessionId,
      role: "sheet-auth",
      namespace: "preview-relays",
      applicationPort: 4101,
      relayLabels: {
        "app.kubernetes.io/managed-by": "tiara-stack-preview-relay",
        "tiara-stack.io/session-id": sessionId,
        "tiara-stack.io/role": "sheet-auth",
      },
      agentLabels: { "app.kubernetes.io/name": "telepresence-agent" },
      trafficManager,
      ingressSources: [
        {
          namespace: "tiara-stack-dev",
          podLabels: { app: "sheet-bot" },
          port: 443,
        },
      ],
      developmentDestinations: [
        {
          hostname: "pg.dev.tiara-stack.moe",
          namespace: "tiara-stack-dev",
          podLabels: { app: "postgres-development" },
          port: 5432,
        },
      ],
    });
  const first = sessionPolicy("session-a");
  const second = sessionPolicy("session-b");
  const defaultTrafficManagerPolicy = sessionPolicy("session-default", {
    namespace: "ambassador",
    podLabels: { app: "traffic-manager" },
  });
  expect(first.spec.podSelector.matchLabels["tiara-stack.io/session-id"]).toBe("session-a");
  expect(second.spec.podSelector.matchLabels["tiara-stack.io/session-id"]).toBe("session-b");
  expect(first.spec.ingress[0]?.from[1]?.podSelector.matchLabels["tiara-stack.io/session-id"]).toBe(
    "session-a",
  );
  expect(
    first.spec.egress[1]?.to[0]?.namespaceSelector.matchLabels["kubernetes.io/metadata.name"],
  ).toBe("ambassador");
  expect(first.spec.egress[1]?.to[0]?.podSelector.matchLabels).toEqual({ app: "traffic-manager" });
  expect(first.spec.egress[1]?.ports).toEqual([{ protocol: "TCP", port: 8081 }]);
  expect(defaultTrafficManagerPolicy.spec.egress[1]?.ports).toEqual([
    { protocol: "TCP", port: 8081 },
  ]);
  expect(
    first.spec.egress[2]?.to[0]?.namespaceSelector.matchLabels["kubernetes.io/metadata.name"],
  ).toBe("tiara-stack-dev");
  expect(() =>
    buildSessionRelayNetworkPolicy({
      sessionId: "session-a",
      role: "sheet-auth",
      namespace: "preview-relays",
      applicationPort: 4101,
      relayLabels: { "tiara-stack.io/session-id": "session-a" },
      agentLabels: { "app.kubernetes.io/name": "telepresence-agent" },
      trafficManager: providerConfig.trafficManager,
      ingressSources: [],
      developmentDestinations: [
        {
          hostname: "db.production.example.com",
          namespace: "tiara-stack-dev",
          podLabels: { app: "postgres-production" },
          port: 5432,
        },
      ],
    }),
  ).toThrow(PreviewRelayProviderError);
  expect(normalizeDevelopmentHostname("127.0.0.1")).toBeUndefined();
});
