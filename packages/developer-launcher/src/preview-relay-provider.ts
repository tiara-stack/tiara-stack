import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { hostname as getHostIdentity } from "node:os";
import { Context, Duration, Effect, Layer, Match, Predicate, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import { spawnProcess } from "./executor";
import type { ProcessExecutor } from "./types";
import type { ConnectedPreviewRole } from "./types";
import type {
  PreviewResourceAdapter,
  PreviewResourceMetadata,
  VerifiedAllocationResolution,
} from "./preview-allocations";
import { previewRelayAllocationResources, previewRelayHostRoles } from "./preview-relays";

export { previewRelayHostRoles } from "./preview-relays";
export type PreviewRelayRole = (typeof previewRelayHostRoles)[number];

export const PreviewRelayHostListenerSchema = Schema.Struct({
  role: Schema.Literals(previewRelayHostRoles),
  host: Schema.Literals(["127.0.0.1", "::1"]),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  processId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/)),
});
export type PreviewRelayHostListener = typeof PreviewRelayHostListenerSchema.Type;

const normalizeProviderHostname = (hostname: string) => {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  const fqdn =
    normalized.length <= 253 &&
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      normalized,
    ) &&
    !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) &&
    !/(^|[.-])(prod|production|live)([.-]|$)/.test(normalized);
  const developmentSuffix = [
    ".dev.tiara-stack.moe",
    ".tiara-stack-dev",
    ".tiara-stack-dev.svc",
    ".tiara-stack-dev.svc.cluster.local",
  ].some((suffix) => normalized.endsWith(suffix));
  return fqdn && developmentSuffix ? normalized : undefined;
};

const isValidKubernetesLabelKey = (key: string) => {
  const segments = key.split("/");
  if (segments.length > 2) return false;
  const name = segments.at(-1) ?? "";
  if (!/^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/.test(name)) return false;
  const prefix = segments[0];
  return (
    segments.length === 1 ||
    (prefix !== undefined &&
      prefix.length <= 253 &&
      prefix.split(".").every((label) => /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(label)))
  );
};

const isValidKubernetesLabelValue = (value: string) =>
  value === "" || /^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/.test(value);

const isValidKubernetesLabelSelector = (labels: Readonly<Record<string, string>>) =>
  Object.keys(labels).length > 0 &&
  Object.entries(labels).every(
    ([key, value]) => isValidKubernetesLabelKey(key) && isValidKubernetesLabelValue(value),
  );

const isValidKubernetesNamespace = (namespace: string) =>
  namespace.length <= 63 &&
  /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace) &&
  !/(^|-)(prod|production|live)(-|$)/.test(namespace);

const PreviewRelayProviderConfigSchema = Schema.Struct({
  environment: Schema.Literals(["tiara-stack-dev"]),
  clusterContext: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,127}$/)),
  apiServer: Schema.String.check(Schema.isPattern(/^https:\/\/[A-Za-z0-9.[\]:-]+(?::[0-9]+)?$/)),
  tokenEnvironmentName: Schema.String.check(Schema.isPattern(/^TIARA_[A-Z0-9_]+_TOKEN$/)),
  namespace: Schema.Literals(["preview-relays"]),
  telepresenceContext: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,127}$/),
  ),
  telepresenceVersion: Schema.String.check(
    Schema.isPattern(/^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/),
  ),
  trafficManager: Schema.Struct({
    namespace: Schema.String,
    podLabels: Schema.Record(Schema.String, Schema.String),
    apiPort: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  }),
  relayImage: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$/)),
  approvedDevelopmentHosts: Schema.Array(Schema.String),
  approvedCallerSources: Schema.Array(
    Schema.Struct({
      namespace: Schema.Literals(["tiara-stack-dev"]),
      podLabels: Schema.Record(Schema.String, Schema.String),
      port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    }),
  ),
  approvedDevelopmentDestinations: Schema.Array(
    Schema.Struct({
      hostname: Schema.String,
      namespace: Schema.Literals(["tiara-stack-dev"]),
      podLabels: Schema.Record(Schema.String, Schema.String),
      port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    }),
  ),
});
export type PreviewRelayProviderConfig = typeof PreviewRelayProviderConfigSchema.Type;

const isSafePreviewRelayProviderConfig = (config: PreviewRelayProviderConfig) => {
  const approvedHosts = config.approvedDevelopmentHosts.map(normalizeProviderHostname);
  const approvedHostSet = new Set(approvedHosts.filter((host) => host !== undefined));
  return (
    isValidKubernetesNamespace(config.trafficManager.namespace) &&
    isValidKubernetesLabelSelector(config.trafficManager.podLabels) &&
    config.approvedDevelopmentHosts.length > 0 &&
    approvedHosts.every((host) => host !== undefined) &&
    config.approvedCallerSources.length > 0 &&
    config.approvedCallerSources.every((source) =>
      isValidKubernetesLabelSelector(source.podLabels),
    ) &&
    config.approvedDevelopmentDestinations.length > 0 &&
    config.approvedDevelopmentDestinations.every((destination) => {
      const hostname = normalizeProviderHostname(destination.hostname);
      return (
        hostname !== undefined &&
        approvedHostSet.has(hostname) &&
        isValidKubernetesLabelSelector(destination.podLabels)
      );
    })
  );
};

export const parsePreviewRelayProviderConfig = (raw: string | undefined) => {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    const decoded = Schema.decodeUnknownOption(PreviewRelayProviderConfigSchema)(value);
    if (decoded._tag === "None") return undefined;
    const hostname = new URL(decoded.value.apiServer).hostname.toLowerCase();
    const developmentContexts = [
      decoded.value.clusterContext,
      decoded.value.telepresenceContext,
    ].every((context) => /dev/i.test(context) && !/prod/i.test(context));
    return developmentContexts &&
      isSafePreviewRelayProviderConfig(decoded.value) &&
      (hostname.endsWith(".dev.tiara-stack.moe") ||
        hostname.endsWith(".tiara-stack-dev") ||
        hostname.endsWith(".tiara-stack-dev.svc"))
      ? decoded.value
      : undefined;
  } catch {
    return undefined;
  }
};

type PreviewRelayIdentity = {
  readonly sessionId: string;
  readonly role: PreviewRelayRole;
  readonly processId: string;
};

export type PreviewRelayOwnerLabels = Readonly<Record<string, string>>;

export type PreviewRelayManifest = {
  readonly serviceName: string;
  readonly serviceFqdn: string;
  readonly namespace: "preview-relays";
  readonly image: string;
  readonly applicationPort: number;
  readonly hostListener: PreviewRelayHostListener;
  readonly labels: PreviewRelayOwnerLabels;
  readonly networkPolicy: ReturnType<typeof buildSessionRelayNetworkPolicy>;
};

export type PreviewRelayServiceReceipt = {
  readonly providerResourceId: string;
  readonly serviceName: string;
  readonly serviceFqdn: string;
  readonly labels: PreviewRelayOwnerLabels;
};

export type PreviewRelayListenerReservationReceipt = {
  readonly reservationId: string;
  readonly sessionId: string;
  readonly role: PreviewRelayRole;
  readonly processId: string;
  readonly host: PreviewRelayHostListener["host"];
  readonly port: number;
  readonly labels: PreviewRelayOwnerLabels;
};

export type PreviewRelayAttachmentReceipt = {
  readonly providerResourceId: string;
  readonly listenerReservationId: string;
  readonly sessionId: string;
  readonly role: PreviewRelayRole;
  readonly processId: string;
  readonly host: PreviewRelayHostListener["host"];
  readonly port: number;
  readonly serviceFqdn: string;
  readonly labels: PreviewRelayOwnerLabels;
};

export type PreviewRelayDependencyProbeRequest = {
  readonly sessionId: string;
  readonly role: PreviewRelayRole;
  readonly processId: string;
  readonly hostname: string;
  readonly port?: number;
  readonly protocol: "https";
  readonly probePath: string;
  readonly tlsServerName: string;
  readonly credentialReference: string | undefined;
};

export type PreviewRelayDependencyProbeResponse = {
  readonly status: number;
  readonly authenticated: boolean;
};

export type PreviewRelayResourceKind = "service" | "attachment";

export type PreviewRelayDoctorCheck = {
  readonly id: string;
  readonly status: "ready" | "failed" | "unavailable";
  readonly detail: string;
};

export type PreviewRelayDoctorInput = {
  readonly profile: string;
  readonly roles: readonly ConnectedPreviewRole[];
  readonly listeners: readonly PreviewRelayHostListener[];
};

export type PreviewRelayScopedAttachmentTarget = {
  readonly identity: PreviewRelayIdentity;
  readonly listener: PreviewRelayHostListener;
  readonly namespace: "preview-relays";
  readonly serviceName: string;
  readonly serviceFqdn: string;
  readonly sharedWorkload: {
    readonly namespace: "default";
    readonly name: "shared-workload-control";
  };
};

export const previewRelayDoctorCheckIds = [
  "telepresence-client-pin",
  "telepresence-manager-agent-pin",
  "workspace-tun-capabilities",
  "workspace-dns",
  "development-cluster-access",
  "scoped-relay-attachment",
] as const;

export class PreviewRelayProviderError extends Schema.TaggedErrorClass<PreviewRelayProviderError>()(
  "PreviewRelayProviderError",
  {
    reason: Schema.Literals([
      "provider-configuration-missing",
      "provider-client-unavailable",
      "provider-configuration-invalid",
      "unsafe-target",
      "identity-mismatch",
      "listener-collision",
      "owner-label-mismatch",
      "resource-create-failed",
      "attachment-failed",
      "resource-delete-failed",
      "dependency-not-allowlisted",
      "dependency-network-failed",
      "dependency-dns-failed",
      "dependency-tls-failed",
      "dependency-application-authentication-failed",
      "dependency-probe-failed",
    ]),
  },
) {}

export interface PreviewRelayPlatformClient {
  readonly createServiceAndRelayWorkload: (input: {
    readonly config: PreviewRelayProviderConfig;
    readonly identity: PreviewRelayIdentity;
    readonly manifest: PreviewRelayManifest;
  }) => Effect.Effect<PreviewRelayServiceReceipt, PreviewRelayProviderError>;
  readonly reserveHostListener: (input: {
    readonly identity: PreviewRelayIdentity;
    readonly listener: PreviewRelayHostListener;
    readonly labels: PreviewRelayOwnerLabels;
  }) => Effect.Effect<PreviewRelayListenerReservationReceipt, PreviewRelayProviderError>;
  readonly releaseHostListener: (input: {
    readonly reservationId: string;
    readonly labels: PreviewRelayOwnerLabels;
  }) => Effect.Effect<void, PreviewRelayProviderError>;
  readonly attachHostListener: (input: {
    readonly config: PreviewRelayProviderConfig;
    readonly identity: PreviewRelayIdentity;
    readonly service: PreviewRelayServiceReceipt;
    readonly listener: PreviewRelayHostListener;
    readonly reservation: PreviewRelayListenerReservationReceipt;
    readonly labels: PreviewRelayOwnerLabels;
  }) => Effect.Effect<PreviewRelayAttachmentReceipt, PreviewRelayProviderError>;
  readonly detachOwnedAttachment: (input: {
    readonly config: PreviewRelayProviderConfig;
    readonly providerResourceId: string;
    readonly labels: PreviewRelayOwnerLabels;
  }) => Effect.Effect<void, PreviewRelayProviderError>;
  readonly deleteOwnedServiceAndWorkload: (input: {
    readonly config: PreviewRelayProviderConfig;
    readonly providerResourceId: string;
    readonly labels: PreviewRelayOwnerLabels;
  }) => Effect.Effect<void, PreviewRelayProviderError>;
  readonly verifyOwnedResource: (input: {
    readonly config: PreviewRelayProviderConfig;
    readonly providerResourceId: string;
    readonly labels: PreviewRelayOwnerLabels;
  }) => Effect.Effect<boolean, PreviewRelayProviderError>;
  readonly resolveUnknownResource: (input: {
    readonly config: PreviewRelayProviderConfig;
    readonly sessionId: string;
    readonly role: PreviewRelayRole;
    readonly ownerToken: string;
    readonly kind: PreviewRelayResourceKind;
  }) => Effect.Effect<
    { readonly providerResourceId: string; readonly processId: string } | undefined,
    PreviewRelayProviderError
  >;
  readonly checkPreparedWorkspace: (
    input: PreviewRelayDoctorInput,
  ) => Effect.Effect<readonly PreviewRelayDoctorCheck[], PreviewRelayProviderError>;
  readonly probeDevelopmentDependency: (
    input: PreviewRelayDependencyProbeRequest,
  ) => Effect.Effect<PreviewRelayDependencyProbeResponse, PreviewRelayProviderError>;
}

type KubernetesResource = Readonly<Record<string, unknown>>;
type KubernetesRequest = (
  method: string,
  path: string,
  body?: unknown,
) => Effect.Effect<unknown, PreviewRelayProviderError>;

const isKubernetesSuccess = (status: number) => status >= 200 && status < 300;

const makeKubernetesHttpRequest = (
  httpClient: HttpClient.HttpClient,
  method: string,
  url: string,
  token: string,
  body: unknown,
) =>
  Effect.gen(function* () {
    const request = yield* makeKubernetesHttpRequestMessage(method, url, token, body);
    const response = yield* httpClient
      .execute(request)
      .pipe(
        Effect.mapError(() => new PreviewRelayProviderError({ reason: "resource-create-failed" })),
      );
    if (!isKubernetesSuccess(response.status))
      return yield* Effect.fail(
        new PreviewRelayProviderError({
          reason:
            response.status === 404
              ? "owner-label-mismatch"
              : response.status === 409
                ? "listener-collision"
                : "resource-create-failed",
        }),
      );
    if (method === "DELETE") return undefined;
    return yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
      Effect.mapError(() => new PreviewRelayProviderError({ reason: "resource-create-failed" })),
    );
  });

const makeKubernetesHttpRequestMessage = (
  method: string,
  url: string,
  token: string,
  body: unknown,
) => {
  const base =
    method === "GET"
      ? HttpClientRequest.get(url)
      : method === "POST"
        ? HttpClientRequest.post(url)
        : HttpClientRequest.make("DELETE")(url);
  const authenticated = HttpClientRequest.bearerToken(base, Redacted.make(token));
  return body === undefined
    ? Effect.succeed(authenticated)
    : HttpClientRequest.bodyJson(authenticated, body).pipe(
        Effect.mapError(() => new PreviewRelayProviderError({ reason: "resource-create-failed" })),
      );
};

const makeTelepresenceCommandRunner =
  (config: PreviewRelayProviderConfig, executor: ProcessExecutor, cwd: string) =>
  (args: readonly string[], timeoutMs: number, kind: "dependency-check" | "runtime") =>
    Effect.tryPromise({
      try: (signal) =>
        executor(
          {
            command: "telepresence",
            args: ["--context", config.telepresenceContext, ...args],
            cwd,
            env: {},
            timeoutMs,
            kind,
            readOnly: kind === "dependency-check",
            output: "capture",
          },
          signal,
        ),
      catch: () => new PreviewRelayProviderError({ reason: "attachment-failed" }),
    });

const telepresenceVersionMatches = (reported: string, expectedVersion: string) => {
  const actualVersion = reported.match(/(?:Client:\s*)?v?(\d+\.\d+\.\d+)/)?.[1];
  return actualVersion === expectedVersion.replace(/^v/, "");
};

const telepresenceManagerAndAgentVersionsMatch = (reported: string, expectedVersion: string) => {
  const expected = expectedVersion.replace(/^v/, "");
  const manager = /Traffic Manager(?: Image)?:[^\n]*?v?(\d+\.\d+\.\d+)/i.exec(reported)?.[1];
  const agent = /Traffic Agent(?: Image)?:[^\n]*?v?(\d+\.\d+\.\d+)/i.exec(reported)?.[1];
  return manager === expected && agent === expected;
};

const listenerHostDigest = (hostIdentity: string) =>
  createHash("sha256").update(hostIdentity).digest("hex").slice(0, 12);

const listenerLeaseName = (hostIdentity: string, port: number) =>
  `preview-listener-${listenerHostDigest(hostIdentity)}-${port}`;

const listenerLeaseHolder = (identity: PreviewRelayIdentity) =>
  `${identity.sessionId}/${identity.role}/${identity.processId}`;

const listenerLeasePath = (namespace: string, name: string) =>
  `/apis/coordination.k8s.io/v1/namespaces/${namespace}/leases/${name}`;

const listenerLeaseReservationId = (namespace: string, name: string) =>
  `${namespace}/lease/${name}`;

const makeHostListenerLease = (
  namespace: string,
  name: string,
  hostIdentity: string,
  identity: PreviewRelayIdentity,
  listener: PreviewRelayHostListener,
  labels: PreviewRelayOwnerLabels,
) => ({
  apiVersion: "coordination.k8s.io/v1",
  kind: "Lease",
  metadata: {
    name,
    namespace,
    labels,
    annotations: {
      "tiara-stack.io/listener-host": listener.host,
      "tiara-stack.io/workspace-host-sha256": listenerHostDigest(hostIdentity),
    },
  },
  spec: { holderIdentity: listenerLeaseHolder(identity) },
});

const listenerLeaseMetadata = (lease: unknown) => {
  if (!isRecord(lease) || !isRecord(lease.metadata) || !isRecord(lease.spec)) return undefined;
  return {
    name: lease.metadata.name,
    labels: isRecord(lease.metadata.labels) ? lease.metadata.labels : {},
    annotations: isRecord(lease.metadata.annotations) ? lease.metadata.annotations : {},
    holderIdentity: lease.spec.holderIdentity,
  };
};

const listenerLeaseHasOwner = (
  labels: PreviewRelayOwnerLabels,
  observed: Record<string, unknown>,
) => labelsMatch(labels, observed as Record<string, string>);

const listenerLeaseHasHolder = (identity: PreviewRelayIdentity, holder: unknown) =>
  holder === listenerLeaseHolder(identity);

const listenerLeaseHasTarget = (
  hostIdentity: string,
  listener: PreviewRelayHostListener,
  annotations: Record<string, unknown>,
) =>
  annotations["tiara-stack.io/listener-host"] === listener.host &&
  annotations["tiara-stack.io/workspace-host-sha256"] === listenerHostDigest(hostIdentity);

const listenerLeaseMatches = (
  lease: unknown,
  leaseName: string,
  hostIdentity: string,
  identity: PreviewRelayIdentity,
  listener: PreviewRelayHostListener,
  labels: PreviewRelayOwnerLabels,
) => {
  const metadata = listenerLeaseMetadata(lease);
  return (
    metadata !== undefined &&
    metadata.name === leaseName &&
    listenerLeaseHasOwner(labels, metadata.labels) &&
    listenerLeaseHasHolder(identity, metadata.holderIdentity) &&
    listenerLeaseHasTarget(hostIdentity, listener, metadata.annotations)
  );
};

const isOwnedAttachmentLease = (
  lease: unknown,
  leaseName: string,
  port: number,
  hostIdentity: string,
  labels: PreviewRelayOwnerLabels,
) => {
  const metadata = listenerLeaseMetadata(lease);
  if (metadata === undefined) return false;
  const sessionId = labels["tiara-stack.io/session-id"];
  const role = labels["tiara-stack.io/role"];
  const processId = labels["tiara-stack.io/process-id"];
  if (
    typeof sessionId !== "string" ||
    typeof processId !== "string" ||
    !previewRelayHostRoles.some((candidate) => candidate === role)
  )
    return false;
  const identity = { sessionId, role: role as PreviewRelayRole, processId };
  if (!sessionIdentityIsValid(identity)) return false;
  const listener = Schema.decodeUnknownOption(PreviewRelayHostListenerSchema)({
    role: identity.role,
    host: metadata.annotations["tiara-stack.io/listener-host"],
    port,
    processId,
  });
  return (
    listener._tag === "Some" &&
    listenerLeaseMatches(lease, leaseName, hostIdentity, identity, listener.value, labels)
  );
};

const listenerLeaseReceipt = (
  namespace: string,
  leaseName: string,
  identity: PreviewRelayIdentity,
  listener: PreviewRelayHostListener,
  labels: PreviewRelayOwnerLabels,
): PreviewRelayListenerReservationReceipt => ({
  reservationId: listenerLeaseReservationId(namespace, leaseName),
  sessionId: identity.sessionId,
  role: identity.role,
  processId: identity.processId,
  host: listener.host,
  port: listener.port,
  labels,
});

type ParsedAttachmentResource = {
  readonly namespace: string;
  readonly kind: string;
  readonly serviceName: string;
  readonly portText: string;
  readonly leaseName: string;
  readonly port: number;
};

const leasePortText = (leaseName: string) =>
  /^preview-listener-[a-f0-9]{12}-(\d{1,5})$/.exec(leaseName)?.[1];

const attachmentResourceSegments = (providerResourceId: string) => {
  const parts = providerResourceId.split("/");
  return parts.length === 5
    ? {
        namespace: parts[0] ?? "",
        kind: parts[1] ?? "",
        serviceName: parts[2] ?? "",
        portText: parts[3] ?? "",
        leaseName: parts[4] ?? "",
      }
    : undefined;
};

const validRelayPortText = (portText: string) => {
  const port = Number(portText);
  return Number.isInteger(port) && port >= 1 && port <= 65535 && String(port) === portText
    ? port
    : undefined;
};

const leaseNameMatchesPort = (leaseName: string, portText: string) =>
  leasePortText(leaseName) === portText;

const parseAttachmentResourceId = (
  providerResourceId: string,
): ParsedAttachmentResource | undefined => {
  const segments = attachmentResourceSegments(providerResourceId);
  if (segments === undefined) return undefined;
  const port = validRelayPortText(segments.portText);
  if (port === undefined || !leaseNameMatchesPort(segments.leaseName, segments.portText))
    return undefined;
  return { ...segments, port };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const kubernetesResourceUid = (value: unknown) =>
  isRecord(value) &&
  isRecord(value.metadata) &&
  typeof value.metadata.uid === "string" &&
  value.metadata.uid.length > 0
    ? value.metadata.uid
    : undefined;

const networkPolicySpec = (resource: unknown) =>
  isRecord(resource) && isRecord(resource.spec) ? resource.spec : undefined;

const isEmptyRecord = (value: unknown) => isRecord(value) && Object.keys(value).length === 0;

const isEmptyArray = (value: unknown) => Array.isArray(value) && value.length === 0;

const isEmptyOrOmittedArray = (value: unknown) => value === undefined || isEmptyArray(value);

const hasBothPolicyTypes = (value: unknown) =>
  Array.isArray(value) && value.includes("Ingress") && value.includes("Egress");

const isDefaultDenyPolicy = (spec: Record<string, unknown> | undefined) =>
  spec !== undefined &&
  isEmptyRecord(spec.podSelector) &&
  hasBothPolicyTypes(spec.policyTypes) &&
  isEmptyOrOmittedArray(spec.ingress) &&
  isEmptyOrOmittedArray(spec.egress);

const isSingleEgressPolicy = (spec: Record<string, unknown> | undefined) =>
  spec !== undefined &&
  Array.isArray(spec.policyTypes) &&
  spec.policyTypes.length === 1 &&
  spec.policyTypes[0] === "Egress" &&
  Array.isArray(spec.egress) &&
  spec.egress.length === 1;

const selectedRecord = (values: unknown) =>
  Array.isArray(values) && values.length === 1 && isRecord(values[0]) ? values[0] : undefined;

const selectorLabels = (selector: unknown) =>
  isRecord(selector) && isRecord(selector.matchLabels) ? selector.matchLabels : undefined;

const isDnsSelector = (destination: Record<string, unknown>) =>
  selectorLabels(destination.namespaceSelector)?.["kubernetes.io/metadata.name"] ===
    "kube-system" && selectorLabels(destination.podSelector)?.["k8s-app"] === "kube-dns";

const isDnsPort = (value: unknown) =>
  isRecord(value) && value.port === 53 && (value.protocol === "UDP" || value.protocol === "TCP");

const isDnsPorts = (value: unknown) =>
  Array.isArray(value) && value.length === 2 && value.every(isDnsPort);

const isDnsOnlyEgressPolicy = (spec: Record<string, unknown> | undefined) => {
  if (spec === undefined || !isSingleEgressPolicy(spec)) return false;
  const rule = selectedRecord(spec.egress);
  if (rule === undefined) return false;
  const destination = selectedRecord(rule.to);
  return destination !== undefined && isDnsSelector(destination) && isDnsPorts(rule.ports);
};

const verifyInstalledOperatorPolicies = (
  get: (path: string) => Effect.Effect<unknown, PreviewRelayProviderError>,
  namespace: string,
) =>
  Effect.gen(function* () {
    const root = `/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies/`;
    const defaultDeny = yield* get(`${root}preview-relays-default-deny`);
    const dnsEgress = yield* get(`${root}preview-relays-dns-egress`);
    if (
      !isDefaultDenyPolicy(networkPolicySpec(defaultDeny)) ||
      !isDnsOnlyEgressPolicy(networkPolicySpec(dnsEgress))
    )
      return yield* Effect.fail(
        new PreviewRelayProviderError({ reason: "provider-configuration-invalid" }),
      );
  });

const isOwnedRelayManifest = (
  identity: PreviewRelayIdentity,
  manifest: PreviewRelayManifest,
  namespace: string,
) =>
  manifest.serviceName === relayNameFor(identity.sessionId, identity.role) &&
  manifest.namespace === namespace &&
  Object.entries(identityOwnerLabels(identity)).every(
    ([key, value]) => manifest.labels[key] === value,
  ) &&
  /^[a-f0-9]{63}$/.test(manifest.labels["tiara-stack.io/owner-token-sha256"] ?? "");

const makeOwnedRelayService = (manifest: PreviewRelayManifest, namespace: string) => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: { name: manifest.serviceName, namespace, labels: manifest.labels },
  spec: {
    type: "ClusterIP",
    selector: manifest.labels,
    ports: [
      {
        name: "http",
        protocol: "TCP",
        port: manifest.applicationPort,
        targetPort: manifest.applicationPort,
      },
    ],
  },
});

const makeOwnedRelayDeployment = (manifest: PreviewRelayManifest, namespace: string) => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: manifest.serviceName, namespace, labels: manifest.labels },
  spec: {
    replicas: 1,
    selector: { matchLabels: manifest.labels },
    template: {
      metadata: { labels: manifest.labels },
      spec: {
        containers: [
          {
            name: "relay",
            image: manifest.image,
            args: ["serve", "--listen", `:${manifest.applicationPort}`],
            ports: [{ containerPort: manifest.applicationPort }],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              runAsNonRoot: true,
              capabilities: { drop: ["ALL"] },
              seccompProfile: { type: "RuntimeDefault" },
            },
          },
        ],
      },
    },
  },
});

const makeOwnedRelayPolicy = (manifest: PreviewRelayManifest, namespace: string) => ({
  ...manifest.networkPolicy,
  metadata: { ...manifest.networkPolicy.metadata, namespace },
});

const createOwnedRelayResources = (
  config: PreviewRelayProviderConfig,
  manifest: PreviewRelayManifest,
  create: (
    path: string,
    resource: KubernetesResource,
  ) => Effect.Effect<unknown, PreviewRelayProviderError>,
  deleteOwned: (
    path: string,
    labels: PreviewRelayOwnerLabels,
  ) => Effect.Effect<void, PreviewRelayProviderError>,
) =>
  Effect.gen(function* () {
    const servicePath = `/api/v1/namespaces/${config.namespace}/services`;
    const deploymentPath = `/apis/apps/v1/namespaces/${config.namespace}/deployments`;
    const policyPath = `/apis/networking.k8s.io/v1/namespaces/${config.namespace}/networkpolicies`;
    const ownedServicePath = `${servicePath}/${manifest.serviceName}`;
    const ownedDeploymentPath = `${deploymentPath}/${manifest.serviceName}`;
    const serviceCreate = yield* Effect.result(
      create(servicePath, makeOwnedRelayService(manifest, config.namespace)),
    );
    if (serviceCreate._tag === "Failure") return yield* Effect.fail(serviceCreate.failure);
    const deploymentCreate = yield* Effect.result(
      create(deploymentPath, makeOwnedRelayDeployment(manifest, config.namespace)),
    );
    if (deploymentCreate._tag === "Failure") {
      const rollback = yield* Effect.result(deleteOwned(ownedServicePath, manifest.labels));
      return yield* Effect.fail(
        rollback._tag === "Failure"
          ? new PreviewRelayProviderError({ reason: "resource-delete-failed" })
          : deploymentCreate.failure,
      );
    }
    const policyCreate = yield* Effect.result(
      create(policyPath, makeOwnedRelayPolicy(manifest, config.namespace)),
    );
    if (policyCreate._tag === "Failure") {
      const rollbackDeployment = yield* Effect.result(
        deleteOwned(ownedDeploymentPath, manifest.labels),
      );
      const rollbackService = yield* Effect.result(deleteOwned(ownedServicePath, manifest.labels));
      return yield* Effect.fail(
        rollbackDeployment._tag === "Failure" || rollbackService._tag === "Failure"
          ? new PreviewRelayProviderError({ reason: "resource-delete-failed" })
          : policyCreate.failure,
      );
    }
  });

const isSafeListenerReservation = (
  identity: PreviewRelayIdentity,
  listener: PreviewRelayHostListener,
  hostIdentity: string,
) =>
  sessionIdentityIsValid(identity) &&
  identity.role === listener.role &&
  identity.processId === listener.processId &&
  Number.isInteger(listener.port) &&
  listener.port >= 1 &&
  listener.port <= 65535 &&
  hostIdentity.trim().length > 0 &&
  (listener.host === "127.0.0.1" || listener.host === "::1");

const reservationReceiptOrCollision = (
  resource: unknown,
  name: string,
  namespace: string,
  hostIdentity: string,
  identity: PreviewRelayIdentity,
  listener: PreviewRelayHostListener,
  labels: PreviewRelayOwnerLabels,
) =>
  listenerLeaseMatches(resource, name, hostIdentity, identity, listener, labels)
    ? Effect.succeed(listenerLeaseReceipt(namespace, name, identity, listener, labels))
    : Effect.fail(new PreviewRelayProviderError({ reason: "listener-collision" }));

type ListenerLeaseAllocation = {
  readonly get: (path: string) => Effect.Effect<unknown, PreviewRelayProviderError>;
  readonly create: (
    path: string,
    body: KubernetesResource,
  ) => Effect.Effect<unknown, PreviewRelayProviderError>;
  readonly namespace: string;
  readonly hostIdentity: string;
  readonly name: string;
  readonly identity: PreviewRelayIdentity;
  readonly listener: PreviewRelayHostListener;
  readonly labels: PreviewRelayOwnerLabels;
};

const createOrJoinHostListenerLease = (allocation: ListenerLeaseAllocation) =>
  Effect.gen(function* () {
    const { get, namespace, hostIdentity, name, identity, listener, labels } = allocation;
    const path = listenerLeasePath(namespace, name);
    const current = yield* Effect.result(get(path));
    if (current._tag === "Success")
      return yield* reservationReceiptOrCollision(
        current.success,
        name,
        namespace,
        hostIdentity,
        identity,
        listener,
        labels,
      );
    if (current.failure.reason !== "owner-label-mismatch")
      return yield* Effect.fail(current.failure);
    return yield* createHostListenerLease(allocation);
  });

const createHostListenerLease = (allocation: ListenerLeaseAllocation) =>
  Effect.gen(function* () {
    const { get, create, namespace, hostIdentity, name, identity, listener, labels } = allocation;
    const collectionPath = `/apis/coordination.k8s.io/v1/namespaces/${namespace}/leases`;
    const created = yield* Effect.result(
      create(
        collectionPath,
        makeHostListenerLease(namespace, name, hostIdentity, identity, listener, labels),
      ),
    );
    if (created._tag === "Success")
      return yield* reservationReceiptOrCollision(
        created.success,
        name,
        namespace,
        hostIdentity,
        identity,
        listener,
        labels,
      );
    if (created.failure.reason !== "listener-collision") return yield* Effect.fail(created.failure);
    const winner = yield* Effect.result(get(listenerLeasePath(namespace, name)));
    if (winner._tag === "Failure") return yield* Effect.fail(created.failure);
    return yield* reservationReceiptOrCollision(
      winner.success,
      name,
      namespace,
      hostIdentity,
      identity,
      listener,
      labels,
    );
  });

/** Kubernetes HTTPS operations and Telepresence CLI adapter. It only addresses the configured namespace and deterministic owned names. */
export const makeConfiguredPreviewRelayPlatformClient = (
  configuredHttpClient: HttpClient.HttpClient | undefined,
  config: PreviewRelayProviderConfig,
  options: {
    readonly executor?: ProcessExecutor;
    readonly cwd?: string;
    readonly hostIdentity?: string;
    readonly token?: string;
    readonly unknownResolutionSettleDelayMs?: number;
    readonly dnsLookup?: (hostname: string) => Promise<unknown>;
    readonly workspaceCapabilitiesProbe?: () => Effect.Effect<
      { readonly tunAvailable: boolean; readonly netAdmin: boolean },
      PreviewRelayProviderError
    >;
    /** Only this adapter can prove an attachment to the selected session/role/process target. */
    readonly scopedAttachmentAuthorizationProbe?: (
      target: PreviewRelayScopedAttachmentTarget,
    ) => Effect.Effect<
      { readonly targetAllowed: boolean; readonly sharedWorkloadDenied: boolean },
      PreviewRelayProviderError
    >;
    readonly developmentDependencyProbeTimeout?: Duration.Input;
    readonly resolveCredential?: (
      reference: string | undefined,
    ) => Effect.Effect<Redacted.Redacted<string> | undefined, PreviewRelayProviderError>;
    readonly kubernetesRequest?: (input: {
      readonly method: string;
      readonly url: string;
      readonly bearerToken: string;
      readonly body?: unknown;
    }) => Effect.Effect<unknown, PreviewRelayProviderError>;
  } = {},
): PreviewRelayPlatformClient => {
  const kubernetesRequestTimeout = Duration.seconds(15);
  const doctorTimeout = Duration.seconds(60);
  const hostIdentity = options.hostIdentity ?? getHostIdentity();
  const httpClientLayer =
    configuredHttpClient === undefined
      ? Layer.mergeAll(
          FetchHttpClient.layer,
          Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }),
        )
      : Layer.succeed(HttpClient.HttpClient, configuredHttpClient);
  const request: KubernetesRequest = (method, path, body) => {
    const token = options.token ?? process.env[config.tokenEnvironmentName];
    if (token === undefined || token.trim().length === 0)
      return Effect.fail(new PreviewRelayProviderError({ reason: "provider-client-unavailable" }));
    const url = `${config.apiServer.replace(/\/+$/, "")}${path}`;
    const operation =
      options.kubernetesRequest !== undefined
        ? options.kubernetesRequest({
            method,
            url,
            bearerToken: token,
            ...(body === undefined ? {} : { body }),
          })
        : Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
            makeKubernetesHttpRequest(httpClient, method, url, token, body),
          ).pipe(Effect.provide(httpClientLayer));
    return operation.pipe(
      Effect.timeout(kubernetesRequestTimeout),
      Effect.mapError((error) =>
        error instanceof PreviewRelayProviderError
          ? error
          : new PreviewRelayProviderError({ reason: "provider-client-unavailable" }),
      ),
    );
  };
  const executor = options.executor ?? spawnProcess;
  const runCommand = makeTelepresenceCommandRunner(config, executor, options.cwd ?? process.cwd());
  const runTelepresence = (args: readonly string[]) =>
    runCommand(args, 30_000, "runtime").pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(new PreviewRelayProviderError({ reason: "attachment-failed" })),
      ),
    );
  const verifyTelepresenceVersion = () =>
    runCommand(["version", "--client"], 10_000, "dependency-check").pipe(
      Effect.flatMap((result) => {
        const reported = `${result.stdout ?? ""} ${result.stderr ?? ""}`;
        return result.exitCode === 0 &&
          telepresenceVersionMatches(reported, config.telepresenceVersion)
          ? Effect.void
          : Effect.fail(
              new PreviewRelayProviderError({ reason: "provider-configuration-invalid" }),
            );
      }),
    );
  const doctorCheck = (
    id: (typeof previewRelayDoctorCheckIds)[number],
    check: Effect.Effect<void, PreviewRelayProviderError>,
  ): Effect.Effect<PreviewRelayDoctorCheck> =>
    Effect.map(Effect.result(check), (result) =>
      result._tag === "Success"
        ? { id, status: "ready", detail: "Read-only check passed." }
        : { id, status: "failed", detail: `Read-only check failed: ${result.failure.reason}.` },
    );
  const checkWorkspaceCapabilities = (): Effect.Effect<void, PreviewRelayProviderError> => {
    const injected = options.workspaceCapabilitiesProbe?.();
    if (injected !== undefined)
      return Effect.flatMap(injected, ({ tunAvailable, netAdmin }) =>
        tunAvailable && netAdmin
          ? Effect.void
          : Effect.fail(new PreviewRelayProviderError({ reason: "provider-client-unavailable" })),
      );
    return Effect.try({
      try: () => {
        accessSync("/dev/net/tun", fsConstants.R_OK | fsConstants.W_OK);
        const status = readFileSync("/proc/self/status", "utf8");
        const effective = /^CapEff:\s*([0-9a-f]+)$/im.exec(status)?.[1];
        const netAdmin = effective !== undefined && (BigInt(`0x${effective}`) & (1n << 12n)) !== 0n;
        if (!netAdmin) throw new Error("CAP_NET_ADMIN is missing");
      },
      catch: () => new PreviewRelayProviderError({ reason: "provider-client-unavailable" }),
    });
  };
  const checkApprovedDns = () =>
    Effect.tryPromise({
      try: async () => {
        for (const hostname of config.approvedDevelopmentHosts) {
          const addresses = await (options.dnsLookup ?? lookup)(hostname);
          if (
            addresses === undefined ||
            addresses === null ||
            addresses === false ||
            (Array.isArray(addresses) && addresses.length === 0)
          )
            throw new Error("Approved development hostname resolved no addresses");
        }
      },
      catch: () => new PreviewRelayProviderError({ reason: "dependency-dns-failed" }),
    }).pipe(
      Effect.timeout(Duration.seconds(15)),
      Effect.mapError(() => new PreviewRelayProviderError({ reason: "dependency-dns-failed" })),
    );
  const checkClusterAccess = () => verifyInstalledOperatorPolicies(get, config.namespace);
  const checkScopedAttachment = (input: PreviewRelayDoctorInput) =>
    Effect.gen(function* () {
      const selectedRoles = input.roles.filter((role): role is PreviewRelayRole =>
        previewRelayHostRoles.some((candidate) => candidate === role),
      );
      if (selectedRoles.length === 0)
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "provider-configuration-invalid" }),
        );
      const sessionId = `doctor-${createHash("sha256").update(`${hostIdentity}/${input.profile}`).digest("hex").slice(0, 12)}`;
      const targets = selectedRoles.map((role) => {
        const listener = input.listeners.find((candidate) => candidate.role === role);
        if (listener === undefined || listener.processId.length === 0) return undefined;
        const targetSessionId = `doctor-${createHash("sha256").update(`${sessionId}/${listener.processId}`).digest("hex").slice(0, 12)}`;
        const serviceName = relayNameFor(targetSessionId, role);
        return {
          identity: { sessionId: targetSessionId, role, processId: listener.processId },
          listener,
          namespace: config.namespace,
          serviceName,
          serviceFqdn: `${serviceName}.${config.namespace}.svc.cluster.local`,
          sharedWorkload: {
            namespace: "default" as const,
            name: "shared-workload-control" as const,
          },
        } satisfies PreviewRelayScopedAttachmentTarget;
      });
      if (targets.some((target) => target === undefined))
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "provider-configuration-invalid" }),
        );
      if (options.scopedAttachmentAuthorizationProbe === undefined)
        return {
          id: "scoped-relay-attachment",
          status: "unavailable" as const,
          detail:
            "No adapter verified an actual Telepresence attachment to the session/role/process target; the authorization result remains unsupported.",
        };
      const authorization = yield* Effect.forEach(
        targets as PreviewRelayScopedAttachmentTarget[],
        (target) => options.scopedAttachmentAuthorizationProbe!(target),
      );
      if (
        authorization.some(
          ({ targetAllowed, sharedWorkloadDenied }) => !targetAllowed || !sharedWorkloadDenied,
        )
      )
        return {
          id: "scoped-relay-attachment",
          status: "failed" as const,
          detail:
            "The workspace identity cannot attach to the selected relay while denying the shared workload.",
        };
      return {
        id: "scoped-relay-attachment",
        status: "ready" as const,
        detail:
          "The injected adapter verified attachment to each session/role/process target and denial for the shared workload.",
      };
    });
  const servicePath = (name: string) => `/api/v1/namespaces/${config.namespace}/services/${name}`;
  const deploymentPath = (name: string) =>
    `/apis/apps/v1/namespaces/${config.namespace}/deployments/${name}`;
  const policyPath = (name: string) =>
    `/apis/networking.k8s.io/v1/namespaces/${config.namespace}/networkpolicies/${name}`;
  const get = (path: string) => request("GET", path);
  const expectedOwnedName = (labels: PreviewRelayOwnerLabels) => {
    const sessionId = labels["tiara-stack.io/session-id"];
    const role = labels["tiara-stack.io/role"];
    if (sessionId === undefined || !previewRelayHostRoles.some((candidate) => candidate === role))
      return undefined;
    return relayNameFor(sessionId, role as PreviewRelayRole);
  };
  const ownedResourceName = (
    providerResourceId: string,
    kind: "attachment" | "service",
    labels: PreviewRelayOwnerLabels,
  ) => {
    const expectedName = expectedOwnedName(labels);
    const resourceName = providerResourceId.split("/").at(-1) ?? "";
    return expectedName !== undefined &&
      resourceName === expectedName &&
      providerResourceId === `${config.namespace}/${kind}/${expectedName}`
      ? resourceName
      : undefined;
  };
  const ownedAttachmentResource = (providerResourceId: string, labels: PreviewRelayOwnerLabels) => {
    const expectedService = expectedOwnedName(labels);
    const resource = parseAttachmentResourceId(providerResourceId);
    if (expectedService === undefined || resource === undefined) return undefined;
    if (
      resource.namespace !== config.namespace ||
      resource.kind !== "attachment" ||
      resource.serviceName !== expectedService ||
      leasePortText(resource.leaseName) !== resource.portText
    )
      return undefined;
    return {
      serviceName: resource.serviceName,
      port: resource.port,
      leaseName: resource.leaseName,
    };
  };
  const owned = (value: unknown, labels: PreviewRelayOwnerLabels) => {
    if (typeof value !== "object" || value === null || !("metadata" in value)) return false;
    const metadata = (value as { metadata?: { labels?: Record<string, string> } }).metadata;
    return metadata?.labels !== undefined && labelsMatch(labels, metadata.labels);
  };
  const ownedSession = (value: unknown, labels: PreviewRelayOwnerLabels) => {
    if (typeof value !== "object" || value === null || !("metadata" in value)) return false;
    const metadata = (value as { metadata?: { labels?: Record<string, string> } }).metadata;
    return metadata?.labels !== undefined && sessionIdentityLabelsMatch(labels, metadata.labels);
  };
  const safeOwnedOrAbsent = (
    path: string,
    labels: PreviewRelayOwnerLabels,
    matchesOwner: (resource: unknown, expected: PreviewRelayOwnerLabels) => boolean,
  ) =>
    get(path).pipe(
      Effect.map((resource) => matchesOwner(resource, labels)),
      Effect.catch((error) => Effect.succeed(error.reason === "owner-label-mismatch")),
    );
  const ownedIdentity = (
    sessionId: string,
    role: PreviewRelayRole,
    ownerToken: string,
    resource: unknown,
  ): Effect.Effect<PreviewRelayIdentity, PreviewRelayProviderError> => {
    if (!isRecord(resource) || !isRecord(resource.metadata) || !isRecord(resource.metadata.labels))
      return Effect.fail(new PreviewRelayProviderError({ reason: "owner-label-mismatch" }));
    const processId = resource.metadata.labels["tiara-stack.io/process-id"];
    if (typeof processId !== "string")
      return Effect.fail(new PreviewRelayProviderError({ reason: "owner-label-mismatch" }));
    const identity = { sessionId, role, processId };
    return sessionIdentityIsValid(identity) &&
      owned(resource, previewRelayOwnerLabels(identity, ownerToken))
      ? Effect.succeed(identity)
      : Effect.fail(new PreviewRelayProviderError({ reason: "owner-label-mismatch" }));
  };
  const resolveUnknownServiceResource = (input: {
    readonly sessionId: string;
    readonly role: PreviewRelayRole;
    readonly ownerToken: string;
  }) =>
    Effect.gen(function* () {
      const name = relayNameFor(input.sessionId, input.role);
      const paths = [servicePath(name), deploymentPath(name), policyPath(`${name}-session-route`)];
      let foundIdentity: PreviewRelayIdentity | undefined;
      for (const path of paths) {
        const result = yield* Effect.result(get(path));
        if (result._tag === "Failure") {
          if (result.failure.reason === "owner-label-mismatch") continue;
          return yield* Effect.fail(result.failure);
        }
        const identity = yield* ownedIdentity(
          input.sessionId,
          input.role,
          input.ownerToken,
          result.success,
        );
        if (foundIdentity !== undefined && foundIdentity.processId !== identity.processId)
          return yield* Effect.fail(new PreviewRelayProviderError({ reason: "identity-mismatch" }));
        foundIdentity = identity;
      }
      return foundIdentity === undefined
        ? undefined
        : {
            providerResourceId: `${config.namespace}/service/${name}`,
            processId: foundIdentity.processId,
          };
    });
  const listUnknownAttachmentLeases = (input: {
    readonly sessionId: string;
    readonly role: PreviewRelayRole;
    readonly ownerToken: string;
  }): Effect.Effect<readonly unknown[], PreviewRelayProviderError> =>
    Effect.gen(function* () {
      const labels = {
        "app.kubernetes.io/managed-by": "tiara-stack-preview-relay",
        "tiara-stack.io/environment": "tiara-stack-dev",
        "tiara-stack.io/session-id": input.sessionId,
        "tiara-stack.io/role": input.role,
      };
      const selector = Object.entries(labels)
        .map(([key, value]) => `${key}=${value}`)
        .join(",");
      const path = `/apis/coordination.k8s.io/v1/namespaces/${config.namespace}/leases?labelSelector=${encodeURIComponent(selector)}`;
      const response = yield* get(path);
      if (!isRecord(response) || !Array.isArray(response.items))
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "provider-configuration-invalid" }),
        );
      return response.items;
    });
  const parseOwnedAttachmentLease = (
    input: {
      readonly sessionId: string;
      readonly role: PreviewRelayRole;
      readonly ownerToken: string;
    },
    resource: unknown,
    metadata: NonNullable<ReturnType<typeof listenerLeaseMetadata>>,
  ) =>
    Effect.gen(function* () {
      const name = metadata.name;
      const portText = typeof name === "string" ? leasePortText(name) : undefined;
      const port = portText === undefined ? undefined : validRelayPortText(portText);
      const processId = metadata.labels["tiara-stack.io/process-id"];
      const host = metadata.annotations["tiara-stack.io/listener-host"];
      if (port === undefined || typeof processId !== "string")
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "owner-label-mismatch" }),
        );
      const listener = Schema.decodeUnknownOption(PreviewRelayHostListenerSchema)({
        role: input.role,
        host,
        port,
        processId,
      });
      const identity = { sessionId: input.sessionId, role: input.role, processId };
      const labels = previewRelayOwnerLabels(identity, input.ownerToken);
      if (
        listener._tag === "None" ||
        !sessionIdentityIsValid(identity) ||
        !listenerLeaseMatches(
          resource,
          String(name),
          hostIdentity,
          identity,
          listener.value,
          labels,
        )
      )
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "owner-label-mismatch" }),
        );
      return { name: String(name), port, processId };
    });
  const resolveUnknownAttachmentLease = (
    input: {
      readonly sessionId: string;
      readonly role: PreviewRelayRole;
      readonly ownerToken: string;
    },
    resource: unknown,
  ): Effect.Effect<
    { readonly providerResourceId: string; readonly processId: string } | undefined,
    PreviewRelayProviderError
  > =>
    Effect.gen(function* () {
      const metadata = listenerLeaseMetadata(resource);
      if (metadata === undefined) return undefined;
      const expectedSelectorLabels = {
        "app.kubernetes.io/managed-by": "tiara-stack-preview-relay",
        "tiara-stack.io/environment": "tiara-stack-dev",
        "tiara-stack.io/session-id": input.sessionId,
        "tiara-stack.io/role": input.role,
      };
      const selectorMatches = Object.entries(expectedSelectorLabels).every(
        ([key, value]) => metadata.labels[key] === value,
      );
      if (!selectorMatches) return undefined;
      if (
        metadata.labels["tiara-stack.io/owner-token-sha256"] !== ownerTokenDigest(input.ownerToken)
      )
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "owner-label-mismatch" }),
        );
      const target = yield* parseOwnedAttachmentLease(input, resource, metadata);
      return {
        providerResourceId: `${config.namespace}/attachment/${relayNameFor(input.sessionId, input.role)}/${target.port}/${target.name}`,
        processId: target.processId,
      };
    });
  const resolveUnknownAttachmentResource = (input: {
    readonly sessionId: string;
    readonly role: PreviewRelayRole;
    readonly ownerToken: string;
  }) =>
    Effect.gen(function* () {
      const resources = yield* listUnknownAttachmentLeases(input);
      const matches = yield* Effect.forEach(resources, (resource) =>
        resolveUnknownAttachmentLease(input, resource),
      );
      const found = matches.filter(
        (
          resource,
        ): resource is { readonly providerResourceId: string; readonly processId: string } =>
          resource !== undefined,
      );
      if (found.length > 1)
        return yield* Effect.fail(new PreviewRelayProviderError({ reason: "identity-mismatch" }));
      return found[0];
    });
  const create = (path: string, body: KubernetesResource) => request("POST", path, body);
  const ensureOwnedDelete = (path: string, labels: PreviewRelayOwnerLabels) =>
    Effect.gen(function* () {
      const lookup = yield* Effect.result(get(path));
      if (lookup._tag === "Failure") {
        if (lookup.failure.reason === "owner-label-mismatch") return;
        return yield* Effect.fail(lookup.failure);
      }
      const current = lookup.success;
      if (!owned(current, labels))
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "owner-label-mismatch" }),
        );
      const uid = kubernetesResourceUid(current);
      if (uid === undefined)
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "owner-label-mismatch" }),
        );
      const deletion = yield* Effect.result(
        request("DELETE", path, {
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid },
        }),
      );
      if (deletion._tag === "Failure" && deletion.failure.reason !== "owner-label-mismatch")
        return yield* Effect.fail(deletion.failure);
    });
  const verifyOwnedAttachmentLease = (
    leaseName: string,
    port: number,
    labels: PreviewRelayOwnerLabels,
  ): Effect.Effect<boolean, PreviewRelayProviderError> =>
    Effect.gen(function* () {
      const lookup = yield* Effect.result(get(listenerLeasePath(config.namespace, leaseName)));
      if (lookup._tag === "Failure") {
        if (lookup.failure.reason === "owner-label-mismatch") return false;
        return yield* Effect.fail(lookup.failure);
      }
      if (!isOwnedAttachmentLease(lookup.success, leaseName, port, hostIdentity, labels))
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "owner-label-mismatch" }),
        );
      return true;
    });
  const reserveHostListener = (
    identity: PreviewRelayIdentity,
    listener: PreviewRelayHostListener,
    labels: PreviewRelayOwnerLabels,
  ) => {
    if (!isSafeListenerReservation(identity, listener, hostIdentity))
      return Effect.fail(new PreviewRelayProviderError({ reason: "unsafe-target" }));
    const name = listenerLeaseName(hostIdentity, listener.port);
    return createOrJoinHostListenerLease({
      get,
      create,
      namespace: config.namespace,
      hostIdentity,
      name,
      identity,
      listener,
      labels,
    });
  };
  const releaseHostListener = (reservationId: string, labels: PreviewRelayOwnerLabels) => {
    const prefix = `${config.namespace}/lease/`;
    const name = reservationId.startsWith(prefix) ? reservationId.slice(prefix.length) : "";
    const matches = /^preview-listener-[a-f0-9]{12}-(\d{1,5})$/.exec(name);
    const portText = matches?.[1] ?? "";
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return Effect.fail(new PreviewRelayProviderError({ reason: "owner-label-mismatch" }));
    const path = listenerLeasePath(config.namespace, name);
    return Effect.gen(function* () {
      const current = yield* Effect.result(get(path));
      if (current._tag === "Failure") {
        if (current.failure.reason === "owner-label-mismatch") return;
        return yield* Effect.fail(current.failure);
      }
      if (!owned(current.success, labels))
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "owner-label-mismatch" }),
        );
      yield* ensureOwnedDelete(path, labels);
    });
  };
  return {
    createServiceAndRelayWorkload: ({ identity: _identity, manifest }) =>
      Effect.gen(function* () {
        yield* verifyTelepresenceVersion();
        yield* verifyInstalledOperatorPolicies(get, config.namespace);
        if (!isOwnedRelayManifest(_identity, manifest, config.namespace))
          return yield* Effect.fail(new PreviewRelayProviderError({ reason: "unsafe-target" }));
        yield* createOwnedRelayResources(config, manifest, create, ensureOwnedDelete);
        return {
          providerResourceId: `${config.namespace}/service/${manifest.serviceName}`,
          serviceName: manifest.serviceName,
          serviceFqdn: manifest.serviceFqdn,
          labels: manifest.labels,
        };
      }),
    reserveHostListener: ({ identity, listener, labels }) =>
      reserveHostListener(identity, listener, labels),
    releaseHostListener: ({ reservationId, labels }) => releaseHostListener(reservationId, labels),
    attachHostListener: ({ identity, service, listener, reservation, labels }) =>
      Effect.gen(function* () {
        if (!serviceReferenceIsValid(identity, service, config.namespace))
          return yield* Effect.fail(new PreviewRelayProviderError({ reason: "unsafe-target" }));
        const currentService = yield* get(servicePath(service.serviceName));
        if (!owned(currentService, service.labels))
          return yield* Effect.fail(
            new PreviewRelayProviderError({ reason: "owner-label-mismatch" }),
          );
        yield* verifyHostListenerReservation(
          get,
          config.namespace,
          hostIdentity,
          identity,
          listener,
          reservation,
          labels,
        );
        yield* verifyTelepresenceVersion();
        yield* runTelepresence([
          "intercept",
          service.serviceName,
          "--namespace",
          config.namespace,
          "--workload",
          service.serviceName,
          "--service",
          service.serviceName,
          "--port",
          `${listener.port}:${listener.port}`,
        ]);
        return {
          providerResourceId: `${config.namespace}/attachment/${service.serviceName}/${listener.port}/${listenerLeaseName(hostIdentity, listener.port)}`,
          listenerReservationId: reservation.reservationId,
          sessionId: identity.sessionId,
          role: identity.role,
          processId: identity.processId,
          host: listener.host,
          port: listener.port,
          serviceFqdn: service.serviceFqdn,
          labels,
        };
      }),
    detachOwnedAttachment: ({ providerResourceId, labels }) => {
      const target = ownedAttachmentResource(providerResourceId, labels);
      if (target === undefined)
        return Effect.fail(new PreviewRelayProviderError({ reason: "owner-label-mismatch" }));
      return Effect.gen(function* () {
        const service = yield* Effect.result(get(servicePath(target.serviceName)));
        if (service._tag === "Success" && !ownedSession(service.success, labels))
          return yield* Effect.fail(
            new PreviewRelayProviderError({ reason: "owner-label-mismatch" }),
          );
        if (service._tag === "Failure" && service.failure.reason !== "owner-label-mismatch")
          return yield* Effect.fail(service.failure);
        const leaseIsOwned = yield* verifyOwnedAttachmentLease(
          target.leaseName,
          target.port,
          labels,
        );
        if (!leaseIsOwned) return;
        yield* runTelepresence(["leave", target.serviceName]);
        yield* ensureOwnedDelete(listenerLeasePath(config.namespace, target.leaseName), labels);
      });
    },
    deleteOwnedServiceAndWorkload: ({ providerResourceId, labels }) => {
      const name = ownedResourceName(providerResourceId, "service", labels);
      if (name === undefined)
        return Effect.fail(new PreviewRelayProviderError({ reason: "owner-label-mismatch" }));
      return Effect.gen(function* () {
        yield* ensureOwnedDelete(policyPath(`${name}-session-route`), labels);
        yield* ensureOwnedDelete(deploymentPath(name), labels);
        yield* ensureOwnedDelete(servicePath(name), labels);
      });
    },
    verifyOwnedResource: ({ providerResourceId, labels }) => {
      const serviceName = ownedResourceName(providerResourceId, "service", labels);
      if (serviceName !== undefined) {
        return Effect.gen(function* () {
          const paths = [
            servicePath(serviceName),
            deploymentPath(serviceName),
            policyPath(`${serviceName}-session-route`),
          ];
          for (const path of paths) {
            if (!(yield* safeOwnedOrAbsent(path, labels, owned))) return false;
          }
          return true;
        });
      }
      const attachment = ownedAttachmentResource(providerResourceId, labels);
      if (attachment === undefined) return Effect.succeed(false);
      return Effect.gen(function* () {
        const serviceIsSafe = yield* safeOwnedOrAbsent(
          servicePath(attachment.serviceName),
          labels,
          ownedSession,
        );
        if (!serviceIsSafe) return false;
        return yield* safeOwnedOrAbsent(
          listenerLeasePath(config.namespace, attachment.leaseName),
          labels,
          owned,
        );
      });
    },
    resolveUnknownResource: (input) =>
      Effect.gen(function* () {
        const resolve = () =>
          input.kind === "service"
            ? resolveUnknownServiceResource(input)
            : resolveUnknownAttachmentResource(input);
        const firstObservation = yield* resolve();
        if (firstObservation !== undefined) return firstObservation;
        const settleDelay = options.unknownResolutionSettleDelayMs ?? 60_000;
        if (settleDelay > 0) yield* Effect.sleep(Duration.millis(settleDelay));
        return yield* resolve();
      }),
    checkPreparedWorkspace: (input) =>
      Effect.gen(function* () {
        const client = yield* doctorCheck("telepresence-client-pin", verifyTelepresenceVersion());
        const manager = yield* doctorCheck(
          "telepresence-manager-agent-pin",
          runCommand(["status"], 10_000, "dependency-check").pipe(
            Effect.flatMap((result) => {
              const reported = `${result.stdout ?? ""} ${result.stderr ?? ""}`;
              return result.exitCode === 0 &&
                telepresenceManagerAndAgentVersionsMatch(reported, config.telepresenceVersion)
                ? Effect.void
                : Effect.fail(
                    new PreviewRelayProviderError({ reason: "provider-configuration-invalid" }),
                  );
            }),
          ),
        );
        const capabilities = yield* doctorCheck(
          "workspace-tun-capabilities",
          checkWorkspaceCapabilities(),
        );
        const dns = yield* doctorCheck("workspace-dns", checkApprovedDns());
        const cluster = yield* doctorCheck("development-cluster-access", checkClusterAccess());
        const attachmentResult = yield* Effect.result(checkScopedAttachment(input));
        const attachment =
          attachmentResult._tag === "Success"
            ? attachmentResult.success
            : {
                id: "scoped-relay-attachment",
                status: "failed" as const,
                detail: `Read-only check failed: ${attachmentResult.failure.reason}.`,
              };
        return [client, manager, capabilities, dns, cluster, attachment];
      }).pipe(
        Effect.timeout(doctorTimeout),
        Effect.mapError(
          () => new PreviewRelayProviderError({ reason: "provider-client-unavailable" }),
        ),
      ),
    probeDevelopmentDependency: (input) =>
      Effect.provide(
        Effect.gen(function* () {
          const httpClient = yield* HttpClient.HttpClient;
          const probe = makeHttpsDevelopmentDependencyProbe(
            httpClient,
            options.resolveCredential ?? resolveEnvironmentCredential,
            options.developmentDependencyProbeTimeout ?? Duration.seconds(15),
          );
          return yield* probe(input);
        }),
        httpClientLayer,
      ),
  };
};

export interface PreviewRelayProviderApi {
  readonly configured: boolean;
  readonly createService: (input: {
    readonly ownerToken: string;
    readonly identity: PreviewRelayIdentity;
    readonly listener: PreviewRelayHostListener;
  }) => Effect.Effect<PreviewRelayServiceReceipt, PreviewRelayProviderError>;
  readonly attach: (input: {
    readonly ownerToken: string;
    readonly identity: PreviewRelayIdentity;
    readonly listener: PreviewRelayHostListener;
    readonly service: PreviewRelayServiceReceipt;
  }) => Effect.Effect<PreviewRelayAttachmentReceipt, PreviewRelayProviderError>;
  readonly deleteAttachment: (input: {
    readonly ownerToken: string;
    readonly identity: PreviewRelayIdentity;
    readonly providerResourceId: string;
  }) => Effect.Effect<void, PreviewRelayProviderError>;
  readonly deleteService: (input: {
    readonly ownerToken: string;
    readonly identity: PreviewRelayIdentity;
    readonly providerResourceId: string;
  }) => Effect.Effect<void, PreviewRelayProviderError>;
  readonly verifyOwnedResource: (input: {
    readonly ownerToken: string;
    readonly identity: PreviewRelayIdentity;
    readonly providerResourceId: string;
  }) => Effect.Effect<boolean, PreviewRelayProviderError>;
  readonly resolveUnknownResource: (
    input: Parameters<NonNullable<PreviewResourceAdapter["resolveUnknown"]>>[0],
  ) => Effect.Effect<VerifiedAllocationResolution, PreviewRelayProviderError>;
  readonly checkPreparedWorkspace: (
    input: PreviewRelayDoctorInput,
  ) => Effect.Effect<readonly PreviewRelayDoctorCheck[], PreviewRelayProviderError>;
  readonly checkDevelopmentDependency: (input: {
    readonly approvedHostnames: readonly string[];
    readonly request: PreviewRelayDependencyProbeRequest;
  }) => Effect.Effect<PreviewRelayDependencyProbeResponse, PreviewRelayProviderError>;
}

export class PreviewRelayProvider extends Context.Service<
  PreviewRelayProvider,
  PreviewRelayProviderApi
>()("developer-launcher/PreviewRelayProvider") {}

const ownerTokenDigest = (ownerToken: string) =>
  createHash("sha256").update(ownerToken).digest("hex").slice(0, 63);

const identityOwnerLabels = (identity: PreviewRelayIdentity): PreviewRelayOwnerLabels => ({
  "app.kubernetes.io/managed-by": "tiara-stack-preview-relay",
  "tiara-stack.io/environment": "tiara-stack-dev",
  "tiara-stack.io/session-id": identity.sessionId,
  "tiara-stack.io/role": identity.role,
  "tiara-stack.io/process-id": identity.processId,
});

export const previewRelayOwnerLabels = (
  identity: PreviewRelayIdentity,
  ownerToken: string,
): PreviewRelayOwnerLabels => ({
  ...identityOwnerLabels(identity),
  "tiara-stack.io/owner-token-sha256": ownerTokenDigest(ownerToken),
});

const previewRelayOwnerLabelsFromDigest = (
  identity: PreviewRelayIdentity,
  ownerDigest: string,
): PreviewRelayOwnerLabels => ({
  ...identityOwnerLabels(identity),
  "tiara-stack.io/owner-token-sha256": ownerDigest,
});

const labelsMatch = (expected: PreviewRelayOwnerLabels, observed: PreviewRelayOwnerLabels) =>
  Object.entries(expected).every(([key, value]) => observed[key] === value) &&
  Object.keys(expected).length === Object.keys(observed).length;

const sameLabelKeys = (expected: Record<string, string>, observed: Record<string, string>) => {
  const expectedKeys = Object.keys(expected).sort();
  const observedKeys = Object.keys(observed).sort();
  return (
    observedKeys.length === expectedKeys.length &&
    observedKeys.every((key, index) => key === expectedKeys[index])
  );
};

const sessionIdentityLabelsMatch = (
  expected: PreviewRelayOwnerLabels,
  observed: Record<string, string>,
) =>
  Object.entries(expected).every(
    ([key, value]) => key === "tiara-stack.io/owner-token-sha256" || observed[key] === value,
  ) &&
  sameLabelKeys(expected, observed) &&
  /^[a-f0-9]{63}$/.test(observed["tiara-stack.io/owner-token-sha256"] ?? "");

export const relayNameFor = (sessionId: string, role: PreviewRelayRole) => {
  const sessionKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return `relay-${sessionKey}-${role}`;
};

export type PreviewRelayPolicyDestination = {
  readonly hostname: string;
  readonly namespace: string;
  readonly podLabels: Readonly<Record<string, string>>;
  readonly port: number;
};

export const normalizeDevelopmentHostname = (hostname: string): string | undefined => {
  return normalizeProviderHostname(hostname);
};

const isDevelopmentDestination = (destination: PreviewRelayPolicyDestination) => {
  return (
    destination.namespace === "tiara-stack-dev" &&
    normalizeDevelopmentHostname(destination.hostname) !== undefined &&
    Number.isInteger(destination.port) &&
    destination.port > 0 &&
    destination.port <= 65535 &&
    isValidKubernetesLabelSelector(destination.podLabels)
  );
};

export const buildSessionRelayNetworkPolicy = (input: {
  readonly sessionId: string;
  readonly role: PreviewRelayRole;
  readonly namespace: "preview-relays";
  readonly applicationPort: number;
  readonly relayLabels: PreviewRelayOwnerLabels;
  readonly agentLabels: PreviewRelayOwnerLabels;
  readonly trafficManager: PreviewRelayProviderConfig["trafficManager"];
  readonly ingressSources: readonly {
    readonly namespace: "tiara-stack-dev";
    readonly podLabels: Readonly<Record<string, string>>;
    readonly port: number;
  }[];
  readonly developmentDestinations: readonly PreviewRelayPolicyDestination[];
}) => {
  const trafficManagerApiPort = input.trafficManager.apiPort ?? 8081;
  if (
    input.applicationPort < 1 ||
    input.applicationPort > 65535 ||
    !Number.isInteger(input.applicationPort) ||
    !input.developmentDestinations.every(isDevelopmentDestination) ||
    !isValidKubernetesNamespace(input.trafficManager.namespace) ||
    !isValidKubernetesLabelSelector(input.trafficManager.podLabels) ||
    trafficManagerApiPort < 1 ||
    trafficManagerApiPort > 65535 ||
    !Number.isInteger(trafficManagerApiPort) ||
    input.ingressSources.some(
      (source) =>
        source.namespace !== "tiara-stack-dev" ||
        !isValidKubernetesLabelSelector(source.podLabels) ||
        !Number.isInteger(source.port) ||
        source.port < 1 ||
        source.port > 65535,
    )
  )
    throw new PreviewRelayProviderError({ reason: "unsafe-target" });

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: `${relayNameFor(input.sessionId, input.role)}-session-route`,
      namespace: input.namespace,
      labels: input.relayLabels,
    },
    spec: {
      podSelector: { matchLabels: input.relayLabels },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [
            {
              podSelector: {
                matchLabels: {
                  ...input.agentLabels,
                  "tiara-stack.io/session-id": input.sessionId,
                  "tiara-stack.io/role": input.role,
                },
              },
            },
            ...input.ingressSources.map((source) => ({
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": source.namespace },
              },
              podSelector: {
                matchLabels: {
                  ...source.podLabels,
                  "tiara-stack.io/session-id": input.sessionId,
                },
              },
            })),
          ],
          ports: [{ protocol: "TCP", port: input.applicationPort }],
        },
      ],
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
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": input.trafficManager.namespace,
                },
              },
              podSelector: { matchLabels: input.trafficManager.podLabels },
            },
          ],
          ports: [{ protocol: "TCP", port: trafficManagerApiPort }],
        },
        ...input.developmentDestinations.map((destination) => ({
          to: [
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": destination.namespace,
                  "tiara-stack.io/environment": "development",
                },
              },
              podSelector: { matchLabels: destination.podLabels },
            },
          ],
          ports: [{ protocol: "TCP", port: destination.port }],
        })),
      ],
    },
  } as const;
};

const sessionIdentityIsValid = (identity: PreviewRelayIdentity) =>
  /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(identity.sessionId) &&
  previewRelayHostRoles.some((role) => role === identity.role) &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(identity.processId);

const serviceReferenceIsValid = (
  identity: PreviewRelayIdentity,
  service: PreviewRelayServiceReceipt,
  namespace: string,
) =>
  service.serviceName === relayNameFor(identity.sessionId, identity.role) &&
  service.serviceFqdn === `${service.serviceName}.${namespace}.svc.cluster.local` &&
  service.providerResourceId === `${namespace}/service/${service.serviceName}` &&
  Object.entries(identityOwnerLabels(identity)).every(
    ([key, value]) => service.labels[key] === value,
  ) &&
  /^[a-f0-9]{63}$/.test(service.labels["tiara-stack.io/owner-token-sha256"] ?? "");

type ReadyPreviewRelayProvider = {
  readonly config: PreviewRelayProviderConfig;
  readonly client: PreviewRelayPlatformClient;
};
type RequireReadyPreviewRelayProvider = () => Effect.Effect<
  ReadyPreviewRelayProvider,
  PreviewRelayProviderError
>;

const isSafeServiceInput = (input: {
  readonly identity: PreviewRelayIdentity;
  readonly listener: PreviewRelayHostListener;
}) =>
  sessionIdentityIsValid(input.identity) &&
  input.listener.role === input.identity.role &&
  input.listener.processId === input.identity.processId &&
  (input.listener.host === "127.0.0.1" || input.listener.host === "::1");

const isSafeAttachInput = (
  input: {
    readonly identity: PreviewRelayIdentity;
    readonly listener: PreviewRelayHostListener;
    readonly service: PreviewRelayServiceReceipt;
  },
  namespace: string,
) =>
  sessionIdentityIsValid(input.identity) &&
  input.listener.role === input.identity.role &&
  input.listener.processId === input.identity.processId &&
  serviceReferenceIsValid(input.identity, input.service, namespace);

const makeRelayManifest = (
  input: {
    readonly ownerToken: string;
    readonly identity: PreviewRelayIdentity;
    readonly listener: PreviewRelayHostListener;
  },
  config: PreviewRelayProviderConfig,
): PreviewRelayManifest => {
  const labels = previewRelayOwnerLabels(input.identity, input.ownerToken);
  const serviceName = relayNameFor(input.identity.sessionId, input.identity.role);
  return {
    serviceName,
    serviceFqdn: `${serviceName}.${config.namespace}.svc.cluster.local`,
    namespace: config.namespace,
    image: config.relayImage,
    applicationPort: input.listener.port,
    hostListener: input.listener,
    labels,
    networkPolicy: makePreviewRelaySessionPolicy(input, config, labels),
  };
};

const makePreviewRelaySessionPolicy = (
  input: {
    readonly identity: PreviewRelayIdentity;
    readonly listener: PreviewRelayHostListener;
  },
  config: PreviewRelayProviderConfig,
  labels: PreviewRelayOwnerLabels,
) =>
  buildSessionRelayNetworkPolicy({
    sessionId: input.identity.sessionId,
    role: input.identity.role,
    namespace: config.namespace,
    applicationPort: input.listener.port,
    relayLabels: labels,
    agentLabels: {
      "app.kubernetes.io/name": "telepresence-agent",
      "tiara-stack.io/session-id": input.identity.sessionId,
      "tiara-stack.io/role": input.identity.role,
    },
    ingressSources: config.approvedCallerSources,
    trafficManager: config.trafficManager,
    developmentDestinations: config.approvedDevelopmentDestinations,
  });

const releaseHostReservation = (
  client: PreviewRelayPlatformClient,
  reservation: PreviewRelayListenerReservationReceipt,
  labels: PreviewRelayOwnerLabels,
) =>
  Effect.result(client.releaseHostListener({ reservationId: reservation.reservationId, labels }));

const isReservationForListener = (
  reservation: PreviewRelayListenerReservationReceipt,
  identity: PreviewRelayIdentity,
  listener: PreviewRelayHostListener,
  labels: PreviewRelayOwnerLabels,
) =>
  reservation.sessionId === identity.sessionId &&
  reservation.role === identity.role &&
  reservation.processId === identity.processId &&
  reservation.host === listener.host &&
  reservation.port === listener.port &&
  labelsMatch(labels, reservation.labels);

const verifyHostListenerReservation = (
  get: (path: string) => Effect.Effect<unknown, PreviewRelayProviderError>,
  namespace: string,
  hostIdentity: string,
  identity: PreviewRelayIdentity,
  listener: PreviewRelayHostListener,
  reservation: PreviewRelayListenerReservationReceipt,
  labels: PreviewRelayOwnerLabels,
) => {
  const leaseName = listenerLeaseName(hostIdentity, listener.port);
  if (
    !isReservationForListener(reservation, identity, listener, labels) ||
    reservation.reservationId !== listenerLeaseReservationId(namespace, leaseName)
  )
    return Effect.fail(new PreviewRelayProviderError({ reason: "listener-collision" }));
  return get(listenerLeasePath(namespace, leaseName)).pipe(
    Effect.flatMap((resource) =>
      listenerLeaseMatches(resource, leaseName, hostIdentity, identity, listener, labels)
        ? Effect.void
        : Effect.fail(new PreviewRelayProviderError({ reason: "listener-collision" })),
    ),
  );
};

const isAttachmentForReservation = (
  attachment: PreviewRelayAttachmentReceipt,
  identity: PreviewRelayIdentity,
  listener: PreviewRelayHostListener,
  service: PreviewRelayServiceReceipt,
  reservation: PreviewRelayListenerReservationReceipt,
  labels: PreviewRelayOwnerLabels,
) =>
  attachment.listenerReservationId === reservation.reservationId &&
  attachment.sessionId === identity.sessionId &&
  attachment.role === identity.role &&
  attachment.processId === identity.processId &&
  attachment.host === listener.host &&
  attachment.port === listener.port &&
  attachment.serviceFqdn === service.serviceFqdn &&
  labelsMatch(labels, attachment.labels);

const isApprovedDevelopmentDestination = (
  hostname: string,
  port: number | undefined,
  approvedHostnames: readonly string[],
  configuredHostnames: readonly string[],
  configuredDestinations: PreviewRelayProviderConfig["approvedDevelopmentDestinations"],
) => {
  const normalized = normalizeDevelopmentHostname(hostname);
  const targetPort = port ?? 443;
  return (
    normalized !== undefined &&
    Number.isInteger(targetPort) &&
    targetPort >= 1 &&
    targetPort <= 65535 &&
    [...approvedHostnames, ...configuredHostnames].some(
      (approved) => normalizeDevelopmentHostname(approved) === normalized,
    ) &&
    configuredDestinations.some(
      (destination) =>
        normalizeDevelopmentHostname(destination.hostname) === normalized &&
        destination.port === targetPort,
    )
  );
};

const makeCreateServiceOperation =
  (requireReady: RequireReadyPreviewRelayProvider) =>
  (input: {
    readonly ownerToken: string;
    readonly identity: PreviewRelayIdentity;
    readonly listener: PreviewRelayHostListener;
  }) =>
    Effect.gen(function* () {
      const ready = yield* requireReady();
      if (!isSafeServiceInput(input))
        return yield* Effect.fail(new PreviewRelayProviderError({ reason: "unsafe-target" }));
      const labels = previewRelayOwnerLabels(input.identity, input.ownerToken);
      const manifest = yield* Effect.try({
        try: () => makeRelayManifest(input, ready.config),
        catch: (error) =>
          error instanceof PreviewRelayProviderError
            ? error
            : new PreviewRelayProviderError({ reason: "provider-configuration-invalid" }),
      });
      const receipt = yield* ready.client.createServiceAndRelayWorkload({
        config: ready.config,
        identity: input.identity,
        manifest,
      });
      if (
        !serviceReferenceIsValid(input.identity, receipt, ready.config.namespace) ||
        !labelsMatch(labels, receipt.labels)
      )
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "owner-label-mismatch" }),
        );
      return receipt;
    });

const makeAttachOperation =
  (requireReady: RequireReadyPreviewRelayProvider) =>
  (input: {
    readonly ownerToken: string;
    readonly identity: PreviewRelayIdentity;
    readonly listener: PreviewRelayHostListener;
    readonly service: PreviewRelayServiceReceipt;
  }) =>
    Effect.gen(function* () {
      const ready = yield* requireReady();
      const labels = previewRelayOwnerLabels(input.identity, input.ownerToken);
      if (!isSafeAttachInput(input, ready.config.namespace))
        return yield* Effect.fail(new PreviewRelayProviderError({ reason: "identity-mismatch" }));
      const reservation = yield* ready.client.reserveHostListener({
        identity: input.identity,
        listener: input.listener,
        labels,
      });
      if (!isReservationForListener(reservation, input.identity, input.listener, labels)) {
        yield* releaseHostReservation(ready.client, reservation, labels);
        return yield* Effect.fail(new PreviewRelayProviderError({ reason: "identity-mismatch" }));
      }
      const attachment = yield* Effect.result(
        ready.client.attachHostListener({
          config: ready.config,
          identity: input.identity,
          service: input.service,
          listener: input.listener,
          reservation,
          labels,
        }),
      );
      if (attachment._tag === "Failure") {
        yield* releaseHostReservation(ready.client, reservation, labels);
        return yield* Effect.fail(attachment.failure);
      }
      if (
        !isAttachmentForReservation(
          attachment.success,
          input.identity,
          input.listener,
          input.service,
          reservation,
          labels,
        )
      ) {
        yield* releaseHostReservation(ready.client, reservation, labels);
        return yield* Effect.fail(new PreviewRelayProviderError({ reason: "identity-mismatch" }));
      }
      return attachment.success;
    });

const makeDeleteAttachmentOperation =
  (requireReady: RequireReadyPreviewRelayProvider) =>
  (input: {
    readonly ownerToken: string;
    readonly identity: PreviewRelayIdentity;
    readonly providerResourceId: string;
  }) =>
    Effect.gen(function* () {
      const ready = yield* requireReady();
      yield* ready.client.detachOwnedAttachment({
        config: ready.config,
        providerResourceId: input.providerResourceId,
        labels: previewRelayOwnerLabels(input.identity, input.ownerToken),
      });
    });

const makeDeleteServiceOperation =
  (requireReady: RequireReadyPreviewRelayProvider) =>
  (input: {
    readonly ownerToken: string;
    readonly identity: PreviewRelayIdentity;
    readonly providerResourceId: string;
  }) =>
    Effect.gen(function* () {
      const ready = yield* requireReady();
      yield* ready.client.deleteOwnedServiceAndWorkload({
        config: ready.config,
        providerResourceId: input.providerResourceId,
        labels: previewRelayOwnerLabels(input.identity, input.ownerToken),
      });
    });

const makeVerifyOwnedResourceOperation =
  (requireReady: RequireReadyPreviewRelayProvider) =>
  (input: {
    readonly ownerToken: string;
    readonly identity: PreviewRelayIdentity;
    readonly providerResourceId: string;
  }) =>
    Effect.gen(function* () {
      const ready = yield* requireReady();
      return yield* ready.client.verifyOwnedResource({
        config: ready.config,
        providerResourceId: input.providerResourceId,
        labels: previewRelayOwnerLabels(input.identity, input.ownerToken),
      });
    });

const makeCheckDevelopmentDependencyOperation =
  (requireReady: RequireReadyPreviewRelayProvider) =>
  (input: {
    readonly approvedHostnames: readonly string[];
    readonly request: PreviewRelayDependencyProbeRequest;
  }) =>
    Effect.gen(function* () {
      const ready = yield* requireReady();
      if (
        !isApprovedDevelopmentDestination(
          input.request.hostname,
          input.request.port,
          input.approvedHostnames,
          ready.config.approvedDevelopmentHosts,
          ready.config.approvedDevelopmentDestinations,
        ) ||
        !sessionIdentityIsValid(input.request)
      )
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "dependency-not-allowlisted" }),
        );
      const probe = yield* ready.client.probeDevelopmentDependency({
        ...input.request,
        hostname: input.request.hostname,
        tlsServerName: input.request.hostname,
      });
      if (!probe.authenticated)
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "dependency-application-authentication-failed" }),
        );
      if (probe.status < 200 || probe.status >= 300)
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "dependency-probe-failed" }),
        );
      return probe;
    });

const makeResolveUnknownResourceOperation =
  (requireReady: RequireReadyPreviewRelayProvider) =>
  (
    input: Parameters<NonNullable<PreviewResourceAdapter["resolveUnknown"]>>[0],
  ): Effect.Effect<VerifiedAllocationResolution, PreviewRelayProviderError> =>
    Effect.gen(function* () {
      const ready = yield* requireReady();
      const serviceRole = previewRelayHostRoles.find(
        (role) => input.resource === relayServiceResourceKey(role),
      );
      const attachmentRole = previewRelayHostRoles.find(
        (role) => input.resource === relayAttachmentResourceKey(role),
      );
      let target:
        | { readonly role: PreviewRelayRole; readonly kind: PreviewRelayResourceKind }
        | undefined;
      if (serviceRole !== undefined) target = { role: serviceRole, kind: "service" };
      if (attachmentRole !== undefined) target = { role: attachmentRole, kind: "attachment" };
      if (target === undefined || input.providerIdentities.length !== 1)
        return yield* Effect.fail(new PreviewRelayProviderError({ reason: "unsafe-target" }));
      const providerIdentity = input.providerIdentities[0];
      if (providerIdentity === undefined)
        return yield* Effect.fail(
          new PreviewRelayProviderError({ reason: "provider-configuration-invalid" }),
        );
      const providerResourceId = yield* ready.client.resolveUnknownResource({
        config: ready.config,
        sessionId: input.sessionId,
        role: target.role,
        ownerToken: input.ownerToken,
        kind: target.kind,
      });
      const reference =
        providerResourceId === undefined
          ? undefined
          : relayResourceReference(
              target.kind,
              input.ownerToken,
              {
                sessionId: input.sessionId,
                role: target.role,
                processId: providerResourceId.processId,
              },
              providerResourceId.providerResourceId,
            );
      return {
        sessionId: input.sessionId,
        resource: input.resource,
        ownerToken: input.ownerToken,
        provider: providerIdentity.provider,
        identity: providerIdentity.identity,
        verifiedAt: Date.now(),
        allocationSettled: true,
        result:
          reference === undefined
            ? { status: "absent" as const }
            : { status: "found" as const, providerResourceId: reference },
      };
    });

export const makePreviewRelayProvider = (
  rawConfig: unknown,
  client: PreviewRelayPlatformClient | undefined,
): PreviewRelayProviderApi => {
  const decoded = Schema.decodeUnknownOption(PreviewRelayProviderConfigSchema)(rawConfig);
  const config =
    decoded._tag === "Some" && isSafePreviewRelayProviderConfig(decoded.value)
      ? decoded.value
      : undefined;
  const unavailableReason =
    config === undefined
      ? "provider-configuration-missing"
      : client === undefined
        ? "provider-client-unavailable"
        : undefined;
  const requireReady: RequireReadyPreviewRelayProvider = () => {
    if (config !== undefined && client !== undefined) return Effect.succeed({ config, client });
    return Effect.fail(
      new PreviewRelayProviderError({
        reason: unavailableReason ?? "provider-configuration-missing",
      }),
    );
  };
  return {
    configured: unavailableReason === undefined,
    createService: makeCreateServiceOperation(requireReady),
    attach: makeAttachOperation(requireReady),
    deleteAttachment: makeDeleteAttachmentOperation(requireReady),
    deleteService: makeDeleteServiceOperation(requireReady),
    verifyOwnedResource: makeVerifyOwnedResourceOperation(requireReady),
    resolveUnknownResource: makeResolveUnknownResourceOperation(requireReady),
    checkPreparedWorkspace: (input) =>
      config === undefined || client === undefined
        ? Effect.succeed(
            previewRelayDoctorCheckIds.map((id) => ({
              id,
              status: "unavailable" as const,
              detail: "No explicit prepared-workspace relay provider is configured.",
            })),
          )
        : client.checkPreparedWorkspace(input),
    checkDevelopmentDependency: makeCheckDevelopmentDependencyOperation(requireReady),
  };
};

export const PreviewRelayProviderUnavailable = () => makePreviewRelayProvider(undefined, undefined);

export const PreviewRelayProviderLayer = (provider: PreviewRelayProviderApi) =>
  Layer.succeed(PreviewRelayProvider, provider);

export type PreviewRelayResourcePlan = {
  readonly resources: readonly string[];
  readonly metadata: Readonly<Record<string, PreviewResourceMetadata>>;
};

export const buildPreviewRelayResourcePlan = (
  roles: readonly ConnectedPreviewRole[],
  listeners: readonly PreviewRelayHostListener[],
):
  | { readonly plan: PreviewRelayResourcePlan; readonly error?: never }
  | { readonly plan?: never; readonly error: string } => {
  const hostRoles = previewRelayHostRoles.filter((role) => roles.includes(role));
  const unselectedListeners = listeners.filter(({ role }) => !hostRoles.includes(role));
  if (unselectedListeners.length > 0)
    return {
      error: `Host relay listeners target roles not selected by this profile: ${unselectedListeners.map(({ role }) => role).join(", ")}.`,
    };
  const selectedListeners = listeners.filter((listener) => hostRoles.includes(listener.role));
  const listenerRoles = new Set(selectedListeners.map(({ role }) => role));
  const ports = new Set(selectedListeners.map(({ port }) => port));
  if (listenerRoles.size !== selectedListeners.length || ports.size !== selectedListeners.length)
    return { error: "Selected host relay listeners must have unique roles and reserved ports." };
  const missingRoles = hostRoles.filter((role) => !listenerRoles.has(role));
  if (missingRoles.length > 0)
    return { error: `Host relay listeners are missing for: ${missingRoles.join(", ")}.` };

  const metadata: Record<string, PreviewResourceMetadata> = {};
  for (const listener of selectedListeners) {
    const serviceKey = relayServiceResourceKey(listener.role);
    const attachmentKey = relayAttachmentResourceKey(listener.role);
    const target = {
      role: listener.role,
      processId: listener.processId,
      host: listener.host,
      port: listener.port,
    };
    metadata[serviceKey] = { kind: "preview-relay-service", ...target };
    metadata[attachmentKey] = { kind: "preview-relay-attachment", ...target };
  }
  return { plan: { resources: previewRelayAllocationResources(roles), metadata } };
};

const relayServiceResourceKey = (role: PreviewRelayRole) => `preview-relay-service-${role}`;
const relayAttachmentResourceKey = (role: PreviewRelayRole) => `preview-relay-attachment-${role}`;

export const RelayResourceReferenceSchema = Schema.Struct({
  version: Schema.Literals([1]),
  kind: Schema.Literals(["service", "attachment"]),
  sessionId: Schema.String,
  role: Schema.Literals(previewRelayHostRoles),
  processId: Schema.String,
  ownerTokenDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{63}$/)),
  providerResourceId: Schema.String,
});
type RelayResourceReference = typeof RelayResourceReferenceSchema.Type;

const relayResourceReference = (
  kind: RelayResourceReference["kind"],
  ownerToken: string,
  identity: PreviewRelayIdentity,
  providerResourceId: string,
) =>
  JSON.stringify({
    version: 1,
    kind,
    sessionId: identity.sessionId,
    role: identity.role,
    processId: identity.processId,
    ownerTokenDigest: ownerTokenDigest(ownerToken),
    providerResourceId,
  } satisfies RelayResourceReference);

const decodeRelayResourceReference = (value: string): RelayResourceReference | undefined => {
  try {
    return Schema.decodeUnknownSync(RelayResourceReferenceSchema)(JSON.parse(value));
  } catch {
    return undefined;
  }
};

const relayResourceIdentity = (reference: RelayResourceReference): PreviewRelayIdentity => ({
  sessionId: reference.sessionId,
  role: reference.role,
  processId: reference.processId,
});

const RelayResourceMetadataSchema = Schema.Struct({
  kind: Schema.Literals(["preview-relay-service", "preview-relay-attachment"]),
  role: Schema.Literals(previewRelayHostRoles),
  processId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/)),
  host: Schema.Literals(["127.0.0.1", "::1"]),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});
type RelayResourceMetadata = typeof RelayResourceMetadataSchema.Type;

const isRelayResourceMetadata = (
  metadata: PreviewResourceMetadata | undefined,
): metadata is PreviewResourceMetadata & RelayResourceMetadata =>
  metadata !== undefined && Schema.is(RelayResourceMetadataSchema)(metadata);

const decodeServiceResource = (value: string) => {
  const reference = decodeRelayResourceReference(value);
  return reference?.kind === "service" ? reference : undefined;
};

type RelayAllocationInput = Parameters<PreviewResourceAdapter["allocate"]>[0];
type RelayDeletionInput = Parameters<PreviewResourceAdapter["deleteOwned"]>[0];

const makeRelayAllocationIdentity = (
  input: RelayAllocationInput,
  metadata: RelayResourceMetadata,
): PreviewRelayIdentity => ({
  sessionId: input.sessionId,
  role: metadata.role,
  processId: metadata.processId,
});

const makeRelayAllocationListener = (
  metadata: RelayResourceMetadata,
): PreviewRelayHostListener => ({
  role: metadata.role,
  host: metadata.host,
  port: metadata.port,
  processId: metadata.processId,
});

const allocateRelayService = (
  provider: PreviewRelayProviderApi,
  input: RelayAllocationInput,
  identity: PreviewRelayIdentity,
  listener: PreviewRelayHostListener,
) => {
  if (input.resource !== relayServiceResourceKey(listener.role))
    return Effect.fail(new Error("relay-service-resource-role-mismatch"));
  return provider
    .createService({ ownerToken: input.ownerToken, identity, listener })
    .pipe(
      Effect.map((receipt) =>
        relayResourceReference("service", input.ownerToken, identity, receipt.providerResourceId),
      ),
    );
};

const allocateRelayAttachment = (
  provider: PreviewRelayProviderApi,
  input: RelayAllocationInput,
  metadata: RelayResourceMetadata,
  identity: PreviewRelayIdentity,
  listener: PreviewRelayHostListener,
) => {
  const serviceReferenceText = input.priorResources?.[relayServiceResourceKey(metadata.role)];
  const serviceReference =
    serviceReferenceText === undefined ? undefined : decodeServiceResource(serviceReferenceText);
  if (
    input.resource !== relayAttachmentResourceKey(metadata.role) ||
    serviceReference === undefined ||
    serviceReference.sessionId !== input.sessionId ||
    serviceReference.role !== metadata.role ||
    serviceReference.processId !== metadata.processId
  )
    return Effect.fail(new Error("relay-attachment-service-identity-unavailable"));
  const service: PreviewRelayServiceReceipt = {
    providerResourceId: serviceReference.providerResourceId,
    serviceName: relayNameFor(identity.sessionId, identity.role),
    serviceFqdn: `${relayNameFor(identity.sessionId, identity.role)}.preview-relays.svc.cluster.local`,
    labels: previewRelayOwnerLabelsFromDigest(identity, serviceReference.ownerTokenDigest),
  };
  return provider
    .attach({ ownerToken: input.ownerToken, identity, listener, service })
    .pipe(
      Effect.map((receipt) =>
        relayResourceReference(
          "attachment",
          input.ownerToken,
          identity,
          receipt.providerResourceId,
        ),
      ),
    );
};

const allocateRelayResource = (
  base: PreviewResourceAdapter,
  provider: PreviewRelayProviderApi,
  input: RelayAllocationInput,
) => {
  if (!isRelayResourceMetadata(input.metadata)) {
    return input.resource.startsWith("preview-relay-")
      ? Effect.fail(new PreviewRelayProviderError({ reason: "unsafe-target" }))
      : base.allocate(input);
  }
  const identity = makeRelayAllocationIdentity(input, input.metadata);
  const listener = makeRelayAllocationListener(input.metadata);
  return input.metadata.kind === "preview-relay-service"
    ? allocateRelayService(provider, input, identity, listener)
    : allocateRelayAttachment(provider, input, input.metadata, identity, listener);
};

const ownsRelayLedgerReference = (reference: RelayResourceReference, input: RelayDeletionInput) =>
  reference.sessionId === input.sessionId &&
  reference.ownerTokenDigest === ownerTokenDigest(input.ownerToken) &&
  (reference.kind === "service"
    ? input.resource === relayServiceResourceKey(reference.role)
    : input.resource === relayAttachmentResourceKey(reference.role));

const deleteRelayResource = (
  base: PreviewResourceAdapter,
  provider: PreviewRelayProviderApi,
  input: RelayDeletionInput,
) => {
  const reference = decodeRelayResourceReference(input.providerResourceId);
  if (reference === undefined)
    return input.resource.startsWith("preview-relay-")
      ? Effect.fail(new PreviewRelayProviderError({ reason: "owner-label-mismatch" }))
      : base.deleteOwned(input);
  if (!ownsRelayLedgerReference(reference, input))
    return Effect.fail(new Error("relay-resource-owner-mismatch"));
  const identity = relayResourceIdentity(reference);
  return reference.kind === "service"
    ? provider.deleteService({
        ownerToken: input.ownerToken,
        identity,
        providerResourceId: reference.providerResourceId,
      })
    : provider.deleteAttachment({
        ownerToken: input.ownerToken,
        identity,
        providerResourceId: reference.providerResourceId,
      });
};

/** Routes relay resource-ledger entries through the provider and all other resources through the base adapter. */
export const makePreviewRelayResourceAdapter = (
  base: PreviewResourceAdapter,
  provider: PreviewRelayProviderApi,
): PreviewResourceAdapter => ({
  planProfile: base.planProfile,
  validateProfileAllocation: base.validateProfileAllocation,
  allocate: (input) => allocateRelayResource(base, provider, input),
  deleteOwned: (input) => deleteRelayResource(base, provider, input),
  proveCleanup: (input) =>
    Effect.gen(function* () {
      const relayProofs: boolean[] = [];
      for (const resource of input.resources) {
        const reference =
          resource.providerResourceId === null
            ? undefined
            : decodeRelayResourceReference(resource.providerResourceId);
        if (resource.resource.startsWith("preview-relay-") && reference === undefined) return false;
        if (reference === undefined) continue;
        relayProofs.push(
          yield* provider.verifyOwnedResource({
            ownerToken: resource.ownerToken,
            identity: relayResourceIdentity(reference),
            providerResourceId: reference.providerResourceId,
          }),
        );
      }
      if (relayProofs.some((proved) => !proved)) return false;
      return yield* base.proveCleanup(input);
    }),
  ...(base.resolveUnknown === undefined
    ? {}
    : {
        resolveUnknown: (input) =>
          input.resource.startsWith("preview-relay-")
            ? provider.resolveUnknownResource(input)
            : (base.resolveUnknown?.(input) ??
              Effect.fail(new Error("base-resource-ownership-resolution-unavailable"))),
      }),
});

export const classifyDependencyHttpFailure = (error: unknown): PreviewRelayProviderError => {
  const parts = [error instanceof Error ? `${error.name} ${error.message}` : String(error)];
  if (HttpClientError.isHttpClientError(error)) {
    const reason = error.reason;
    parts.push(reason._tag, reason.message);
    if ("cause" in reason && reason.cause !== undefined) {
      const cause = reason.cause;
      parts.push(
        cause instanceof Error
          ? `${cause.name} ${cause.message}`
          : (JSON.stringify(cause) ?? "unknown error"),
      );
      if (Predicate.hasProperty(cause, "code")) parts.push(String(cause.code));
    }
  }
  const value = parts.join(" ").toLowerCase();
  return Match.value(value).pipe(
    Match.when(
      (text) => /enotfound|eai_again|nxdomain|dns/.test(text),
      () => new PreviewRelayProviderError({ reason: "dependency-dns-failed" }),
    ),
    Match.when(
      (text) => /certificate|cert_|tls|ssl|handshake/.test(text),
      () => new PreviewRelayProviderError({ reason: "dependency-tls-failed" }),
    ),
    Match.when(
      (text) => /401|403|unauthori[sz]ed|forbidden|authentication/.test(text),
      () =>
        new PreviewRelayProviderError({ reason: "dependency-application-authentication-failed" }),
    ),
    Match.orElse(() => new PreviewRelayProviderError({ reason: "dependency-network-failed" })),
  );
};

const resolveEnvironmentCredential = (reference: string | undefined) => {
  if (reference === undefined) return Effect.succeed(undefined);
  const environmentName = /^env:\/\/([A-Z][A-Z0-9_]{0,127})$/.exec(reference)?.[1];
  if (environmentName === undefined)
    return Effect.fail(new PreviewRelayProviderError({ reason: "provider-configuration-invalid" }));
  const value = process.env[environmentName];
  return value === undefined || value.length === 0
    ? Effect.fail(new PreviewRelayProviderError({ reason: "provider-configuration-invalid" }))
    : Effect.succeed(Redacted.make(value));
};

const makeHttpsDevelopmentDependencyProbe =
  (
    httpClient: HttpClient.HttpClient,
    resolveCredential: (
      reference: string | undefined,
    ) => Effect.Effect<Redacted.Redacted<string> | undefined, PreviewRelayProviderError>,
    timeout: Duration.Input,
  ) =>
  (
    input: PreviewRelayDependencyProbeRequest,
  ): Effect.Effect<PreviewRelayDependencyProbeResponse, PreviewRelayProviderError> =>
    Effect.gen(function* () {
      if (
        input.protocol !== "https" ||
        input.hostname !== input.tlsServerName ||
        !input.probePath.startsWith("/") ||
        input.probePath.startsWith("//")
      )
        return yield* Effect.fail(new PreviewRelayProviderError({ reason: "unsafe-target" }));
      const credential = yield* resolveCredential(input.credentialReference);
      const port = input.port === undefined ? "" : `:${input.port}`;
      const bareRequest = HttpClientRequest.get(
        `https://${input.hostname}${port}${input.probePath}`,
      );
      const request =
        credential === undefined
          ? bareRequest
          : HttpClientRequest.bearerToken(bareRequest, credential);
      const response = yield* httpClient.execute(request).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(new PreviewRelayProviderError({ reason: "dependency-network-failed" })),
        }),
      );
      return {
        status: response.status,
        authenticated: response.status !== 401 && response.status !== 403,
      };
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          error instanceof PreviewRelayProviderError ? error : classifyDependencyHttpFailure(error),
        ),
      ),
    );
