import { Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";

const Identifier = Schema.Trimmed.check(Schema.isNonEmpty());
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const HttpEvidenceUrl = Schema.String.check(Schema.isMaxLength(2_048)).check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:"
        ? undefined
        : "Expected an HTTP or HTTPS evidence URL";
    } catch {
      return "Expected an HTTP or HTTPS evidence URL";
    }
  }),
);

export const RolloutGateExecutionPath = Schema.Literals(["legacy", "replacement"]);
export type RolloutGateExecutionPath = Schema.Schema.Type<typeof RolloutGateExecutionPath>;

export const RolloutGateClient = Schema.Struct({
  platform: Identifier,
  clientId: Identifier,
});
export type RolloutGateClient = Schema.Schema.Type<typeof RolloutGateClient>;

export const RolloutGateAllPrincipalsKey = "*" as const;
export const RolloutGateEvaluatePath = "/internal/rollout-gates/evaluate" as const;
export const RolloutGateChangePath = "/internal/rollout-gates/change" as const;

const EffectivePrincipalKey = Schema.Union([
  Schema.Literal(RolloutGateAllPrincipalsKey),
  Schema.Trimmed.check(Schema.isPattern(/^(?:user|service):\S+$/)),
]);

export const RolloutGateScope = Schema.Struct({
  contractIdentity: Identifier,
  contractWireVersion: Identifier,
  client: RolloutGateClient,
  workspaceId: Schema.optional(Identifier),
});
export type RolloutGateScope = Schema.Schema.Type<typeof RolloutGateScope>;

export const RolloutGateEvaluationRequest = Schema.Struct({
  ...RolloutGateScope.fields,
  invocationId: InvocationId,
});
export type RolloutGateEvaluationRequest = Schema.Schema.Type<typeof RolloutGateEvaluationRequest>;

export const RolloutGateControlKey = Schema.Struct({
  ...RolloutGateScope.fields,
  effectivePrincipalKey: Schema.optional(EffectivePrincipalKey),
});
export type RolloutGateControlKey = Schema.Schema.Type<typeof RolloutGateControlKey>;

export const RolloutGateDecision = Schema.Struct({
  gateKey: Identifier,
  revision: NonNegativeInt,
  matched: Schema.Boolean,
  executionPath: RolloutGateExecutionPath,
  reason: Identifier,
});
export type RolloutGateDecision = Schema.Schema.Type<typeof RolloutGateDecision>;

export const RolloutGateChangeRequest = Schema.Struct({
  ...RolloutGateControlKey.fields,
  executionPath: RolloutGateExecutionPath,
  reason: Identifier,
  evidenceUrl: HttpEvidenceUrl,
  expectedRevision: NonNegativeInt,
});
export type RolloutGateChangeRequest = Schema.Schema.Type<typeof RolloutGateChangeRequest>;

export const RolloutGateChangeResponse = Schema.Struct({
  gateKey: Identifier,
  revision: NonNegativeInt,
  executionPath: RolloutGateExecutionPath,
});
export type RolloutGateChangeResponse = Schema.Schema.Type<typeof RolloutGateChangeResponse>;
