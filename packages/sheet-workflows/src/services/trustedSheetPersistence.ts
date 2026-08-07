import { Effect, Layer } from "effect";
import { makePostgresTrustedSheetPersistenceLayer } from "sheet-zero-server/persistence";
import type { WorkflowZeroContext } from "sheet-zero-server/authorization";
import { config } from "@/config";

const workflowPersistenceContext: WorkflowZeroContext = {
  principalId: "sheet-workflows",
  visibilityKey: "service:sheet-workflows",
};

export const trustedSheetPersistenceLayer = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* config.postgresUrl;
    const maxConnections = yield* config.trustedSheetPersistenceMaxConnections;
    const statementTimeoutMillis = yield* config.trustedSheetPersistenceStatementTimeoutMillis;
    return makePostgresTrustedSheetPersistenceLayer({
      url,
      context: workflowPersistenceContext,
      applicationName: "sheet-workflows-persistence",
      maxConnections,
      statementTimeoutMillis,
    });
  }),
).pipe(Layer.withSpan("sheet-workflows.trustedSheetPersistence"));
