import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  InvocationConflict,
  InvocationId,
  defineWorkflowContract,
  makeRunReference,
  makeWorkflowRunSchema,
  type WorkflowRun,
} from "./contract";
import { decodeWorkflowSse, encodeWorkflowSse, workflowHttpRouteManifest } from "./contract-http";
import {
  makeWorkflowHttpRouteHandlers,
  workflowEnqueueErrorStatus,
  workflowHttpServerExecutorFromHandler,
} from "./contract-http-server";
import {
  WorkflowObservationInvalidData,
  workflowContractRoutePrefix,
  workflowContractRoutes,
  workflowContractZeroGroupIdentifier,
  type WorkflowTransportHandler,
} from "./contract-transport";

const Contract = defineWorkflowContract({
  identity: "example.echo",
  wireVersion: "1.0",
  input: Schema.Struct({ value: Schema.String }),
  success: Schema.String,
  declaredFailure: Schema.Never,
  authorizationPolicy: { policy: "example.echo.invoke" },
});

const invocationId = Schema.decodeUnknownSync(InvocationId)("123e4567-e89b-42d3-a456-426614174000");

const makeContract = (identity: string, wireVersion: string) =>
  defineWorkflowContract({
    identity,
    wireVersion,
    input: Schema.Struct({ value: Schema.String }),
    success: Schema.String,
    declaredFailure: Schema.Never,
    authorizationPolicy: { policy: "example.echo.invoke" },
  });

describe("Workflow Contract HTTP/SSE transport", () => {
  it("generates only literal, versioned contract routes", () => {
    expect(workflowHttpRouteManifest([Contract])).toEqual([
      { method: "POST", path: "/workflows/example.echo/v/1.0/enqueue" },
      {
        method: "GET",
        path: "/workflows/example.echo/v/1.0/runs/:invocationId/events",
      },
      { method: "GET", path: "/workflows/example.echo/v/1.0/runs/events" },
    ]);
    expect(workflowContractZeroGroupIdentifier(Contract)).toBe("workflow:example%2Eecho:v:1%2E0");
  });

  it("rejects dot-segment contract identifiers from HTTP and Zero routes", () => {
    for (const value of [".", ".."]) {
      const identityContract = makeContract(value, "1.0");
      const wireVersionContract = makeContract("example.echo", value);
      const message = `Workflow contract route identifier cannot be "${value}"`;

      expect(() => workflowContractRoutePrefix(identityContract)).toThrow(message);
      expect(() => workflowContractZeroGroupIdentifier(identityContract)).toThrow(message);
      expect(() => workflowContractRoutePrefix(wireVersionContract)).toThrow(message);
      expect(() => workflowContractZeroGroupIdentifier(wireVersionContract)).toThrow(message);
    }
  });

  it.effect("matches encoded contract identities in the HTTP router", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handler = yield* HttpRouter.toHttpEffect(
          HttpRouter.add(
            "POST",
            workflowContractRoutes(Contract).enqueue as HttpRouter.PathInput,
            HttpServerResponse.empty({ status: 202 }),
          ).pipe(Layer.provide(HttpRouter.layer)),
        );
        const response = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://localhost/workflows/example%2Eecho/v/1%2E0/enqueue", {
                method: "POST",
              }),
            ),
          ),
        );

        expect(response.status).toBe(202);
      }),
    ),
  );

  it.effect("round trips fragmented SSE data through a runtime schema", () =>
    Effect.gen(function* () {
      const encoded = yield* encodeWorkflowSse(Schema.Struct({ value: Schema.String }), {
        value: "hello",
      });
      const bytes = new TextEncoder().encode(encoded);
      const stream = Stream.make(bytes.slice(0, 7), bytes.slice(7));
      const decoded = yield* Stream.runCollect(
        decodeWorkflowSse(Schema.Struct({ value: Schema.String }), stream),
      );

      expect(Array.from(decoded)).toEqual([{ value: "hello" }]);
    }),
  );

  it.effect("rejects SSE payloads that do not match the contract", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Stream.runCollect(
          decodeWorkflowSse(
            Schema.Struct({ value: Schema.String }),
            Stream.succeed(new TextEncoder().encode('data: {"value":1}\n\n')),
          ),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find(Cause.isFailReason);
        expect(failure?.error).toBeInstanceOf(WorkflowObservationInvalidData);
      }
    }),
  );

  it.effect("emits one pending SSE event and then closes for a snapshot handler", () =>
    Effect.gen(function* () {
      const handler: WorkflowTransportHandler<{}> = {
        enqueue: (contract, _context, request) =>
          Effect.succeed(makeRunReference(contract, request.invocationId)),
        get: (contract) =>
          Schema.decodeUnknownEffect(makeWorkflowRunSchema(contract))({
            reference: makeRunReference(contract, invocationId),
            result: { _tag: "Pending" as const, phase: "Queued" as const },
            submittedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }).pipe(
            Effect.map((run) => run as WorkflowRun<typeof contract>),
            Effect.mapError(
              () =>
                new WorkflowObservationInvalidData({
                  message: "Workflow test run is invalid",
                }),
            ),
          ),
        list: () => Effect.succeed([]),
      };
      const routes = makeWorkflowHttpRouteHandlers(
        Contract,
        workflowHttpServerExecutorFromHandler(handler),
      );
      const events = yield* Stream.runCollect(routes.get({}, invocationId));

      expect(Array.from(events)).toHaveLength(1);
      expect(Array.from(events)[0]).toContain('"_tag":"Pending"');
    }),
  );

  it.effect("preserves a conflicting replay as a definitive enqueue error", () =>
    Effect.gen(function* () {
      const conflict = new InvocationConflict({
        invocationId,
        reason: "CanonicalInputMismatch",
        existing: { contractIdentity: Contract.identity, wireVersion: Contract.wireVersion },
        requested: { contractIdentity: Contract.identity, wireVersion: Contract.wireVersion },
        message: "Invocation conflicts with an existing request",
      });
      const handler: WorkflowTransportHandler<{}> = {
        enqueue: () => Effect.fail(conflict),
        get: () => Effect.succeed(undefined),
        list: () => Effect.succeed([]),
      };
      const route = makeWorkflowHttpRouteHandlers(
        Contract,
        workflowHttpServerExecutorFromHandler(handler),
      );
      const exit = yield* Effect.exit(
        route.enqueue({}, { invocationId, input: { value: "replayed with different input" } }),
      );

      expect(workflowEnqueueErrorStatus(conflict)).toBe(409);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      const failure = exit.cause.reasons.find(Cause.isFailReason);
      expect(failure?.error).toBe(conflict);
    }),
  );
});
