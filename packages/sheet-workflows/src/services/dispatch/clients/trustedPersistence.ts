import {
  Array as EffectArray,
  Clock,
  DateTime,
  Effect,
  Option,
  Predicate,
  Schema,
  Semaphore,
} from "effect";
import { MessageCheckin, MessageCheckinMember } from "sheet-ingress-api/schemas/messageCheckin";
import {
  MessageRoomOrder,
  MessageRoomOrderEntry,
  MessageRoomOrderRange,
} from "sheet-ingress-api/schemas/messageRoomOrder";
import { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import { MessageTeamSubmission } from "sheet-ingress-api/schemas/teamSubmission";
import type {
  TeamSubmissionConfirmButtonDispatchPayload,
  TeamSubmissionDispatchPayload,
  TeamSubmissionDispatchResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import { UserPlatformConfig } from "sheet-ingress-api/schemas/userConfig";
import {
  WorkspaceConfig,
  WorkspaceConversationConfig,
  WorkspaceFeatureFlag,
  WorkspaceMonitorRole,
  WorkspaceUpdateAnnouncementDelivery,
} from "sheet-ingress-api/schemas/workspaceConfig";
import type { TrustedSheetPersistenceShape } from "sheet-zero-server/persistence";
import { makeArgumentError, makeDBQueryError } from "typhoon-core/error";
import { ZeroClient } from "typhoon-zero/client";
import type { ClientDeliveryClient } from "../../clientDeliveryClient";
import { decodeTagged } from "../persistenceDecoding";

export type MessageKey = {
  readonly clientPlatform: string;
  readonly clientId: string;
  readonly messageId: string;
};

const supportedPlatforms = new Set(["discord"]);
export const updateAnnouncementDeliveryPendingConversationId =
  "__pending_update_announcement_delivery__";
const teamSubmissionVersionConflictCode = "TEAM_SUBMISSION_VERSION_CONFLICT";
const isSome = Predicate.isTagged("Some");
const isNone = Predicate.isTagged("None");
const isTeamSubmissionVersionConflict = (
  error: unknown,
): error is ZeroClient.ZeroClientExecutorError =>
  Predicate.isTagged("ZeroClientExecutorError")(error) &&
  Predicate.hasProperty(error, "code") &&
  error.code === teamSubmissionVersionConflictCode;

const decodeOptional = <SchemaValue extends Schema.Top>(
  schema: SchemaValue,
  tag: string,
  value: unknown,
) => {
  const optionValue = Option.isOption(value) ? value : undefined;
  const normalized =
    Predicate.isNotUndefined(optionValue) && Option.isSome(optionValue)
      ? optionValue.value
      : isSome(value) && Predicate.hasProperty(value, "value")
        ? value.value
        : value;
  return (Predicate.isNotUndefined(optionValue) && Option.isNone(optionValue)) || isNone(value)
    ? Effect.succeed(Option.none())
    : decodeTagged(schema, tag, normalized).pipe(Effect.map(Option.some));
};

const decodeRows = <SchemaValue extends Schema.Top>(
  schema: SchemaValue,
  tag: string,
  rows: ReadonlyArray<unknown>,
) => Effect.forEach(rows, (row) => decodeTagged(schema, tag, row));

const mutationResultOrFetch = <SchemaValue extends Schema.Top, MutationError, FetchError, R>(
  mutation: Effect.Effect<void, MutationError, R>,
  fetch: () => Effect.Effect<Option.Option<unknown>, FetchError, R>,
  schema: SchemaValue,
  tag: string,
  errorMessage: string,
) =>
  Effect.gen(function* () {
    yield* mutation;
    const row = yield* fetch();
    if (Option.isNone(row)) {
      return yield* Effect.fail(makeDBQueryError(errorMessage));
    }
    return yield* decodeTagged(schema, tag, row.value);
  });

const requireSupportedPlatform = (platform: string) =>
  supportedPlatforms.has(platform)
    ? Effect.void
    : Effect.fail(makeArgumentError(`Unsupported notification platform: ${platform}`));

const optionalRunningFilter = (running: boolean | undefined) =>
  Predicate.isUndefined(running) ? {} : { running };

const normalizeFeatureFlagName = (flagName: string) => {
  const normalized = flagName.trim();
  return normalized.length > 0
    ? Effect.succeed(normalized)
    : Effect.fail(makeArgumentError("Feature flag name cannot be empty"));
};

const makeWorkspaceConfigService = (persistence: TrustedSheetPersistenceShape["workspaces"]) => {
  // This only limits contention within one process; PostgreSQL remains the source of truth
  // across replicas, and every mutation result is derived from an authoritative re-read.
  const workspaceMutationLocks = new Map<
    string,
    { readonly semaphore: ReturnType<typeof Semaphore.makeUnsafe>; users: number }
  >();
  const withWorkspaceMutationLock = <A, E, R>(
    workspaceId: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.suspend(() => {
      const existing = workspaceMutationLocks.get(workspaceId);
      const entry = existing ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      entry.users += 1;
      if (Predicate.isUndefined(existing)) {
        workspaceMutationLocks.set(workspaceId, entry);
      }
      return entry.semaphore
        .withPermits(1)(effect)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.users -= 1;
              if (entry.users === 0 && workspaceMutationLocks.get(workspaceId) === entry) {
                workspaceMutationLocks.delete(workspaceId);
              }
            }),
          ),
        );
    });

  const getWorkspaceConfig = (workspaceId: string) =>
    persistence
      .getWorkspaceConfigByWorkspaceId({ workspaceId })
      .pipe(Effect.flatMap((row) => decodeOptional(WorkspaceConfig, "WorkspaceConfig", row)));

  const getWorkspaceMonitorRoles = (workspaceId: string) =>
    persistence
      .getWorkspaceMonitorRoles({ workspaceId })
      .pipe(
        Effect.flatMap((rows) => decodeRows(WorkspaceMonitorRole, "WorkspaceMonitorRole", rows)),
      );

  const getWorkspaceFeatureFlags = (workspaceId: string) =>
    persistence
      .getWorkspaceFeatureFlags({ workspaceId })
      .pipe(
        Effect.flatMap((rows) => decodeRows(WorkspaceFeatureFlag, "WorkspaceFeatureFlag", rows)),
      );

  const getWorkspaceConversationById = (query: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly running?: boolean | undefined;
  }) =>
    persistence
      .getWorkspaceConversationById(query)
      .pipe(
        Effect.flatMap((row) =>
          decodeOptional(WorkspaceConversationConfig, "WorkspaceConversationConfig", row),
        ),
      );

  const getWorkspaceConversationByName = (query: {
    readonly workspaceId: string;
    readonly conversationName: string;
    readonly running?: boolean | undefined;
  }) =>
    persistence
      .getWorkspaceConversationByName(query)
      .pipe(
        Effect.flatMap((row) =>
          decodeOptional(WorkspaceConversationConfig, "WorkspaceConversationConfig", row),
        ),
      );

  const getWorkspaceUpdateAnnouncementDelivery = (workspaceId: string, announcementId: string) =>
    persistence
      .getWorkspaceUpdateAnnouncementDelivery({ workspaceId, announcementId })
      .pipe(
        Effect.flatMap((row) =>
          decodeOptional(
            WorkspaceUpdateAnnouncementDelivery,
            "WorkspaceUpdateAnnouncementDelivery",
            row,
          ),
        ),
      );

  return {
    getAutoCheckinWorkspaces: () =>
      persistence
        .getAutoCheckinWorkspaces({})
        .pipe(Effect.flatMap((rows) => decodeRows(WorkspaceConfig, "WorkspaceConfig", rows))),
    getWorkspaceConfig,
    upsertWorkspaceConfig: (
      workspaceId: string,
      config: {
        readonly sheetId?: string | null | undefined;
        readonly autoCheckin?: boolean | null | undefined;
        readonly monitorConversationId?: string | null | undefined;
      },
    ) =>
      withWorkspaceMutationLock(
        workspaceId,
        mutationResultOrFetch(
          persistence.upsertWorkspaceConfig({ workspaceId, ...config }),
          () => persistence.getWorkspaceConfigByWorkspaceId({ workspaceId }),
          WorkspaceConfig,
          "WorkspaceConfig",
          "Failed to upsert workspace config",
        ),
      ),
    getWorkspaceMonitorRoles,
    getWorkspaceFeatureFlags,
    claimWorkspaceUpdateAnnouncementDelivery: (claim: {
      readonly workspaceId: string;
      readonly announcementId: string;
      readonly publishedAt: DateTime.Utc;
      readonly claimToken: string;
    }) =>
      Effect.gen(function* () {
        yield* persistence.claimWorkspaceUpdateAnnouncementDelivery({
          ...claim,
          publishedAt: DateTime.toEpochMillis(claim.publishedAt),
        });
        const delivery = yield* getWorkspaceUpdateAnnouncementDelivery(
          claim.workspaceId,
          claim.announcementId,
        );
        if (Option.isNone(delivery)) {
          return yield* Effect.fail(
            makeDBQueryError("Failed to claim workspace update announcement delivery"),
          );
        }
        if (delivery.value.conversationId === updateAnnouncementDeliveryPendingConversationId) {
          return {
            status: delivery.value.messageId === claim.claimToken ? "claimed" : "already_claimed",
            delivery,
          } as const;
        }
        return { status: "already_delivered", delivery } as const;
      }),
    releaseWorkspaceUpdateAnnouncementDeliveryClaim: (claim: {
      readonly workspaceId: string;
      readonly announcementId: string;
      readonly claimToken: string;
    }) => persistence.releaseWorkspaceUpdateAnnouncementDeliveryClaim(claim),
    addWorkspaceMonitorRole: (workspaceId: string, roleId: string) =>
      persistence.addWorkspaceMonitorRole({ workspaceId, roleId }),
    removeWorkspaceMonitorRole: (workspaceId: string, roleId: string) =>
      persistence.removeWorkspaceMonitorRole({ workspaceId, roleId }),
    addWorkspaceFeatureFlag: (workspaceId: string, flagName: string) =>
      Effect.gen(function* () {
        const normalized = yield* normalizeFeatureFlagName(flagName);
        yield* persistence.addWorkspaceFeatureFlag({
          workspaceId,
          flagName: normalized,
        });
        return { workspaceId, flagName: normalized };
      }),
    removeWorkspaceFeatureFlag: (workspaceId: string, flagName: string) =>
      Effect.gen(function* () {
        const normalized = yield* normalizeFeatureFlagName(flagName);
        yield* persistence.removeWorkspaceFeatureFlag({
          workspaceId,
          flagName: normalized,
        });
        return { workspaceId, flagName: normalized };
      }),
    recordWorkspaceUpdateAnnouncementDelivery: (delivery: {
      readonly workspaceId: string;
      readonly announcementId: string;
      readonly publishedAt: DateTime.Utc;
      readonly deliveredAt: DateTime.Utc;
      readonly conversationId: string;
      readonly messageId: string;
      readonly claimToken: string;
    }) =>
      mutationResultOrFetch(
        persistence.recordWorkspaceUpdateAnnouncementDelivery({
          ...delivery,
          publishedAt: DateTime.toEpochMillis(delivery.publishedAt),
          deliveredAt: DateTime.toEpochMillis(delivery.deliveredAt),
        }),
        () =>
          persistence.getWorkspaceUpdateAnnouncementDelivery({
            workspaceId: delivery.workspaceId,
            announcementId: delivery.announcementId,
          }),
        WorkspaceUpdateAnnouncementDelivery,
        "WorkspaceUpdateAnnouncementDelivery",
        "Failed to record workspace update announcement delivery",
      ),
    upsertWorkspaceConversationConfig: (
      workspaceId: string,
      conversationId: string,
      config: {
        readonly name?: string | null | undefined;
        readonly running?: boolean | null | undefined;
        readonly roleId?: string | null | undefined;
        readonly checkinConversationId?: string | null | undefined;
      },
    ) =>
      withWorkspaceMutationLock(
        workspaceId,
        mutationResultOrFetch(
          persistence.upsertWorkspaceConversationConfig({
            workspaceId,
            conversationId,
            ...config,
          }),
          () => persistence.getWorkspaceConversationById({ workspaceId, conversationId }),
          WorkspaceConversationConfig,
          "WorkspaceConversationConfig",
          "Failed to upsert workspace conversation config",
        ),
      ),
    getWorkspaceConversationById,
    getWorkspaceConversationByName,
    getWorkspaceConversations: (workspaceId: string, running: boolean) =>
      persistence
        .getWorkspaceConversations({ workspaceId, ...optionalRunningFilter(running) })
        .pipe(
          Effect.flatMap((rows) =>
            decodeRows(WorkspaceConversationConfig, "WorkspaceConversationConfig", rows),
          ),
        ),
  };
};

const makeUserConfigService = (
  persistence: TrustedSheetPersistenceShape["preferences"],
  botClient: typeof ClientDeliveryClient.Service,
) => {
  const getUserPlatformConfig = (platform: string, userId: string) =>
    requireSupportedPlatform(platform).pipe(
      Effect.andThen(persistence.getUserPlatformConfig({ platform, userId })),
      Effect.flatMap((row) => decodeOptional(UserPlatformConfig, "UserPlatformConfig", row)),
    );

  const recipients = (
    field: "getCheckinDmEnabledUserConfigs" | "getMonitorDmEnabledUserConfigs",
    platform: string,
    userIds: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      yield* requireSupportedPlatform(platform);
      const requestedUserIds = [...new Set(userIds)];
      if (requestedUserIds.length === 0) return [];
      const configs = yield* persistence[field]({ platform, userIds: requestedUserIds });
      return configs.flatMap((config) =>
        Predicate.isString(config.defaultClientId)
          ? [
              {
                platform: config.platform,
                userId: config.userId,
                defaultClientId: config.defaultClientId,
              },
            ]
          : [],
      );
    });

  return {
    getUserPlatformConfig,
    upsertUserPlatformConfig: (
      platform: string,
      userId: string,
      config: {
        readonly checkinDmEnabled?: boolean | undefined;
        readonly monitorDmEnabled?: boolean | undefined;
        readonly defaultClientId?: string | null | undefined;
      },
    ) =>
      Effect.gen(function* () {
        yield* requireSupportedPlatform(platform);
        if (Predicate.isString(config.defaultClientId)) {
          const clients = yield* botClient.listClients();
          if (
            !clients.some(
              (client) =>
                client.platform === platform && client.clientId === config.defaultClientId,
            )
          ) {
            return yield* Effect.fail(
              makeArgumentError(
                `Unsupported notification client: ${platform}:${config.defaultClientId}`,
              ),
            );
          }
        }
        return yield* mutationResultOrFetch(
          persistence.upsertUserPlatformConfig({ platform, userId, ...config }),
          () => persistence.getUserPlatformConfig({ platform, userId }),
          UserPlatformConfig,
          "UserPlatformConfig",
          "Failed to upsert user platform config",
        );
      }),
    getCheckinDmRecipients: (platform: string, userIds: ReadonlyArray<string>) =>
      recipients("getCheckinDmEnabledUserConfigs", platform, userIds),
    getMonitorDmRecipients: (platform: string, userIds: ReadonlyArray<string>) =>
      recipients("getMonitorDmEnabledUserConfigs", platform, userIds),
  };
};

const makeMessageCheckinService = (
  persistence: TrustedSheetPersistenceShape["checkinState"],
  withMessageKey: <A, E, R>(
    messageId: string,
    operation: (key: MessageKey) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>,
) => ({
  getMessageCheckinData: (messageId: string) =>
    withMessageKey(messageId, (key) =>
      persistence
        .getMessageCheckinData(key)
        .pipe(Effect.flatMap((row) => decodeOptional(MessageCheckin, "MessageCheckin", row))),
    ),
  getMessageCheckinMembers: (messageId: string) =>
    withMessageKey(messageId, (key) =>
      persistence
        .getMessageCheckinMembers(key)
        .pipe(
          Effect.flatMap((rows) => decodeRows(MessageCheckinMember, "MessageCheckinMember", rows)),
        ),
    ),
  persistMessageCheckin: (
    messageId: string,
    payload: Omit<
      Parameters<TrustedSheetPersistenceShape["checkinState"]["persistMessageCheckin"]>[0],
      keyof MessageKey
    >,
  ) =>
    withMessageKey(messageId, (key) => persistence.persistMessageCheckin({ ...key, ...payload })),
  removeMessageCheckin: (messageId: string) =>
    withMessageKey(messageId, persistence.removeMessageCheckin),
  setMessageCheckinMemberCheckinAtIfUnset: (
    messageId: string,
    memberId: string,
    checkinAt: number,
    checkinClaimId: string,
  ) =>
    withMessageKey(messageId, (key) =>
      Effect.gen(function* () {
        yield* persistence.setMessageCheckinMemberCheckinAtIfUnset({
          ...key,
          memberId,
          checkinAt,
          checkinClaimId,
        });
        const members = yield* persistence.getMessageCheckinMembers(key);
        const member = EffectArray.findFirst(members, (item) => item.memberId === memberId);
        if (Option.isNone(member)) {
          return yield* Effect.fail(
            makeArgumentError("Member is not registered for this check-in"),
          );
        }
        return yield* decodeTagged(MessageCheckinMember, "MessageCheckinMember", member.value);
      }),
    ),
});

const makeMessageSlotService = (
  persistence: TrustedSheetPersistenceShape["slotState"],
  withMessageKey: <A, E, R>(
    messageId: string,
    operation: (key: MessageKey) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>,
) => ({
  getMessageSlotData: (messageId: string) =>
    withMessageKey(messageId, (key) =>
      persistence
        .getMessageSlotData(key)
        .pipe(Effect.flatMap((row) => decodeOptional(MessageSlot, "MessageSlot", row))),
    ),
  upsertMessageSlotData: (
    messageId: string,
    data: Omit<
      Parameters<TrustedSheetPersistenceShape["slotState"]["upsertMessageSlotData"]>[0],
      keyof MessageKey
    >,
  ) => withMessageKey(messageId, (key) => persistence.upsertMessageSlotData({ ...key, ...data })),
});

const makeMessageRoomOrderService = (
  persistence: TrustedSheetPersistenceShape["roomOrderState"],
  withMessageKey: <A, E, R>(
    messageId: string,
    operation: (key: MessageKey) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>,
) => {
  const getMessageRoomOrder = (messageId: string) =>
    withMessageKey(messageId, (key) =>
      persistence
        .getMessageRoomOrder(key)
        .pipe(Effect.flatMap((row) => decodeOptional(MessageRoomOrder, "MessageRoomOrder", row))),
    );

  const mutateAndRead = (
    messageId: string,
    operation: (key: MessageKey) => Effect.Effect<void, unknown>,
    errorMessage: string,
  ) =>
    withMessageKey(messageId, (key) =>
      mutationResultOrFetch(
        operation(key),
        () => persistence.getMessageRoomOrder(key),
        MessageRoomOrder,
        "MessageRoomOrder",
        errorMessage,
      ),
    );

  const claim =
    (
      operation: (args: MessageKey & { readonly claimId: string }) => Effect.Effect<void, unknown>,
      errorMessage: string,
    ) =>
    (messageId: string, claimId: string) =>
      mutateAndRead(messageId, (key) => operation({ ...key, claimId }), errorMessage);

  const release =
    (
      operation: (args: MessageKey & { readonly claimId: string }) => Effect.Effect<void, unknown>,
    ) =>
    (messageId: string, claimId: string) =>
      withMessageKey(messageId, (key) => operation({ ...key, claimId }));

  return {
    getMessageRoomOrder,
    persistMessageRoomOrder: (
      messageId: string,
      payload: Omit<
        Parameters<TrustedSheetPersistenceShape["roomOrderState"]["persistMessageRoomOrder"]>[0],
        keyof MessageKey
      >,
    ) =>
      withMessageKey(messageId, (key) =>
        persistence.persistMessageRoomOrder({ ...key, ...payload }),
      ),
    decrementMessageRoomOrderRank: (
      messageId: string,
      payload: Omit<
        Parameters<
          TrustedSheetPersistenceShape["roomOrderState"]["decrementMessageRoomOrderRank"]
        >[0],
        keyof MessageKey
      >,
    ) =>
      mutateAndRead(
        messageId,
        (key) => persistence.decrementMessageRoomOrderRank({ ...key, ...payload }),
        "Failed to decrement room order rank",
      ),
    incrementMessageRoomOrderRank: (
      messageId: string,
      payload: Omit<
        Parameters<
          TrustedSheetPersistenceShape["roomOrderState"]["incrementMessageRoomOrderRank"]
        >[0],
        keyof MessageKey
      >,
    ) =>
      mutateAndRead(
        messageId,
        (key) => persistence.incrementMessageRoomOrderRank({ ...key, ...payload }),
        "Failed to increment room order rank",
      ),
    getMessageRoomOrderEntry: (messageId: string, rank: number) =>
      withMessageKey(messageId, (key) =>
        persistence
          .getMessageRoomOrderEntry({ ...key, rank })
          .pipe(
            Effect.flatMap((rows) =>
              decodeRows(MessageRoomOrderEntry, "MessageRoomOrderEntry", rows),
            ),
          ),
      ),
    getMessageRoomOrderRange: (messageId: string) =>
      withMessageKey(messageId, (key) =>
        persistence.getMessageRoomOrderRange(key).pipe(
          Effect.map((entries) =>
            EffectArray.match(entries, {
              onEmpty: () => Option.none<MessageRoomOrderRange>(),
              onNonEmpty: ([head, ...tail]) =>
                Option.some(
                  new MessageRoomOrderRange({
                    minRank: tail.reduce((rank, entry) => Math.min(rank, entry.rank), head.rank),
                    maxRank: tail.reduce((rank, entry) => Math.max(rank, entry.rank), head.rank),
                  }),
                ),
            }),
          ),
        ),
      ),
    claimMessageRoomOrderSend: claim(
      persistence.claimMessageRoomOrderSend,
      "Failed to claim room order send",
    ),
    completeMessageRoomOrderSend: (
      messageId: string,
      claimId: string,
      sentMessage: { readonly id: string; readonly conversationId: string },
    ) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((sentAt) =>
          mutateAndRead(
            messageId,
            (key) =>
              persistence.completeMessageRoomOrderSend({
                ...key,
                claimId,
                sentMessageId: sentMessage.id,
                sentConversationId: sentMessage.conversationId,
                sentAt,
              }),
            "Failed to complete room order send",
          ),
        ),
      ),
    releaseMessageRoomOrderSendClaim: release(persistence.releaseMessageRoomOrderSendClaim),
    claimMessageRoomOrderTentativeUpdate: claim(
      persistence.claimMessageRoomOrderTentativeUpdate,
      "Failed to claim tentative room order update",
    ),
    releaseMessageRoomOrderTentativeUpdateClaim: release(
      persistence.releaseMessageRoomOrderTentativeUpdateClaim,
    ),
    claimMessageRoomOrderTentativePin: claim(
      persistence.claimMessageRoomOrderTentativePin,
      "Failed to claim tentative room order pin",
    ),
    completeMessageRoomOrderTentativePin: (messageId: string, claimId: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((pinnedAt) =>
          mutateAndRead(
            messageId,
            (key) =>
              persistence.completeMessageRoomOrderTentativePin({ ...key, claimId, pinnedAt }),
            "Failed to complete tentative room order pin",
          ),
        ),
      ),
    releaseMessageRoomOrderTentativePinClaim: release(
      persistence.releaseMessageRoomOrderTentativePinClaim,
    ),
    markMessageRoomOrderTentative: (messageId: string) =>
      withMessageKey(messageId, (key) =>
        Effect.gen(function* () {
          const existing = yield* persistence.getMessageRoomOrder(key);
          if (Option.isNone(existing)) {
            return yield* Effect.fail(
              makeDBQueryError("Failed to mark message room order tentative"),
            );
          }
          if (
            Predicate.isNull(existing.value.workspaceId) ||
            Predicate.isNull(existing.value.conversationId)
          ) {
            return yield* Effect.fail(
              makeDBQueryError("Failed to resolve tentative room order ownership"),
            );
          }
          const updated = yield* mutationResultOrFetch(
            persistence.markMessageRoomOrderTentative({
              ...key,
              workspaceId: existing.value.workspaceId,
              conversationId: existing.value.conversationId,
            }),
            () => persistence.getMessageRoomOrder(key),
            MessageRoomOrder,
            "MessageRoomOrder",
            "Failed to mark message room order tentative",
          );
          return updated.tentative
            ? updated
            : yield* Effect.fail(makeDBQueryError("Failed to mark message room order tentative"));
        }),
      ),
  };
};

const actionableTeamSubmissionStatuses = new Set(["registered", "updated"]);

const makeTeamSubmissionStateService = (
  persistence: TrustedSheetPersistenceShape["teamSubmissionState"],
) => {
  const getSubmission = (key: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly messageId: string;
  }) =>
    persistence
      .getMessageTeamSubmission(key)
      .pipe(
        Effect.flatMap((row) =>
          decodeOptional(MessageTeamSubmission, "MessageTeamSubmission", row),
        ),
      );

  return {
    setConfirmationMessage: (
      payload: TeamSubmissionDispatchPayload,
      confirmationMessageId: string,
      previousResult: TeamSubmissionDispatchResult,
    ) =>
      Effect.gen(function* () {
        const key = {
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
          messageId: payload.messageId,
        };
        yield* persistence.setMessageTeamSubmissionConfirmation({
          ...key,
          confirmationMessageId,
        });
        const submission = yield* getSubmission(key);
        if (Option.isNone(submission)) {
          return yield* Effect.fail(makeArgumentError("Team submission is not registered"));
        }
        return {
          ...previousResult,
          confirmationMessage: Option.some({
            conversation: {
              workspace: { client: payload.client, workspaceId: payload.workspaceId },
              conversationId: payload.conversationId,
            },
            messageId: confirmationMessageId,
          }),
          status: submission.value.status,
        } satisfies TeamSubmissionDispatchResult;
      }),
    confirmFromDiscord: (
      payload: TeamSubmissionConfirmButtonDispatchPayload,
      requesterUserId: string,
    ) =>
      Effect.gen(function* () {
        const submissionOption = yield* getSubmission({
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
          messageId: payload.messageId,
        });
        if (Option.isNone(submissionOption)) {
          return yield* Effect.fail(makeArgumentError("Team submission record was not found"));
        }
        const submission = submissionOption.value;
        if (submission.discordAuthorId !== requesterUserId) {
          return yield* Effect.fail(
            makeArgumentError("Only the original submitter can confirm this team submission"),
          );
        }
        if (!actionableTeamSubmissionStatuses.has(submission.status)) {
          return yield* Effect.fail(
            makeArgumentError(
              `Team submission is already ${submission.status} and cannot be changed`,
            ),
          );
        }
        if (!Option.contains(submission.confirmationMessageId, payload.confirmationMessageId)) {
          return yield* Effect.fail(
            makeArgumentError("Team submission confirmation message does not match"),
          );
        }
        yield* persistence
          .upsertMessageTeamSubmission({
            workspaceId: submission.workspaceId,
            conversationId: submission.conversationId,
            messageId: submission.messageId,
            clientPlatform: submission.clientPlatform,
            clientId: submission.clientId,
            discordGuildId: submission.discordGuildId,
            discordChannelId: submission.discordChannelId,
            discordAuthorId: submission.discordAuthorId,
            sheetId: submission.sheetId,
            confirmationMessageId: Option.getOrNull(submission.confirmationMessageId),
            parsedSubmission: submission.parsedSubmission,
            rowMappings: submission.rowMappings,
            rollbackSnapshot: Option.getOrNull(submission.rollbackSnapshot),
            expectedVersion: submission.version,
            status: "confirmed",
          })
          .pipe(
            Effect.catchIf(isTeamSubmissionVersionConflict, () =>
              Effect.fail(
                makeArgumentError("Team submission changed before it could be confirmed"),
              ),
            ),
          );
        return { status: "confirmed" } as const;
      }),
  };
};

export const makeTrustedPersistenceServices = (
  persistence: TrustedSheetPersistenceShape,
  botClient: typeof ClientDeliveryClient.Service,
  withMessageKey: <A, E, R>(
    messageId: string,
    operation: (key: MessageKey) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>,
) => ({
  userConfigService: makeUserConfigService(persistence.preferences, botClient),
  workspaceConfigService: makeWorkspaceConfigService(persistence.workspaces),
  messageCheckinService: makeMessageCheckinService(persistence.checkinState, withMessageKey),
  messageRoomOrderService: makeMessageRoomOrderService(persistence.roomOrderState, withMessageKey),
  messageSlotService: makeMessageSlotService(persistence.slotState, withMessageKey),
  teamSubmissionStateService: makeTeamSubmissionStateService(persistence.teamSubmissionState),
});
