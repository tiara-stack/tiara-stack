import { Effect, Schema } from "effect";
import {
  InvocationId,
  type AnyWorkflowContract,
  type WorkflowContractInput,
} from "effect-zero-workflow/contract";
import { ActorProvenance, EffectivePrincipal } from "sheet-auth/identity";

export const workflowContractExecutionSchema = <Contract extends AnyWorkflowContract>(
  contract: Contract,
) =>
  Schema.Struct({
    invocationId: InvocationId,
    input: contract.input,
    principal: EffectivePrincipal,
    actorProvenance: Schema.optional(ActorProvenance),
  });

export const decodeWorkflowContractInputOrDie = <Contract extends AnyWorkflowContract>(
  contract: Contract,
  input: unknown,
) =>
  (
    Schema.decodeUnknownEffect(contract.input)(input) as Effect.Effect<
      WorkflowContractInput<Contract>,
      Schema.SchemaError
    >
  ).pipe(Effect.orDie);
