import { Effect, Layer, Match, Option, Predicate, Schema, Semaphore } from "effect";
import { workspaceRefFrom, type BotSemanticFileBinding, type RespondReceipt } from "sheet-bot-api";
import { ScreenshotsCaptureAndDeliver, SpreadsheetId } from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { config } from "@/config";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveAuthorizationRevoked,
  interactiveConfigurationMissing,
  interactiveDeliveryRejected,
  interactiveExternalOperationRejected,
  interactiveInvalidRequest,
  interactiveResourceNotFound,
  mapDeliveryFailure,
} from "../shared/interactive";
import { providerCauseKind } from "../shared/providerFailure";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { ScreenshotBrowser, ScreenshotBrowserError } from "./browser";
import {
  makeScreenshotDeliveryKey,
  makeScreenshotLogicalRequest,
  makeScreenshotSemanticFileIdentity,
} from "./keys";
import type { ScreenshotCaptureExecution } from "./schema";
import {
  ScreenshotCaptureOperations,
  ScreenshotSourceOperations,
  ScreenshotWorkflowOperationsError,
} from "./service";
import {
  ScreenshotSourceProvider,
  ScreenshotSourceProviderError,
  type ScreenshotSourceResolutionCode,
} from "./sourceProvider";

const resolveOperation = "screenshots.captureAndDeliver.resolve-screenshot-source";
const captureOperation = "screenshots.captureAndDeliver.capture-and-deliver-screenshot";
const screenshotFilename = "screenshot.png";
const screenshotContentType = "image/png";

const operationError = (operation: string, cause: unknown) =>
  new ScreenshotWorkflowOperationsError({ operation, cause });

const isInteractiveDeclaredFailure = Schema.is(ScreenshotsCaptureAndDeliver.declaredFailure);

const reauthorizationFailure = (operation: string, error: unknown) =>
  Match.value(error).pipe(
    Match.when(Predicate.isTagged("WorkflowInvocationUnauthorized"), () =>
      interactiveAuthorizationRevoked(ScreenshotsCaptureAndDeliver.authorizationPolicy.policy),
    ),
    Match.when(isInteractiveDeclaredFailure, (declaredFailure) => declaredFailure),
    Match.orElse((cause) => operationError(`${operation}.authorize`, cause)),
  );

const makeReauthorize =
  (authorization: ReadOnlyWorkflowAuthorization["Service"]) =>
  (
    execution: {
      readonly principal: Parameters<typeof authorization.authorize>[1];
      readonly input: unknown;
    },
    operation: string,
  ) =>
    authorization
      .authorize(ScreenshotsCaptureAndDeliver, execution.principal, execution.input)
      .pipe(Effect.mapError((error) => reauthorizationFailure(operation, error)));

const sourceResolutionFailure = (code: typeof ScreenshotSourceResolutionCode.Type) =>
  Match.value(code).pipe(
    Match.when("MissingSchedule", () => interactiveConfigurationMissing("screenshot.schedule")),
    Match.when("MissingSheet", () => interactiveConfigurationMissing("screenshot.sheet")),
    Match.when("MissingScreenshotRange", () => interactiveConfigurationMissing("screenshot.range")),
    Match.when("MissingSheetGid", () => interactiveConfigurationMissing("screenshot.sheetGid")),
    Match.when("InvalidSpreadsheetId", () => interactiveConfigurationMissing("workspace.sheetId")),
    Match.when("InvalidSheet", () =>
      interactiveExternalOperationRejected(
        resolveOperation,
        "InvalidSheet",
        "The configured screenshot sheet is invalid",
      ),
    ),
    Match.when("InvalidScreenshotRange", () =>
      interactiveExternalOperationRejected(
        resolveOperation,
        "InvalidScreenshotRange",
        "The configured screenshot range is invalid",
      ),
    ),
    Match.when("InvalidSheetGid", () =>
      interactiveExternalOperationRejected(
        resolveOperation,
        "InvalidSheetGid",
        "The configured screenshot sheet identifier is invalid",
      ),
    ),
    Match.when("InvalidMetadata", () =>
      interactiveExternalOperationRejected(
        resolveOperation,
        "InvalidProviderResponse",
        "The Sheets provider returned invalid screenshot metadata",
      ),
    ),
    Match.when("InvalidRenderTarget", () =>
      interactiveExternalOperationRejected(
        resolveOperation,
        "InvalidRenderTarget",
        "The generated screenshot render target is invalid",
      ),
    ),
    Match.exhaustive,
  );

const providerFailure = (error: ScreenshotSourceProviderError) =>
  Effect.logWarning("The Sheets provider failed the screenshot source read").pipe(
    Effect.annotateLogs({
      providerOperation: error.operation,
      providerCauseKind: providerCauseKind(error.cause),
    }),
    Effect.andThen(Effect.fail(operationError(`${resolveOperation}.${error.operation}`, error))),
  );

export const screenshotSourceOperationsLayer = Layer.effect(
  ScreenshotSourceOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* ScreenshotSourceProvider;
    const reauthorize = makeReauthorize(yield* ReadOnlyWorkflowAuthorization);

    const resolve: ScreenshotSourceOperations["Service"]["resolve"] = (execution) =>
      Effect.gen(function* () {
        const input = yield* decodeWorkflowContractInputOrDie(
          ScreenshotsCaptureAndDeliver,
          execution.input,
        );
        yield* reauthorize(execution, resolveOperation);
        const workspace = yield* persistence.workspaces
          .getWorkspaceConfigByWorkspaceId({ workspaceId: input.workspaceId })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) => operationError(`${resolveOperation}.workspace`, cause)),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(interactiveResourceNotFound("workspace", input.workspaceId)),
                onSome: Effect.succeed,
              }),
            ),
          );
        if (
          workspace.workspaceId !== input.workspaceId ||
          Predicate.isNotNull(workspace.deletedAt)
        ) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "NonCanonicalScreenshotWorkspace",
              "Trusted persistence returned a non-canonical workspace",
            ),
          );
        }
        const spreadsheetId = yield* Predicate.isNull(workspace.sheetId)
          ? Effect.fail(interactiveConfigurationMissing("workspace.sheetId"))
          : Schema.decodeUnknownEffect(SpreadsheetId)(workspace.sheetId).pipe(
              Effect.mapError(() => interactiveConfigurationMissing("workspace.sheetId")),
            );
        return yield* provider.resolve(spreadsheetId, input.conversationName, input.day).pipe(
          Effect.catchTag("ScreenshotSourceResolutionError", ({ code }) =>
            Effect.fail(sourceResolutionFailure(code)),
          ),
          Effect.catchTag("ScreenshotSourceProviderError", providerFailure),
        );
      });

    return { resolve };
  }),
);

const fileBindingFor = (
  invocationId: (typeof ScreenshotCaptureExecution.Type)["invocationId"],
  input: typeof ScreenshotsCaptureAndDeliver.input.Type,
): BotSemanticFileBinding => ({
  semanticIdentity: makeScreenshotSemanticFileIdentity(
    invocationId,
    input.workspaceId,
    input.conversationName,
    input.day,
  ),
  logicalRequest: makeScreenshotLogicalRequest(
    input.workspaceId,
    input.conversationName,
    input.day,
  ),
});

const validateReceipt = (
  receipt: RespondReceipt,
  responseReference: (typeof ScreenshotsCaptureAndDeliver.input.Type)["responseReference"],
  expected: {
    readonly deliveryKey: RespondReceipt["deliveryKey"];
    readonly binding: BotSemanticFileBinding;
  },
) => {
  const file = receipt.files?.[0];
  const mismatchedFields = [
    ["operation", receipt.operation === "respond"],
    ["deliveryKey", receipt.deliveryKey === expected.deliveryKey],
    ["responseReference", receipt.target.responseReference === responseReference],
    ["files.length", receipt.files?.length === 1],
    ["filename", file?.name === screenshotFilename],
    ["contentType", file?.contentType === screenshotContentType],
    [
      "deliveryBinding.semanticIdentity",
      file?.deliveryBinding?.semanticIdentity === expected.binding.semanticIdentity,
    ],
    [
      "deliveryBinding.logicalRequest",
      file?.deliveryBinding?.logicalRequest === expected.binding.logicalRequest,
    ],
  ]
    .filter(([, matches]) => !matches)
    .map(([field]) => field);
  if (mismatchedFields.length > 0 || Predicate.isUndefined(file)) {
    return Effect.logWarning("The screenshot response receipt did not match").pipe(
      Effect.annotateLogs({ mismatchedReceiptFields: mismatchedFields.join(",") }),
      Effect.andThen(
        Effect.fail(
          interactiveDeliveryRejected(
            captureOperation,
            "The screenshot response receipt did not match the requested delivery",
            false,
          ),
        ),
      ),
    );
  }
  return Effect.succeed({ receipt, byteLength: file.byteLength });
};

const browserFailure = (error: ScreenshotBrowserError) =>
  Effect.logWarning("The browser runner failed screenshot capture").pipe(
    Effect.annotateLogs({ browserOperation: error.operation }),
    Effect.andThen(Effect.fail(operationError(`${captureOperation}.${error.operation}`, error))),
  );

export const screenshotCaptureOperationsLayer = Layer.effect(
  ScreenshotCaptureOperations,
  Effect.gen(function* () {
    const browser = yield* ScreenshotBrowser;
    const delivery = yield* SheetBotDeliveryClient;
    const concurrency = yield* config.screenshotBrowserConcurrency;
    const clientId = yield* config.sheetBotClientId;
    const client = { platform: "discord", clientId } as const;
    const semaphore = yield* Semaphore.make(concurrency);
    const reauthorize = makeReauthorize(yield* ReadOnlyWorkflowAuthorization);

    const captureAndDeliver: ScreenshotCaptureOperations["Service"]["captureAndDeliver"] = (
      execution,
    ) =>
      Effect.gen(function* () {
        const input = yield* decodeWorkflowContractInputOrDie(
          ScreenshotsCaptureAndDeliver,
          execution.input,
        );
        const content = yield* semaphore.withPermit(
          browser
            .capture(execution.target)
            .pipe(Effect.catchTag("ScreenshotBrowserError", browserFailure)),
        );
        const deliveryKey = makeScreenshotDeliveryKey(execution.invocationId);
        const binding = fileBindingFor(execution.invocationId, input);

        // Keep the second policy check adjacent to the only external Commit Point.
        yield* reauthorize(execution, captureOperation);
        const receipt = yield* delivery
          .get()
          .delivery.respond({
            payload: {
              responseReference: input.responseReference,
              deliveryKey,
              workspace: workspaceRefFrom(client, input.workspaceId),
              message: {
                files: [
                  {
                    name: screenshotFilename,
                    contentType: screenshotContentType,
                    content,
                    deliveryBinding: binding,
                  },
                ],
              },
            },
          })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(
              mapDeliveryFailure(
                ScreenshotsCaptureAndDeliver.authorizationPolicy.policy,
                captureOperation,
                "response",
                false,
                "The screenshot response was rejected",
                operationError,
              ),
            ),
          );
        return yield* validateReceipt(receipt, input.responseReference, { deliveryKey, binding });
      });

    return { captureAndDeliver };
  }),
);
