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
  const runsProcedures = procedureNames.filter((procedure) => procedure.startsWith("runs."));
  const isEnqueueAsCaller = runsProcedures.includes("runs.enqueueAsCaller");

  if (isEnqueueAsCaller && (!token.scopes.has("service") || !token.scopes.has("ingress.forward"))) {
    return Effect.fail(
      unauthorized("Delegated workflow enqueue requires service and ingress.forward scopes"),
    );
  }

  if (token.scopes.has("service")) {
    return Predicate.isString(token.clientId)
      ? Effect.succeed({
          principalId: token.clientId,
          visibilityKey: `service:${token.clientId}`,
        })
      : Effect.fail(unauthorized("Service access token is missing a client identity"));
  }

  // Filter out pure-query runs procedures; they don't require workflow.dispatch scope.
  const pureQueryProcedures = runsProcedures.filter((p) => p === "runs.list" || p === "runs.get");

  if (
    pureQueryProcedures.length === runsProcedures.length &&
    runsProcedures.length === procedureNames.length &&
    runsProcedures.length > 0
  ) {
    // All procedures are runs procedures, and all runs procedures are pure queries — no workflow.dispatch scope needed.
    return Predicate.isString(token.accountId)
      ? Effect.succeed({
          principalId: token.accountId,
          visibilityKey: `account:${token.accountId}`,
        })
      : Effect.succeed({
          principalId: "anonymous",
          visibilityKey: "public",
        });
  }

  if (runsProcedures.length === procedureNames.length && runsProcedures.length > 0) {
    if (!token.scopes.has("workflow.dispatch")) {
      return Effect.fail(unauthorized("Runs access token is missing workflow.dispatch"));
    }
    return Predicate.isString(token.accountId)
      ? Effect.succeed({
          principalId: token.accountId,
          visibilityKey: `account:${token.accountId}`,
        })
      : Effect.fail(unauthorized("Runs access token is missing an account identity"));
  }

  return Effect.fail(unauthorized("Access outside the runs API requires service scope"));
};

const ANONYMOUS_CONTEXT: WorkflowZeroContext = {
  principalId: "anonymous",
  visibilityKey: "public",
};

// Public visibility procedures — no auth required when no token is present.
const PUBLIC_ONLY_PROCEDURE_PREFIXES = ["runs.list", "runs.get"] as const;
const isPublicOnlyProcedureSet = (procedureNames: readonly string[]): boolean =>
  procedureNames.length > 0 &&
  procedureNames.every((p) => (PUBLIC_ONLY_PROCEDURE_PREFIXES as readonly string[]).includes(p));

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
            procedure: "runs",
            message,
          }),
      });
      return {
        authorize: (procedureNames, headers) => {
          const oauthResult = authorizer
            .requireAuthorizedHeaders(headers)
            .pipe(Effect.flatMap((token) => zeroContextFromToken(procedureNames, token)));
          // Browser Zero clients send BetterAuth session tokens (not OAuth resource tokens),
          // so OAuth validation always fails for them. For public-only procedure sets,
          // fall back to anonymous context instead of erroring.
          if (isPublicOnlyProcedureSet(procedureNames)) {
            return Effect.catchTag(oauthResult, "ZeroDispatchUnauthorizedError", () =>
              Effect.succeed(ANONYMOUS_CONTEXT),
            );
          }
          return oauthResult;
        },
      };
    }),
  );
}
