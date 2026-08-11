import { Effect, Match, Option, Predicate, Schema } from "effect";
import type { AnyWorkflowContract } from "effect-zero-workflow/contract";
import { WorkflowInvocationUnauthorized } from "effect-zero-workflow/contract/transport";
import { EffectivePrincipal } from "sheet-auth/identity";
import { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";

const isInteractiveDeclaredFailure = Schema.is(InteractiveDeclaredFailure);
const isWorkflowInvocationUnauthorized = Schema.is(WorkflowInvocationUnauthorized);

const interactiveAuthorizationRevoked = (policy: string): InteractiveDeclaredFailure => ({
  _tag: "AuthorizationRevoked",
  policy,
});

export const interactiveInvalidRequest = (
  code: string,
  message: string,
): InteractiveDeclaredFailure => ({
  _tag: "InvalidRequest",
  code,
  message,
});

export const interactiveResourceNotFound = (resource: string): InteractiveDeclaredFailure => ({
  _tag: "ResourceNotFound",
  resource,
});

const interactiveDeliveryRejected = (
  operation: string,
  message: string,
  recoveryRequired: boolean,
): InteractiveDeclaredFailure => ({
  _tag: "DeliveryRejected",
  operation,
  message,
  recoveryRequired,
});

const mapBotAuthorizationFailure = (policy: string, error: unknown) =>
  Match.value(error).pipe(
    Match.when(
      Predicate.or(
        Predicate.isTagged("BotUnauthenticated"),
        Predicate.isTagged("BotAdmissionDenied"),
      ),
      () => Option.some(interactiveAuthorizationRevoked(policy)),
    ),
    Match.orElse(() => Option.none<InteractiveDeclaredFailure>()),
  );

const mapBotAdmissionOrResourceFailure = (policy: string, resource: string, error: unknown) => {
  const authorizationFailure = mapBotAuthorizationFailure(policy, error);
  return Option.isSome(authorizationFailure)
    ? authorizationFailure
    : Predicate.isTagged("BotResourceNotFound")(error)
      ? Option.some(interactiveResourceNotFound(resource))
      : Option.none<InteractiveDeclaredFailure>();
};

export const mapBotCacheFailure =
  <E>(
    policy: string,
    resource: string,
    operation: string,
    operationError: (operation: string, cause: unknown) => E,
  ) =>
  (error: unknown): InteractiveDeclaredFailure | E => {
    const knownFailure = mapBotAdmissionOrResourceFailure(policy, resource, error);
    if (Option.isSome(knownFailure)) {
      return knownFailure.value;
    }
    if (Predicate.isTagged("BotRequestRejected")(error)) {
      return interactiveInvalidRequest(
        "ProviderRequestRejected",
        `The ${resource} request was rejected`,
      );
    }
    return operationError(operation, error);
  };

export const requireInteractiveDiscordAccountId = (
  principal: typeof EffectivePrincipal.Type,
  policy: string,
) =>
  Match.type<typeof EffectivePrincipal.Type>().pipe(
    Match.discriminatorsExhaustive("kind")({
      service: () => Effect.fail(interactiveAuthorizationRevoked(policy)),
      user: ({ discordAccount }) =>
        Predicate.isNotUndefined(discordAccount)
          ? Effect.succeed(discordAccount.accountId)
          : Effect.fail(interactiveAuthorizationRevoked(policy)),
    }),
  )(principal);

export const mapDeliveryFailure =
  <E>(
    policy: string,
    operation: string,
    resource: string,
    recoveryRequired: boolean,
    rejectedMessage: string,
    operationError: (operation: string, cause: unknown) => E,
  ) =>
  (error: unknown): InteractiveDeclaredFailure | E => {
    const knownFailure = mapBotAdmissionOrResourceFailure(policy, resource, error);
    if (Option.isSome(knownFailure)) {
      return knownFailure.value;
    }
    if (Predicate.isTagged("BotResponseExpired")(error)) {
      return interactiveDeliveryRejected(
        operation,
        "The response is no longer available",
        recoveryRequired,
      );
    }
    if (Predicate.isTagged("BotRequestRejected")(error)) {
      return interactiveDeliveryRejected(operation, rejectedMessage, recoveryRequired);
    }
    return operationError(operation, error);
  };

export const preserveInteractiveDeclaredFailure = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, InteractiveDeclaredFailure, R> =>
  effect.pipe(
    Effect.catch((error) =>
      isInteractiveDeclaredFailure(error) ? Effect.fail(error) : Effect.die(error),
    ),
  );

export const authorizeInteractiveWorkflow = (
  contract: AnyWorkflowContract,
  execution: {
    readonly principal: typeof EffectivePrincipal.Type;
    readonly input: unknown;
  },
) =>
  Effect.flatMap(ReadOnlyWorkflowAuthorization, (authorization) =>
    authorization.authorize(contract, execution.principal, execution.input),
  ).pipe(
    Effect.mapError((error) =>
      isWorkflowInvocationUnauthorized(error)
        ? interactiveAuthorizationRevoked(contract.authorizationPolicy.policy)
        : error,
    ),
  );
