import { Config, Effect, Layer, Match, Predicate, Schema } from "effect";
import { HttpBody, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  actorProvenanceFromVerifiedOAuthClaims,
  effectivePrincipalFromVerifiedOAuthClaims,
} from "sheet-auth/identity/server";
import {
  makeOAuthResourceTokenAuthorizer,
  type VerifiedOAuthResourceToken,
} from "sheet-auth/oauth-resource-authorization";
import { Unauthorized } from "typhoon-core/error";
import {
  RolloutGateChangePath,
  RolloutGateChangeRequest,
  RolloutGateEvaluatePath,
  RolloutGateEvaluationRequest,
} from "sheet-workflow-contracts";
import { config } from "@/config";
import {
  RolloutGateControl,
  RolloutGateRevisionConflict,
  RolloutGateStorageFailure,
} from "@/services/rolloutGate";

class RolloutGateRequestInvalid extends Schema.TaggedErrorClass<RolloutGateRequestInvalid>()(
  "RolloutGateRequestInvalid",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const decodeJsonBody = <A>(schema: Schema.Decoder<A, never>) => {
  return (request: HttpServerRequest.HttpServerRequest) =>
    HttpServerRequest.schemaBodyJson(schema).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.mapError(
        (cause) =>
          new RolloutGateRequestInvalid({
            message: Schema.isSchemaError(cause)
              ? "Rollout Gate request body does not match its contract"
              : "Rollout Gate request body is not valid JSON",
            cause,
          }),
      ),
    );
};

const contextFromToken = (token: VerifiedOAuthResourceToken) =>
  Effect.try({
    try: () => {
      const effectivePrincipal = effectivePrincipalFromVerifiedOAuthClaims(token);
      const actorProvenance = actorProvenanceFromVerifiedOAuthClaims(token);
      return {
        effectivePrincipal,
        ...(Predicate.isUndefined(actorProvenance) ? {} : { actorProvenance }),
      };
    },
    catch: (cause) => new Unauthorized({ message: "Invalid Rollout Gate identity", cause }),
  });

const makeAuthorizer = (requiredScopes: readonly string[], trustedClientIds: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const issuer = yield* config.sheetAuthIssuer;
    const audience = yield* config.sheetAuthWorkflowHttpAudience;
    return yield* makeOAuthResourceTokenAuthorizer({
      issuer,
      audience,
      requiredScopes,
      trustedClientIds,
      headerName: "authorization",
      makeUnauthorized: ({ message, cause }) => new Unauthorized({ message, cause }),
    });
  });

type RolloutGateRouteError =
  | Unauthorized
  | RolloutGateRequestInvalid
  | RolloutGateRevisionConflict
  | RolloutGateStorageFailure
  | HttpBody.HttpBodyError;

const routeErrorResponse = (error: RolloutGateRouteError) =>
  Match.typeTags<
    RolloutGateRouteError,
    Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBody.HttpBodyError>
  >()({
    Unauthorized: () =>
      HttpServerResponse.json(
        { _tag: "Unauthorized", message: "Rollout Gate authorization is required" },
        { status: 401 },
      ),
    RolloutGateRequestInvalid: (requestError) =>
      HttpServerResponse.json(
        { _tag: "RolloutGateRequestInvalid", message: requestError.message },
        { status: 400 },
      ),
    RolloutGateRevisionConflict: (conflict) =>
      HttpServerResponse.json(
        {
          _tag: conflict._tag,
          message: conflict.message,
          gateKey: conflict.gateKey,
          expectedRevision: conflict.expectedRevision,
          currentRevision: conflict.currentRevision,
        },
        { status: 409 },
      ),
    RolloutGateStorageFailure: () =>
      HttpServerResponse.json(
        { _tag: "RolloutGateStorageFailure", message: "Rollout Gate Control is unavailable" },
        { status: 503 },
      ),
    HttpBodyError: (bodyError) => Effect.fail(bodyError),
  })(error);

export const rolloutGateRoutesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const control = yield* RolloutGateControl;
    const { configuredTrustedClientIds, defaultClientId } = yield* Config.all({
      configuredTrustedClientIds: config.sheetAuthTrustedDelegationClientIds,
      defaultClientId: config.sheetAuthOAuthClientId,
    });
    const trustedClientIds = new Set(
      configuredTrustedClientIds.length > 0 ? configuredTrustedClientIds : [defaultClientId],
    );
    const evaluateAuthorizer = yield* makeAuthorizer(
      ["workflow.enqueue", "rollout.gate.evaluate"],
      trustedClientIds,
    );
    const changeAuthorizer = yield* makeAuthorizer(
      ["service", "rollout.gate.write"],
      trustedClientIds,
    );

    const evaluateRoute = HttpRouter.add(
      "POST",
      RolloutGateEvaluatePath,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* Effect.gen(function* () {
          const token = yield* evaluateAuthorizer.requireAuthorizedHeaders(request.headers);
          const identity = yield* contextFromToken(token);
          const input = yield* decodeJsonBody<RolloutGateEvaluationRequest>(
            RolloutGateEvaluationRequest,
          )(request);
          const decision = yield* control.evaluate({ ...input, ...identity });
          return yield* HttpServerResponse.json(decision, { status: 200 });
        }).pipe(Effect.catch(routeErrorResponse));
      }),
    );

    const changeRoute = HttpRouter.add(
      "POST",
      RolloutGateChangePath,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* Effect.gen(function* () {
          const token = yield* changeAuthorizer.requireAuthorizedHeaders(request.headers);
          const identity = yield* contextFromToken(token);
          const input =
            yield* decodeJsonBody<RolloutGateChangeRequest>(RolloutGateChangeRequest)(request);
          const change = yield* control.change({
            ...input,
            changedBy: identity.effectivePrincipal,
            ...(Predicate.isUndefined(identity.actorProvenance)
              ? {}
              : { actorProvenance: identity.actorProvenance }),
          });
          return yield* HttpServerResponse.json(change, { status: 200 });
        }).pipe(Effect.catch(routeErrorResponse));
      }),
    );

    return evaluateRoute.pipe(Layer.merge(changeRoute));
  }),
);
