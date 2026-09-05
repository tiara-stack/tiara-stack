import { Array as EffectArray, Clock, Effect, Option, Predicate, Semaphore } from "effect";
import type { TrustedSheetPersistenceShape } from "sheet-zero-server/persistence";
import { ZeroClient } from "typhoon-zero/client";

type TestTextPart = {
  readonly type: string;
  readonly text?: string;
  readonly userId?: string;
  readonly roleId?: string;
  readonly conversation?: { readonly conversationId: string };
  readonly message?: { readonly messageId: string };
  readonly parts?: ReadonlyArray<unknown>;
  readonly label?: string;
  readonly url?: string;
  readonly term?: string;
  readonly casing?: string;
  readonly epochMs?: number;
  readonly style?: string;
};

const clientTerms: Record<string, string> = {
  runDestination: "run destination",
  checkinDestination: "check-in destination",
  monitorRole: "monitor role",
  lockdownRole: "lockdown role",
  testRun: "test run",
};

const sentenceCase = (value: string): string => `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;

const renderClientTerm = (part: TestTextPart): string => {
  const rendered = clientTerms[part.term ?? ""] ?? part.term ?? "";
  return part.casing === "sentence" ? sentenceCase(rendered) : rendered;
};

const nestedParts = (part: TestTextPart): string => renderTextForTest(part.parts ?? []) ?? "";

const timestampStyles: Record<string, string> = {
  shortTime: "t",
  longTime: "T",
  shortDate: "d",
  longDate: "D",
  relative: "R",
};

const renderTimestamp = (part: TestTextPart): string => {
  const epochSeconds = Math.floor((part.epochMs ?? 0) / 1_000);
  return `<t:${epochSeconds}:${timestampStyles[part.style ?? ""] ?? "F"}>`;
};

const renderers: Record<string, (part: TestTextPart) => string> = {
  text: (part) => part.text ?? "",
  inlineCode: (part) => part.text ?? "",
  userMention: (part) => `@${part.userId ?? ""}`,
  conversationMention: (part) => `#${part.conversation?.conversationId ?? ""}`,
  roleMention: (part) => `@role:${part.roleId ?? ""}`,
  messageLink: (part) =>
    part.label ?? (part.message?.messageId ? `message ${part.message.messageId}` : "message"),
  strong: nestedParts,
  subtle: nestedParts,
  strikethrough: nestedParts,
  externalLink: (part) => part.label ?? part.url ?? "",
  clientTerm: renderClientTerm,
  timestamp: renderTimestamp,
};

const renderPartForTest = (part: unknown): string => {
  if (typeof part !== "object" || part === null || !("type" in part)) {
    return String(part);
  }

  const typedPart = part as TestTextPart;
  return renderers[typedPart.type]?.(typedPart) ?? "";
};

export const renderTextForTest = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined || typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  }

  return value.map(renderPartForTest).join("");
};

const textFieldKeys = new Set(["content", "title", "description", "name", "value", "text"]);

export const normalizePayloadText = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizePayloadText);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (textFieldKeys.has(key) && Array.isArray(item)) {
        return [key, renderTextForTest(item)];
      }
      return [key, normalizePayloadText(item)];
    }),
  );
};

type TrustedSheetPersistenceMockShape = TrustedSheetPersistenceShape;
type MethodSuccess<Method> = Method extends (
  ...args: infer _Args
) => Effect.Effect<infer Success, infer _Error, infer _Requirements>
  ? Success
  : never;
type ArrayElement<Value> = Value extends ReadonlyArray<infer Element> ? Element : never;
type OptionValue<Value> = Value extends Option.Option<infer Element> ? Element : never;
type ConfigWorkspaceRow = ArrayElement<
  MethodSuccess<TrustedSheetPersistenceShape["workspaces"]["getAutoCheckinWorkspaces"]>
>;
type ConfigWorkspaceFeatureFlagRow = ArrayElement<
  MethodSuccess<TrustedSheetPersistenceShape["workspaces"]["getWorkspaceFeatureFlags"]>
>;
type ConfigWorkspaceMonitorRoleRow = ArrayElement<
  MethodSuccess<TrustedSheetPersistenceShape["workspaces"]["getWorkspaceMonitorRoles"]>
>;
type ConfigWorkspaceConversationRow = ArrayElement<
  MethodSuccess<TrustedSheetPersistenceShape["workspaces"]["getWorkspaceConversations"]>
>;
type ConfigWorkspaceUpdateAnnouncementDeliveryRow = OptionValue<
  MethodSuccess<
    TrustedSheetPersistenceShape["workspaces"]["getWorkspaceUpdateAnnouncementDelivery"]
  >
>;
type ConfigWorkspaceTeamSubmissionChannelRow = ArrayElement<
  MethodSuccess<TrustedSheetPersistenceShape["workspaces"]["getTeamSubmissionChannelsForWorkspace"]>
>;
type ConfigUserPlatformRow = OptionValue<
  MethodSuccess<TrustedSheetPersistenceShape["preferences"]["getUserPlatformConfig"]>
>;
type MessageCheckinRow = OptionValue<
  MethodSuccess<TrustedSheetPersistenceShape["checkinState"]["getMessageCheckinData"]>
>;
type MessageCheckinMemberRow = ArrayElement<
  MethodSuccess<TrustedSheetPersistenceShape["checkinState"]["getMessageCheckinMembers"]>
>;
type MessageRoomOrderRow = OptionValue<
  MethodSuccess<TrustedSheetPersistenceShape["roomOrderState"]["getMessageRoomOrder"]>
>;
type MessageRoomOrderEntryRow = ArrayElement<
  MethodSuccess<TrustedSheetPersistenceShape["roomOrderState"]["getMessageRoomOrderEntry"]>
>;
type MessageSlotRow = OptionValue<
  MethodSuccess<TrustedSheetPersistenceShape["slotState"]["getMessageSlotData"]>
>;
type MessageTeamSubmissionRow = OptionValue<
  MethodSuccess<TrustedSheetPersistenceShape["teamSubmissionState"]["getMessageTeamSubmission"]>
>;

const auditFields = () =>
  Clock.currentTimeMillis.pipe(
    Effect.map((timestamp) => ({ createdAt: timestamp, updatedAt: timestamp, deletedAt: null })),
  );

const presentOr = <Value, Fallback>(
  value: Value | null | undefined,
  fallback: Fallback,
): NonNullable<Value> | Fallback =>
  Option.fromNullishOr(value).pipe(Option.getOrElse(() => fallback));

const valueOr = <Value, Fallback>(
  value: Value | undefined,
  fallback: Fallback,
): Exclude<Value, undefined> | Fallback =>
  Option.fromUndefinedOr(value).pipe(Option.getOrElse(() => fallback));

const claimStaleMs = 10 * 60 * 1000;

type ClaimTimestamp = Date | number | null | undefined;

type MessageRoomOrderClaimState = Pick<
  MessageRoomOrderRow,
  | "sentMessageId"
  | "sendClaimId"
  | "sendClaimedAt"
  | "tentativePinnedAt"
  | "tentativePinClaimId"
  | "tentativePinClaimedAt"
  | "tentativeUpdateClaimId"
  | "tentativeUpdateClaimedAt"
>;

const claimTimestampEpochMillis = (claimedAt: ClaimTimestamp) =>
  Predicate.isDate(claimedAt) ? claimedAt.getTime() : claimedAt;

const isActiveTimestampClaim = (claimedAt: ClaimTimestamp, now: number) => {
  const claimedAtMillis = claimTimestampEpochMillis(claimedAt);
  return (
    Predicate.isNotNullish(claimedAtMillis) &&
    Number.isFinite(claimedAtMillis) &&
    Math.abs(now - claimedAtMillis) <= claimStaleMs
  );
};

const isActiveSendClaim = (
  claimId: string | null | undefined,
  claimedAt: ClaimTimestamp,
  now: number,
) => Predicate.isNotNullish(claimId) && isActiveTimestampClaim(claimedAt, now);

const hasActiveTentativePinClaim = (row: MessageRoomOrderClaimState, now: number) =>
  Predicate.isNotNullish(row.tentativePinClaimId) &&
  isActiveTimestampClaim(row.tentativePinClaimedAt, now);

const hasActiveTentativeUpdateClaim = (row: MessageRoomOrderClaimState, now: number) =>
  Predicate.isNotNullish(row.tentativeUpdateClaimId) &&
  isActiveTimestampClaim(row.tentativeUpdateClaimedAt, now);

const hasStaleUntrackedSendClaim = (row: MessageRoomOrderClaimState, now: number) =>
  Predicate.isNotNullish(row.sendClaimId) &&
  Predicate.isNullish(row.sentMessageId) &&
  !isActiveSendClaim(row.sendClaimId, row.sendClaimedAt, now);

const blocksSendClaim = (row: MessageRoomOrderClaimState, now: number) =>
  [
    Predicate.isNotNullish(row.sentMessageId),
    Predicate.isNotNullish(row.tentativePinnedAt),
    isActiveSendClaim(row.sendClaimId, row.sendClaimedAt, now),
    hasActiveTentativeUpdateClaim(row, now),
    hasActiveTentativePinClaim(row, now),
  ].some(Predicate.isTruthy);

const blocksTentativeClaim = (row: MessageRoomOrderClaimState, now: number) =>
  [
    Predicate.isNotNullish(row.tentativePinnedAt),
    hasStaleUntrackedSendClaim(row, now),
    isActiveSendClaim(row.sendClaimId, row.sendClaimedAt, now),
    hasActiveTentativePinClaim(row, now),
    hasActiveTentativeUpdateClaim(row, now),
  ].some(Predicate.isTruthy);

const hasMessageTeamSubmissionKey = (
  submission: MessageTeamSubmissionRow,
  key: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly messageId: string;
  },
) =>
  submission.workspaceId === key.workspaceId &&
  submission.conversationId === key.conversationId &&
  submission.messageId === key.messageId;

const pendingUpdateAnnouncementConversationId = "__pending_update_announcement_delivery__";

/** A test-only in-memory implementation of the trusted persistence port. */
export const makeTrustedSheetPersistenceMock = (): TrustedSheetPersistenceShape => {
  const workspaceConfigs = new Map<string, ConfigWorkspaceRow>();
  const workspaceConversations = new Map<string, ConfigWorkspaceConversationRow>();
  const workspaceMonitorRoles = new Map<string, ConfigWorkspaceMonitorRoleRow>();
  const workspaceTeamSubmissionChannels = new Map<
    string,
    ConfigWorkspaceTeamSubmissionChannelRow
  >();
  const workspaceUpdateAnnouncementDeliveries = new Map<
    string,
    ConfigWorkspaceUpdateAnnouncementDeliveryRow
  >();
  const addedWorkspaceFeatureFlags = new Map<string, ConfigWorkspaceFeatureFlagRow>();
  const removedWorkspaceFeatureFlags = new Set<string>();
  const userPlatformConfigs = new Map<string, ConfigUserPlatformRow>();
  const messageCheckins = new Map<string, MessageCheckinRow>();
  const messageCheckinMembers = new Map<string, MessageCheckinMemberRow>();
  const messageRoomOrders = new Map<string, MessageRoomOrderRow>();
  const messageRoomOrderEntries = new Map<string, MessageRoomOrderEntryRow>();
  const messageRoomOrderBindLocks = new Map<
    string,
    { readonly semaphore: ReturnType<typeof Semaphore.makeUnsafe>; users: number }
  >();
  const messageSlots = new Map<string, MessageSlotRow>();
  const defaultMessageTeamSubmission = {
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    messageId: "source-message-1",
    clientPlatform: "discord",
    clientId: "discord-main",
    discordGuildId: "workspace-1",
    discordChannelId: "conversation-1",
    discordAuthorId: "discord-user-1",
    sheetId: "sheet-1",
    sheetConfigurationBinding: null,
    confirmationMessageId: "confirmation-message-1",
    parsedSubmission: [],
    rowMappings: [],
    rollbackSnapshot: null,
    version: 1,
    status: "registered",
  } as const;
  let messageTeamSubmission: MessageTeamSubmissionRow | undefined;
  const getMessageTeamSubmissionState = Effect.gen(function* () {
    if (Predicate.isNotUndefined(messageTeamSubmission)) return messageTeamSubmission;
    const initialSubmission = {
      ...defaultMessageTeamSubmission,
      ...(yield* auditFields()),
    };
    messageTeamSubmission = initialSubmission;
    return initialSubmission;
  });
  const workspaceFeatureFlagKey = (workspaceId: string, flagName: string) =>
    `${workspaceId}\u0000${flagName}`;
  const workspaceConversationKey = (workspaceId: string, conversationId: string) =>
    `${workspaceId}\u0000${conversationId}`;
  const matchesRunningFilter = (
    row: ConfigWorkspaceConversationRow,
    running: boolean | undefined,
  ) => Predicate.isUndefined(running) || row.running === running;
  const workspaceUpdateAnnouncementDeliveryKey = (workspaceId: string, announcementId: string) =>
    `${workspaceId}\u0000${announcementId}`;
  const userPlatformConfigKey = (platform: string, userId: string) => `${platform}\u0000${userId}`;
  const messageKey = (clientPlatform: string, clientId: string, messageId: string) =>
    `${clientPlatform}\u0000${clientId}\u0000${messageId}`;
  const messageSlotKey = (
    clientPlatform: string,
    clientId: string,
    workspaceId: string,
    conversationId: string,
  ) => `${clientPlatform}\u0000${clientId}\u0000${workspaceId}\u0000${conversationId}`;
  const withMessageRoomOrderBindLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const existing = messageRoomOrderBindLocks.get(key);
      const entry = existing ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      entry.users += 1;
      if (Predicate.isUndefined(existing)) {
        messageRoomOrderBindLocks.set(key, entry);
      }
      return entry.semaphore.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.users -= 1;
            if (entry.users === 0 && messageRoomOrderBindLocks.get(key) === entry) {
              messageRoomOrderBindLocks.delete(key);
            }
          }),
        ),
      );
    });
  const messageMemberKey = (
    clientPlatform: string,
    clientId: string,
    messageId: string,
    memberId: string,
  ) => `${messageKey(clientPlatform, clientId, messageId)}\u0000${memberId}`;
  const updateMessageRoomOrder = (
    args: {
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
    },
    update: Partial<MessageRoomOrderRow>,
  ) => {
    const key = messageKey(args.clientPlatform, args.clientId, args.messageId);
    const current = messageRoomOrders.get(key);
    if (Predicate.isUndefined(current)) return;
    messageRoomOrders.set(key, { ...current, ...update });
  };

  const persistence: TrustedSheetPersistenceMockShape = {
    workspaces: {
      getAutoCheckinWorkspaces: () =>
        Effect.succeed([...workspaceConfigs.values()].filter((row) => row.autoCheckin === true)),
      getWorkspaceConfigByWorkspaceId: ({ workspaceId }) =>
        Effect.succeed(Option.fromNullishOr(workspaceConfigs.get(workspaceId))),
      getWorkspaceMonitorRoles: ({ workspaceId }) =>
        Effect.succeed(
          [...workspaceMonitorRoles.values()].filter(
            (row) => row.workspaceId === workspaceId && Predicate.isNull(row.deletedAt),
          ),
        ),
      getWorkspaceFeatureFlags: ({ workspaceId }) =>
        Effect.succeed(
          [...addedWorkspaceFeatureFlags.values()].filter(
            (row) =>
              row.workspaceId === workspaceId &&
              !removedWorkspaceFeatureFlags.has(
                workspaceFeatureFlagKey(row.workspaceId, row.flagName),
              ),
          ),
        ),
      getWorkspacesForFeatureFlag: ({ flagName }) =>
        Effect.succeed(
          [...addedWorkspaceFeatureFlags.values()].filter(
            (row) =>
              row.flagName === flagName &&
              !removedWorkspaceFeatureFlags.has(
                workspaceFeatureFlagKey(row.workspaceId, row.flagName),
              ),
          ),
        ),
      getWorkspaceFeatureFlag: ({ workspaceId, flagName }) =>
        persistence.workspaces
          .getWorkspaceFeatureFlags({ workspaceId })
          .pipe(
            Effect.map(
              EffectArray.findFirst(
                (flag) => flag.workspaceId === workspaceId && flag.flagName === flagName,
              ),
            ),
          ),
      getWorkspaceUpdateAnnouncementDelivery: ({ workspaceId, announcementId }) => {
        const row = workspaceUpdateAnnouncementDeliveries.get(
          workspaceUpdateAnnouncementDeliveryKey(workspaceId, announcementId),
        );
        return Effect.succeed(Option.fromNullishOr(row));
      },
      getWorkspaceConversations: (args) =>
        Effect.succeed(
          [...workspaceConversations.values()].filter(
            (row) =>
              row.workspaceId === args.workspaceId && matchesRunningFilter(row, args.running),
          ),
        ),
      getWorkspaceConversationById: (args) => {
        const row = workspaceConversations.get(
          workspaceConversationKey(args.workspaceId, args.conversationId),
        );
        return Effect.succeed(
          Predicate.isUndefined(row) || !matchesRunningFilter(row, args.running)
            ? Option.none()
            : Option.some(row),
        );
      },
      getWorkspaceConversationByName: (args) =>
        Option.fromNullishOr(
          [...workspaceConversations.values()].find(
            (row) =>
              row.workspaceId === args.workspaceId &&
              row.name === args.conversationName &&
              matchesRunningFilter(row, args.running),
          ),
        ).pipe(
          Option.match({
            onNone: () => Effect.succeed(Option.none()),
            onSome: (row) => Effect.succeed(Option.some(row)),
          }),
        ),
      getTeamSubmissionChannelByConversationId: (args) =>
        Effect.succeed(
          Option.fromNullishOr(
            workspaceTeamSubmissionChannels.get(
              workspaceConversationKey(args.workspaceId, args.conversationId),
            ),
          ),
        ),
      getTeamSubmissionChannelsForWorkspace: (args) =>
        Effect.succeed(
          [...workspaceTeamSubmissionChannels.values()].filter(
            (row) => row.workspaceId === args.workspaceId && Predicate.isNull(row.deletedAt),
          ),
        ),
      upsertWorkspaceConfig: ({ workspaceId, ...config }) =>
        Effect.gen(function* () {
          const existing = workspaceConfigs.get(workspaceId);
          const fields = yield* auditFields();
          workspaceConfigs.set(workspaceId, {
            workspaceId,
            sheetId: presentOr(config.sheetId, presentOr(existing?.sheetId, null)),
            autoCheckin: presentOr(config.autoCheckin, presentOr(existing?.autoCheckin, null)),
            monitorConversationId: presentOr(
              config.monitorConversationId,
              presentOr(existing?.monitorConversationId, null),
            ),
            ...fields,
            createdAt: presentOr(existing?.createdAt, fields.createdAt),
          });
        }),
      addWorkspaceMonitorRole: (args) =>
        Effect.gen(function* () {
          workspaceMonitorRoles.set(`${args.workspaceId}\u0000${args.roleId}`, {
            ...args,
            ...(yield* auditFields()),
          });
        }),
      removeWorkspaceMonitorRole: (args) =>
        Effect.sync(() => {
          workspaceMonitorRoles.delete(`${args.workspaceId}\u0000${args.roleId}`);
        }),
      addWorkspaceFeatureFlag: (args) =>
        Effect.gen(function* () {
          const key = workspaceFeatureFlagKey(args.workspaceId, args.flagName);
          removedWorkspaceFeatureFlags.delete(key);
          addedWorkspaceFeatureFlags.set(key, {
            ...args,
            ...(yield* auditFields()),
          });
        }),
      removeWorkspaceFeatureFlag: (args) =>
        Effect.sync(() => {
          const key = workspaceFeatureFlagKey(args.workspaceId, args.flagName);
          addedWorkspaceFeatureFlags.delete(key);
          removedWorkspaceFeatureFlags.add(key);
        }),
      recordWorkspaceUpdateAnnouncementDelivery: ({
        publishedAt,
        deliveredAt,
        claimToken,
        ...args
      }) =>
        Effect.gen(function* () {
          const key = workspaceUpdateAnnouncementDeliveryKey(args.workspaceId, args.announcementId);
          const existing = workspaceUpdateAnnouncementDeliveries.get(key);
          if (
            existing?.conversationId === pendingUpdateAnnouncementConversationId &&
            existing.messageId === claimToken
          ) {
            workspaceUpdateAnnouncementDeliveries.set(key, {
              ...args,
              publishedAt,
              deliveredAt,
              ...(yield* auditFields()),
            });
          }
        }),
      claimWorkspaceUpdateAnnouncementDelivery: ({ publishedAt, ...args }) =>
        Effect.gen(function* () {
          const key = workspaceUpdateAnnouncementDeliveryKey(args.workspaceId, args.announcementId);
          const existing = workspaceUpdateAnnouncementDeliveries.get(key);
          if (
            Predicate.isUndefined(existing) ||
            (existing.conversationId === pendingUpdateAnnouncementConversationId &&
              existing.messageId === args.claimToken)
          ) {
            workspaceUpdateAnnouncementDeliveries.set(key, {
              workspaceId: args.workspaceId,
              announcementId: args.announcementId,
              publishedAt,
              deliveredAt: yield* Clock.currentTimeMillis,
              conversationId: pendingUpdateAnnouncementConversationId,
              messageId: args.claimToken,
              ...(yield* auditFields()),
            });
          }
        }),
      releaseWorkspaceUpdateAnnouncementDeliveryClaim: (args) =>
        Effect.sync(() => {
          const key = workspaceUpdateAnnouncementDeliveryKey(args.workspaceId, args.announcementId);
          const existing = workspaceUpdateAnnouncementDeliveries.get(key);
          if (
            Predicate.isNotUndefined(existing) &&
            existing.conversationId === pendingUpdateAnnouncementConversationId &&
            existing.messageId === args.claimToken
          ) {
            workspaceUpdateAnnouncementDeliveries.delete(key);
          }
        }),
      upsertWorkspaceConversationConfig: ({ workspaceId, conversationId, ...config }) =>
        Effect.gen(function* () {
          const key = workspaceConversationKey(workspaceId, conversationId);
          const existing = workspaceConversations.get(key);
          const fields = yield* auditFields();
          workspaceConversations.set(key, {
            workspaceId,
            conversationId,
            name: presentOr(config.name, presentOr(existing?.name, null)),
            running: presentOr(config.running, presentOr(existing?.running, null)),
            roleId: presentOr(config.roleId, presentOr(existing?.roleId, null)),
            checkinConversationId: presentOr(
              config.checkinConversationId,
              presentOr(existing?.checkinConversationId, null),
            ),
            ...fields,
            createdAt: presentOr(existing?.createdAt, fields.createdAt),
          });
        }),
      upsertTeamSubmissionChannel: (args) =>
        Effect.gen(function* () {
          const key = workspaceConversationKey(args.workspaceId, args.conversationId);
          const existing = workspaceTeamSubmissionChannels.get(key);
          const fields = yield* auditFields();
          workspaceTeamSubmissionChannels.set(key, {
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
            destinationTeamConfigName: presentOr(args.destinationTeamConfigName, null),
            writeMode: args.writeMode,
            removedRowStrategy: args.removedRowStrategy,
            requireValidOshi: presentOr(args.requireValidOshi, false),
            ...fields,
            createdAt: presentOr(existing?.createdAt, fields.createdAt),
          });
        }),
      removeTeamSubmissionChannel: (args) =>
        Effect.sync(() => {
          workspaceTeamSubmissionChannels.delete(
            workspaceConversationKey(args.workspaceId, args.conversationId),
          );
        }),
    },
    sheetConfiguration: {
      getSheetConfiguration: () => Effect.succeed(Option.none()),
      getSheetConfigurationRevisions: () => Effect.succeed([]),
      getSheetConfigurationRevisionById: () => Effect.succeed(Option.none()),
      getSheetConfigurationRevisionsBySpreadsheetId: () => Effect.succeed([]),
      getSheetConfigurationImportAttempt: () => Effect.succeed(Option.none()),
      upsertSheetConfigurationDraft: () => Effect.void,
      saveSheetConfigurationRevision: () => Effect.void,
      activateSheetConfigurationRevision: () => Effect.void,
      rollbackSheetConfiguration: () => Effect.void,
      discardSheetConfigurationDraft: () => Effect.void,
      upsertSheetConfigurationImportAttempt: () => Effect.void,
      recordSheetConfigurationAudit: () => Effect.void,
    },
    checkinMessages: {
      getMessageSet: () => Effect.succeed(Option.none()),
      getHourlyMessage: () => Effect.succeed(Option.none()),
      listHourlyMessages: () => Effect.succeed([]),
      getSaveReceipt: () => Effect.succeed(Option.none()),
      reconcileMessageSet: () => Effect.void,
      saveHourlyMessage: () => Effect.void,
    },
    preferences: {
      getUserPlatformConfig: (args) => {
        const row = userPlatformConfigs.get(userPlatformConfigKey(args.platform, args.userId));
        return Effect.succeed(Option.fromNullishOr(row));
      },
      getCheckinDmEnabledUserConfigs: ({ platform, userIds }) =>
        Effect.succeed(
          [...userPlatformConfigs.values()].filter(
            (row) =>
              row.platform === platform &&
              userIds.includes(row.userId) &&
              row.checkinDmEnabled &&
              Predicate.isNotNull(row.defaultClientId),
          ),
        ),
      // The in-memory test adapter intentionally mirrors the adjacent preference query.
      // fallow-ignore-next-line code-duplication
      getMonitorDmEnabledUserConfigs: ({ platform, userIds }) =>
        Effect.succeed(
          [...userPlatformConfigs.values()].filter(
            (row) =>
              row.platform === platform &&
              userIds.includes(row.userId) &&
              row.monitorDmEnabled &&
              Predicate.isNotNull(row.defaultClientId),
          ),
        ),
      upsertUserPlatformConfig: (args) =>
        Effect.gen(function* () {
          const key = userPlatformConfigKey(args.platform, args.userId);
          const existing = userPlatformConfigs.get(key);
          const fields = yield* auditFields();
          userPlatformConfigs.set(key, {
            platform: args.platform,
            userId: args.userId,
            checkinDmEnabled: presentOr(
              args.checkinDmEnabled,
              presentOr(existing?.checkinDmEnabled, false),
            ),
            monitorDmEnabled: presentOr(
              args.monitorDmEnabled,
              presentOr(existing?.monitorDmEnabled, false),
            ),
            defaultClientId: presentOr(
              args.defaultClientId,
              presentOr(existing?.defaultClientId, null),
            ),
            ...fields,
            createdAt: presentOr(existing?.createdAt, fields.createdAt),
          });
        }),
    },
    checkinState: {
      getMessageCheckinData: (args) => {
        const row = messageCheckins.get(
          messageKey(args.clientPlatform, args.clientId, args.messageId),
        );
        return Effect.succeed(Option.fromNullishOr(row));
      },
      getMessageCheckinMembers: (args) =>
        Effect.succeed(
          [...messageCheckinMembers.values()].filter(
            (row) =>
              row.clientPlatform === args.clientPlatform &&
              row.clientId === args.clientId &&
              row.messageId === args.messageId,
          ),
        ),
      persistMessageCheckin: (args) =>
        Effect.gen(function* () {
          messageCheckins.set(messageKey(args.clientPlatform, args.clientId, args.messageId), {
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            ...args.data,
            roleId: presentOr(args.data.roleId, null),
            workspaceId: args.data.workspaceId,
            conversationId: args.data.conversationId,
            createdByUserId: args.data.createdByUserId,
            ...(yield* auditFields()),
          });
          for (const memberId of args.memberIds) {
            const fields = yield* auditFields();
            messageCheckinMembers.set(
              messageMemberKey(args.clientPlatform, args.clientId, args.messageId, memberId),
              {
                clientPlatform: args.clientPlatform,
                clientId: args.clientId,
                messageId: args.messageId,
                memberId,
                checkinAt: null,
                checkinClaimId: null,
                ...fields,
              },
            );
          }
        }),
      setMessageCheckinMemberCheckinAtIfUnset: (args) =>
        Effect.gen(function* () {
          const key = messageMemberKey(
            args.clientPlatform,
            args.clientId,
            args.messageId,
            args.memberId,
          );
          const existing = messageCheckinMembers.get(key);
          if (Predicate.isUndefined(existing)) {
            const fields = yield* auditFields();
            messageCheckinMembers.set(key, {
              clientPlatform: args.clientPlatform,
              clientId: args.clientId,
              messageId: args.messageId,
              memberId: args.memberId,
              checkinAt: args.checkinAt,
              checkinClaimId: args.checkinClaimId,
              ...fields,
            });
          } else if (Predicate.isNull(existing.checkinAt)) {
            messageCheckinMembers.set(key, {
              ...existing,
              checkinAt: args.checkinAt,
              checkinClaimId: args.checkinClaimId,
              updatedAt: yield* Clock.currentTimeMillis,
            });
          }
        }),
      removeMessageCheckin: (args) =>
        Effect.sync(() => {
          const key = messageKey(args.clientPlatform, args.clientId, args.messageId);
          messageCheckins.delete(key);
          for (const memberKey of messageCheckinMembers.keys()) {
            if (memberKey.startsWith(`${key}\u0000`)) {
              messageCheckinMembers.delete(memberKey);
            }
          }
        }),
    },
    roomOrderState: {
      getMessageRoomOrder: (args) => {
        const key = messageKey(args.clientPlatform, args.clientId, args.messageId);
        const row = messageRoomOrders.get(key);
        return Effect.succeed(Option.fromNullishOr(row));
      },
      getMessageRoomOrderEntry: (args) =>
        Effect.succeed(
          [...messageRoomOrderEntries.values()].filter(
            (row) =>
              row.clientPlatform === args.clientPlatform &&
              row.clientId === args.clientId &&
              row.messageId === args.messageId &&
              row.rank === args.rank &&
              Predicate.isNull(row.deletedAt),
          ),
        ),
      // These range variants share the same key filtering by design.
      // fallow-ignore-next-line code-duplication
      getMessageRoomOrderRange: (args) =>
        Effect.succeed(
          [...messageRoomOrderEntries.values()].filter(
            (row) =>
              row.clientPlatform === args.clientPlatform &&
              row.clientId === args.clientId &&
              row.messageId === args.messageId &&
              Predicate.isNull(row.deletedAt),
          ),
        ),
      decrementMessageRoomOrderRank: (args) =>
        Effect.sync(() => {
          const current = messageRoomOrders.get(
            messageKey(args.clientPlatform, args.clientId, args.messageId),
          );
          if (
            Predicate.isUndefined(current) ||
            (Predicate.isNotUndefined(args.expectedRank) && current.rank !== args.expectedRank)
          ) {
            return;
          }
          updateMessageRoomOrder(args, { rank: current.rank - 1 });
        }),
      // Rank updates share the same optimistic-concurrency guard by design.
      // fallow-ignore-next-line code-duplication
      incrementMessageRoomOrderRank: (args) =>
        Effect.sync(() => {
          const current = messageRoomOrders.get(
            messageKey(args.clientPlatform, args.clientId, args.messageId),
          );
          if (
            Predicate.isUndefined(current) ||
            (Predicate.isNotUndefined(args.expectedRank) && current.rank !== args.expectedRank)
          ) {
            return;
          }
          updateMessageRoomOrder(args, { rank: current.rank + 1 });
        }),
      claimMessageRoomOrderSend: (args) =>
        Effect.gen(function* () {
          const claimedAt = yield* Clock.currentTimeMillis;
          const current = messageRoomOrders.get(
            messageKey(args.clientPlatform, args.clientId, args.messageId),
          );
          if (Predicate.isUndefined(current) || blocksSendClaim(current, claimedAt)) return;
          updateMessageRoomOrder(args, {
            sendClaimId: args.claimId,
            sendClaimedAt: claimedAt,
            tentativeUpdateClaimId: null,
            tentativeUpdateClaimedAt: null,
            tentativePinClaimId: null,
            tentativePinClaimedAt: null,
          });
        }),
      completeMessageRoomOrderSend: (args) =>
        Effect.sync(() => {
          const current = messageRoomOrders.get(
            messageKey(args.clientPlatform, args.clientId, args.messageId),
          );
          if (Predicate.isUndefined(current) || current.sendClaimId !== args.claimId) return;
          updateMessageRoomOrder(args, {
            sendClaimId: null,
            sendClaimedAt: null,
            sentMessageId: args.sentMessageId,
            sentConversationId: args.sentConversationId,
            sentAt: args.sentAt,
          });
        }),
      releaseMessageRoomOrderSendClaim: (args) =>
        Effect.sync(() => {
          const current = messageRoomOrders.get(
            messageKey(args.clientPlatform, args.clientId, args.messageId),
          );
          if (current?.sendClaimId === args.claimId) {
            updateMessageRoomOrder(args, { sendClaimId: null, sendClaimedAt: null });
          }
        }),
      // Claim variants share the same claim timestamp and stale-claim guard by design.
      // fallow-ignore-next-line code-duplication
      claimMessageRoomOrderTentativeUpdate: (args) =>
        Effect.gen(function* () {
          const claimedAt = yield* Clock.currentTimeMillis;
          const current = messageRoomOrders.get(
            messageKey(args.clientPlatform, args.clientId, args.messageId),
          );
          if (Predicate.isUndefined(current) || blocksTentativeClaim(current, claimedAt)) return;
          updateMessageRoomOrder(args, {
            sendClaimId: null,
            sendClaimedAt: null,
            tentativeUpdateClaimId: args.claimId,
            tentativeUpdateClaimedAt: claimedAt,
            tentativePinClaimId: null,
            tentativePinClaimedAt: null,
          });
        }),
      releaseMessageRoomOrderTentativeUpdateClaim: (args) =>
        Effect.sync(() => {
          const current = messageRoomOrders.get(
            messageKey(args.clientPlatform, args.clientId, args.messageId),
          );
          if (current?.tentativeUpdateClaimId === args.claimId) {
            updateMessageRoomOrder(args, {
              tentativeUpdateClaimId: null,
              tentativeUpdateClaimedAt: null,
            });
          }
        }),
      // Claim variants share the same claim timestamp and stale-claim guard by design.
      // fallow-ignore-next-line code-duplication
      claimMessageRoomOrderTentativePin: (args) =>
        Effect.gen(function* () {
          const claimedAt = yield* Clock.currentTimeMillis;
          const current = messageRoomOrders.get(
            messageKey(args.clientPlatform, args.clientId, args.messageId),
          );
          if (Predicate.isUndefined(current) || blocksTentativeClaim(current, claimedAt)) return;
          updateMessageRoomOrder(args, {
            sendClaimId: null,
            sendClaimedAt: null,
            tentativePinClaimId: args.claimId,
            tentativePinClaimedAt: claimedAt,
            tentativeUpdateClaimId: null,
            tentativeUpdateClaimedAt: null,
          });
        }),
      // Claim completion and rank updates intentionally use the same guarded lookup shape.
      // fallow-ignore-next-line code-duplication
      completeMessageRoomOrderTentativePin: (args) =>
        Effect.sync(() => {
          const current = messageRoomOrders.get(
            messageKey(args.clientPlatform, args.clientId, args.messageId),
          );
          if (
            Predicate.isUndefined(current) ||
            Predicate.isNotNull(current.tentativePinnedAt) ||
            current.tentativePinClaimId !== args.claimId
          ) {
            return;
          }
          updateMessageRoomOrder(args, {
            tentativePinClaimId: null,
            tentativePinClaimedAt: null,
            tentativePinnedAt: args.pinnedAt,
          });
        }),
      releaseMessageRoomOrderTentativePinClaim: (args) =>
        Effect.sync(() => {
          const current = messageRoomOrders.get(
            messageKey(args.clientPlatform, args.clientId, args.messageId),
          );
          if (
            current?.tentativePinClaimId === args.claimId &&
            Predicate.isNull(current.tentativePinnedAt)
          ) {
            updateMessageRoomOrder(args, {
              tentativePinClaimId: null,
              tentativePinClaimedAt: null,
            });
          }
        }),
      markMessageRoomOrderTentative: ({ workspaceId, conversationId, ...args }) =>
        Effect.gen(function* () {
          const current = yield* persistence.roomOrderState.getMessageRoomOrder(args).pipe(
            Effect.mapError(
              (error) =>
                new ZeroClient.ZeroClientExecutorError({
                  operation: "get message room order before marking tentative",
                  message:
                    Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
                      ? error.message
                      : "Failed to load message room order before marking tentative",
                }),
            ),
          );
          if (
            Option.isSome(current) &&
            (current.value.workspaceId !== workspaceId ||
              current.value.conversationId !== conversationId)
          ) {
            return;
          }
          updateMessageRoomOrder(args, { tentative: true, workspaceId, conversationId });
        }),
      persistMessageRoomOrder: (args) =>
        // This mock mirrors the full persistence transition used by the workflow tests.
        // fallow-ignore-next-line complexity
        Effect.gen(function* () {
          const key = messageKey(args.clientPlatform, args.clientId, args.messageId);
          const current = messageRoomOrders.get(key);
          const fields = yield* auditFields();
          messageRoomOrders.set(key, {
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            ...args.data,
            tentative: presentOr(args.data.tentative, presentOr(current?.tentative, false)),
            monitor: presentOr(args.data.monitor, presentOr(current?.monitor, null)),
            sendClaimId: presentOr(current?.sendClaimId, null),
            sendClaimedAt: presentOr(current?.sendClaimedAt, null),
            sentMessageId: presentOr(current?.sentMessageId, null),
            sentConversationId: presentOr(current?.sentConversationId, null),
            sentAt: presentOr(current?.sentAt, null),
            tentativeUpdateClaimId: presentOr(current?.tentativeUpdateClaimId, null),
            tentativeUpdateClaimedAt: presentOr(current?.tentativeUpdateClaimedAt, null),
            tentativePinClaimId: presentOr(current?.tentativePinClaimId, null),
            tentativePinClaimedAt: presentOr(current?.tentativePinClaimedAt, null),
            tentativePinnedAt: presentOr(current?.tentativePinnedAt, null),
            ...fields,
            createdAt: presentOr(current?.createdAt, fields.createdAt),
          });
          const supplied = new Set(args.entries.map((entry) => `${entry.rank}:${entry.position}`));
          for (const [entryKey, entry] of messageRoomOrderEntries) {
            if (
              entry.clientPlatform === args.clientPlatform &&
              entry.clientId === args.clientId &&
              entry.messageId === args.messageId &&
              !supplied.has(`${entry.rank}:${entry.position}`)
            ) {
              messageRoomOrderEntries.delete(entryKey);
            }
          }
          for (const entry of args.entries) {
            messageRoomOrderEntries.set(`${key}\u0000${entry.rank}:${entry.position}`, {
              clientPlatform: args.clientPlatform,
              clientId: args.clientId,
              messageId: args.messageId,
              ...entry,
              ...fields,
            });
          }
        }),
      bindMessageRoomOrderIfAbsent: (args) => {
        const { clientPlatform, clientId, messageId } = args;
        return withMessageRoomOrderBindLock(
          messageKey(clientPlatform, clientId, messageId),
          Effect.gen(function* () {
            const current = yield* persistence.roomOrderState
              .getMessageRoomOrder({ clientPlatform, clientId, messageId })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new ZeroClient.ZeroClientExecutorError({
                      operation: "get message room order before binding",
                      message:
                        Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
                          ? error.message
                          : "Failed to load message room order before binding",
                    }),
                ),
              );
            if (Option.isSome(current)) return;
            const fields = yield* auditFields();
            const key = messageKey(clientPlatform, clientId, messageId);
            messageRoomOrders.set(key, {
              clientPlatform,
              clientId,
              messageId,
              ...args.data,
              tentative: args.data.tentative ?? false,
              monitor: args.data.monitor ?? null,
              sendClaimId: null,
              sendClaimedAt: null,
              sentMessageId: null,
              sentConversationId: null,
              sentAt: null,
              tentativeUpdateClaimId: null,
              tentativeUpdateClaimedAt: null,
              tentativePinClaimId: null,
              tentativePinClaimedAt: null,
              tentativePinnedAt: null,
              ...fields,
            });
            for (const entry of args.entries) {
              messageRoomOrderEntries.set(`${key}\u0000${entry.rank}:${entry.position}`, {
                clientPlatform,
                clientId,
                messageId,
                ...entry,
                ...fields,
              });
            }
          }),
        );
      },
    },
    slotState: {
      getMessageSlotData: (args) => {
        const row = Array.from(messageSlots.values()).find(
          (candidate) =>
            candidate.clientPlatform === args.clientPlatform &&
            candidate.clientId === args.clientId &&
            candidate.messageId === args.messageId &&
            Predicate.isNull(candidate.deletedAt),
        );
        return Effect.succeed(Option.fromNullishOr(row));
      },
      getMessageSlotDataByConversation: (args) => {
        const row = messageSlots.get(
          messageSlotKey(args.clientPlatform, args.clientId, args.workspaceId, args.conversationId),
        );
        return Effect.succeed(
          Option.fromNullishOr(row).pipe(
            Option.filter((candidate) => Predicate.isNull(candidate.deletedAt)),
          ),
        );
      },
      upsertMessageSlotData: ({
        clientPlatform,
        clientId,
        messageId,
        workspaceId,
        conversationId,
        ...data
      }) =>
        Effect.gen(function* () {
          const key = messageSlotKey(clientPlatform, clientId, workspaceId, conversationId);
          const existing = messageSlots.get(key);
          const conflictingMessage = Array.from(messageSlots.values()).find(
            (candidate) =>
              candidate.clientPlatform === clientPlatform &&
              candidate.clientId === clientId &&
              candidate.messageId === messageId &&
              messageSlotKey(
                candidate.clientPlatform,
                candidate.clientId,
                candidate.workspaceId,
                candidate.conversationId,
              ) !== key,
          );
          if (Predicate.isNotUndefined(conflictingMessage)) {
            return yield* Effect.fail(
              new ZeroClient.ZeroClientExecutorError({
                operation: "upsert message slot",
                code: "23505",
                message: "duplicate message slot identity",
              }),
            );
          }
          const fields = yield* auditFields();
          messageSlots.set(key, {
            clientPlatform,
            clientId,
            messageId,
            workspaceId,
            conversationId,
            ...data,
            ...fields,
            createdAt: presentOr(existing?.createdAt, fields.createdAt),
          });
        }),
    },
    teamSubmissionState: {
      getMessageTeamSubmission: (args) =>
        getMessageTeamSubmissionState.pipe(
          Effect.map((submission) =>
            hasMessageTeamSubmissionKey(submission, args) ? Option.some(submission) : Option.none(),
          ),
        ),
      getMessageTeamSubmissionByDiscordMessage: (args) =>
        getMessageTeamSubmissionState.pipe(
          Effect.map((submission) =>
            submission.discordGuildId === args.discordGuildId &&
            submission.discordChannelId === args.discordChannelId &&
            submission.messageId === args.messageId
              ? Option.some(submission)
              : Option.none(),
          ),
        ),
      upsertMessageTeamSubmission: (args) =>
        Effect.gen(function* () {
          const currentSubmission = yield* getMessageTeamSubmissionState;
          const existing = hasMessageTeamSubmissionKey(currentSubmission, args)
            ? currentSubmission
            : undefined;
          if (
            Predicate.isNotUndefined(args.expectedVersion) &&
            existing?.version !== args.expectedVersion
          ) {
            return yield* Effect.fail(
              new ZeroClient.ZeroClientExecutorError({
                operation: "run mutation",
                code: "TEAM_SUBMISSION_VERSION_CONFLICT",
                message: `Team submission version conflict: expected ${args.expectedVersion}, found ${presentOr(existing?.version, "missing")}`,
              }),
            );
          }
          const { expectedVersion: _, ...submission } = args;
          const timestamp = yield* Clock.currentTimeMillis;
          const nextSubmission: MessageTeamSubmissionRow = {
            ...submission,
            sheetConfigurationBinding: valueOr(
              submission.sheetConfigurationBinding,
              presentOr(existing?.sheetConfigurationBinding, null),
            ),
            confirmationMessageId: presentOr(submission.confirmationMessageId, null),
            rollbackSnapshot: presentOr(submission.rollbackSnapshot, null),
            version: presentOr(existing?.version, 0) + 1,
            createdAt: presentOr(existing?.createdAt, timestamp),
            updatedAt: timestamp,
            deletedAt: null,
          };
          messageTeamSubmission = nextSubmission;
        }),
      setMessageTeamSubmissionConfirmation: (args) =>
        Effect.gen(function* () {
          const submission = yield* getMessageTeamSubmissionState;
          if (!hasMessageTeamSubmissionKey(submission, args)) return;
          messageTeamSubmission = {
            ...submission,
            confirmationMessageId: args.confirmationMessageId,
            updatedAt: yield* Clock.currentTimeMillis,
          };
        }),
    },
  };
  return persistence;
};
