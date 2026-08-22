import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ActorProvenance,
  AuditAttribution,
  CapabilityScopesByAudience,
  EffectivePrincipal,
  ServicePrincipal,
  SheetAuthAudience,
  SheetAuthCapabilityScope,
  UserPrincipal,
  type EffectivePrincipal as EffectivePrincipalType,
  type SheetAuthAudience as SheetAuthAudienceType,
  type SheetAuthCapabilityScope as SheetAuthCapabilityScopeType,
} from "./identity";

describe("identity schemas", () => {
  it("decodes user principals with or without a Discord account", () => {
    expect(
      Schema.decodeUnknownSync(UserPrincipal)({
        kind: "user",
        userId: "user-1",
        discordAccount: { accountId: "discord-1" },
      }),
    ).toEqual({
      kind: "user",
      userId: "user-1",
      discordAccount: { accountId: "discord-1" },
    });
    expect(
      Schema.decodeUnknownSync(UserPrincipal)({ kind: "user", userId: "unlinked-user" }),
    ).toEqual({ kind: "user", userId: "unlinked-user" });
  });

  it("decodes service principals without a service-user sentinel", () => {
    expect(
      Schema.decodeUnknownSync(ServicePrincipal)({
        kind: "service",
        serviceId: "sheet-workflows",
        oauthClientId: "sheet-workflows-client",
      }),
    ).toEqual({
      kind: "service",
      serviceId: "sheet-workflows",
      oauthClientId: "sheet-workflows-client",
    });
  });

  it("rejects invalid principal identifiers and kinds", () => {
    expect(() =>
      Schema.decodeUnknownSync(EffectivePrincipal)({ kind: "user", userId: "  " }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EffectivePrincipal)({
        kind: "service-user",
        serviceId: "sheet-workflows",
        oauthClientId: "sheet-workflows-client",
      }),
    ).toThrow();
  });

  it("keeps actor provenance separate from the effective principal", () => {
    const attribution = Schema.decodeUnknownSync(AuditAttribution)({
      effectivePrincipal: { kind: "user", userId: "user-1" },
      actorProvenance: {
        actorServiceId: "sheet-bot",
        workloadIdentity: "system:serviceaccount:sheet:sheet-bot",
        interactionId: "interaction-1",
        jobKind: "discord-command",
      },
    });

    expect(Schema.decodeUnknownSync(ActorProvenance)(attribution.actorProvenance)).toEqual({
      actorServiceId: "sheet-bot",
      workloadIdentity: "system:serviceaccount:sheet:sheet-bot",
      interactionId: "interaction-1",
      jobKind: "discord-command",
    });
    expect(attribution.effectivePrincipal).toEqual({ kind: "user", userId: "user-1" });
  });

  it("defines the isolated audiences and capability scopes", () => {
    expect(Schema.decodeUnknownSync(SheetAuthAudience)("sheet-zero")).toBe("sheet-zero");
    expect(Schema.decodeUnknownSync(SheetAuthCapabilityScope)("workflow.enqueue")).toBe(
      "workflow.enqueue",
    );
    expect(CapabilityScopesByAudience).toEqual({
      "sheet-zero": ["zero.read", "zero.mutate", "workflow.enqueue"],
      "sheet-workflows-http": [
        "workflow.observe",
        "workflow.enqueue",
        "rollout.gate.write",
        "rollout.gate.evaluate",
      ],
      "sheet-bot": ["bot.cache.read", "bot.delivery.write"],
      "sheet-auth": ["token.exchange"],
    });
    expect(() => Schema.decodeUnknownSync(SheetAuthAudience)("sheet-ingress")).toThrow();
    expect(() => Schema.decodeUnknownSync(SheetAuthCapabilityScope)("service")).toThrow();
    expectTypeOf<SheetAuthAudienceType>().toEqualTypeOf<
      "sheet-zero" | "sheet-workflows-http" | "sheet-bot" | "sheet-auth"
    >();
    expectTypeOf<SheetAuthCapabilityScopeType>().toEqualTypeOf<
      | "zero.read"
      | "zero.mutate"
      | "workflow.observe"
      | "workflow.enqueue"
      | "bot.cache.read"
      | "bot.delivery.write"
      | "rollout.gate.write"
      | "rollout.gate.evaluate"
      | "token.exchange"
    >();
    expectTypeOf<EffectivePrincipalType>().toMatchTypeOf<
      | { readonly kind: "user"; readonly userId: string }
      | {
          readonly kind: "service";
          readonly serviceId: string;
          readonly oauthClientId: string;
        }
    >();
  });
});
