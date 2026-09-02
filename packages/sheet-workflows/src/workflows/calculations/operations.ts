import { createHash } from "node:crypto";
import { Cause, Effect, Exit, Layer, Option, Predicate } from "effect";
import { CalculationsRecalculateSheet } from "sheet-workflow-contracts";
import type { WebSheetConfiguration } from "sheet-domain";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { providerCauseKind } from "../shared/providerFailure";
import { resolveAuthoritativeSheetConfigurationBySpreadsheetId } from "../../services/authoritativeSheetConfiguration";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import {
  calculationAuthorizationRevoked,
  calculationExternalOperationRejected,
  calculationExternalOperationCodes,
  calculationInvalidRequest,
  calculationInvalidRequestCodes,
  isWorkflowInvocationUnauthorized,
} from "./failure";
import {
  CalculationProvider,
  CalculationProviderError,
  CalculationTargetError,
  sameCalculationRows,
} from "./provider";
import { CalculationWorkflowOperations, CalculationWorkflowOperationsError } from "./service";
import type { CalculationRows, CalculationWriteReceipt } from "./schema";
import { decodeCalculationSource } from "./source";

const operationPrefix = CalculationsRecalculateSheet.identity;

const operationError = (operation: string, cause: unknown) =>
  new CalculationWorkflowOperationsError({ operation, cause });

const providerRejected = (operation: string, error: CalculationProviderError) =>
  Effect.logWarning("The Sheets provider rejected a calculation operation").pipe(
    Effect.annotateLogs({
      operation,
      providerOperation: error.operation,
      providerCauseKind: providerCauseKind(error.cause),
    }),
    Effect.andThen(
      Effect.fail(
        calculationExternalOperationRejected(
          calculationExternalOperationCodes.providerRejected,
          "The Sheets provider rejected the calculation operation",
        ),
      ),
    ),
  );

const targetRejectionMessages: Record<CalculationTargetError["code"], string> = {
  MissingSheet: "The calculation sheet does not exist in the bound spreadsheet",
  NonCanonicalSheet: "The calculation sheet reference is not canonical",
};

const targetRejectionCodes: Record<
  CalculationTargetError["code"],
  (typeof calculationInvalidRequestCodes)["missingSheet" | "nonCanonicalSheet"]
> = {
  MissingSheet: calculationInvalidRequestCodes.missingSheet,
  NonCanonicalSheet: calculationInvalidRequestCodes.nonCanonicalSheet,
};

const targetRejected = (error: CalculationTargetError) =>
  Effect.fail(
    calculationInvalidRequest(
      targetRejectionCodes[error.code],
      targetRejectionMessages[error.code],
    ),
  );

const projectionEvidence = (rows: CalculationRows): string =>
  createHash("sha256").update(JSON.stringify(rows)).digest("hex");

const conflictingOutcome = (
  observed: CalculationRows,
  desired: CalculationRows,
  preWrite: CalculationRows,
) =>
  Effect.logError("The calculation projection has an unresolved conflicting outcome").pipe(
    Effect.annotateLogs({
      observedEvidence: projectionEvidence(observed),
      desiredEvidence: projectionEvidence(desired),
      preWriteEvidence: projectionEvidence(preWrite),
      observedRows: observed.length,
      desiredRows: desired.length,
      preWriteRows: preWrite.length,
    }),
    Effect.andThen(
      Effect.fail(
        calculationExternalOperationRejected(
          calculationExternalOperationCodes.conflictingAmbiguousOutcome,
          "The calculation projection changed while an ambiguous write was reconciled",
        ),
      ),
    ),
  );

const noWriteConflictOutcome = (
  observed: CalculationRows,
  desired: CalculationRows,
  preWrite: CalculationRows,
) =>
  Effect.logError("The calculation projection changed before a write was needed").pipe(
    Effect.annotateLogs({
      observedEvidence: projectionEvidence(observed),
      desiredEvidence: projectionEvidence(desired),
      preWriteEvidence: projectionEvidence(preWrite),
      observedRows: observed.length,
      desiredRows: desired.length,
      preWriteRows: preWrite.length,
    }),
    Effect.andThen(
      Effect.fail(
        calculationExternalOperationRejected(
          calculationExternalOperationCodes.projectionWriteRejected,
          "The calculation projection changed before the write was needed",
        ),
      ),
    ),
  );

export const calculationWorkflowOperationsLayer = Layer.effect(
  CalculationWorkflowOperations,
  Effect.gen(function* () {
    const authorization = yield* ReadOnlyWorkflowAuthorization;
    const provider = yield* CalculationProvider;
    const persistence = yield* TrustedSheetPersistence;

    const resolveConfiguration = (
      spreadsheetId: string,
    ): Effect.Effect<WebSheetConfiguration | undefined, CalculationWorkflowOperationsError> =>
      resolveAuthoritativeSheetConfigurationBySpreadsheetId(persistence, spreadsheetId).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((error) =>
          operationError(`${operationPrefix}.resolve-sheet-configuration`, error),
        ),
        Effect.map(
          Option.match({
            onNone: () => undefined,
            onSome: ({ configuration }) => configuration ?? undefined,
          }),
        ),
      );

    const reauthorize = (
      execution: {
        readonly principal: Parameters<typeof authorization.authorize>[1];
        readonly input: unknown;
      },
      operation: string,
    ) =>
      authorization
        .authorize(CalculationsRecalculateSheet, execution.principal, execution.input)
        .pipe(
          Effect.mapError((error) =>
            isWorkflowInvocationUnauthorized(error)
              ? calculationAuthorizationRevoked()
              : operationError(`${operation}.authorize`, error),
          ),
        );

    const load: CalculationWorkflowOperations["Service"]["load"] = (execution) =>
      Effect.gen(function* () {
        const input = execution.input;
        yield* reauthorize(execution, `${operationPrefix}.load-calculation-source`);
        const configuration = yield* resolveConfiguration(input.spreadsheetId);
        const snapshot = yield* provider
          .load({
            spreadsheetId: input.spreadsheetId,
            sheetTitle: execution.sheetTitle,
            canonicalSheetRef: execution.canonicalSheetRef,
            ...(Predicate.isUndefined(configuration) ? {} : { configuration }),
          })
          .pipe(
            Effect.catchTag("CalculationTargetError", targetRejected),
            Effect.catchTag("CalculationProviderError", (error) =>
              providerRejected(`${operationPrefix}.load-calculation-source`, error),
            ),
          );
        return decodeCalculationSource(
          snapshot,
          input.players.map(({ name }) => name),
        );
      });

    const write: CalculationWorkflowOperations["Service"]["write"] = (execution) =>
      Effect.gen(function* () {
        const input = execution.input;
        const desired = execution.projection.rows;
        const preWrite = execution.source.preWriteProjection;
        const receipt = (disposition: CalculationWriteReceipt["disposition"]) => ({
          disposition,
          outputRange: execution.projection.outputRange,
          roomCount: execution.projection.roomCount,
        });
        const attempt = () =>
          provider.replaceProjection({
            spreadsheetId: input.spreadsheetId,
            sheetId: execution.source.sheetId,
            sheetTitle: execution.source.sheetTitle,
            canonicalSheetRef: execution.canonicalSheetRef,
            desiredRows: desired,
            preWriteRows: preWrite,
          });
        const observe = (afterAmbiguousWrite: boolean) =>
          provider
            .readProjection(input.spreadsheetId, execution.canonicalSheetRef)
            .pipe(
              Effect.catchTag("CalculationProviderError", (error) =>
                afterAmbiguousWrite
                  ? Effect.fail(
                      calculationExternalOperationRejected(
                        calculationExternalOperationCodes.projectionWriteUnconfirmed,
                        "The calculation projection write could not be confirmed after an ambiguous provider failure",
                      ),
                    )
                  : providerRejected(`${operationPrefix}.reconcile-calculation-projection`, error),
              ),
            );

        // Retries reuse the same snapshots. If the first request succeeded but its response was
        // lost, the retry may send the identical update again; that duplicate write is idempotent.
        const classifyAttempt = () =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(attempt());
            if (Exit.isSuccess(exit)) return "confirmed" as const;
            const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
            if (!Predicate.isTagged("CalculationProjectionWriteError")(error)) {
              return yield* Effect.failCause(exit.cause).pipe(Effect.orDie);
            }
            if (error.conflicting === true) {
              return yield* Effect.fail(
                calculationExternalOperationRejected(
                  calculationExternalOperationCodes.conflictingAmbiguousOutcome,
                  "The calculation projection changed before the write could start",
                ),
              );
            }
            if (error.ambiguous === false) {
              return yield* Effect.fail(
                calculationExternalOperationRejected(
                  calculationExternalOperationCodes.projectionWriteRejected,
                  "The Sheets provider rejected the calculation projection write",
                ),
              );
            }
            const observed = yield* observe(true);
            if (sameCalculationRows(observed, desired)) return "reconciled" as const;
            if (!sameCalculationRows(observed, preWrite)) {
              return yield* conflictingOutcome(observed, desired, preWrite);
            }
            return "unconfirmed" as const;
          });

        yield* reauthorize(execution, `${operationPrefix}.write-calculation-projection`);
        if (sameCalculationRows(preWrite, desired)) {
          const observed = yield* observe(false);
          if (sameCalculationRows(observed, desired)) return receipt("reconciled");
          return yield* noWriteConflictOutcome(observed, desired, preWrite);
        }

        const first = yield* classifyAttempt();
        if (first !== "unconfirmed") return receipt(first);
        yield* reauthorize(execution, `${operationPrefix}.retry-calculation-projection`);
        const retry = yield* classifyAttempt();
        if (retry !== "unconfirmed") return receipt(retry);
        return yield* Effect.fail(
          calculationExternalOperationRejected(
            calculationExternalOperationCodes.projectionWriteUnconfirmed,
            "The calculation projection write could not be confirmed within its action budget",
          ),
        );
      });

    return { load, write };
  }),
);
