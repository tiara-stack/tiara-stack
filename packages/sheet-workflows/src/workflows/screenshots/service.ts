import { Context, Data, type Effect } from "effect";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import type {
  ScreenshotCaptureExecution,
  ScreenshotCaptureResult,
  ScreenshotExecution,
  ScreenshotRenderTarget,
} from "./schema";

export class ScreenshotWorkflowOperationsError extends Data.TaggedError(
  "ScreenshotWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type ScreenshotResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | ScreenshotWorkflowOperationsError
>;

interface ScreenshotSourceOperationsShape {
  readonly resolve: (
    execution: typeof ScreenshotExecution.Type,
  ) => ScreenshotResult<ScreenshotRenderTarget>;
}

export class ScreenshotSourceOperations extends Context.Service<
  ScreenshotSourceOperations,
  ScreenshotSourceOperationsShape
>()("sheet-workflows/ScreenshotSourceOperations") {}

interface ScreenshotCaptureOperationsShape {
  readonly captureAndDeliver: (
    execution: typeof ScreenshotCaptureExecution.Type,
  ) => ScreenshotResult<typeof ScreenshotCaptureResult.Type>;
}

export class ScreenshotCaptureOperations extends Context.Service<
  ScreenshotCaptureOperations,
  ScreenshotCaptureOperationsShape
>()("sheet-workflows/ScreenshotCaptureOperations") {}
