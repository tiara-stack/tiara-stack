import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  InvocationId,
  defineWorkflowContract,
  makeRunReference,
  makeWorkflowRunSchema,
  type WorkflowContractInput,
  workflowContractKey,
} from "./contract";
import { decodeWorkflowSse } from "./contract-http";
import {
  makeWorkflowHttpRouteHandlers,
  workflowHttpServerExecutorFromHandler,
} from "./contract-http-server";
import {
  makeWorkflowTransportHandler,
  type MaterializedWorkflowRunRow,
  type WorkflowInvocationStore,
} from "./contract-server";
import { makeWorkflowZeroClient, type WorkflowZeroExecutor } from "./contract-zero";
import { WorkflowInputRejected } from "./contract-transport";

const Contract = defineWorkflowContract({
  identity: "example.echo",
  wireVersion: "1.0",
  input: Schema.Struct({ value: Schema.String }),
  success: Schema.String,
  declaredFailure: Schema.Never,
  authorizationPolicy: { policy: "example.echo.invoke" },
});

const TransformedContract = defineWorkflowContract({
  identity: "example.transformed",
  wireVersion: "1.0",
  input: Schema.Struct({
    value: Schema.String,
    occurredAt: Schema.DateFromString,
  }),
  success: Schema.String,
  declaredFailure: Schema.Never,
  authorizationPolicy: { policy: "example.transformed.invoke" },
});

const invocationId = Schema.decodeUnknownSync(InvocationId)("123e4567-e89b-42d3-a456-426614174000");

const row: MaterializedWorkflowRunRow = {
  runId: invocationId,
  status: "succeeded",
  result: "hello",
  error: null,
  completedAt: "2026-01-01T00:00:01.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
};

describe("Workflow Contract transport conformance", () => {
  it.effect("preserves shared enqueue and observation semantics across Zero and HTTP/SSE", () =>
    Effect.gen(function* () {
      const context = { ownerKey: "owner-a", principal: "principal-a" };
      const store: WorkflowInvocationStore<string> = {
        enqueue: (invocation) => Effect.succeed(invocation.fingerprint),
        get: () => Effect.succeed(row),
        list: () => Effect.succeed([row]),
      };
      const handler = yield* makeWorkflowTransportHandler({
        contracts: [Contract],
        registrations: [
          {
            contract: Contract,
            definitionVersion: "definition-1",
            authorize: () => Effect.void,
            authorizeObservation: () => Effect.void,
          },
        ],
        store,
      });
      const http = makeWorkflowHttpRouteHandlers(
        Contract,
        workflowHttpServerExecutorFromHandler(handler),
      );
      const zeroExecutor: WorkflowZeroExecutor = {
        enqueue: (contract, request) => {
          const decodeInput = Schema.decodeUnknownEffect(contract.input)(
            request.input,
          ) as Effect.Effect<WorkflowContractInput<typeof contract>, Schema.SchemaError>;
          return decodeInput.pipe(
            Effect.mapError(
              () => new WorkflowInputRejected({ message: "Workflow input is invalid" }),
            ),
            Effect.flatMap((input) =>
              handler.enqueue(contract, context, {
                invocationId: request.invocationId,
                input,
              }),
            ),
            Effect.asVoid,
          );
        },
        get: (contract, requestedInvocationId) =>
          Stream.fromEffect(
            store.get(context.ownerKey, workflowContractKey(contract), requestedInvocationId),
          ).pipe(Stream.map(Option.fromUndefinedOr)),
        list: (contract, filter) =>
          Stream.fromEffect(store.list(context.ownerKey, workflowContractKey(contract), filter)),
      };
      const zero = makeWorkflowZeroClient(Contract, zeroExecutor);

      const zeroReference = yield* zero.enqueue({ value: "hello" }, { invocationId });
      const httpReference = yield* http.enqueue(context, {
        invocationId,
        input: { value: "hello" },
      });
      const zeroEvents = yield* Stream.runCollect(zero.get(zeroReference));
      const httpEvents = yield* Stream.runCollect(
        decodeWorkflowSse(
          Schema.OptionFromNullishOr(makeWorkflowRunSchema(Contract)),
          http
            .get(context, invocationId)
            .pipe(Stream.map((event) => new TextEncoder().encode(event))),
        ),
      );

      expect(httpReference).toEqual(zeroReference);
      expect(Array.from(httpEvents)).toEqual(Array.from(zeroEvents));
    }),
  );

  it.effect("accepts transformed input after HTTP request decoding", () =>
    Effect.gen(function* () {
      const context = { ownerKey: "owner-a", principal: "principal-a" };
      const store: WorkflowInvocationStore<string> = {
        enqueue: (invocation) => Effect.succeed(invocation.fingerprint),
        get: () => Effect.succeed(undefined),
        list: () => Effect.succeed([]),
      };
      const handler = yield* makeWorkflowTransportHandler({
        contracts: [TransformedContract],
        registrations: [
          {
            contract: TransformedContract,
            definitionVersion: "definition-1",
            authorize: () => Effect.void,
            authorizeObservation: () => Effect.void,
          },
        ],
        store,
      });
      const http = makeWorkflowHttpRouteHandlers(
        TransformedContract,
        workflowHttpServerExecutorFromHandler(handler),
      );

      const reference = yield* http.enqueue(context, {
        invocationId,
        input: {
          value: "hello",
          occurredAt: "2026-01-01T00:00:00.000Z",
        },
      });

      expect(reference).toEqual(makeRunReference(TransformedContract, invocationId));
    }),
  );
});
