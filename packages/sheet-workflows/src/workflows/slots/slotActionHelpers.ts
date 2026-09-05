import { Effect, Option } from "effect";
import { SlotWorkflowOperations, type SlotButtonConversation } from "./operations";

type PreserveFailure<Failure> = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
) => Effect.Effect<A, Failure, R>;

export const loadCurrentSlotForWorkflow = <
  Input extends SlotButtonConversation,
  Failure,
  AuthorizationSuccess,
  AuthorizationRequirements,
>(
  authorize: Effect.Effect<AuthorizationSuccess, unknown, AuthorizationRequirements>,
  inputEffect: Effect.Effect<Input, never, never>,
  preserveFailure: PreserveFailure<Failure>,
) =>
  Effect.gen(function* () {
    yield* preserveFailure(authorize);
    const operations = yield* SlotWorkflowOperations;
    const input = yield* inputEffect;
    return yield* preserveFailure(
      operations.loadCurrentSlot(input).pipe(Effect.map(Option.getOrNull)),
    );
  });
