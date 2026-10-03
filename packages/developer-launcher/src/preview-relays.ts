import { Schema } from "effect";
import { connectedPreviewRoles, type ConnectedPreviewRole } from "./types";

const relayIdentitySchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/)),
  role: Schema.Literals(connectedPreviewRoles),
  processId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)),
  serviceName: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  serviceFqdn: Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+$/)),
  attachmentId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/)),
  host: Schema.Literals(["127.0.0.1", "::1"]),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});

export type PreviewRelayIdentity = typeof relayIdentitySchema.Type;

export class PreviewRelayError extends Error {
  constructor(
    readonly reason:
      | "unavailable"
      | "collision"
      | "wrong-target"
      | "unsafe-destination"
      | "network"
      | "dns"
      | "tls"
      | "application-authentication",
  ) {
    super(reason);
  }
}

type AttachmentTarget = {
  readonly sessionId: string;
  readonly role: ConnectedPreviewRole;
  readonly processId: string;
  readonly port: number;
};

type RelayRecord = {
  readonly identity: PreviewRelayIdentity;
  attachment: AttachmentTarget | undefined;
};

type RelayProcessIdentity = {
  readonly sessionId: string;
  readonly role: ConnectedPreviewRole;
  readonly processId: string;
};

const matchesProcessIdentity = (actual: RelayProcessIdentity, expected: RelayProcessIdentity) =>
  actual.sessionId === expected.sessionId &&
  actual.role === expected.role &&
  actual.processId === expected.processId;

const isAttachedToTarget = (record: RelayRecord, expected: RelayProcessIdentity) =>
  record.attachment !== undefined &&
  matchesProcessIdentity(record.identity, expected) &&
  matchesProcessIdentity(record.attachment, expected);

const relayHostname = (identity: PreviewRelayIdentity) =>
  `relay-${identity.sessionId}-${identity.role}.preview-relays.svc.cluster.local`;
export const previewRelayHostRoles = [
  "sheet-web",
  "sheet-auth",
  "sheet-db-server",
  "sheet-bot",
  "sheet-workflows-api",
] as const satisfies readonly ConnectedPreviewRole[];

/** Resource keys are included in each session's existing durable allocation ledger. */
export const previewRelayAllocationResources = (roles: readonly ConnectedPreviewRole[]) =>
  roles
    .filter((role) => previewRelayHostRoles.some((hostRole) => hostRole === role))
    .flatMap((role) => [`preview-relay-service-${role}`, `preview-relay-attachment-${role}`]);

/** In-memory contract harness. Production adapters must persist these records through the ownership ledger. */
export class PreviewRelayRegistry {
  private readonly relays = new Map<string, RelayRecord>();
  private readonly serviceOwners = new Map<string, string>();
  private readonly reservedListeners = new Map<number, string>();
  private readonly developmentDependencies = new Map<string, Set<string>>();

  allocate(identity: PreviewRelayIdentity): void {
    Schema.decodeUnknownSync(relayIdentitySchema)(identity);
    if (
      identity.serviceFqdn !== relayHostname(identity) ||
      identity.serviceName !== `relay-${identity.sessionId}-${identity.role}`
    )
      throw new PreviewRelayError("wrong-target");
    if (this.relays.has(identity.attachmentId) || this.serviceOwners.has(identity.serviceFqdn)) {
      throw new PreviewRelayError("collision");
    }
    if (this.reservedListeners.has(identity.port)) throw new PreviewRelayError("collision");
    this.reservedListeners.set(identity.port, identity.attachmentId);
    this.serviceOwners.set(identity.serviceFqdn, identity.attachmentId);
    this.relays.set(identity.attachmentId, { identity, attachment: undefined });
  }

  attach(identity: PreviewRelayIdentity, target: AttachmentTarget): void {
    const record = this.relays.get(identity.attachmentId);
    if (record === undefined) throw new PreviewRelayError("unavailable");
    if (
      !matchesProcessIdentity(record.identity, identity) ||
      !matchesProcessIdentity(target, identity) ||
      target.port !== identity.port
    )
      throw new PreviewRelayError("wrong-target");
    const owner = this.reservedListeners.get(target.port);
    if (owner !== identity.attachmentId) throw new PreviewRelayError("collision");
    record.attachment = target;
  }

  detach(attachmentId: string): void {
    const record = this.relays.get(attachmentId);
    if (record === undefined) throw new PreviewRelayError("unavailable");
    record.attachment = undefined;
  }

  async request<T>(input: {
    readonly serviceFqdn: string;
    readonly expectedSessionId: string;
    readonly expectedRole: ConnectedPreviewRole;
    readonly expectedProcessId: string;
    readonly forward: (target: {
      readonly host: PreviewRelayIdentity["host"];
      readonly port: number;
      readonly sessionId: string;
      readonly role: ConnectedPreviewRole;
      readonly processId: string;
    }) => Promise<T>;
  }): Promise<T> {
    const id = this.serviceOwners.get(input.serviceFqdn);
    const record = id === undefined ? undefined : this.relays.get(id);
    const expected = {
      sessionId: input.expectedSessionId,
      role: input.expectedRole,
      processId: input.expectedProcessId,
    };
    if (record === undefined || !isAttachedToTarget(record, expected))
      throw new PreviewRelayError("unavailable");
    const identity = record.identity;
    const attachment = record.attachment;
    if (attachment === undefined) throw new PreviewRelayError("unavailable");
    return input
      .forward({
        host: identity.host,
        port: attachment.port,
        sessionId: attachment.sessionId,
        role: attachment.role,
        processId: attachment.processId,
      })
      .catch(() => {
        throw new PreviewRelayError("unavailable");
      });
  }

  validateDevelopmentDependency(hostname: string): string {
    const normalized = hostname.toLowerCase().replace(/\.$/, "");
    if (
      normalized.length > 253 ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        normalized,
      ) ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) ||
      /(^|[.-])(prod|production|live)([.-]|$)/.test(normalized)
    )
      throw new PreviewRelayError("unsafe-destination");
    return normalized;
  }

  approveDevelopmentDependency(sessionId: string, hostname: string): string {
    const fqdn = this.validateDevelopmentDependency(hostname);
    const approved = this.developmentDependencies.get(sessionId) ?? new Set<string>();
    approved.add(fqdn);
    this.developmentDependencies.set(sessionId, approved);
    return fqdn;
  }

  checkDevelopmentDependency(sessionId: string, hostname: string): string {
    const fqdn = this.validateDevelopmentDependency(hostname);
    if (!this.developmentDependencies.get(sessionId)?.has(fqdn))
      throw new PreviewRelayError("unavailable");
    // Return the configured FQDN verbatim after validation; callers retain their DNS and TLS identity.
    return hostname;
  }

  cleanup(sessionId: string): void {
    this.developmentDependencies.delete(sessionId);
    for (const [id, record] of this.relays) {
      if (record.identity.sessionId !== sessionId) continue;
      this.relays.delete(id);
      this.serviceOwners.delete(record.identity.serviceFqdn);
      if (this.reservedListeners.get(record.identity.port) === id)
        this.reservedListeners.delete(record.identity.port);
    }
  }
}
