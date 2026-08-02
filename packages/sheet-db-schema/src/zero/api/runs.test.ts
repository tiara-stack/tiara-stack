import type { Transaction } from "@rocicorp/zero";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { api } from "../api";
import { internal, service } from "../internal";
import { mutators } from "../mutators";
import type { Schema as SheetZeroSchema } from "../schema";
import { mutateWithWorkflow, type WorkflowEnqueueRequest, type WorkflowZeroContext } from "./runs";

const context: WorkflowZeroContext = {
  principalId: "account-1",
  visibilityKey: "account:account-1",
};

const input: WorkflowEnqueueRequest = {
  runId: "invocation-1",
  workflowName: "example",
  definitionVersion: "v1",
  executionId: "execution-1",
  payload: { value: 1 },
  runAfter: Date.UTC(2026, 0, 2, 3, 4, 5),
};

const makeServerTx = (
  query: (sql: string, args: readonly unknown[]) => Promise<readonly unknown[]>,
) =>
  ({
    location: "server",
    dbTransaction: { query },
  }) as unknown as Transaction<SheetZeroSchema>;

describe("Sheet workflow Zero component installation", () => {
  it("mounts the stable public, service, and internal runs catalogs", () => {
    const publicReferences = Object.values(api).flatMap((group) => Object.values(group));

    expect(publicReferences.every((reference) => reference.visibility === "public")).toBe(true);
    expect(Object.keys(api.runs)).toEqual(["get", "list"]);
    expect(Object.keys(service.runs)).toEqual(["enqueueAsCaller"]);
    expect(Object.keys(internal.runs)).toEqual(["enqueue", "command", "sendEvent"]);
    expect(mutators.runs).toHaveProperty("enqueueAsCaller");
  });

  it.effect("binds authoritative workflow writes to the sheet_db tables", () =>
    Effect.gen(function* () {
      const statements: Array<{ readonly sql: string; readonly args: readonly unknown[] }> = [];
      let domainMutationExecuted = false;
      const tx = makeServerTx((sql, args) => {
        statements.push({ sql, args });
        return Promise.resolve(
          sql.includes("RETURNING run_id")
            ? [
                {
                  run_id: input.runId,
                  visibility_key: context.visibilityKey,
                  definition_matches: true,
                  payload_matches: true,
                  max_attempts_matches: true,
                },
              ]
            : [],
        );
      });

      yield* Effect.promise(() =>
        mutateWithWorkflow(tx, context, input, () => {
          domainMutationExecuted = true;
          return Promise.resolve();
        }),
      );

      expect(domainMutationExecuted).toBe(true);
      expect(statements[0]?.sql).toContain("INSERT INTO sheet_db_workflow_run");
      expect(statements[1]?.sql).toContain("INSERT INTO sheet_db_workflow_command");
    }),
  );

  it.effect("maps delegated callers to account visibility", () =>
    Effect.gen(function* () {
      const statements: Array<{ readonly args: readonly unknown[] }> = [];
      const tx = makeServerTx((sql, args) => {
        statements.push({ args });
        return Promise.resolve(
          sql.includes("RETURNING run_id")
            ? [
                {
                  run_id: input.runId,
                  visibility_key: "account:account-2",
                  definition_matches: true,
                  payload_matches: true,
                  max_attempts_matches: true,
                },
              ]
            : [],
        );
      });

      yield* Effect.promise(() =>
        service.runs.enqueueAsCaller.endpoint.mutator({
          args: {
            caller: { principalId: "account-2" },
            workflow: input,
          },
          ctx: {
            principalId: "sheet-ingress",
            visibilityKey: "service:sheet-ingress",
          },
          tx,
        }),
      );

      expect(statements[0]?.args[4]).toBe("account:account-2");
      expect(statements[0]?.args[5]).toBe('{"id":"account-2"}');
    }),
  );
});
