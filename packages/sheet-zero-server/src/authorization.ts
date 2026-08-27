import { Context, Effect, Layer, Match, Predicate } from "effect";
import type { Headers } from "effect/unstable/http";
import {
  makeOAuthResourceTokenAuthorizer,
  type VerifiedOAuthResourceToken,
} from "sheet-auth/oauth-resource-authorization";
import { ZeroDispatchUnauthorizedError } from "typhoon-zero/server";

export interface WorkflowZeroContext {
  readonly principalId: string;
  readonly visibilityKey: string;
}

interface SheetZeroAuthorizationShape {
  readonly authorize: (
    procedureNames: readonly string[],
    headers: Headers.Headers,
  ) => Effect.Effect<WorkflowZeroContext, ZeroDispatchUnauthorizedError>;
}

export interface SheetZeroAuthorizationOptions {
  readonly issuer: string;
  readonly audience: string;
}

const unauthorized = (message: string) =>
  new ZeroDispatchUnauthorizedError({
    procedure: "zero",
    message,
  });

type ProcedureBatch = "publicRuns" | "runs" | "delegated" | "outsideRuns";

const publicRunProcedures = new Set<string>(["runs.get", "runs.list"]);
const delegatedRunProcedures = new Set<string>(["runs.enqueueAsCaller"]);
const isRunsProcedure = (procedure: string) => procedure.startsWith("runs.");

const classifyProcedureBatch = (procedureNames: readonly string[]): ProcedureBatch => {
  if (procedureNames.some((procedure) => delegatedRunProcedures.has(procedure))) {
    return "delegated";
  }
  if (
    procedureNames.length > 0 &&
    procedureNames.every((procedure) => publicRunProcedures.has(procedure))
  ) {
    return "publicRuns";
  }
  if (procedureNames.length > 0 && procedureNames.every(isRunsProcedure)) {
    return "runs";
  }
  return "outsideRuns";
};

const serviceContext = (token: VerifiedOAuthResourceToken) =>
  Predicate.isString(token.clientId)
    ? Effect.succeed({
        principalId: token.clientId,
        visibilityKey: `service:${token.clientId}`,
      })
    : Effect.fail(unauthorized("Service access token is missing a client identity"));

const accountContext = (token: VerifiedOAuthResourceToken) =>
  Predicate.isString(token.accountId)
    ? Effect.succeed({
        principalId: token.accountId,
        visibilityKey: `account:${token.accountId}`,
      })
    : Effect.fail(unauthorized("Runs access token is missing an account identity"));

const publicRunsContext = (token: VerifiedOAuthResourceToken) =>
  Predicate.isString(token.accountId)
    ? accountContext(token)
    : Effect.succeed({
        principalId: "anonymous",
        visibilityKey: "public",
      });

export const zeroContextFromToken = (
  procedureNames: readonly string[],
  token: VerifiedOAuthResourceToken,
): Effect.Effect<WorkflowZeroContext, ZeroDispatchUnauthorizedError> => {
  const isService = token.scopes.has("service");
  return Match.value(classifyProcedureBatch(procedureNames)).pipe(
    Match.when("delegated", () =>
      isService && token.scopes.has("workflow.enqueue")
        ? serviceContext(token)
        : Effect.fail(
            unauthorized("Delegated workflow enqueue requires service and workflow.enqueue scopes"),
          ),
    ),
    Match.when("publicRuns", () => (isService ? serviceContext(token) : publicRunsContext(token))),
    Match.when("runs", () =>
      isService
        ? serviceContext(token)
        : token.scopes.has("workflow.dispatch")
          ? accountContext(token)
          : Effect.fail(unauthorized("Runs access token is missing workflow.dispatch")),
    ),
    Match.when("outsideRuns", () =>
      isService
        ? serviceContext(token)
        : Effect.fail(unauthorized("Access outside the runs API requires service scope")),
    ),
    Match.exhaustive,
  );
};

export class SheetZeroAuthorization extends Context.Service<
  SheetZeroAuthorization,
  SheetZeroAuthorizationShape
>()("sheet-zero-server/SheetZeroAuthorization") {}

export const makeSheetZeroAuthorizationLayer = (options: SheetZeroAuthorizationOptions) =>
  Layer.effect(
    SheetZeroAuthorization,
    Effect.gen(function* () {
      const authorizer = yield* makeOAuthResourceTokenAuthorizer({
        issuer: options.issuer,
        audience: options.audience,
        headerName: "authorization",
        requiredScopes: [],
        makeUnauthorized: ({ message }) =>
          new ZeroDispatchUnauthorizedError({
            procedure: "runs",
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
