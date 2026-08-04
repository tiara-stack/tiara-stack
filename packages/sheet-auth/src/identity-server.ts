import { Data, Predicate, Schema } from "effect";
import {
  ActorProvenance,
  AuditAttribution,
  EffectivePrincipal,
  type AuditAttribution as AuditAttributionType,
  type EffectivePrincipal as EffectivePrincipalType,
} from "./identity";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "./oauth";

export interface LegacyResolvedIdentity {
  readonly userId: string;
  readonly accountId?: string | undefined;
  readonly clientId?: string | undefined;
  readonly permissions: readonly string[];
}

export interface VerifiedOAuthIdentityClaims {
  readonly accountId: string | undefined;
  readonly actorClientId: string | undefined;
  readonly actorSub: string | undefined;
  readonly clientId: string | undefined;
  readonly scopes: ReadonlySet<string>;
  readonly sub: string | undefined;
}

export class IdentityCompatibilityError extends Data.TaggedError("IdentityCompatibilityError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const decodeEffectivePrincipal = (input: unknown): EffectivePrincipalType => {
  try {
    return Schema.decodeUnknownSync(EffectivePrincipal)(input);
  } catch (cause) {
    throw new IdentityCompatibilityError({
      message: "Legacy identity cannot be represented as an Effective Principal",
      cause,
    });
  }
};

const requireServiceClientId = (clientId: string | undefined) => {
  if (!Predicate.isString(clientId) || clientId.trim().length === 0) {
    throw new IdentityCompatibilityError({
      message: "A service identity requires a non-empty OAuth client ID",
    });
  }
  return clientId;
};

const servicePrincipal = (clientId: string | undefined) => {
  const resolvedClientId = requireServiceClientId(clientId);
  return decodeEffectivePrincipal({
    kind: "service",
    serviceId: resolvedClientId,
    oauthClientId: resolvedClientId,
  });
};

export const effectivePrincipalFromLegacyIdentity = (
  identity: LegacyResolvedIdentity,
): EffectivePrincipalType => {
  const isService =
    identity.permissions.includes("service") ||
    identity.userId === DISCORD_SERVICE_USER_ID_SENTINEL ||
    identity.accountId === DISCORD_SERVICE_USER_ID_SENTINEL;
  if (isService) return servicePrincipal(identity.clientId);

  return decodeEffectivePrincipal({
    kind: "user",
    userId: identity.userId,
    ...(identity.accountId === undefined
      ? {}
      : { discordAccount: { accountId: identity.accountId } }),
  });
};

export const effectivePrincipalFromVerifiedOAuthClaims = (
  claims: VerifiedOAuthIdentityClaims,
): EffectivePrincipalType => {
  if (claims.sub === undefined || claims.scopes.has("service")) {
    return servicePrincipal(claims.clientId);
  }

  return decodeEffectivePrincipal({
    kind: "user",
    userId: claims.sub,
    ...(claims.accountId === undefined ? {} : { discordAccount: { accountId: claims.accountId } }),
  });
};

export const actorProvenanceFromVerifiedOAuthClaims = (claims: VerifiedOAuthIdentityClaims) => {
  if (
    claims.actorClientId !== undefined &&
    claims.actorSub !== undefined &&
    claims.actorClientId !== claims.actorSub
  ) {
    throw new IdentityCompatibilityError({
      message: "OAuth actor subject and client ID do not identify the same service",
    });
  }

  const actorServiceId = claims.actorClientId ?? claims.actorSub;
  if (actorServiceId === undefined) return undefined;

  try {
    return Schema.decodeUnknownSync(ActorProvenance)({ actorServiceId });
  } catch (cause) {
    throw new IdentityCompatibilityError({
      message: "OAuth actor claims cannot be represented as Actor Provenance",
      cause,
    });
  }
};

export const auditAttributionFromVerifiedOAuthClaims = (
  claims: VerifiedOAuthIdentityClaims,
): AuditAttributionType => {
  const actorProvenance = actorProvenanceFromVerifiedOAuthClaims(claims);
  return Schema.decodeUnknownSync(AuditAttribution)({
    effectivePrincipal: effectivePrincipalFromVerifiedOAuthClaims(claims),
    ...(actorProvenance === undefined ? {} : { actorProvenance }),
  });
};
