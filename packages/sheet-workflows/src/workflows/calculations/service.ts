import { Context, Data, type Effect } from "effect";
import type { CalculationDeclaredFailure } from "sheet-workflow-contracts";
import type {
  CalculationSource,
  CalculationWriteReceipt,
  CalculationWriteExecution,
  CanonicalCalculationExecution,
} from "./schema";

export class CalculationWorkflowOperationsError extends Data.TaggedError(
  "CalculationWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type CalculationResult<A> = Effect.Effect<
  A,
  CalculationDeclaredFailure | CalculationWorkflowOperationsError
>;

interface CalculationWorkflowOperationsShape {
  readonly load: (
    execution: typeof CanonicalCalculationExecution.Type,
  ) => CalculationResult<CalculationSource>;
  readonly write: (
    execution: typeof CalculationWriteExecution.Type,
  ) => CalculationResult<CalculationWriteReceipt>;
}

export class CalculationWorkflowOperations extends Context.Service<
  CalculationWorkflowOperations,
  CalculationWorkflowOperationsShape
>()("sheet-workflows/CalculationWorkflowOperations") {}
