import { Cause, Effect, Exit, Predicate, Schema } from "effect";
import { Workflow } from "effect/unstable/workflow";
import { describe, expect, it } from "@effect/vitest";
import {
  InvocationId,
  defineWorkflowContract,
  defineWorkflowContractCatalog,
  workflowContractKey,
} from "./contract";
import {
  CanonicalInputHash,
  effectWorkflowExecutionId,
  WorkflowContractRegistrationError,
  makeWorkflowTransportHandler,
  materializeWorkflowRun,
  validateInvocationReuse,
  validateWorkflowContractRegistrations,
  type WorkflowInvocationContext,
  type WorkflowInvocationStore,
  type WorkflowInvocationFingerprint,
} from "./contract-server";
import {
  WorkflowInvocationUnauthorized,
  WorkflowObservationInvalidData,
  WorkflowObservationUnauthorized,
} from "./contract-transport";

const First = defineWorkflowContract({
  identity: "example.first",
  wireVersion: "1",
  input: Schema.Struct({ value: Schema.String }),
  success: Schema.String,
  declaredFailure: Schema.Never,
  authorizationPolicy: { policy: "example.invoke" },
});

const Second = defineWorkflowContract({
  identity: "example.second",
  wireVersion: "1",
  input: Schema.Struct({ value: Schema.Number }),
  success: Schema.Number,
  declaredFailure: Schema.Never,
  authorizationPolicy: { policy: "example.invoke" },
});

const invocationId = Schema.decodeUnknownSync(InvocationId)("123e4567-e89b-42d3-a456-426614174000");
const otherInvocationId = Schema.decodeUnknownSync(InvocationId)(
  "223e4567-e89b-42d3-a456-426614174000",
);
const inputHash = Schema.decodeUnknownSync(CanonicalInputHash)("sha256:one");
const otherInputHash = Schema.decodeUnknownSync(CanonicalInputHash)("sha256:two");

const fingerprint = (
  overrides: Partial<WorkflowInvocationFingerprint> = {},
): WorkflowInvocationFingerprint => ({
  invocationId,
  contractIdentity: First.identity,
  wireVersion: First.wireVersion,
  canonicalInputHash: inputHash,
  ...overrides,
});

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected Effect to fail");
  }
  const failure = exit.cause.reasons.find(Cause.isFailReason);
  if (Predicate.isUndefined(failure)) {
    throw new Error("Expected Cause to contain a typed failure");
  }
  return failure.error;
};

describe("Workflow Contract server validation", () => {
  it.effect("matches Effect Workflow execution IDs for contract invocations", () =>
    Effect.gen(function* () {
      const workflow = Workflow.make({
        name: workflowContractKey(First),
        payload: Schema.Struct({
          invocationId: InvocationId,
          input: First.input,
          principal: Schema.String,
        }),
        idempotencyKey: ({ invocationId }) => invocationId,
      });
      const payload = { invocationId, input: { value: "hello" }, principal: "principal" };

      expect(yield* effectWorkflowExecutionId(workflow.name, invocationId)).toBe(
        yield* workflow.executionId(payload),
      );
    }),
  );

  it.effect("accepts complete registrations and preserves their handler types", () =>
    Effect.gen(function* () {
      const catalog = defineWorkflowContractCatalog(First, Second);
      const registrations = [
        { contract: First, handler: "first-handler" },
        { contract: Second, handler: "second-handler" },
      ] as const;
      const registry = yield* validateWorkflowContractRegistrations(catalog, registrations);

      expect(registry.get(workflowContractKey(First))?.handler).toBe("first-handler");
      expect(registry.get(workflowContractKey(Second))?.handler).toBe("second-handler");
    }),
  );

  it.effect("fails startup validation when a published contract is unregistered", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        validateWorkflowContractRegistrations(
          [First, Second],
          [{ contract: First, handler: "first-handler" }],
        ),
      );
      const error = failureOf(exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(error).toBeInstanceOf(WorkflowContractRegistrationError);
      expect(error.reason).toBe("MissingRegistration");
      expect(error.contractIdentity).toBe(Second.identity);
    }),
  );

  it.effect("rejects duplicate, unexpected, and declaration-incompatible registrations", () =>
    Effect.gen(function* () {
      const duplicateExit = yield* Effect.exit(
        validateWorkflowContractRegistrations([First], [{ contract: First }, { contract: First }]),
      );
      const duplicate = failureOf(duplicateExit);
      expect(duplicate.reason).toBe("DuplicateRegistration");

      const unexpectedExit = yield* Effect.exit(
        validateWorkflowContractRegistrations([First], [{ contract: Second }]),
      );
      const unexpected = failureOf(unexpectedExit);
      expect(unexpected.reason).toBe("UnexpectedRegistration");

      const duplicatePublishedExit = yield* Effect.exit(
        validateWorkflowContractRegistrations([First, First], [{ contract: First }]),
      );
      const duplicatePublished = failureOf(duplicatePublishedExit);
      expect(duplicatePublished.reason).toBe("DuplicatePublishedContract");

      const redeclaredFirst = defineWorkflowContract({
        ...First,
        input: Schema.Struct({ incompatible: Schema.Boolean }),
      });
      const incompatibleExit = yield* Effect.exit(
        validateWorkflowContractRegistrations([First], [{ contract: redeclaredFirst }]),
      );
      const incompatible = failureOf(incompatibleExit);
      expect(incompatible.reason).toBe("IncompatibleRegistration");
    }),
  );

  it.effect("returns an existing invocation only for the same contract, version, and input", () =>
    Effect.gen(function* () {
      yield* validateInvocationReuse(fingerprint(), fingerprint());
      yield* validateInvocationReuse(
        fingerprint(),
        fingerprint({ invocationId: otherInvocationId, canonicalInputHash: otherInputHash }),
      );

      const identityConflictExit = yield* Effect.exit(
        validateInvocationReuse(fingerprint(), fingerprint({ contractIdentity: Second.identity })),
      );
      const identityConflict = failureOf(identityConflictExit);
      expect(identityConflict.reason).toBe("ContractIdentityMismatch");

      const versionConflictExit = yield* Effect.exit(
        validateInvocationReuse(fingerprint(), fingerprint({ wireVersion: "2" })),
      );
      const versionConflict = failureOf(versionConflictExit);
      expect(versionConflict.reason).toBe("WireVersionMismatch");

      const inputConflictExit = yield* Effect.exit(
        validateInvocationReuse(fingerprint(), fingerprint({ canonicalInputHash: otherInputHash })),
      );
      const inputConflict = failureOf(inputConflictExit);
      expect(inputConflict.reason).toBe("CanonicalInputMismatch");
    }),
  );

  it.effect("maps invalid stored identifiers and timestamps to typed observation failures", () =>
    Effect.gen(function* () {
      const baseRow = {
        runId: invocationId,
        status: "pending" as const,
        result: null,
        error: null,
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      };
      const invalidDate = failureOf(
        yield* Effect.exit(materializeWorkflowRun(First, { ...baseRow, createdAt: "invalid" })),
      );
      const invalidId = failureOf(
        yield* Effect.exit(materializeWorkflowRun(First, { ...baseRow, runId: "invalid" })),
      );

      expect(invalidDate).toBeInstanceOf(WorkflowObservationInvalidData);
      expect(invalidId).toBeInstanceOf(WorkflowObservationInvalidData);
    }),
  );

  it.effect("authorizes before persistence and scopes observation by owner", () =>
    Effect.gen(function* () {
      type TestContext = WorkflowInvocationContext<string, { readonly source: string }>;
      let enqueueCount = 0;
      let actorProvenance: { readonly source: string } | undefined;
      let acceptedAt: number | undefined;
      const observedOwners: Array<string> = [];
      const listedOwners: Array<string> = [];
      const store: WorkflowInvocationStore<string, never, { readonly source: string }> = {
        enqueue: (invocation) =>
          Effect.sync(() => {
            enqueueCount += 1;
            actorProvenance = invocation.actorProvenance;
            acceptedAt = invocation.acceptedAt;
            return invocation.fingerprint;
          }),
        get: (ownerKey) =>
          Effect.sync(() => {
            observedOwners.push(ownerKey);
            return undefined;
          }),
        list: (ownerKey) =>
          Effect.sync(() => {
            listedOwners.push(ownerKey);
            return [];
          }),
      };
      const handler = yield* makeWorkflowTransportHandler({
        contracts: [First],
        registrations: [
          {
            contract: First,
            definitionVersion: "definition-1",
            authorize: (context: TestContext) =>
              context.principal === "allowed"
                ? Effect.void
                : Effect.fail(new WorkflowInvocationUnauthorized({ message: "Invocation denied" })),
            authorizeObservation: (context: TestContext) =>
              context.principal === "allowed"
                ? Effect.void
                : Effect.fail(
                    new WorkflowInvocationUnauthorized({ message: "Observation denied" }),
                  ),
          },
        ],
        store,
      });

      const denied = yield* Effect.exit(
        handler.enqueue(
          First,
          { ownerKey: "owner-a", principal: "denied" },
          { invocationId, input: { value: "hello" } },
        ),
      );
      expect(Exit.isFailure(denied)).toBe(true);
      expect(failureOf(denied)).toBeInstanceOf(WorkflowInvocationUnauthorized);
      expect(enqueueCount).toBe(0);

      const deniedGet = yield* Effect.exit(
        handler.get(First, { ownerKey: "owner-a", principal: "denied" }, invocationId),
      );
      const deniedList = yield* Effect.exit(
        handler.list(First, { ownerKey: "owner-a", principal: "denied" }),
      );
      expect(failureOf(deniedGet)).toBeInstanceOf(WorkflowObservationUnauthorized);
      expect(failureOf(deniedList)).toBeInstanceOf(WorkflowObservationUnauthorized);
      expect(observedOwners).toEqual([]);
      expect(listedOwners).toEqual([]);

      yield* handler.enqueue(
        First,
        {
          ownerKey: "owner-a",
          principal: "allowed",
          actorProvenance: { source: "contract-server-test" },
        },
        { invocationId, input: { value: "hello" } },
      );
      yield* handler.get(First, { ownerKey: "owner-b", principal: "allowed" }, invocationId);
      yield* handler.list(First, { ownerKey: "owner-c", principal: "allowed" });

      expect(enqueueCount).toBe(1);
      expect(actorProvenance).toEqual({ source: "contract-server-test" });
      expect(acceptedAt).toEqual(expect.any(Number));
      expect(observedOwners).toEqual(["owner-b"]);
      expect(listedOwners).toEqual(["owner-c"]);
    }),
  );
});
