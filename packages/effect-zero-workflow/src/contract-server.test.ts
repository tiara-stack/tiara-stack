import { Cause, Effect, Exit, Predicate, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  InvocationId,
  defineWorkflowContract,
  defineWorkflowContractCatalog,
  workflowContractKey,
} from "./contract";
import {
  CanonicalInputHash,
  WorkflowContractRegistrationError,
  validateInvocationReuse,
  validateWorkflowContractRegistrations,
  type WorkflowInvocationFingerprint,
} from "./contract-server";

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
});
