import { Effect, Layer } from "effect";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { mapDeliveryFailure } from "../shared/interactive";
import { SlotListProvider } from "./slotListProvider";
import { loadSlotViewForWorkspace } from "./slotViewLoading";
import { SlotOpenWorkflowOperations, SlotOpenWorkflowOperationsError } from "./slotOpenService";

const operationError = (operation: string, cause: unknown) =>
  new SlotOpenWorkflowOperationsError({ operation, cause });

export const slotOpenWorkflowOperationsLayer = Layer.effect(
  SlotOpenWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* SlotListProvider;
    const delivery = yield* SheetBotDeliveryClient;

    const loadSlotView: SlotOpenWorkflowOperations["Service"]["loadSlotView"] = (context) =>
      loadSlotViewForWorkspace({
        workspaceId: context.workspaceId,
        day: context.day,
        resolveWorkspace: persistence.workspaces.getWorkspaceConfigByWorkspaceId({
          workspaceId: context.workspaceId,
        }),
        provider,
        resolveOperation: "slots.open.resolveWorkspace",
        loadOperation: "slots.open.loadSlotView",
        operationError,
      });

    const respond: SlotOpenWorkflowOperations["Service"]["respond"] = (
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
              "slots.open.respond",
              "response",
              false,
              "The slot-open response was rejected",
              operationError,
            ),
          ),
        );

    return { loadSlotView, respond };
  }),
);
