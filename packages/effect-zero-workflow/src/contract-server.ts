import { Effect, Match, Predicate, Schema } from "effect";
import {
  InvocationConflict,
  InvocationId,
  WorkflowContractIdentity,
  WorkflowContractWireVersion,
  workflowContractKey,
  type AnyWorkflowContract,
} from "./contract";

export const CanonicalInputHash = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(
  Schema.brand("effect-zero-workflow/CanonicalInputHash"),
);
export type CanonicalInputHash = Schema.Schema.Type<typeof CanonicalInputHash>;

export const WorkflowInvocationFingerprint = Schema.Struct({
  invocationId: InvocationId,
  contractIdentity: WorkflowContractIdentity,
  wireVersion: WorkflowContractWireVersion,
  canonicalInputHash: CanonicalInputHash,
});
export type WorkflowInvocationFingerprint = Schema.Schema.Type<
  typeof WorkflowInvocationFingerprint
>;

const contractReference = (fingerprint: WorkflowInvocationFingerprint) => ({
  contractIdentity: fingerprint.contractIdentity,
  wireVersion: fingerprint.wireVersion,
});

export const validateInvocationReuse = (
  existing: WorkflowInvocationFingerprint,
  requested: WorkflowInvocationFingerprint,
): Effect.Effect<void, InvocationConflict> => {
  if (existing.invocationId !== requested.invocationId) {
    return Effect.void;
  }

  const reason = Match.value({ existing, requested }).pipe(
    Match.when(
      ({ existing, requested }) => existing.contractIdentity !== requested.contractIdentity,
      () => "ContractIdentityMismatch" as const,
    ),
    Match.when(
      ({ existing, requested }) => existing.wireVersion !== requested.wireVersion,
      () => "WireVersionMismatch" as const,
    ),
    Match.when(
      ({ existing, requested }) => existing.canonicalInputHash !== requested.canonicalInputHash,
      () => "CanonicalInputMismatch" as const,
    ),
    Match.orElse(() => undefined),
  );

  if (Predicate.isUndefined(reason)) {
    return Effect.void;
  }

  return Effect.fail(
    new InvocationConflict({
      invocationId: requested.invocationId,
      reason,
      existing: contractReference(existing),
      requested: contractReference(requested),
      message: `Invocation ${requested.invocationId} conflicts with an existing invocation`,
    }),
  );
};

export const WorkflowContractRegistrationErrorReason = Schema.Literals([
  "DuplicatePublishedContract",
  "DuplicateRegistration",
  "MissingRegistration",
  "UnexpectedRegistration",
  "IncompatibleRegistration",
]);
export type WorkflowContractRegistrationErrorReason = Schema.Schema.Type<
  typeof WorkflowContractRegistrationErrorReason
>;

export class WorkflowContractRegistrationError extends Schema.TaggedErrorClass<WorkflowContractRegistrationError>()(
  "WorkflowContractRegistrationError",
  {
    reason: WorkflowContractRegistrationErrorReason,
    contractIdentity: WorkflowContractIdentity,
    wireVersion: WorkflowContractWireVersion,
    message: Schema.String,
  },
) {}

export interface WorkflowContractRegistration {
  readonly contract: AnyWorkflowContract;
}

const registrationError = (
  reason: WorkflowContractRegistrationErrorReason,
  contract: AnyWorkflowContract,
  message: string,
) =>
  new WorkflowContractRegistrationError({
    reason,
    contractIdentity: contract.identity,
    wireVersion: contract.wireVersion,
    message,
  });

export const validateWorkflowContractRegistrations = <
  Registration extends WorkflowContractRegistration,
>(
  publishedContracts: ReadonlyArray<AnyWorkflowContract>,
  registrations: ReadonlyArray<Registration>,
): Effect.Effect<ReadonlyMap<string, Registration>, WorkflowContractRegistrationError> =>
  Effect.gen(function* () {
    const publishedByKey = new Map<string, AnyWorkflowContract>();
    for (const contract of publishedContracts) {
      const key = workflowContractKey(contract);
      if (publishedByKey.has(key)) {
        return yield* Effect.fail(
          registrationError(
            "DuplicatePublishedContract",
            contract,
            `Published contract is duplicated: ${contract.identity}@${contract.wireVersion}`,
          ),
        );
      }
      publishedByKey.set(key, contract);
    }

    const registrationsByKey = new Map<string, Registration>();
    for (const registration of registrations) {
      const key = workflowContractKey(registration.contract);
      if (registrationsByKey.has(key)) {
        return yield* Effect.fail(
          registrationError(
            "DuplicateRegistration",
            registration.contract,
            `Contract registration is duplicated: ${registration.contract.identity}@${registration.contract.wireVersion}`,
          ),
        );
      }

      const published = publishedByKey.get(key);
      if (Predicate.isUndefined(published)) {
        return yield* Effect.fail(
          registrationError(
            "UnexpectedRegistration",
            registration.contract,
            `Contract is registered but not published: ${registration.contract.identity}@${registration.contract.wireVersion}`,
          ),
        );
      }
      if (published !== registration.contract) {
        return yield* Effect.fail(
          registrationError(
            "IncompatibleRegistration",
            registration.contract,
            `Registration must reference the published declaration: ${registration.contract.identity}@${registration.contract.wireVersion}`,
          ),
        );
      }
      registrationsByKey.set(key, registration);
    }

    for (const contract of publishedContracts) {
      if (!registrationsByKey.has(workflowContractKey(contract))) {
        return yield* Effect.fail(
          registrationError(
            "MissingRegistration",
            contract,
            `Published contract has no server registration: ${contract.identity}@${contract.wireVersion}`,
          ),
        );
      }
    }

    return registrationsByKey;
  });
