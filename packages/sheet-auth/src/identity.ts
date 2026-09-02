import { Schema } from "effect";

const Identifier = Schema.Trimmed.check(Schema.isNonEmpty());

export const UserId = Identifier.pipe(Schema.brand("UserId"));
export type UserId = Schema.Schema.Type<typeof UserId>;

export const ServiceId = Identifier.pipe(Schema.brand("ServiceId"));
export type ServiceId = Schema.Schema.Type<typeof ServiceId>;

export const DiscordAccountId = Identifier.pipe(Schema.brand("DiscordAccountId"));
export type DiscordAccountId = Schema.Schema.Type<typeof DiscordAccountId>;

export const OAuthClientId = Identifier.pipe(Schema.brand("OAuthClientId"));
export type OAuthClientId = Schema.Schema.Type<typeof OAuthClientId>;

export const DiscordAccount = Schema.Struct({
  accountId: DiscordAccountId,
});
export type DiscordAccount = Schema.Schema.Type<typeof DiscordAccount>;

export const UserPrincipal = Schema.Struct({
  kind: Schema.Literal("user"),
  userId: UserId,
  discordAccount: Schema.optional(DiscordAccount),
});
export type UserPrincipal = Schema.Schema.Type<typeof UserPrincipal>;

export const ServicePrincipal = Schema.Struct({
  kind: Schema.Literal("service"),
  serviceId: ServiceId,
  oauthClientId: OAuthClientId,
});
export type ServicePrincipal = Schema.Schema.Type<typeof ServicePrincipal>;

export const EffectivePrincipal = Schema.Union([UserPrincipal, ServicePrincipal]);
export type EffectivePrincipal = Schema.Schema.Type<typeof EffectivePrincipal>;

export const ActorProvenance = Schema.Struct({
  actorServiceId: Schema.optional(ServiceId),
  workloadIdentity: Schema.optional(Identifier),
  interactionId: Schema.optional(Identifier),
  jobKind: Schema.optional(Identifier),
});
export type ActorProvenance = Schema.Schema.Type<typeof ActorProvenance>;

export const AuditAttribution = Schema.Struct({
  effectivePrincipal: EffectivePrincipal,
  actorProvenance: Schema.optional(ActorProvenance),
});
export type AuditAttribution = Schema.Schema.Type<typeof AuditAttribution>;

export const SheetAuthAudiences = [
  "sheet-zero",
  "sheet-workflows-http",
  "sheet-bot",
  "sheet-auth",
] as const;

export const SheetAuthAudience = Schema.Literals(SheetAuthAudiences);
export type SheetAuthAudience = Schema.Schema.Type<typeof SheetAuthAudience>;

export const SheetAuthCapabilityScopes = [
  "zero.read",
  "zero.mutate",
  "workflow.observe",
  "workflow.enqueue",
  "bot.cache.read",
  "bot.delivery.write",
  "rollout.gate.write",
  "rollout.gate.evaluate",
  "token.exchange",
] as const;

export const SheetAuthCapabilityScope = Schema.Literals(SheetAuthCapabilityScopes);
export type SheetAuthCapabilityScope = Schema.Schema.Type<typeof SheetAuthCapabilityScope>;

export const CapabilityScopesByAudience = {
  "sheet-zero": ["zero.read", "zero.mutate", "workflow.observe", "workflow.enqueue"],
  "sheet-workflows-http": [
    "workflow.observe",
    "workflow.enqueue",
    "rollout.gate.write",
    "rollout.gate.evaluate",
  ],
  "sheet-bot": ["bot.cache.read", "bot.delivery.write"],
  "sheet-auth": ["token.exchange"],
} as const satisfies Readonly<Record<SheetAuthAudience, readonly SheetAuthCapabilityScope[]>>;
