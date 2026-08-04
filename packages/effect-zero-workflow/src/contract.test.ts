import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { expectTypeOf } from "vitest";
import {
  InvocationId,
  WorkflowRunCursor,
  WorkflowRunListFilter,
  defineWorkflowContract,
  defineWorkflowContractCatalog,
  isRunReferenceFor,
  makeRunReference,
  makeRunReferenceSchema,
  makeWorkflowResultSchema,
  makeWorkflowRunSchema,
  workflowContractKey,
  type RunReference,
  type WorkflowClient,
  type WorkflowContractDeclaredFailure,
  type WorkflowContractInput,
  type WorkflowContractSuccess,
  type WorkflowRun,
} from "./contract";

const EchoDeclaredFailure = Schema.TaggedStruct("MessageRejected", {
  reason: Schema.String,
});

const EchoV1 = defineWorkflowContract({
  identity: "example.echo",
  wireVersion: "1",
  input: Schema.Struct({ message: Schema.String }),
  success: Schema.Struct({ echoed: Schema.String }),
  declaredFailure: EchoDeclaredFailure,
  authorizationPolicy: {
    policy: "example.echo.invoke",
    resourceField: "message",
  },
});

const EchoV2 = defineWorkflowContract({
  identity: "example.echo",
  wireVersion: "2",
  input: Schema.Struct({ message: Schema.String, uppercase: Schema.Boolean }),
  success: Schema.Struct({ echoed: Schema.String }),
  declaredFailure: EchoDeclaredFailure,
  authorizationPolicy: {
    policy: "example.echo.invoke",
    resourceField: "message",
  },
});

const invocationId = Schema.decodeUnknownSync(InvocationId)("123e4567-e89b-42d3-a456-426614174000");

describe("Workflow Contract declarations", () => {
  it("preserves schemas and authorization-policy metadata at the type level", () => {
    type DecodedRun = Schema.Schema.Type<ReturnType<typeof makeWorkflowRunSchema<typeof EchoV1>>>;

    expectTypeOf<WorkflowContractInput<typeof EchoV1>>().toEqualTypeOf<{
      readonly message: string;
    }>();
    expectTypeOf<WorkflowContractSuccess<typeof EchoV1>>().toEqualTypeOf<{
      readonly echoed: string;
    }>();
    expectTypeOf<WorkflowContractDeclaredFailure<typeof EchoV1>>().toEqualTypeOf<{
      readonly _tag: "MessageRejected";
      readonly reason: string;
    }>();
    expectTypeOf(EchoV1.identity).toEqualTypeOf<"example.echo">();
    expectTypeOf(EchoV1.wireVersion).toEqualTypeOf<"1">();
    expectTypeOf(EchoV1.authorizationPolicy.resourceField).toEqualTypeOf<"message">();
    expectTypeOf<DecodedRun>().toEqualTypeOf<WorkflowRun<typeof EchoV1>>();
  });

  it("rejects unstable declaration identity, version, and policy values", () => {
    expect(() =>
      defineWorkflowContract({
        ...EchoV1,
        identity: " ",
      }),
    ).toThrow();
    expect(() =>
      defineWorkflowContract({
        ...EchoV1,
        wireVersion: "",
      }),
    ).toThrow();
    expect(() =>
      defineWorkflowContract({
        ...EchoV1,
        authorizationPolicy: { policy: "" },
      }),
    ).toThrow();
  });

  it("keeps contract versions distinct in catalogs and Run References", () => {
    const catalog = defineWorkflowContractCatalog(EchoV1, EchoV2);
    const reference = makeRunReference(EchoV1, invocationId);

    expect(catalog).toEqual([EchoV1, EchoV2]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(workflowContractKey(EchoV1)).not.toBe(workflowContractKey(EchoV2));
    expect(isRunReferenceFor(EchoV1, reference)).toBe(true);
    expect(isRunReferenceFor(EchoV2, reference)).toBe(false);
    expect(() => Schema.decodeUnknownSync(makeRunReferenceSchema(EchoV2))(reference)).toThrow();
    expect(makeRunReferenceSchema(EchoV1)).toBe(makeRunReferenceSchema(EchoV1));
    expect(makeWorkflowResultSchema(EchoV1)).toBe(makeWorkflowResultSchema(EchoV1));
    expect(makeWorkflowRunSchema(EchoV1)).toBe(makeWorkflowRunSchema(EchoV1));
    expectTypeOf(reference).toEqualTypeOf<RunReference<typeof EchoV1>>();
  });

  it("keeps published declaration identity, version, and policy metadata immutable", () => {
    const contract = defineWorkflowContract({
      ...EchoV1,
      authorizationPolicy: {
        policy: "example.echo.invoke",
        requirements: {
          resource: "guild",
          scopes: ["guild.manage"],
        },
      },
    });

    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.authorizationPolicy)).toBe(true);
    expect(Object.isFrozen(contract.authorizationPolicy.requirements)).toBe(true);
    expect(Object.isFrozen(contract.authorizationPolicy.requirements.scopes)).toBe(true);
    expect(Reflect.set(contract, "identity", "mutated")).toBe(false);
    expect(Reflect.set(contract, "wireVersion", "mutated")).toBe(false);
    expect(Reflect.set(contract.authorizationPolicy, "policy", "mutated")).toBe(false);
    expect(Reflect.set(contract.authorizationPolicy.requirements, "resource", "mutated")).toBe(
      false,
    );
    expect(Reflect.set(contract.authorizationPolicy.requirements.scopes, 0, "mutated")).toBe(false);
    expect(workflowContractKey(contract)).toBe('["example.echo","1"]');
    expect(makeRunReference(contract, invocationId)).toMatchObject({
      contractIdentity: "example.echo",
      wireVersion: "1",
    });
  });

  it("decodes public outcomes without runtime causes or raw errors", () => {
    const decode = Schema.decodeUnknownSync(makeWorkflowRunSchema(EchoV1));
    const pending = decode({
      reference: makeRunReference(EchoV1, invocationId),
      result: { _tag: "Pending", phase: "Running" },
      submittedAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:01:00.000Z",
    });
    const declaredFailure = decode({
      reference: makeRunReference(EchoV1, invocationId),
      result: {
        _tag: "Failure",
        failure: {
          _tag: "Declared",
          error: {
            _tag: "MessageRejected",
            reason: "blocked",
            cause: { message: "private runtime cause" },
            stack: "private stack trace",
          },
        },
        completedAt: "2026-08-04T00:02:00.000Z",
      },
      submittedAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:02:00.000Z",
    });
    const success = decode({
      reference: makeRunReference(EchoV1, invocationId),
      result: {
        _tag: "Success",
        value: { echoed: "hello" },
        completedAt: "2026-08-04T00:03:00.000Z",
      },
      submittedAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:03:00.000Z",
    });
    const systemFailure = decode({
      reference: makeRunReference(EchoV1, invocationId),
      result: {
        _tag: "Failure",
        failure: {
          _tag: "System",
          code: "RetriesExhausted",
          retryable: false,
        },
        completedAt: "2026-08-04T00:04:00.000Z",
      },
      submittedAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:04:00.000Z",
    });

    expect(pending.result).toEqual({ _tag: "Pending", phase: "Running" });
    expect(declaredFailure.result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "Declared",
        error: { _tag: "MessageRejected", reason: "blocked" },
      },
    });
    if (
      declaredFailure.result._tag !== "Failure" ||
      declaredFailure.result.failure._tag !== "Declared"
    ) {
      throw new Error("Expected a decoded Declared Failure");
    }
    const declaredError = declaredFailure.result.failure.error;
    expect(declaredError).not.toHaveProperty("cause");
    expect(declaredError).not.toHaveProperty("stack");
    expect(declaredFailure.result).not.toHaveProperty("failure.error.cause");
    expect(declaredFailure.result).not.toHaveProperty("failure.error.stack");
    expect(success.result).toEqual({
      _tag: "Success",
      value: { echoed: "hello" },
      completedAt: new Date("2026-08-04T00:03:00.000Z"),
    });
    expect(systemFailure.result).toEqual({
      _tag: "Failure",
      failure: {
        _tag: "System",
        code: "RetriesExhausted",
        retryable: false,
      },
      completedAt: new Date("2026-08-04T00:04:00.000Z"),
    });
  });

  it("bounds list filters to the common owner-scoped page size", () => {
    expect(
      Schema.decodeUnknownSync(WorkflowRunListFilter)({
        states: ["Pending", "Failure"],
        limit: 100,
      }),
    ).toEqual({ states: ["Pending", "Failure"], limit: 100 });
    expect(() => Schema.decodeUnknownSync(WorkflowRunListFilter)({ limit: 101 })).toThrow();
    expect(() => Schema.decodeUnknownSync(WorkflowRunListFilter)({ limit: 0 })).toThrow();
    expect(() => Schema.decodeUnknownSync(WorkflowRunListFilter)({ limit: 1.5 })).toThrow();
    expect(
      Schema.decodeUnknownSync(WorkflowRunCursor)({
        submittedAt: "2026-08-04T00:00:00.000Z",
        invocationId,
      }),
    ).toEqual({
      submittedAt: new Date("2026-08-04T00:00:00.000Z"),
      invocationId,
    });
  });

  it("defines one transport-independent client shape", () => {
    type Client = WorkflowClient<typeof EchoV1, "enqueue-error", "observation-error">;
    const client: Client = {
      enqueue: (_input) => Effect.succeed(makeRunReference(EchoV1, invocationId)),
      get: (_reference) => Stream.succeed(Option.none()),
      list: (_filter) => Stream.succeed([]),
    };

    expectTypeOf<Parameters<Client["enqueue"]>[0]>().toEqualTypeOf<{
      readonly message: string;
    }>();
    expectTypeOf<ReturnType<Client["enqueue"]>>().toEqualTypeOf<
      Effect.Effect<RunReference<typeof EchoV1>, "enqueue-error">
    >();
    expectTypeOf<WorkflowRun<typeof EchoV1>["result"]>().toExtend<
      | { readonly _tag: "Pending" }
      | { readonly _tag: "Success"; readonly value: { readonly echoed: string } }
      | { readonly _tag: "Failure" }
    >();
    expect(client).toBeDefined();
  });
});
