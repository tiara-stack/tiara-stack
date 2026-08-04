import { Predicate, Schema } from "effect";
import type { Effect, Option, Stream } from "effect";
import type { ReadonlyJSONValue as ZeroReadonlyJSONValue } from "@rocicorp/zero";
import { ReadonlyJSONValue } from "typhoon-zero/schema";

const StableIdentifier = Schema.Trimmed.check(Schema.isNonEmpty());

export const WorkflowContractIdentity = StableIdentifier;
export type WorkflowContractIdentity = Schema.Schema.Type<typeof WorkflowContractIdentity>;

export const WorkflowContractWireVersion = StableIdentifier;
export type WorkflowContractWireVersion = Schema.Schema.Type<typeof WorkflowContractWireVersion>;

export const InvocationId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("effect-zero-workflow/InvocationId"),
);
export type InvocationId = Schema.Schema.Type<typeof InvocationId>;

export const WorkflowAuthorizationPolicyMetadataSchema = Schema.StructWithRest(
  Schema.Struct({
    policy: StableIdentifier,
  }),
  [Schema.Record(Schema.String, ReadonlyJSONValue)],
);

export interface WorkflowAuthorizationPolicyMetadata {
  readonly policy: string;
  readonly [metadata: string]: ZeroReadonlyJSONValue;
}

const deepFreezeJson = <Value extends ZeroReadonlyJSONValue | undefined>(value: Value): Value => {
  if (Predicate.isObjectOrArray(value)) {
    for (const nestedValue of Object.values(value) as ReadonlyArray<
      ZeroReadonlyJSONValue | undefined
    >) {
      deepFreezeJson(nestedValue);
    }
    Object.freeze(value);
  }
  return value;
};

export type WorkflowContractSchema = Schema.Top & {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
};

export interface WorkflowContract<
  out Identity extends string,
  out WireVersion extends string,
  out Input extends WorkflowContractSchema,
  out Success extends WorkflowContractSchema,
  out DeclaredFailure extends WorkflowContractSchema,
  out AuthorizationPolicy extends WorkflowAuthorizationPolicyMetadata,
> {
  readonly identity: Identity;
  readonly wireVersion: WireVersion;
  readonly input: Input;
  readonly success: Success;
  readonly declaredFailure: DeclaredFailure;
  readonly authorizationPolicy: AuthorizationPolicy;
}

export type AnyWorkflowContract = WorkflowContract<
  string,
  string,
  WorkflowContractSchema,
  WorkflowContractSchema,
  WorkflowContractSchema,
  WorkflowAuthorizationPolicyMetadata
>;

export type WorkflowContractInput<Contract extends AnyWorkflowContract> = Schema.Schema.Type<
  Contract["input"]
>;

export type WorkflowContractSuccess<Contract extends AnyWorkflowContract> = Schema.Schema.Type<
  Contract["success"]
>;

export type WorkflowContractDeclaredFailure<Contract extends AnyWorkflowContract> =
  Schema.Schema.Type<Contract["declaredFailure"]>;

export const defineWorkflowContract = <
  const Identity extends string,
  const WireVersion extends string,
  Input extends WorkflowContractSchema,
  Success extends WorkflowContractSchema,
  DeclaredFailure extends WorkflowContractSchema,
  const AuthorizationPolicy extends WorkflowAuthorizationPolicyMetadata,
>(options: {
  readonly identity: Identity;
  readonly wireVersion: WireVersion;
  readonly input: Input;
  readonly success: Success;
  readonly declaredFailure: DeclaredFailure;
  readonly authorizationPolicy: AuthorizationPolicy;
}): WorkflowContract<
  Identity,
  WireVersion,
  Input,
  Success,
  DeclaredFailure,
  AuthorizationPolicy
> => {
  Schema.decodeUnknownSync(WorkflowContractIdentity)(options.identity);
  Schema.decodeUnknownSync(WorkflowContractWireVersion)(options.wireVersion);
  const authorizationPolicy = Schema.decodeUnknownSync(WorkflowAuthorizationPolicyMetadataSchema)(
    options.authorizationPolicy,
  ) as AuthorizationPolicy;
  return Object.freeze({
    identity: options.identity,
    wireVersion: options.wireVersion,
    input: options.input,
    success: options.success,
    declaredFailure: options.declaredFailure,
    authorizationPolicy: deepFreezeJson(authorizationPolicy),
  });
};

export const defineWorkflowContractCatalog = <
  const Contracts extends ReadonlyArray<AnyWorkflowContract>,
>(
  ...contracts: Contracts
): Contracts => {
  Object.freeze(contracts);
  return contracts;
};

export const workflowContractKey = (contract: AnyWorkflowContract): string =>
  JSON.stringify([contract.identity, contract.wireVersion]);

export type RunReference<Contract extends AnyWorkflowContract> = {
  readonly invocationId: InvocationId;
  readonly contractIdentity: Contract["identity"];
  readonly wireVersion: Contract["wireVersion"];
};

const makeRunReferenceSchemaUncached = <Contract extends AnyWorkflowContract>(contract: Contract) =>
  Schema.Struct({
    invocationId: InvocationId,
    contractIdentity: Schema.Literal<Contract["identity"]>(contract.identity),
    wireVersion: Schema.Literal<Contract["wireVersion"]>(contract.wireVersion),
  });

type RunReferenceSchema<Contract extends AnyWorkflowContract> = ReturnType<
  typeof makeRunReferenceSchemaUncached<Contract>
>;

const runReferenceSchemaCache = new WeakMap<AnyWorkflowContract, Schema.Top>();

export const makeRunReferenceSchema = <Contract extends AnyWorkflowContract>(
  contract: Contract,
): RunReferenceSchema<Contract> => {
  const cached = runReferenceSchemaCache.get(contract);
  if (Predicate.isNotUndefined(cached)) {
    return cached as RunReferenceSchema<Contract>;
  }
  const schema = makeRunReferenceSchemaUncached(contract);
  runReferenceSchemaCache.set(contract, schema);
  return schema;
};

export const makeRunReference = <Contract extends AnyWorkflowContract>(
  contract: Contract,
  invocationId: InvocationId,
): RunReference<Contract> => ({
  invocationId,
  contractIdentity: contract.identity,
  wireVersion: contract.wireVersion,
});

const runReferenceGuardCache = new WeakMap<AnyWorkflowContract, (reference: unknown) => boolean>();

export const isRunReferenceFor = <Contract extends AnyWorkflowContract>(
  contract: Contract,
  reference: unknown,
): reference is RunReference<Contract> => {
  const cached = runReferenceGuardCache.get(contract);
  if (Predicate.isNotUndefined(cached)) {
    return cached(reference);
  }
  const guard = Schema.is(makeRunReferenceSchema(contract));
  runReferenceGuardCache.set(contract, guard);
  return guard(reference);
};

export const WorkflowSystemFailureCode = Schema.Literals([
  "RetriesExhausted",
  "Cancelled",
  "DefinitionUnavailable",
]);
export type WorkflowSystemFailureCode = Schema.Schema.Type<typeof WorkflowSystemFailureCode>;

export const WorkflowSystemFailure = Schema.TaggedStruct("System", {
  code: WorkflowSystemFailureCode,
  retryable: Schema.Boolean,
});
export type WorkflowSystemFailure = Schema.Schema.Type<typeof WorkflowSystemFailure>;

export const WorkflowPendingPhase = Schema.Literals(["Queued", "Running"]);
export type WorkflowPendingPhase = Schema.Schema.Type<typeof WorkflowPendingPhase>;

export const WorkflowRunState = Schema.Literals(["Pending", "Success", "Failure"]);
export type WorkflowRunState = Schema.Schema.Type<typeof WorkflowRunState>;

const makeWorkflowResultSchemaUncached = <Contract extends AnyWorkflowContract>(
  contract: Contract,
) => {
  const success: Contract["success"] = contract.success;
  const declaredFailure: Contract["declaredFailure"] = contract.declaredFailure;
  return Schema.Union([
    Schema.TaggedStruct("Pending", {
      phase: WorkflowPendingPhase,
    }),
    Schema.TaggedStruct("Success", {
      value: success,
      completedAt: Schema.DateFromString,
    }),
    Schema.TaggedStruct("Failure", {
      failure: Schema.Union([
        Schema.TaggedStruct("Declared", {
          error: declaredFailure,
        }),
        WorkflowSystemFailure,
      ]),
      completedAt: Schema.DateFromString,
    }),
  ]);
};

type WorkflowResultSchema<Contract extends AnyWorkflowContract> = ReturnType<
  typeof makeWorkflowResultSchemaUncached<Contract>
>;

const workflowResultSchemaCache = new WeakMap<AnyWorkflowContract, Schema.Top>();

export const makeWorkflowResultSchema = <Contract extends AnyWorkflowContract>(
  contract: Contract,
): WorkflowResultSchema<Contract> => {
  const cached = workflowResultSchemaCache.get(contract);
  if (Predicate.isNotUndefined(cached)) {
    return cached as WorkflowResultSchema<Contract>;
  }
  const schema = makeWorkflowResultSchemaUncached(contract);
  workflowResultSchemaCache.set(contract, schema);
  return schema;
};

export type WorkflowResult<Contract extends AnyWorkflowContract> =
  | {
      readonly _tag: "Pending";
      readonly phase: WorkflowPendingPhase;
    }
  | {
      readonly _tag: "Success";
      readonly value: WorkflowContractSuccess<Contract>;
      readonly completedAt: Date;
    }
  | {
      readonly _tag: "Failure";
      readonly failure:
        | {
            readonly _tag: "Declared";
            readonly error: WorkflowContractDeclaredFailure<Contract>;
          }
        | WorkflowSystemFailure;
      readonly completedAt: Date;
    };

export type WorkflowRun<Contract extends AnyWorkflowContract> = {
  readonly reference: RunReference<Contract>;
  readonly result: WorkflowResult<Contract>;
  readonly submittedAt: Date;
  readonly updatedAt: Date;
};

const makeWorkflowRunSchemaUncached = <Contract extends AnyWorkflowContract>(contract: Contract) =>
  Schema.Struct({
    reference: makeRunReferenceSchema(contract),
    result: makeWorkflowResultSchema(contract),
    submittedAt: Schema.DateFromString,
    updatedAt: Schema.DateFromString,
  });

type WorkflowRunSchema<Contract extends AnyWorkflowContract> = ReturnType<
  typeof makeWorkflowRunSchemaUncached<Contract>
>;

const workflowRunSchemaCache = new WeakMap<AnyWorkflowContract, Schema.Top>();

export const makeWorkflowRunSchema = <Contract extends AnyWorkflowContract>(
  contract: Contract,
): WorkflowRunSchema<Contract> => {
  const cached = workflowRunSchemaCache.get(contract);
  if (Predicate.isNotUndefined(cached)) {
    return cached as WorkflowRunSchema<Contract>;
  }
  const schema = makeWorkflowRunSchemaUncached(contract);
  workflowRunSchemaCache.set(contract, schema);
  return schema;
};

export const WorkflowRunCursor = Schema.Struct({
  submittedAt: Schema.DateFromString,
  invocationId: InvocationId,
});
export type WorkflowRunCursor = Schema.Schema.Type<typeof WorkflowRunCursor>;

export const defaultWorkflowRunListLimit = 20;
export const maximumWorkflowRunListLimit = 100;

export const WorkflowRunListFilter = Schema.Struct({
  states: Schema.optional(Schema.Array(WorkflowRunState)),
  cursor: Schema.optional(WorkflowRunCursor),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumWorkflowRunListLimit })),
  ),
});
export type WorkflowRunListFilter = Schema.Schema.Type<typeof WorkflowRunListFilter>;

export const WorkflowEnqueueOptions = Schema.Struct({
  invocationId: Schema.optional(InvocationId),
});
export type WorkflowEnqueueOptions = Schema.Schema.Type<typeof WorkflowEnqueueOptions>;

const InvocationContractReference = Schema.Struct({
  contractIdentity: WorkflowContractIdentity,
  wireVersion: WorkflowContractWireVersion,
});

export const InvocationConflictReason = Schema.Literals([
  "ContractIdentityMismatch",
  "WireVersionMismatch",
  "CanonicalInputMismatch",
]);
export type InvocationConflictReason = Schema.Schema.Type<typeof InvocationConflictReason>;

export class InvocationConflict extends Schema.TaggedErrorClass<InvocationConflict>()(
  "InvocationConflict",
  {
    invocationId: InvocationId,
    reason: InvocationConflictReason,
    existing: InvocationContractReference,
    requested: InvocationContractReference,
    message: Schema.String,
  },
) {}

export interface WorkflowClient<
  Contract extends AnyWorkflowContract,
  EnqueueError,
  ObservationError,
  EnqueueRequirements = never,
  ObservationRequirements = never,
> {
  readonly enqueue: (
    input: WorkflowContractInput<Contract>,
    options?: WorkflowEnqueueOptions,
  ) => Effect.Effect<RunReference<Contract>, EnqueueError, EnqueueRequirements>;
  readonly get: (
    reference: RunReference<Contract>,
  ) => Stream.Stream<
    Option.Option<WorkflowRun<Contract>>,
    ObservationError,
    ObservationRequirements
  >;
  readonly list: (
    filter?: WorkflowRunListFilter,
  ) => Stream.Stream<
    ReadonlyArray<WorkflowRun<Contract>>,
    ObservationError,
    ObservationRequirements
  >;
}
