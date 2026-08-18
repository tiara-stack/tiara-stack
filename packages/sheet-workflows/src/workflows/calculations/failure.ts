import { Effect, Schema } from "effect";
import { WorkflowInvocationUnauthorized } from "effect-zero-workflow/contract/transport";
import {
  CalculationDeclaredFailure,
  CalculationsRecalculateSheet,
  type CalculationDeclaredFailure as CalculationFailure,
} from "sheet-workflow-contracts";

const isCalculationDeclaredFailure = Schema.is(CalculationDeclaredFailure);
export const isWorkflowInvocationUnauthorized = Schema.is(WorkflowInvocationUnauthorized);

export const calculationInvalidRequestCodes = Object.freeze({
  invalidSource: "InvalidCalculationSource",
  invalidSheetReference: "InvalidCalculationSheetReference",
  duplicateFixedTeam: "DuplicateFixedTeam",
  sourceSearchSpaceTooLarge: "CalculationSourceSearchSpaceTooLarge",
  payloadTooLarge: "CalculationProjectionPayloadTooLarge",
  incompleteSource: "IncompleteCalculationSource",
  missingSheet: "MissingSheet",
  nonCanonicalSheet: "NonCanonicalSheet",
} as const);

export type CalculationInvalidRequestCode =
  (typeof calculationInvalidRequestCodes)[keyof typeof calculationInvalidRequestCodes];

export const calculationBusinessRuleCodes = Object.freeze({
  searchSpaceTooLarge: "CalculationSearchSpaceTooLarge",
} as const);

export type CalculationBusinessRuleCode =
  (typeof calculationBusinessRuleCodes)[keyof typeof calculationBusinessRuleCodes];

export const calculationExternalOperationCodes = Object.freeze({
  providerRejected: "ProviderRejected",
  projectionWriteUnconfirmed: "ProjectionWriteUnconfirmed",
  conflictingAmbiguousOutcome: "ConflictingAmbiguousOutcome",
  projectionWriteRejected: "ProjectionWriteRejected",
  calculationProjectionEntityUnavailable: "CalculationProjectionEntityUnavailable",
} as const);

export type CalculationExternalOperationCode =
  (typeof calculationExternalOperationCodes)[keyof typeof calculationExternalOperationCodes];

export const calculationAuthorizationRevoked = (): CalculationFailure => ({
  _tag: "AuthorizationRevoked",
  policy: CalculationsRecalculateSheet.authorizationPolicy.policy,
});

export const calculationInvalidRequest = (
  code: CalculationInvalidRequestCode,
  message: string,
): CalculationFailure => ({
  _tag: "InvalidRequest",
  code,
  message,
});

export const calculationBusinessRuleRejected = (
  code: CalculationBusinessRuleCode,
  message: string,
): CalculationFailure => ({
  _tag: "BusinessRuleRejected",
  code,
  message,
});

export const calculationConfigurationMissing = (configuration: string): CalculationFailure => ({
  _tag: "ConfigurationMissing",
  configuration,
});

export const calculationExternalOperationRejected = (
  code: CalculationExternalOperationCode,
  message: string,
): CalculationFailure => ({
  _tag: "ExternalOperationRejected",
  operation: CalculationsRecalculateSheet.identity,
  code,
  message,
});

export const preserveCalculationDeclaredFailure = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, CalculationFailure, R> =>
  effect.pipe(
    Effect.catch((error) =>
      isCalculationDeclaredFailure(error) ? Effect.fail(error) : Effect.die(error),
    ),
  );
