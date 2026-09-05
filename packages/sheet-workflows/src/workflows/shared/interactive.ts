import { Effect, Match, Option, Predicate, Schema } from "effect";
import type { AnyWorkflowContract } from "effect-zero-workflow/contract";
import { WorkflowInvocationUnauthorized } from "effect-zero-workflow/contract/transport";
import { EffectivePrincipal } from "sheet-auth/identity";
import {
  AutonomousDeclaredFailure,
  CheckinsRespond,
  InteractiveDeclaredFailure,
  RoomOrdersCreate,
  RoomOrdersNavigate,
  RoomOrdersPinTentative,
  RoomOrdersSend,
  SlotsOpen,
  WorkspaceId,
} from "sheet-workflow-contracts";
import { config } from "@/config";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";

export const isInteractiveDeclaredFailure = Schema.is(InteractiveDeclaredFailure);
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

export const interactiveResourceNotFound = (
  resource: string,
  resourceId?: string,
): InteractiveDeclaredFailure => ({
  _tag: "ResourceNotFound",
  resource,
  ...(Predicate.isUndefined(resourceId) ? {} : { resourceId }),
});

export const interactiveConfigurationMissing = (
  configuration: string,
): InteractiveDeclaredFailure => ({
  _tag: "ConfigurationMissing",
  configuration,
});

export const interactiveBusinessRuleRejected = (
  code: string,
  message: string,
): InteractiveDeclaredFailure => ({
  _tag: "BusinessRuleRejected",
  code,
  message,
});

export const interactiveExternalOperationRejected = (
  operation: string,
  code: string,
  message: string,
): InteractiveDeclaredFailure => ({
  _tag: "ExternalOperationRejected",
  operation,
  code,
  message,
});

export const interactiveDeliveryRejected = (
  operation: string,
  message: string,
  recoveryRequired: boolean,
  committedReference?: string,
): InteractiveDeclaredFailure => ({
  _tag: "DeliveryRejected",
  operation,
  message,
  ...(Predicate.isUndefined(committedReference) ? {} : { committedReference }),
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

const mapBotKnownRequestFailure = (
  policy: string,
  resource: string,
  error: unknown,
  onRequestRejected: () => InteractiveDeclaredFailure,
): Option.Option<InteractiveDeclaredFailure> => {
  const admissionFailure = mapBotAdmissionOrResourceFailure(policy, resource, error);
  if (Option.isSome(admissionFailure)) return admissionFailure;
  return Predicate.isTagged("BotRequestRejected")(error)
    ? Option.some(onRequestRejected())
    : Option.none();
};

export const mapBotCacheFailure =
  <E>(
    policy: string,
    resource: string,
    operation: string,
    operationError: (operation: string, cause: unknown) => E,
  ) =>
  (error: unknown): InteractiveDeclaredFailure | E => {
    const knownFailure = mapBotKnownRequestFailure(policy, resource, error, () =>
      interactiveInvalidRequest("ProviderRequestRejected", `The ${resource} request was rejected`),
    );
    return Option.getOrElse(knownFailure, () => operationError(operation, error));
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
    committedReference?: string,
  ) =>
  (error: unknown): InteractiveDeclaredFailure | E => {
    if (Predicate.isTagged("BotResponseExpired")(error)) {
      return interactiveDeliveryRejected(
        operation,
        "The response is no longer available",
        recoveryRequired,
        committedReference,
      );
    }
    const knownFailure = mapBotKnownRequestFailure(policy, resource, error, () =>
      interactiveDeliveryRejected(operation, rejectedMessage, recoveryRequired, committedReference),
    );
    return Option.getOrElse(knownFailure, () => operationError(operation, error));
  };

export const preserveInteractiveDeclaredFailure = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, InteractiveDeclaredFailure, R> =>
  effect.pipe(
    Effect.catch((error) =>
      isInteractiveDeclaredFailure(error) ? Effect.fail(error) : Effect.die(error),
    ),
  );

export const preserveAutonomousDeclaredFailure = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, AutonomousDeclaredFailure, R> =>
  effect.pipe(
    Effect.catch((error) =>
      Schema.is(AutonomousDeclaredFailure)(error) ? Effect.fail(error) : Effect.die(error),
    ),
  );

export const authorizeCheckinRespondWorkflow = (execution: {
  readonly principal: typeof EffectivePrincipal.Type;
  readonly input: unknown;
}) =>
  Effect.flatMap(ReadOnlyWorkflowAuthorization, (authorization) =>
    authorization.authorizeCheckinRespond(execution.principal, execution.input),
  ).pipe(
    Effect.mapError((error) =>
      isWorkflowInvocationUnauthorized(error)
        ? interactiveAuthorizationRevoked(CheckinsRespond.authorizationPolicy.policy)
        : error,
    ),
  );

export const authorizeRoomOrdersNavigateWorkflow = (execution: {
  readonly principal: typeof EffectivePrincipal.Type;
  readonly input: unknown;
}) =>
  Effect.flatMap(ReadOnlyWorkflowAuthorization, (authorization) =>
    authorization.authorizeRoomOrdersNavigate(execution.principal, execution.input),
  ).pipe(
    Effect.mapError((error) =>
      isWorkflowInvocationUnauthorized(error)
        ? interactiveAuthorizationRevoked(RoomOrdersNavigate.authorizationPolicy.policy)
        : error,
    ),
  );

export const authorizeRoomOrdersCreateWorkflow = (execution: {
  readonly principal: typeof EffectivePrincipal.Type;
  readonly input: unknown;
}) =>
  Effect.gen(function* () {
    const authorization = yield* ReadOnlyWorkflowAuthorization;
    yield* authorization.authorize(RoomOrdersCreate, execution.principal, execution.input);
    const creatorAccountId = yield* requireInteractiveDiscordAccountId(
      execution.principal,
      RoomOrdersCreate.authorizationPolicy.policy,
    );
    const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(
      Predicate.hasProperty("workspaceId")(execution.input)
        ? execution.input.workspaceId
        : undefined,
    ).pipe(
      Effect.mapError(() =>
        interactiveInvalidRequest("InvalidWorkspaceId", "workspaceId is missing or invalid"),
      ),
    );
    const clientId = yield* config.sheetBotClientId.pipe(
      Effect.mapError(() => interactiveConfigurationMissing("sheetBotClientId")),
    );
    return { clientPlatform: "discord" as const, clientId, workspaceId, creatorAccountId };
  }).pipe(
    Effect.mapError((error) =>
      isWorkflowInvocationUnauthorized(error)
        ? interactiveAuthorizationRevoked(RoomOrdersCreate.authorizationPolicy.policy)
        : error,
    ),
  );

export const authorizeRoomOrdersSendWorkflow = (execution: {
  readonly principal: typeof EffectivePrincipal.Type;
  readonly input: unknown;
}) =>
  Effect.flatMap(ReadOnlyWorkflowAuthorization, (authorization) =>
    authorization.authorizeRoomOrdersSend(execution.principal, execution.input),
  ).pipe(
    Effect.mapError((error) =>
      isWorkflowInvocationUnauthorized(error)
        ? interactiveAuthorizationRevoked(RoomOrdersSend.authorizationPolicy.policy)
        : error,
    ),
  );

export const authorizeRoomOrdersPinTentativeWorkflow = (execution: {
  readonly principal: typeof EffectivePrincipal.Type;
  readonly input: unknown;
}) =>
  Effect.flatMap(ReadOnlyWorkflowAuthorization, (authorization) =>
    authorization.authorizeRoomOrdersPinTentative(execution.principal, execution.input),
  ).pipe(
    Effect.mapError((error) =>
      isWorkflowInvocationUnauthorized(error)
        ? interactiveAuthorizationRevoked(RoomOrdersPinTentative.authorizationPolicy.policy)
        : error,
    ),
  );

const authorizeWorkflow = <Failure>(
  contract: AnyWorkflowContract,
  execution: {
    readonly principal: typeof EffectivePrincipal.Type;
    readonly input: unknown;
  },
  onUnauthorized: (contract: AnyWorkflowContract) => Failure,
) =>
  Effect.flatMap(ReadOnlyWorkflowAuthorization, (authorization) =>
    authorization.authorize(contract, execution.principal, execution.input),
  ).pipe(
    Effect.mapError((error) =>
      isWorkflowInvocationUnauthorized(error) ? onUnauthorized(contract) : error,
    ),
  );

export const authorizeInteractiveWorkflow = (
  contract: AnyWorkflowContract,
  execution: {
    readonly principal: typeof EffectivePrincipal.Type;
    readonly input: unknown;
  },
) =>
  authorizeWorkflow(contract, execution, ({ authorizationPolicy }) =>
    interactiveAuthorizationRevoked(authorizationPolicy.policy),
  );

export const authorizeAutonomousWorkflow = (
  contract: AnyWorkflowContract,
  execution: {
    readonly principal: typeof EffectivePrincipal.Type;
    readonly input: unknown;
  },
) =>
  authorizeWorkflow(contract, execution, ({ authorizationPolicy }) => ({
    _tag: "AuthorizationRevoked" as const,
    policy: authorizationPolicy.policy,
  }));

export const authorizeSlotOpenWorkflow = (execution: {
  readonly principal: typeof EffectivePrincipal.Type;
  readonly input: unknown;
}) =>
  Effect.flatMap(ReadOnlyWorkflowAuthorization, (authorization) =>
    authorization.authorizeSlotOpen(execution.principal, execution.input),
  ).pipe(
    Effect.mapError((error) =>
      isWorkflowInvocationUnauthorized(error)
        ? interactiveAuthorizationRevoked(SlotsOpen.authorizationPolicy.policy)
        : error,
    ),
  );
