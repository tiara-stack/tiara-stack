import { Effect, Match, Predicate, Schema } from "effect";
import { ReadonlyJSONValue } from "typhoon-zero/schema";
import {
  InvocationConflict,
  InvocationId,
  defaultWorkflowRunListLimit,
  makeRunReference,
  makeWorkflowRunSchema,
  WorkflowContractIdentity,
  WorkflowContractWireVersion,
  type WorkflowContractInput,
  type WorkflowRun,
  type WorkflowRunListFilter,
  workflowContractKey,
  type AnyWorkflowContract,
} from "./contract";
import {
  WorkflowInputRejected,
  WorkflowInvocationUnauthorized,
  WorkflowObservationInvalidData,
  WorkflowObservationUnauthorized,
  type WorkflowEnqueueError,
  type WorkflowEnqueueRequest,
  type WorkflowObservationError,
  type WorkflowTransportHandler,
} from "./contract-transport";

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

export interface ExecutableWorkflowContractRegistration<
  Contract extends AnyWorkflowContract = AnyWorkflowContract,
  Context = unknown,
  Requirements = never,
> extends WorkflowContractRegistration {
  readonly contract: Contract;
  readonly definitionVersion: string;
  readonly authorize: (
    context: Context,
    input: WorkflowContractInput<Contract>,
  ) => Effect.Effect<void, WorkflowInvocationUnauthorized, Requirements>;
  readonly authorizeObservation: (
    context: Context,
  ) => Effect.Effect<void, WorkflowInvocationUnauthorized, Requirements>;
}

export interface WorkflowInvocationContext<Principal = unknown, Provenance = unknown> {
  readonly ownerKey: string;
  readonly principal: Principal;
  readonly actorProvenance?: Provenance | undefined;
}

export interface AcceptedWorkflowInvocation<Principal = unknown, Provenance = unknown> {
  readonly fingerprint: WorkflowInvocationFingerprint;
  readonly workflowName: string;
  readonly definitionVersion: string;
  readonly ownerKey: string;
  readonly principal: Principal;
  readonly actorProvenance?: Provenance | undefined;
  readonly input: typeof ReadonlyJSONValue.Type;
}

export interface MaterializedWorkflowRunRow {
  readonly runId: string;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  readonly result: unknown;
  readonly error: unknown;
  readonly completedAt: Date | number | string | null;
  readonly createdAt: Date | number | string;
  readonly updatedAt: Date | number | string;
}

export interface WorkflowInvocationStore<
  Principal = unknown,
  Requirements = never,
  Provenance = unknown,
> {
  readonly enqueue: (
    invocation: AcceptedWorkflowInvocation<Principal, Provenance>,
  ) => Effect.Effect<WorkflowInvocationFingerprint, WorkflowEnqueueError, Requirements>;
  readonly get: (
    ownerKey: string,
    workflowName: string,
    invocationId: InvocationId,
  ) => Effect.Effect<
    MaterializedWorkflowRunRow | undefined,
    WorkflowObservationError,
    Requirements
  >;
  readonly list: (
    ownerKey: string,
    workflowName: string,
    filter: WorkflowRunListFilter,
  ) => Effect.Effect<
    ReadonlyArray<MaterializedWorkflowRunRow>,
    WorkflowObservationError,
    Requirements
  >;
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

const stableJson = (value: typeof ReadonlyJSONValue.Type): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (Predicate.isObject(value) && !Array.isArray(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const canonicalWorkflowContractInput = <Contract extends AnyWorkflowContract>(
  contract: Contract,
  input: WorkflowContractInput<Contract>,
): Effect.Effect<
  {
    readonly encoded: typeof ReadonlyJSONValue.Type;
    readonly hash: CanonicalInputHash;
  },
  WorkflowInputRejected
> =>
  Schema.encodeEffect(contract.input)(input).pipe(
    Effect.mapError(() => new WorkflowInputRejected({ message: "Workflow input is invalid" })),
    Effect.flatMap((encoded) =>
      Schema.decodeUnknownEffect(ReadonlyJSONValue)(encoded).pipe(
        Effect.mapError(
          () => new WorkflowInputRejected({ message: "Workflow input is not JSON encodable" }),
        ),
      ),
    ),
    Effect.flatMap((encoded) =>
      Effect.tryPromise({
        try: async () => {
          const digest = await globalThis.crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(stableJson(encoded)),
          );
          return {
            encoded,
            hash: Schema.decodeUnknownSync(CanonicalInputHash)(
              `sha256:${bytesToHex(new Uint8Array(digest))}`,
            ),
          };
        },
        catch: () =>
          new WorkflowInputRejected({ message: "Workflow input could not be canonicalized" }),
      }),
    ),
  );

const dateFromUnknown = (
  value: Date | number | string,
): Effect.Effect<string, WorkflowObservationInvalidData> =>
  Effect.try({
    try: () => (Predicate.isDate(value) ? value : new Date(value)).toISOString(),
    catch: () =>
      new WorkflowObservationInvalidData({
        message: "Stored workflow timestamp is not a valid date",
      }),
  });

export const materializeWorkflowRun = <Contract extends AnyWorkflowContract>(
  contract: Contract,
  row: MaterializedWorkflowRunRow,
): Effect.Effect<WorkflowRun<Contract>, WorkflowObservationInvalidData> =>
  Effect.gen(function* () {
    const completedAt = Predicate.isNull(row.completedAt)
      ? undefined
      : yield* dateFromUnknown(row.completedAt);
    const submittedAt = yield* dateFromUnknown(row.createdAt);
    const updatedAt = yield* dateFromUnknown(row.updatedAt);
    const runId = yield* Schema.decodeUnknownEffect(InvocationId)(row.runId).pipe(
      Effect.mapError(
        () =>
          new WorkflowObservationInvalidData({
            message: "Stored workflow run identifier is not a valid invocation id",
          }),
      ),
    );
    const result = Match.value(row.status).pipe(
      Match.when("pending", () => ({ _tag: "Pending" as const, phase: "Queued" as const })),
      Match.when("running", () => ({ _tag: "Pending" as const, phase: "Running" as const })),
      Match.when("succeeded", () => ({
        _tag: "Success" as const,
        value: row.result,
        completedAt,
      })),
      Match.when("failed", () => ({
        _tag: "Failure" as const,
        failure: row.error,
        completedAt,
      })),
      Match.when("cancelled", () => ({
        _tag: "Failure" as const,
        failure: { _tag: "System" as const, code: "Cancelled" as const, retryable: false },
        completedAt,
      })),
      Match.exhaustive,
    );
    return yield* Schema.decodeUnknownEffect(makeWorkflowRunSchema(contract))({
      reference: makeRunReference(contract, runId),
      result,
      submittedAt,
      updatedAt,
    }).pipe(
      Effect.map((run) => run as WorkflowRun<Contract>),
      Effect.mapError(
        () =>
          new WorkflowObservationInvalidData({
            message: "Stored workflow outcome does not match its published contract",
          }),
      ),
    );
  });

export const makeWorkflowTransportHandler = <
  Principal,
  Provenance,
  Context extends WorkflowInvocationContext<Principal, Provenance>,
  Requirements,
>(options: {
  readonly contracts: ReadonlyArray<AnyWorkflowContract>;
  readonly registrations: ReadonlyArray<
    ExecutableWorkflowContractRegistration<AnyWorkflowContract, Context, Requirements>
  >;
  readonly store: WorkflowInvocationStore<Principal, Requirements, Provenance>;
}): Effect.Effect<
  WorkflowTransportHandler<Context, Requirements>,
  WorkflowContractRegistrationError
> =>
  Effect.gen(function* () {
    const registrations = yield* validateWorkflowContractRegistrations(
      options.contracts,
      options.registrations,
    );
    const registrationFor = <Contract extends AnyWorkflowContract>(contract: Contract) =>
      registrations.get(workflowContractKey(contract)) as
        | ExecutableWorkflowContractRegistration<Contract, Context, Requirements>
        | undefined;
    const requireRegistration = <Contract extends AnyWorkflowContract>(contract: Contract) => {
      const registration = registrationFor(contract);
      if (Predicate.isUndefined(registration)) {
        throw new Error(
          `Validated Workflow Contract registration is missing: ${workflowContractKey(contract)}`,
        );
      }
      return registration;
    };
    const authorizeObservation = <Contract extends AnyWorkflowContract>(
      registration: ExecutableWorkflowContractRegistration<Contract, Context, Requirements>,
      context: Context,
    ) =>
      registration.authorizeObservation(context).pipe(
        Effect.mapError(
          () =>
            new WorkflowObservationUnauthorized({
              message: "Workflow observation is unauthorized",
            }),
        ),
      );

    return {
      enqueue: <Contract extends AnyWorkflowContract>(
        contract: Contract,
        context: Context,
        request: WorkflowEnqueueRequest<Contract>,
      ) =>
        Effect.gen(function* () {
          const registration = requireRegistration(contract);
          const decodeInput = Schema.decodeUnknownEffect(contract.input)(
            request.input,
          ) as Effect.Effect<WorkflowContractInput<Contract>, Schema.SchemaError>;
          const input = yield* decodeInput.pipe(
            Effect.mapError(
              () => new WorkflowInputRejected({ message: "Workflow input is invalid" }),
            ),
          );
          yield* registration.authorize(context, input);
          const canonical = yield* canonicalWorkflowContractInput(contract, input);
          const requested: WorkflowInvocationFingerprint = {
            invocationId: request.invocationId,
            contractIdentity: contract.identity,
            wireVersion: contract.wireVersion,
            canonicalInputHash: canonical.hash,
          };
          const accepted = yield* options.store.enqueue({
            fingerprint: requested,
            workflowName: workflowContractKey(contract),
            definitionVersion: registration.definitionVersion,
            ownerKey: context.ownerKey,
            principal: context.principal,
            actorProvenance: context.actorProvenance,
            input: canonical.encoded,
          });
          yield* validateInvocationReuse(accepted, requested);
          return makeRunReference(contract, request.invocationId);
        }),
      get: <Contract extends AnyWorkflowContract>(
        contract: Contract,
        context: Context,
        invocationId: InvocationId,
      ) =>
        Effect.gen(function* () {
          yield* authorizeObservation(requireRegistration(contract), context);
          const row = yield* options.store.get(
            context.ownerKey,
            workflowContractKey(contract),
            invocationId,
          );
          return Predicate.isUndefined(row)
            ? undefined
            : yield* materializeWorkflowRun(contract, row);
        }),
      list: <Contract extends AnyWorkflowContract>(
        contract: Contract,
        context: Context,
        filter: WorkflowRunListFilter = { limit: defaultWorkflowRunListLimit },
      ) =>
        Effect.gen(function* () {
          yield* authorizeObservation(requireRegistration(contract), context);
          const rows = yield* options.store.list(context.ownerKey, workflowContractKey(contract), {
            ...filter,
            limit: filter.limit ?? defaultWorkflowRunListLimit,
          });
          return yield* Effect.forEach(rows, (row) => materializeWorkflowRun(contract, row));
        }),
    };
  });
