import { Cause, DateTime, Duration, Effect, Match, Option, pipe, Predicate } from "effect";
import type { SheetTextPart } from "sheet-ingress-api/schemas/client";
import type {
  KickoutDispatchPayload,
  KickoutDispatchResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import type { DispatchRequester } from "sheet-ingress-api/sheet-workflows-workflows";
import { makeArgumentError, makeUnknownError } from "typhoon-core/error";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import * as MessageText from "../../messageText";
import { makeSheetApisServices } from "../clients/sheetApis";
import { logNonInterruptFailure } from "../clients/messageDelivery";
import { recoverNonInterruptCause } from "../pure/failure";
import { requireSome } from "../pure/option";
import { textValue } from "../pure/rendering";

type MessageTextInput = string | ReadonlyArray<SheetTextPart>;
type SheetApisServices = ReturnType<typeof makeSheetApisServices>;
type UpdateInteraction = (content: MessageTextInput) => Effect.Effect<unknown, unknown, never>;

export const makeKickoutOperation = ({
  botClient,
  scheduleService,
  sheetService,
  workspaceConfigService,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly scheduleService: SheetApisServices["scheduleService"];
  readonly sheetService: SheetApisServices["sheetService"];
  readonly workspaceConfigService: SheetApisServices["workspaceConfigService"];
}) => {
  const makeUpdateInteraction =
    (payload: KickoutDispatchPayload): UpdateInteraction =>
    (content) =>
      Predicate.isString(payload.interactionResponseToken) &&
      payload.interactionResponseToken.length > 0
        ? botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
            content: textValue(content),
            allowedMentions: "none",
          })
        : Effect.void;
  const emptyResult = (
    payload: KickoutDispatchPayload,
    runningConversationId: string,
    hour: number,
    roleId: string | null,
    status: KickoutDispatchResult["status"],
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
  const resolveHour = (payload: KickoutDispatchPayload, date: DateTime.DateTime) =>
    payload.hour !== undefined
      ? Effect.succeed(payload.hour)
      : sheetService.getEventConfig(payload.workspaceId).pipe(
          Effect.map((eventConfig) =>
            pipe(
              DateTime.distance(eventConfig.startTime, DateTime.startOf(date, "hour")),
              Duration.toHours,
              Math.floor,
              (value) => value + 1,
              (value) => Math.max(0, value),
            ),
          ),
        );
  const loadRunningConversation = Effect.fn("DispatchService.loadKickoutConversation")(function* (
    payload: KickoutDispatchPayload,
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
  const scheduleFillIds = (
    scheduleItem: Effect.Success<
      ReturnType<SheetApisServices["scheduleService"]["conversationPopulatedMonitorSchedules"]>
    >[number],
  ): ReadonlyArray<string> =>
    Match.value(scheduleItem).pipe(
      Match.tagsExhaustive({
        PopulatedBreakSchedule: () => [],
        PopulatedSchedule: (schedule) =>
          schedule.fills.filter(Option.isSome).flatMap((player) =>
            Match.value(player.value.player).pipe(
              Match.tagsExhaustive({
                Player: (player) => [player.id],
                PartialNamePlayer: () => [],
              }),
            ),
          ),
      }),
    );
  const removeUnexpectedMembers = Effect.fn("DispatchService.removeKickoutMembers")(function* (
    payload: KickoutDispatchPayload,
    runningConversationId: string,
    roleId: string,
    fillIds: ReadonlyArray<string>,
  ) {
    const members = yield* botClient.getMembersForParent(payload.workspaceId);
    const removedMemberIds = members
      .filter((member) => member.value.roles.includes(roleId))
      .map((member) => member.value.user.id)
      .filter((memberId) => !fillIds.includes(memberId));
    const removalResults = yield* Effect.forEach(
      removedMemberIds,
      (memberId) =>
        botClient.removeWorkspaceMemberRole(payload.workspaceId, memberId, roleId).pipe(
          Effect.as({ memberId, removed: true } as const),
          Effect.catchCause((cause) =>
            recoverNonInterruptCause(cause, () =>
              Effect.logError("Failed to remove kickout role from member").pipe(
                Effect.annotateLogs({
                  workspaceId: payload.workspaceId,
                  runningConversationId,
                  memberId,
                  roleId,
                }),
                Effect.andThen(Effect.logError(Cause.pretty(cause))),
                Effect.as({ memberId, removed: false } as const),
              ),
            ),
          ),
        ),
      { concurrency: 4 },
    );
    return {
      removedMemberIds: removalResults
        .filter((result) => result.removed)
        .map((result) => result.memberId),
      failedMemberIds: removalResults
        .filter((result) => !result.removed)
        .map((result) => result.memberId),
    };
  });
  const finishKickoutRemovals = Effect.fn("DispatchService.finishKickoutRemovals")(function* (
    payload: KickoutDispatchPayload,
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
        "Failed to deliver completed kickout result",
        { workspaceId: payload.workspaceId, runningConversationId, hour, roleId },
        Effect.void,
      ),
    );
    if (failedMemberIds.length > 0) {
      return yield* Effect.fail(
        markInteractionFailureHandled(
          makeUnknownError("Failed to remove kickout role from some members", {
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
    } satisfies KickoutDispatchResult;
  });

  return Effect.fn("DispatchService.kickout")(function* (
    payload: KickoutDispatchPayload,
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

    const scheduleItem = (yield* scheduleService.conversationPopulatedMonitorSchedules(
      payload.workspaceId,
      conversationName,
    )).find((schedule) => Option.contains(schedule.hour, hour));
    if (scheduleItem === undefined) {
      yield* Effect.logWarning("Skipping kickout because no schedule was found").pipe(
        Effect.annotateLogs({
          workspaceId: payload.workspaceId,
          runningConversationId,
          conversationName,
          hour,
        }),
      );
      yield* updateInteraction(
        "No schedule found for this conversation and hour; no players kicked out",
      );
      return emptyResult(payload, runningConversationId, hour, roleId, "empty");
    }

    const { failedMemberIds, removedMemberIds } = yield* removeUnexpectedMembers(
      payload,
      runningConversationId,
      roleId,
      scheduleFillIds(scheduleItem),
    );
    return yield* finishKickoutRemovals(
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
