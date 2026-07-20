import { Cause, DateTime, Duration, Effect, Match, Option, pipe, Predicate } from "effect";
import type { ClientDeliveryClient } from "./clientDeliveryClient";
import type { makeSheetApisServices } from "./dispatch/clients/sheetApis";
import { recoverNonInterruptCause } from "./dispatch/pure/failure";
import { shortRoleRetrySchedule } from "./dispatch/pure/retry";

type SheetApisServices = ReturnType<typeof makeSheetApisServices>;
type KickScheduleService = Pick<
  SheetApisServices["scheduleService"],
  "conversationPopulatedMonitorSchedules"
>;
type KickBotClient = Pick<
  typeof ClientDeliveryClient.Service,
  "getMembersForParent" | "removeWorkspaceMemberRole"
>;
type KickMembers = Effect.Success<ReturnType<KickBotClient["getMembersForParent"]>>;

type KickRemovalResult = {
  readonly scheduleFound: boolean;
  readonly removedMemberIds: ReadonlyArray<string>;
  readonly failedMemberIds: ReadonlyArray<string>;
};

type KickRemovalInput = {
  readonly workspaceId: string;
  readonly runningConversationId: string;
  readonly conversationName: string;
  readonly roleId: string;
  readonly hour: number;
  readonly members?: KickMembers;
};

export const deriveKickHour = (eventStart: DateTime.DateTime, date: DateTime.DateTime): number =>
  pipe(
    DateTime.distance(eventStart, DateTime.startOf(date, "hour")),
    Duration.toHours,
    Math.floor,
    (value) => value + 1,
    (value) => Math.max(0, value),
  );

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

export const makeKickRemover = ({
  botClient,
  removalConcurrency,
  scheduleService,
}: {
  readonly botClient: KickBotClient;
  readonly removalConcurrency: number;
  readonly scheduleService: KickScheduleService;
}) =>
  Effect.fn("KickService.removeUnexpectedMembers")(function* (input: KickRemovalInput) {
    const logContext = {
      workspaceId: input.workspaceId,
      runningConversationId: input.runningConversationId,
      conversationName: input.conversationName,
      roleId: input.roleId,
      hour: input.hour,
    };
    const schedules = yield* scheduleService.conversationPopulatedMonitorSchedules(
      input.workspaceId,
      input.conversationName,
    );
    const scheduleItem = schedules.find((schedule) => Option.contains(schedule.hour, input.hour));
    if (Predicate.isUndefined(scheduleItem)) {
      yield* Effect.logWarning("Skipping kick because no schedule was found").pipe(
        Effect.annotateLogs(logContext),
      );
      return {
        scheduleFound: false,
        removedMemberIds: [],
        failedMemberIds: [],
      } satisfies KickRemovalResult;
    }

    const fillIds = scheduleFillIds(scheduleItem);
    const members = Predicate.isUndefined(input.members)
      ? yield* botClient.getMembersForParent(input.workspaceId)
      : input.members;
    const unexpectedMemberIds = members
      .filter((member) => member.value.roles.includes(input.roleId))
      .map((member) => member.value.user.id)
      .filter((memberId) => !fillIds.includes(memberId));
    const removalResults = yield* Effect.forEach(
      unexpectedMemberIds,
      (memberId) =>
        botClient.removeWorkspaceMemberRole(input.workspaceId, memberId, input.roleId).pipe(
          Effect.retry(shortRoleRetrySchedule),
          Effect.as({ memberId, removed: true } as const),
          Effect.catchCause((cause) =>
            recoverNonInterruptCause(cause, () =>
              Effect.logError("Failed to remove lockdown role from member").pipe(
                Effect.annotateLogs({ ...logContext, memberId }),
                Effect.andThen(Effect.logError(Cause.pretty(cause))),
                Effect.as({ memberId, removed: false } as const),
              ),
            ),
          ),
        ),
      { concurrency: removalConcurrency },
    );
    return {
      scheduleFound: true,
      removedMemberIds: removalResults
        .filter((result) => result.removed)
        .map((result) => result.memberId),
      failedMemberIds: removalResults
        .filter((result) => !result.removed)
        .map((result) => result.memberId),
    } satisfies KickRemovalResult;
  });
