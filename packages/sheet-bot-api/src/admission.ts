import { Context, Option, Predicate, Schema } from "effect";
import { HttpApiEndpoint } from "effect/unstable/httpapi";
import { SheetAuthAudience, SheetAuthCapabilityScope } from "sheet-auth/identity";

export const BotAdmissionPolicyMetadata = Schema.Struct({
  audience: SheetAuthAudience,
  requiredScope: SheetAuthCapabilityScope,
  principalKind: Schema.Literal("service"),
});
export type BotAdmissionPolicyMetadata = Schema.Schema.Type<typeof BotAdmissionPolicyMetadata>;

export const BotAdmissionPolicyAnnotation = Context.Service<BotAdmissionPolicyMetadata>(
  "sheet-bot-api/BotAdmissionPolicy",
);

export const BotAdmissionPolicies = Object.freeze({
  cacheRead: Object.freeze({
    audience: "sheet-bot",
    requiredScope: "bot.cache.read",
    principalKind: "service",
  }),
  deliveryWrite: Object.freeze({
    audience: "sheet-bot",
    requiredScope: "bot.delivery.write",
    principalKind: "service",
  }),
} as const satisfies Readonly<Record<string, BotAdmissionPolicyMetadata>>);

export const annotateBotAdmissionPolicy = <
  const Policy extends BotAdmissionPolicyMetadata,
  Endpoint extends HttpApiEndpoint.AnyWithProps,
>(
  endpoint: Endpoint,
  policy: Policy,
) => {
  Schema.decodeUnknownSync(BotAdmissionPolicyMetadata)(policy);
  return endpoint.annotate(BotAdmissionPolicyAnnotation, policy);
};

const hasAnnotations = (
  endpoint: unknown,
): endpoint is { readonly annotations: Context.Context<never> } =>
  Predicate.hasProperty(endpoint, "annotations") && Context.isContext(endpoint.annotations);

export const getBotAdmissionPolicy = (endpoint: unknown): BotAdmissionPolicyMetadata | undefined =>
  HttpApiEndpoint.isHttpApiEndpoint(endpoint) && hasAnnotations(endpoint)
    ? Option.getOrUndefined(Context.getOption(endpoint.annotations, BotAdmissionPolicyAnnotation))
    : undefined;
