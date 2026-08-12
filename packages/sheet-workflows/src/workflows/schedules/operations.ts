import { Effect, Layer, Option, Predicate } from "effect";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveConfigurationMissing,
  interactiveExternalOperationRejected,
  interactiveResourceNotFound,
  mapDeliveryFailure,
} from "../shared/interactive";
import { providerCauseKind } from "../shared/providerFailure";
import { UserScheduleProvider, UserScheduleProviderError } from "./provider";
import { ScheduleWorkflowOperations, ScheduleWorkflowOperationsError } from "./service";

const operationError = (operation: string, cause: unknown) =>
  new ScheduleWorkflowOperationsError({ operation, cause });

const providerRejected = (error: UserScheduleProviderError) =>
  Effect.logWarning("The schedule provider rejected the user schedule read").pipe(
    Effect.annotateLogs({
      providerOperation: error.operation,
      providerCauseKind: providerCauseKind(error.cause),
    }),
    Effect.andThen(
      Effect.fail(
        interactiveExternalOperationRejected(
          "schedules.deliverUserSchedule.loadUserSchedule",
          "ProviderRejected",
          "The schedule provider rejected the user schedule read",
        ),
      ),
    ),
  );

export const scheduleWorkflowOperationsLayer = Layer.effect(
  ScheduleWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* UserScheduleProvider;
    const delivery = yield* SheetBotDeliveryClient;

    const loadUserSchedule: ScheduleWorkflowOperations["Service"]["loadUserSchedule"] = (input) =>
      persistence.workspaces
        .getWorkspaceConfigByWorkspaceId({ workspaceId: input.workspaceId })
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) =>
            operationError("schedules.deliverUserSchedule.resolveWorkspace", cause),
          ),
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

    const respond: ScheduleWorkflowOperations["Service"]["respond"] = (
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
              "schedules.deliverUserSchedule.respond",
              "response",
              false,
              "The user schedule response was rejected",
              operationError,
            ),
          ),
        );

    return { loadUserSchedule, respond };
  }),
);
