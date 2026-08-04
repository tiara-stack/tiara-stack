import { describe, expect, it } from "vitest";
import {
  IdentityCompatibilityError,
  actorProvenanceFromVerifiedOAuthClaims,
  auditAttributionFromVerifiedOAuthClaims,
  effectivePrincipalFromLegacyIdentity,
  effectivePrincipalFromVerifiedOAuthClaims,
} from "./identity-server";

describe("identity compatibility adapters", () => {
  it("adapts linked and unlinked legacy users without inventing Discord identity", () => {
    expect(
      effectivePrincipalFromLegacyIdentity({
        userId: "user-1",
        accountId: "discord-1",
        permissions: [],
      }),
    ).toEqual({
      kind: "user",
      userId: "user-1",
      discordAccount: { accountId: "discord-1" },
    });
    expect(effectivePrincipalFromLegacyIdentity({ userId: "user-2", permissions: [] })).toEqual({
      kind: "user",
      userId: "user-2",
    });
  });

  it("adapts the legacy service sentinel to a distinct service principal", () => {
    expect(
      effectivePrincipalFromLegacyIdentity({
        userId: "service_user",
        accountId: "service_user",
        clientId: "sheet-workflows",
        permissions: ["service"],
      }),
    ).toEqual({
      kind: "service",
      serviceId: "sheet-workflows",
      oauthClientId: "sheet-workflows",
    });
  });

  it("fails closed when a legacy service has no stable client identity", () => {
    expect(() =>
      effectivePrincipalFromLegacyIdentity({
        userId: "service_user",
        accountId: "service_user",
        permissions: ["service"],
      }),
    ).toThrow(IdentityCompatibilityError);
  });

  it("adapts verified user and service claims", () => {
    expect(
      effectivePrincipalFromVerifiedOAuthClaims({
        accountId: "discord-1",
        actorClientId: undefined,
        actorSub: undefined,
        clientId: "sheet-web",
        scopes: new Set(["zero.read"]),
        sub: "user-1",
      }),
    ).toEqual({
      kind: "user",
      userId: "user-1",
      discordAccount: { accountId: "discord-1" },
    });
    expect(
      effectivePrincipalFromVerifiedOAuthClaims({
        accountId: undefined,
        actorClientId: undefined,
        actorSub: undefined,
        clientId: "sheet-db-server",
        scopes: new Set(["bot.cache.read"]),
        sub: undefined,
      }),
    ).toEqual({
      kind: "service",
      serviceId: "sheet-db-server",
      oauthClientId: "sheet-db-server",
    });
  });

  it("records actor claims as provenance without changing user authority", () => {
    const claims = {
      accountId: "discord-1",
      actorClientId: "sheet-bot",
      actorSub: "sheet-bot",
      clientId: "sheet-bot",
      scopes: new Set(["workflow.enqueue"]),
      sub: "user-1",
    } as const;

    expect(actorProvenanceFromVerifiedOAuthClaims(claims)).toEqual({
      actorServiceId: "sheet-bot",
    });
    expect(auditAttributionFromVerifiedOAuthClaims(claims)).toEqual({
      effectivePrincipal: {
        kind: "user",
        userId: "user-1",
        discordAccount: { accountId: "discord-1" },
      },
      actorProvenance: { actorServiceId: "sheet-bot" },
    });
  });

  it("fails closed when actor claims disagree", () => {
    expect(() =>
      actorProvenanceFromVerifiedOAuthClaims({
        accountId: "discord-1",
        actorClientId: "sheet-bot-client",
        actorSub: "different-service",
        clientId: "sheet-bot-client",
        scopes: new Set(["workflow.enqueue"]),
        sub: "user-1",
      }),
    ).toThrow(IdentityCompatibilityError);
  });
});
