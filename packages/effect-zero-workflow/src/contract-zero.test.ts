import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { InvocationId, defineWorkflowContract } from "./contract";
import {
  makeWorkflowZeroClient,
  workflowZeroProcedureManifest,
  type WorkflowZeroExecutor,
} from "./contract-zero";

const Contract = defineWorkflowContract({
  identity: "example.echo",
  wireVersion: "1.0",
  input: Schema.Struct({ value: Schema.String }),
  success: Schema.String,
  declaredFailure: Schema.Never,
  authorizationPolicy: { policy: "example.echo.invoke" },
});

const invocationId = Schema.decodeUnknownSync(InvocationId)("123e4567-e89b-42d3-a456-426614174000");

describe("Workflow Contract Zero transport", () => {
  it("generates explicit procedures without a generic workflow-name endpoint", () => {
    expect(workflowZeroProcedureManifest([Contract])).toEqual([
      "workflow:example%2Eecho:v:1%2E0.enqueue",
      "workflow:example%2Eecho:v:1%2E0.get",
      "workflow:example%2Eecho:v:1%2E0.list",
    ]);
  });

  it.effect("preserves invocation identity and materializes observed rows", () =>
    Effect.gen(function* () {
      const requests: Array<unknown> = [];
      const executor: WorkflowZeroExecutor = {
        enqueue: (_contract, request) => Effect.sync(() => void requests.push(request)),
        get: () =>
          Stream.succeed(
            Option.some({
              runId: invocationId,
              status: "succeeded",
              result: "hello",
              error: null,
              completedAt: "2026-01-01T00:00:01.000Z",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:01.000Z",
            }),
          ),
        list: () => Stream.succeed([]),
      };
      const client = makeWorkflowZeroClient(Contract, executor);

      const reference = yield* client.enqueue({ value: "hello" }, { invocationId });
      const observed = yield* Stream.runCollect(client.get(reference));

      expect(requests).toEqual([{ invocationId, input: { value: "hello" } }]);
      expect(reference.contractIdentity).toBe("example.echo");
      expect(Option.getOrUndefined(Array.from(observed)[0]!)).toMatchObject({
        result: { _tag: "Success", value: "hello" },
      });
    }),
  );
});
