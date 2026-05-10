import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import {
  type AgentAspect,
  type ConsolidatedReview,
  type SpecialistReviewOutput,
  InvalidAgentOutput,
} from "../review/types";
export {
  ProviderAiReviewClient,
  SdkCodexReviewClient,
  type AiReviewClient,
  type AiRunOptions,
  type AiRunResult,
  type CodexReviewClient,
  type CodexRunOptions,
  type CodexRunResult,
} from "../ai/client";

export const SeveritySchema = Schema.Union([
  Schema.Literal("high"),
  Schema.Literal("medium"),
  Schema.Literal("low"),
]);
export const FindingTypeSchema = Schema.Union([
  Schema.Literal("security"),
  Schema.Literal("code-quality"),
  Schema.Literal("logic-bug"),
  Schema.Literal("race-condition"),
  Schema.Literal("test-flakiness"),
  Schema.Literal("maintainability"),
]);
export const FindingSchema = Schema.Struct({
  severity: SeveritySchema,
  type: FindingTypeSchema,
  location: Schema.NullOr(Schema.String),
  issue: Schema.String,
  evidence: Schema.String,
  suggestedFix: Schema.String,
});
export const PriorIssueRecheckSchema = Schema.Struct({
  priorIssue: Schema.String,
  priorFindingId: Schema.NullOr(Schema.String),
  status: Schema.Union([
    Schema.Literal("fixed"),
    Schema.Literal("not-fixed"),
    Schema.Literal("unclear"),
  ]),
  evidence: Schema.String,
});

export const SpecialistOutputSchema = Schema.Struct({
  aspect: Schema.Union([
    Schema.Literal("security"),
    Schema.Literal("code-quality"),
    Schema.Literal("logic-bugs"),
    Schema.Literal("race-conditions"),
    Schema.Literal("test-flakiness"),
    Schema.Literal("maintainability"),
  ]),
  findings: Schema.Array(FindingSchema),
  priorIssuesRechecked: Schema.Array(PriorIssueRecheckSchema),
  contextUsed: Schema.Struct({
    baseReviewed: Schema.String,
    currentCheckpoint: Schema.String,
    extraContextInspected: Schema.String,
  }),
  markdown: Schema.String,
});

export const ConsolidatedOutputSchema = Schema.Struct({
  baseReviewed: Schema.String,
  currentCheckpoint: Schema.String,
  safetyConfidence: Schema.Union([
    Schema.Literal(0),
    Schema.Literal(1),
    Schema.Literal(2),
    Schema.Literal(3),
    Schema.Literal(4),
    Schema.Literal(5),
  ]),
  issues: Schema.Array(FindingSchema),
  priorIssuesRechecked: Schema.Array(PriorIssueRecheckSchema),
  reviewNotes: Schema.Array(Schema.String),
});

export const findingJsonSchema = Tool.getJsonSchemaFromSchema(FindingSchema);
export const specialistOutputSchema = Tool.getJsonSchemaFromSchema(SpecialistOutputSchema);
export const consolidatedOutputSchema = Tool.getJsonSchemaFromSchema(ConsolidatedOutputSchema);

export const decodeSpecialistOutput = (aspect: AgentAspect, input: unknown) =>
  Schema.decodeUnknownEffect(SpecialistOutputSchema)(input).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidAgentOutput({ aspect, message: String(cause), output: JSON.stringify(input) }),
    ),
    Effect.flatMap((output) =>
      output.aspect === aspect
        ? Effect.succeed(output)
        : Effect.fail(
            new InvalidAgentOutput({
              aspect,
              message: `Specialist returned aspect ${output.aspect} for assigned aspect ${aspect}`,
              output: JSON.stringify(input),
            }),
          ),
    ),
  ) as Effect.Effect<SpecialistReviewOutput, InvalidAgentOutput>;

export const decodeConsolidatedOutput = (aspect: AgentAspect, input: unknown) =>
  Schema.decodeUnknownEffect(ConsolidatedOutputSchema)(input).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidAgentOutput({ aspect, message: String(cause), output: JSON.stringify(input) }),
    ),
  ) as Effect.Effect<ConsolidatedReview, InvalidAgentOutput>;
