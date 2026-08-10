import { Effect, Match, Option, Predicate, Schema } from "effect";
import type { AnyWorkflowContract } from "effect-zero-workflow/contract";
import { WorkflowInvocationUnauthorized } from "effect-zero-workflow/contract/transport";
import { EffectivePrincipal } from "sheet-auth/identity";
import { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";

const isInteractiveDeclaredFailure = Schema.is(InteractiveDeclaredFailure);
const isWorkflowInvocationUnauthorized = Schema.is(WorkflowInvocationUnauthorized);

export const interactiveAuthorizationRevoked = (policy: string): InteractiveDeclaredFailure => ({
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

export const mapBotAuthorizationFailure = (policy: string, error: unknown) =>
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
    const authorizationFailure = mapBotAuthorizationFailure(policy, error);
    if (Option.isSome(authorizationFailure)) {
      return authorizationFailure.value;
    }
    if (Predicate.isTagged("BotResourceNotFound")(error)) {
      return interactiveResourceNotFound(resource);
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
