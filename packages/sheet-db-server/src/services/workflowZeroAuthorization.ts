import { Context, Effect, Layer, Predicate } from "effect";
import type { Headers } from "effect/unstable/http";
import {
  makeOAuthResourceTokenAuthorizer,
  type VerifiedOAuthResourceToken,
} from "sheet-auth/oauth-resource-authorization";
import type { WorkflowZeroContext } from "sheet-db-schema/zero";
import { ZeroDispatchUnauthorizedError } from "typhoon-zero/server";
import { config } from "../config";

interface WorkflowZeroAuthorizationService {
  readonly authorize: (
    procedureNames: readonly string[],
    headers: Headers.Headers,
  ) => Effect.Effect<WorkflowZeroContext, ZeroDispatchUnauthorizedError>;
}

const unauthorized = (message: string) =>
  new ZeroDispatchUnauthorizedError({
    procedure: "zero",
    message,
  });

export const zeroContextFromToken = (
  procedureNames: readonly string[],
  token: VerifiedOAuthResourceToken,
): Effect.Effect<WorkflowZeroContext, ZeroDispatchUnauthorizedError> => {
  const workflowProcedures = procedureNames.filter((procedure) =>
    procedure.startsWith("workflow."),
  );
  if (token.scopes.has("service")) {
    return Predicate.isString(token.clientId)
      ? Effect.succeed({
          principalId: token.clientId,
          visibilityKey: `service:${token.clientId}`,
        })
      : Effect.fail(unauthorized("Service access token is missing a client identity"));
  }

  if (workflowProcedures.length === procedureNames.length && workflowProcedures.length > 0) {
    if (!token.scopes.has("workflow.dispatch")) {
      return Effect.fail(unauthorized("Workflow access token is missing workflow.dispatch"));
    }
    return Predicate.isString(token.accountId)
      ? Effect.succeed({
          principalId: token.accountId,
          visibilityKey: `account:${token.accountId}`,
        })
      : Effect.fail(unauthorized("Workflow access token is missing an account identity"));
  }

  return Effect.fail(unauthorized("Non-workflow Zero access requires service scope"));
};

export class WorkflowZeroAuthorization extends Context.Service<
  WorkflowZeroAuthorization,
  WorkflowZeroAuthorizationService
>()("sheet-db-server/WorkflowZeroAuthorization") {
  static readonly layer = Layer.effect(
    WorkflowZeroAuthorization,
    Effect.gen(function* () {
      const issuer = yield* config.sheetAuthIssuer;
      const audience = yield* config.sheetAuthOAuthAudience;
      const authorizer = yield* makeOAuthResourceTokenAuthorizer({
        issuer,
        audience,
        headerName: "authorization",
        requiredScopes: [],
        makeUnauthorized: ({ message }) =>
          new ZeroDispatchUnauthorizedError({
            procedure: "workflow",
            message,
          }),
      });
      return {
        authorize: (procedureNames, headers) =>
          authorizer
            .requireAuthorizedHeaders(headers)
            .pipe(Effect.flatMap((token) => zeroContextFromToken(procedureNames, token))),
      };
    }),
  );
}
