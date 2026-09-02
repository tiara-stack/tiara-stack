import { Effect, Layer } from "effect";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { mapDeliveryFailure } from "../shared/interactive";
import { SlotListProvider } from "./slotListProvider";
import {
  loadSlotViewForWorkspace,
  missingConfigurationKey,
  resolveSlotWorkspace,
} from "./slotViewLoading";
import { SlotListWorkflowOperations, SlotListWorkflowOperationsError } from "./slotListService";

const operationError = (operation: string, cause: unknown) =>
  new SlotListWorkflowOperationsError({ operation, cause });

export const slotListWorkflowOperationsLayer = Layer.effect(
  SlotListWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* SlotListProvider;
    const delivery = yield* SheetBotDeliveryClient;
    const missingConfiguration = missingConfigurationKey(persistence);

    const loadSlotView: SlotListWorkflowOperations["Service"]["loadSlotView"] = (input) =>
      loadSlotViewForWorkspace({
        workspaceId: input.workspaceId,
        day: input.day,
        resolveWorkspace: resolveSlotWorkspace(
          persistence,
          input.workspaceId,
          missingConfiguration,
        ),

        provider,
        resolveOperation: "slots.deliverList.resolveWorkspace",
        loadOperation: "slots.deliverList.loadSlotView",
        operationError,
      });

    const respond: SlotListWorkflowOperations["Service"]["respond"] = (
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
