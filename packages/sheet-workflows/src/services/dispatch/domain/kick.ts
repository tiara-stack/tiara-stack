import { DateTime, Effect, Option, Predicate } from "effect";
import type { SheetTextPart } from "sheet-ingress-api/schemas/client";
import type { KickDispatchPayload, KickDispatchResult } from "sheet-ingress-api/sheet-apis-rpc";
import type { DispatchRequester } from "sheet-ingress-api/internal";
import { makeArgumentError, makeUnknownError } from "typhoon-core/error";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import * as MessageText from "sheet-message-content/text";
import { makeSheetApisServices } from "../clients/sheetApis";
import { logNonInterruptFailure } from "../clients/messageDelivery";
import { requireSome } from "../pure/option";
import { textValue } from "sheet-message-content/rendering";
import { deriveKickHour, makeKickRemover } from "../../kick";

type MessageTextInput = string | ReadonlyArray<SheetTextPart>;
type SheetApisServices = ReturnType<typeof makeSheetApisServices>;
type UpdateInteraction = (content: MessageTextInput) => Effect.Effect<unknown, unknown, never>;

export const makeKickOperation = ({
  botClient,
  removalConcurrency,
  scheduleService,
  sheetService,
  workspaceConfigService,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly removalConcurrency: number;
  readonly scheduleService: SheetApisServices["scheduleService"];
  readonly sheetService: SheetApisServices["sheetService"];
  readonly workspaceConfigService: SheetApisServices["workspaceConfigService"];
}) => {
  const removeKickMembers = makeKickRemover({
    botClient,
    removalConcurrency,
    scheduleService,
  });
  const makeUpdateInteraction =
    (payload: KickDispatchPayload): UpdateInteraction =>
    (content) =>
      Predicate.isString(payload.interactionResponseToken) &&
      payload.interactionResponseToken.length > 0
        ? botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
            content: textValue(content),
            allowedMentions: "none",
          })
        : Effect.void;
  const emptyResult = (
    payload: KickDispatchPayload,
    runningConversationId: string,
    hour: number,
    roleId: string | null,
    status: KickDispatchResult["status"],
  ) => ({
    workspaceId: payload.workspaceId,
    runningConversationId,
    hour,
    roleId,
    removedMemberIds: [],
    status,
  });
  const failInteraction = (updateInteraction: UpdateInteraction, message: string) =>
    updateInteraction(message).pipe(
      Effect.andThen(Effect.fail(markInteractionFailureHandled(makeArgumentError(message)))),
    );
  const resolveHour = (payload: KickDispatchPayload, date: DateTime.DateTime) =>
    payload.hour !== undefined
      ? Effect.succeed(payload.hour)
      : sheetService
          .getEventConfig(payload.workspaceId)
          .pipe(Effect.map((eventConfig) => deriveKickHour(eventConfig.startTime, date)));
  const loadRunningConversation = Effect.fn("DispatchService.loadKickConversation")(function* (
    payload: KickDispatchPayload,
    updateInteraction: UpdateInteraction,
  ) {
    const maybeConversation = Predicate.isString(payload.conversationName)
      ? yield* workspaceConfigService.getWorkspaceConversationByName({
          workspaceId: payload.workspaceId,
          conversationName: payload.conversationName,
          running: true,
        })
      : yield* workspaceConfigService.getWorkspaceConversationById({
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId ?? "",
          running: true,
        });
    const conversation = yield* requireSome(maybeConversation, () =>
      failInteraction(updateInteraction, "Cannot kick out, running conversation not found"),
    );
    const conversationName = yield* requireSome(conversation.name, () =>
      failInteraction(updateInteraction, "Cannot kick out, conversation has no name"),
    );
    return { conversation, conversationName };
  });
  const finishKickRemovals = Effect.fn("DispatchService.finishKickRemovals")(function* (
    payload: KickDispatchPayload,
    updateInteraction: UpdateInteraction,
    runningConversationId: string,
    hour: number,
    roleId: string,
    removedMemberIds: ReadonlyArray<string>,
    failedMemberIds: ReadonlyArray<string>,
  ) {
    const removalSummary =
      removedMemberIds.length > 0
        ? MessageText.parts(
            MessageText.text("Kicked out "),
            ...removedMemberIds.flatMap((userId, index) =>
              MessageText.parts(
                index === 0 ? undefined : MessageText.text(" "),
                MessageText.userMention(userId),
              ),
            ),
          )
        : [MessageText.text("No players were kicked out")];
    yield* updateInteraction(
      failedMemberIds.length === 0
        ? removalSummary
        : MessageText.parts(
            ...removalSummary,
            MessageText.text(`; ${failedMemberIds.length} role removal(s) failed`),
          ),
    ).pipe(
      logNonInterruptFailure(
        "Failed to deliver completed kick result",
        { workspaceId: payload.workspaceId, runningConversationId, hour, roleId },
        Effect.void,
      ),
    );
    if (failedMemberIds.length > 0) {
      return yield* Effect.fail(
        markInteractionFailureHandled(
          makeUnknownError("Failed to remove kick role from some members", {
            failedMemberIds,
            removedMemberIds,
          }),
        ),
      );
    }
    return {
      workspaceId: payload.workspaceId,
      runningConversationId,
      hour,
      roleId,
      removedMemberIds,
      status: removedMemberIds.length > 0 ? "removed" : "empty",
    } satisfies KickDispatchResult;
  });

  return Effect.fn("DispatchService.kick")(function* (
    payload: KickDispatchPayload,
    _requester: DispatchRequester,
  ) {
    yield* Effect.annotateCurrentSpan({
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      conversationName: payload.conversationName,
      hour: payload.hour,
    });
    const updateInteraction = makeUpdateInteraction(payload);
    const date = yield* DateTime.now;
    if (DateTime.getPart(date, "minute") >= 40) {
      yield* updateInteraction("Cannot kick out until next hour starts");
      return emptyResult(
        payload,
        payload.conversationId ?? "",
        payload.hour ?? 0,
        null,
        "tooEarly",
      );
    }

    const hour = yield* resolveHour(payload, date);
    const { conversation, conversationName } = yield* loadRunningConversation(
      payload,
      updateInteraction,
    );
    const runningConversationId = conversation.conversationId;
    const roleId = Option.getOrNull(conversation.roleId);
    if (roleId === null) {
      yield* updateInteraction("No role configured for this conversation");
      return emptyResult(payload, runningConversationId, hour, null, "missingRole");
    }

    const removalResult = yield* removeKickMembers({
      workspaceId: payload.workspaceId,
      runningConversationId,
      conversationName,
      roleId,
      hour,
    });
    if (!removalResult.scheduleFound) {
      yield* updateInteraction(
        "No schedule found for this conversation and hour; no players kicked out",
      );
      return emptyResult(payload, runningConversationId, hour, roleId, "empty");
    }

    const { failedMemberIds, removedMemberIds } = removalResult;
    return yield* finishKickRemovals(
      payload,
      updateInteraction,
      runningConversationId,
      hour,
      roleId,
      removedMemberIds,
      failedMemberIds,
    );
  });
};
