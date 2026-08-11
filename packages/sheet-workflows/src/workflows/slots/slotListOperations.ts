import { Cause, Context, Data, Effect, Layer, Option, Predicate } from "effect";
import { type BotOutboundMessage, DeliveryKey, type RespondReceipt } from "sheet-bot-api";
import {
  type InteractiveDeclaredFailure,
  type SlotsDeliverListInput,
} from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveConfigurationMissing,
  interactiveExternalOperationRejected,
  interactiveResourceNotFound,
  mapDeliveryFailure,
} from "../shared/interactive";
import { SlotListProvider, SlotListProviderError, type SlotView } from "./slotListProvider";

class SlotListWorkflowOperationsError extends Data.TaggedError("SlotListWorkflowOperationsError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type SlotListResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | SlotListWorkflowOperationsError
>;

interface SlotListWorkflowOperationsShape {
  readonly loadSlotView: (input: SlotsDeliverListInput) => SlotListResult<SlotView>;
  readonly respond: (
    input: SlotsDeliverListInput,
    message: BotOutboundMessage,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => SlotListResult<RespondReceipt>;
}

export class SlotListWorkflowOperations extends Context.Service<
  SlotListWorkflowOperations,
  SlotListWorkflowOperationsShape
>()("sheet-workflows/SlotListWorkflowOperations") {}

const operationError = (operation: string, cause: unknown) =>
  new SlotListWorkflowOperationsError({ operation, cause });

const providerCauseKinds: ReadonlyArray<readonly [(cause: unknown) => boolean, string]> = [
  [Cause.isTimeoutError, "timeout"],
  [
    (cause) =>
      Predicate.hasProperty(cause, "response") &&
      Predicate.hasProperty(cause.response, "status") &&
      Predicate.isNumber(cause.response.status),
    "http-response",
  ],
  [
    (cause) => Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code),
    "coded-error",
  ],
  [
    (cause) => Predicate.hasProperty(cause, "_tag") && Predicate.isString(cause._tag),
    "tagged-error",
  ],
  [Predicate.isError, "error"],
];

const providerCauseKind = (cause: unknown): string =>
  providerCauseKinds.find(([matches]) => matches(cause))?.[1] ?? "unknown";

const providerRejected = (error: SlotListProviderError) =>
  Effect.logWarning("The schedule provider rejected the slot view read").pipe(
    Effect.annotateLogs({
      providerOperation: error.operation,
      providerCauseKind: providerCauseKind(error.cause),
    }),
    Effect.andThen(
      Effect.fail(
        interactiveExternalOperationRejected(
          "slots.deliverList.loadSlotView",
          "ProviderRejected",
          "The schedule provider rejected the slot view read",
        ),
      ),
    ),
  );

export const slotListWorkflowOperationsLayer = Layer.effect(
  SlotListWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* SlotListProvider;
    const delivery = yield* SheetBotDeliveryClient;

    const loadSlotView: SlotListWorkflowOperationsShape["loadSlotView"] = (input) =>
      persistence.workspaces
        .getWorkspaceConfigByWorkspaceId({ workspaceId: input.workspaceId })
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) => operationError("slots.deliverList.resolveWorkspace", cause)),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(interactiveResourceNotFound("workspace", input.workspaceId)),
              onSome: ({ sheetId }) =>
                Predicate.isNull(sheetId)
                  ? Effect.fail(interactiveConfigurationMissing("workspace.sheetId"))
                  : provider.load(sheetId, input.day).pipe(Effect.catch(providerRejected)),
            }),
          ),
        );

    const respond: SlotListWorkflowOperationsShape["respond"] = (
      input,
      message,
      deliveryKey,
      policy,
    ) =>
      delivery
        .get()
        .delivery.respond({
          payload: {
            responseReference: input.responseReference,
            deliveryKey,
            message,
          },
        })
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError(
            mapDeliveryFailure(
              policy,
              "slots.deliverList.respond",
              "response",
              false,
              "The slot list response was rejected",
              operationError,
            ),
          ),
        );

    return { loadSlotView, respond };
  }),
);
