import { Context, Effect, Layer, Match, Predicate } from "effect";
import type { Headers } from "effect/unstable/http";
import { api as publicApi } from "sheet-zero-api/server";
import { service as serviceApi } from "sheet-zero-api/server";
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

type ProcedureBatch = "publicRuns" | "runs" | "delegated" | "domain" | "outsideRuns";

const publicRunProcedures = new Set<string>(["runs.get", "runs.list"]);
const delegatedRunProcedures = new Set<string>(["runs.enqueueAsCaller"]);
const isRunsProcedure = (procedure: string) => procedure.startsWith("runs.");

type ProcedureReference = {
  readonly group: string;
  readonly kind: "query" | "mutator";
  readonly name: string;
};

const procedureReferences = (
  catalog: Readonly<Record<string, Readonly<Record<string, ProcedureReference>>>>,
): ReadonlyArray<ProcedureReference> => Object.values(catalog).flatMap(Object.values);

const procedureName = (reference: ProcedureReference): string =>
  `${reference.group}.${reference.name}`;

const publicProcedureReferences = procedureReferences(publicApi);
const serviceProcedureReferences = procedureReferences(serviceApi);
const serviceProcedures = new Set(serviceProcedureReferences.map(procedureName));
const mutatorProcedures = new Set(
  [...publicProcedureReferences, ...serviceProcedureReferences]
    .filter(({ kind }) => kind === "mutator")
    .map(procedureName),
);

const isMutatorProcedure = (procedure: string): boolean => mutatorProcedures.has(procedure);

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
  if (procedureNames.every((procedure) => !isRunsProcedure(procedure))) {
    return "domain";
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
    : Effect.fail(unauthorized("Account access token is missing an account identity"));

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
  const isDelegatedBatch = procedureNames.some((procedure) =>
    delegatedRunProcedures.has(procedure),
  );
  const hasServiceProcedure =
    !isDelegatedBatch && procedureNames.some((procedure) => serviceProcedures.has(procedure));
  if (hasServiceProcedure && !isService) {
    return Effect.fail(unauthorized("Service procedures require service scope"));
  }
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
    Match.when("domain", () =>
      isService
        ? serviceContext(token)
        : token.scopes.has("zero.read") &&
            (procedureNames.every((procedure) => !isMutatorProcedure(procedure)) ||
              token.scopes.has("zero.mutate"))
          ? accountContext(token)
          : Effect.fail(
              unauthorized(
                "Domain access requires zero.read and, for mutations, zero.mutate scopes",
              ),
            ),
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
