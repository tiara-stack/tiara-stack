import { Effect, Layer, Option, Predicate } from "effect";
import { DeliveryKey, ResponseReference, type BotOutboundMessage } from "sheet-bot-api";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { WorkspaceId } from "sheet-workflow-contracts";
import { resolveAuthoritativeConfigurationForOperation } from "../shared/authoritativeConfiguration";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveExternalOperationRejected,
  interactiveResourceNotFound,
  mapDeliveryFailure,
} from "../shared/interactive";
import { providerCauseKind } from "../shared/providerFailure";
import { UserScheduleProvider, UserScheduleProviderError } from "./provider";
import { ScheduleWorkflowOperations, ScheduleWorkflowOperationsError } from "./service";

const operationError = (operation: string, cause: unknown) =>
  new ScheduleWorkflowOperationsError({ operation, cause });

const providerRejected =
  (operation: string, message: string) => (error: UserScheduleProviderError) =>
    Effect.logWarning("The schedule provider rejected the schedule read").pipe(
      Effect.annotateLogs({
        providerOperation: error.operation,
        providerCauseKind: providerCauseKind(error.cause),
      }),
      Effect.andThen(
        Effect.fail(interactiveExternalOperationRejected(operation, "ProviderRejected", message)),
      ),
    );

const loadScheduleView = (
  persistence: TrustedSheetPersistence["Service"],
  workspaceId: typeof WorkspaceId.Type,
  operation: string,
  providerFailureOperation: string,
  providerFailureMessage: string,
  load: (
    spreadsheetId: string,
    configuration: Parameters<UserScheduleProvider["Service"]["load"]>[2],
  ) => ReturnType<UserScheduleProvider["Service"]["load"]>,
) =>
  Effect.gen(function* () {
    const workspace = yield* persistence.workspaces
      .getWorkspaceConfigByWorkspaceId({ workspaceId })
      .pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) => operationError(`${operation}.resolveWorkspace`, cause)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(interactiveResourceNotFound("workspace", workspaceId)),
            onSome: Effect.succeed,
          }),
        ),
      );
    const active = yield* resolveAuthoritativeConfigurationForOperation(
      persistence,
      workspaceId,
      Option.some(workspace),
      `${operation}.resolveSource`,
      operationError,
    );
    return yield* load(active.spreadsheetId, active.configuration).pipe(
      Effect.catch(providerRejected(providerFailureOperation, providerFailureMessage)),
    );
  });

export const scheduleWorkflowOperationsLayer = Layer.effect(
  ScheduleWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* UserScheduleProvider;
    const delivery = yield* SheetBotDeliveryClient;

    const deliverResponse = (
      input: { readonly responseReference: typeof ResponseReference.Type },
      message: typeof BotOutboundMessage.Type,
      deliveryKey: typeof DeliveryKey.Type,
      policy: string,
      operation: string,
      rejectionMessage: string,
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
              operation,
              "response",
              false,
              rejectionMessage,
              operationError,
            ),
          ),
        );

    const loadUserSchedule: ScheduleWorkflowOperations["Service"]["loadUserSchedule"] = (input) =>
      loadScheduleView(
        persistence,
        input.workspaceId,
        "schedules.deliverUserSchedule",
        "schedules.deliverUserSchedule.loadUserSchedule",
        "The schedule provider rejected the user schedule read",
        (spreadsheetId, configuration) => provider.load(spreadsheetId, input.day, configuration),
      );

    const loadChannelFillers: ScheduleWorkflowOperations["Service"]["loadChannelFillers"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const conversation = yield* persistence.workspaces
          .getWorkspaceConversationByName({
            workspaceId: input.workspaceId,
            conversationName: input.conversationName,
            running: true,
          })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) =>
              operationError("schedules.deliverChannelFillers.resolveConversation", cause),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    interactiveResourceNotFound("running conversation", input.conversationName),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );
        if (
          conversation.workspaceId !== input.workspaceId ||
          conversation.running !== true ||
          Predicate.isNull(conversation.name) ||
          conversation.name !== input.conversationName ||
          Predicate.isNotNull(conversation.deletedAt)
        ) {
          return yield* Effect.fail(
            interactiveResourceNotFound("running conversation", input.conversationName),
          );
        }
        return yield* loadScheduleView(
          persistence,
          input.workspaceId,
          "schedules.deliverChannelFillers",
          "schedules.deliverChannelFillers.load",
          "The schedule provider rejected the channel filler read",
          (spreadsheetId, configuration) => provider.loadAll(spreadsheetId, configuration),
        );
      });

    const respond: ScheduleWorkflowOperations["Service"]["respond"] = (
      input,
      message,
      deliveryKey,
      policy,
    ) =>
      deliverResponse(
        input,
        message,
        deliveryKey,
        policy,
        "schedules.deliverUserSchedule.respond",
        "The user schedule response was rejected",
      );

    const respondChannelFillers: ScheduleWorkflowOperations["Service"]["respondChannelFillers"] = (
      input,
      message,
      deliveryKey,
      policy,
    ) =>
      deliverResponse(
        input,
        message,
        deliveryKey,
        policy,
        "schedules.deliverChannelFillers.respond",
        "The channel filler response was rejected",
      );

    return { loadUserSchedule, loadChannelFillers, respond, respondChannelFillers };
  }),
);
