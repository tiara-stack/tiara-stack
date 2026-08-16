import { Schema } from "effect";
import { RespondReceipt } from "sheet-bot-api";
import { ScreenshotsCaptureAndDeliver } from "sheet-workflow-contracts";
import { workflowContractExecutionSchema } from "../shared/execution";

const BoundedRenderUrl = Schema.String.check(Schema.isMaxLength(2_048)).check(
  Schema.makeFilter((value) => {
    try {
      return new URL(value).origin === "https://docs.google.com"
        ? undefined
        : "Expected an HTTPS URL on the docs.google.com origin";
    } catch {
      return "Expected an HTTPS URL on the docs.google.com origin";
    }
  }),
);

export const ScreenshotRenderTargetSchema = Schema.Struct({
  url: BoundedRenderUrl,
});
export type ScreenshotRenderTarget = typeof ScreenshotRenderTargetSchema.Type;

export const maximumScreenshotPngByteLength = 8 * 1024 * 1024;

export const ScreenshotExecution = workflowContractExecutionSchema(ScreenshotsCaptureAndDeliver);

export const ScreenshotCaptureExecution = Schema.Struct({
  ...ScreenshotExecution.fields,
  target: ScreenshotRenderTargetSchema,
});

export const ScreenshotCaptureResult = Schema.Struct({
  receipt: RespondReceipt,
  byteLength: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: maximumScreenshotPngByteLength }),
  ),
});
