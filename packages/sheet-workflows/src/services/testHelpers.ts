import { Array as EffectArray, Clock, DateTime, Effect, Option, Predicate } from "effect";
import type { TrustedSheetPersistenceShape } from "sheet-zero-server/persistence";
import { ZeroClient } from "typhoon-zero/client";
import { ClientDeliveryClient } from "./clientDeliveryClient";
import { updateAnnouncementDeliveryPendingConversationId } from "./dispatch/clients/trustedPersistence";
import type { SheetApisClient } from "./sheetApisClient";

export const text = (value: string) => [{ type: "text" as const, text: value }];

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

const unexpected = (prefix: string, name: string) => () => Effect.die(`${prefix}: ${name}`);

type ClientDeliveryService = typeof ClientDeliveryClient.Service;
type BoundClientDeliveryService = ReturnType<ClientDeliveryService["forClient"]>;
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

type WithoutEffectErrors<Value> = Value extends (
  ...args: infer Args
) => Effect.Effect<infer Success, infer _Error, infer Requirements>
  ? (...args: Args) => Effect.Effect<Success, never, Requirements>
  : Value extends object
    ? { readonly [Key in keyof Value]: WithoutEffectErrors<Value[Key]> }
    : Value;

const makeBoundClientDeliveryMock = (
  overrides: Partial<BoundClientDeliveryService> = {},
): BoundClientDeliveryService => {
  const unexpectedCall = (operation: string) => Effect.die(`Unexpected ${operation} call`);
  return {
    sendMessage: () => unexpectedCall("sendMessage"),
    sendDirectMessage: () => unexpectedCall("sendDirectMessage"),
    listClients: () => unexpectedCall("listClients"),
    updateMessage: () => unexpectedCall("updateMessage"),
    updateConversationPermissionOverwrites: () =>
      unexpectedCall("updateConversationPermissionOverwrites"),
    updateOriginalInteractionResponse: () => unexpectedCall("updateOriginalInteractionResponse"),
    updateOriginalInteractionResponseWithFiles: () =>
      unexpectedCall("updateOriginalInteractionResponseWithFiles"),
    createPin: () => unexpectedCall("createPin"),
    deleteMessage: () => unexpectedCall("deleteMessage"),
    addMessageReaction: () => unexpectedCall("addMessageReaction"),
    removeMessageReaction: () => unexpectedCall("removeMessageReaction"),
    addWorkspaceMemberRole: () => unexpectedCall("addWorkspaceMemberRole"),
    removeWorkspaceMemberRole: () => unexpectedCall("removeWorkspaceMemberRole"),
    getWorkspace: () => unexpectedCall("getWorkspace"),
    getMembersForParent: () => unexpectedCall("getMembersForParent"),
    getConversationsForParent: () => unexpectedCall("getConversationsForParent"),
    ...overrides,
  };
};

export const makeClientDeliveryMock = (
  overrides: Partial<ClientDeliveryService> = {},
): ClientDeliveryService => {
  const { forClient, ...boundOverrides } = overrides;
  const bound = makeBoundClientDeliveryMock(boundOverrides);
  return {
    ...bound,
    forClient:
      forClient ??
      function (this: ClientDeliveryService) {
        return this;
      },
  };
};

export const makeSheetApisClient = (
  services: Record<string, unknown>,
  prefix = "Unexpected call",
) =>
  ({
    get: () =>
      new Proxy(services, {
        get(target, group: string) {
          if (group in target) {
            return target[group];
          }

          return new Proxy(
            {},
            {
              get: (_service, method: string) => unexpected(prefix, `${group}.${method}`),
            },
          );
        },
      }),
  }) as never;

const legacyNotFoundMessages = new Set([
  "Cannot get message checkin data, the message might not be registered",
  "Cannot get message room order, the message might not be registered",
  "Cannot get message room order range, the message might not be registered",
  "Cannot get message slot data, the message might not be registered",
  "Cannot get workspace config, the workspace might not be registered",
  "Cannot get team submission channel, the workspace or conversation might not be registered",
  "Cannot get conversation by id, the workspace or the conversation id might not be registered",
  "Cannot get conversation by id, the workspace or the conversation id might not be registered or does not match the specified running status",
  "Cannot get conversation by name, the workspace or the conversation name might not be registered",
  "Cannot get conversation by name, the workspace or the conversation name might not be registered or does not match the specified running status",
]);

const isLegacyNotFoundError = (error: unknown) =>
  Predicate.isTagged("ArgumentError")(error) &&
  Predicate.hasProperty(error, "message") &&
  Predicate.isString(error.message) &&
  legacyNotFoundMessages.has(error.message);

const isSome = Predicate.isTagged("Some");
const isNone = Predicate.isTagged("None");
const legacyPersistenceModelTags = new Set([
  "MessageCheckin",
  "MessageCheckinMember",
  "MessageRoomOrder",
  "MessageRoomOrderEntry",
  "MessageSlot",
  "MessageTeamSubmission",
  "UserPlatformConfig",
  "WorkspaceConfig",
  "WorkspaceConversationConfig",
  "WorkspaceFeatureFlag",
  "WorkspaceMonitorRole",
  "WorkspaceTeamSubmissionChannel",
  "WorkspaceUpdateAnnouncementDelivery",
]);
const isLegacyPersistenceModel = (value: object) =>
  Predicate.hasProperty(value, "_tag") &&
  Predicate.isString(value._tag) &&
  legacyPersistenceModelTags.has(value._tag);

const toOptional = (value: unknown): Option.Option<unknown> => {
  if (Option.isOption(value)) {
    return isSome(value) && Predicate.hasProperty(value, "value")
      ? Option.some(value.value)
      : Option.none();
  }
  if (isSome(value) && Predicate.hasProperty(value, "value")) {
    return Option.some(value.value);
  }
  return isNone(value) || Predicate.isNullish(value) ? Option.none() : Option.some(value);
};

const optionalLegacyResult = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map(toOptional),
    Effect.catchIf(isLegacyNotFoundError, () => Effect.succeed(Option.none<unknown>())),
  );

const toRawPersistenceValue = <Row>(value: unknown): Row => {
  if (isSome(value) && Predicate.hasProperty(value, "value")) {
    return toRawPersistenceValue<Row>(value.value);
  }
  if (isNone(value) || Option.isOption(value)) {
    return null as Row;
  }
  if (DateTime.isDateTime(value)) {
    return DateTime.toEpochMillis(value) as Row;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toRawPersistenceValue(item)) as Row;
  }
  if (Predicate.isObject(value)) {
    const unwrapTaggedModel = isLegacyPersistenceModel(value);
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "_tag" || !unwrapTaggedModel)
        .map(([key, item]) => [key, toRawPersistenceValue(item)]),
    ) as Row;
  }
  return value as Row;
};

const rawOptionalLegacyResult = <Row, A, E, R>(effect: Effect.Effect<A, E, R>) =>
  optionalLegacyResult(effect).pipe(
    Effect.map((value) =>
      Option.isSome(value)
        ? Option.some(toRawPersistenceValue<Row>(value.value))
        : Option.none<Row>(),
    ),
  );

const rawRows = <Row>(rows: ReadonlyArray<unknown>): ReadonlyArray<Row> =>
  rows.map((row) => toRawPersistenceValue<Row>(row));

const auditFields = () =>
  Clock.currentTimeMillis.pipe(
    Effect.map((timestamp) => ({ createdAt: timestamp, updatedAt: timestamp, deletedAt: null })),
  );

const presentOr = <Value, Fallback>(
  value: Value | null | undefined,
  fallback: Fallback,
): NonNullable<Value> | Fallback =>
  Option.fromNullishOr(value).pipe(Option.getOrElse(() => fallback));

const auditFieldDefaults = (value: {
  readonly createdAt?: number | null | undefined;
  readonly updatedAt?: number | null | undefined;
  readonly deletedAt?: number | null | undefined;
}) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((timestamp) => ({
      createdAt: presentOr(value.createdAt, timestamp),
      updatedAt: presentOr(value.updatedAt, timestamp),
      deletedAt: presentOr(value.deletedAt, null),
    })),
  );

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

/**
 * Adapts the pre-migration HTTP mocks to the trusted persistence port. This is
 * deliberately test-only: production composition always uses the PostgreSQL
 * Zero executor.
 */
export const makeTrustedSheetPersistenceMock = (
  sheetApisClient: typeof SheetApisClient.Service,
): TrustedSheetPersistenceShape => {
  const sheetApis = sheetApisClient.get() as unknown as WithoutEffectErrors<
    ReturnType<typeof sheetApisClient.get>
  >;
  const payload = <Args extends Readonly<Record<string, unknown>>>(args: Args) => ({
    payload: args,
  });
  const query = <Args extends Readonly<Record<string, unknown>>>(args: Args) => ({ query: args });
  const workspaceConfigs = new Map<string, ConfigWorkspaceRow>();
  const workspaceConversations = new Map<string, ConfigWorkspaceConversationRow>();
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
    confirmationMessageId: "confirmation-message-1",
    parsedSubmission: [],
    rowMappings: [],
    rollbackSnapshot: null,
    version: 1,
    status: "registered",
  } as const;
  let messageTeamSubmission: MessageTeamSubmissionRow | undefined;
  const getMessageTeamSubmissionState = Effect.gen(function* () {
    if (Predicate.isUndefined(messageTeamSubmission)) {
      messageTeamSubmission = {
        ...defaultMessageTeamSubmission,
        ...(yield* auditFields()),
      };
    }
    return messageTeamSubmission;
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
  const messageMemberKey = (
    clientPlatform: string,
    clientId: string,
    messageId: string,
    memberId: string,
  ) => `${messageKey(clientPlatform, clientId, messageId)}\u0000${memberId}`;
  const retainRoomOrderMutationResult = <A, E, R>(
    args: {
      readonly clientPlatform: string;
      readonly clientId: string;
      readonly messageId: string;
    },
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          const row = toRawPersistenceValue<MessageRoomOrderRow>(result);
          if (
            Predicate.isObject(row) &&
            Predicate.hasProperty(row, "clientPlatform") &&
            Predicate.hasProperty(row, "clientId") &&
            Predicate.hasProperty(row, "messageId")
          ) {
            messageRoomOrders.set(
              messageKey(args.clientPlatform, args.clientId, args.messageId),
              row,
            );
          }
        }),
      ),
      Effect.asVoid,
    );

  const persistence: TrustedSheetPersistenceMockShape = {
    workspaces: {
      getAutoCheckinWorkspaces: () =>
        sheetApis.workspaceConfig
          .getAutoCheckinWorkspaces()
          .pipe(Effect.map((rows) => rawRows<ConfigWorkspaceRow>(rows))),
      getWorkspaceConfigByWorkspaceId: ({ workspaceId }) =>
        Option.fromNullishOr(workspaceConfigs.get(workspaceId)).pipe(
          Option.match({
            onNone: () =>
              rawOptionalLegacyResult<ConfigWorkspaceRow, unknown, never, never>(
                sheetApis.workspaceConfig.getWorkspaceConfig(query({ workspaceId })),
              ),
            onSome: (row) => Effect.succeed(Option.some(row)),
          }),
        ),
      getWorkspaceMonitorRoles: ({ workspaceId }) =>
        sheetApis.workspaceConfig
          .getWorkspaceMonitorRoles(query({ workspaceId }))
          .pipe(Effect.map((rows) => rawRows<ConfigWorkspaceMonitorRoleRow>(rows))),
      getWorkspaceFeatureFlags: ({ workspaceId }) =>
        sheetApis.workspaceConfig.getWorkspaceFeatureFlags(query({ workspaceId })).pipe(
          Effect.map((rows) => {
            const persisted = rawRows<ConfigWorkspaceFeatureFlagRow>(rows).filter(
              (row) =>
                !removedWorkspaceFeatureFlags.has(
                  workspaceFeatureFlagKey(row.workspaceId, row.flagName),
                ),
            );
            const added = [...addedWorkspaceFeatureFlags.values()].filter(
              (row) =>
                row.workspaceId === workspaceId &&
                !persisted.some((existing) => existing.flagName === row.flagName),
            );
            return [...persisted, ...added];
          }),
        ),
      getWorkspacesForFeatureFlag: ({ flagName }) =>
        sheetApis.workspaceConfig
          .getWorkspacesForFeatureFlag(query({ flagName }))
          .pipe(Effect.map((rows) => rawRows<ConfigWorkspaceFeatureFlagRow>(rows))),
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
        return Predicate.isUndefined(row)
          ? rawOptionalLegacyResult<
              ConfigWorkspaceUpdateAnnouncementDeliveryRow,
              unknown,
              never,
              never
            >(
              sheetApis.workspaceConfig.getWorkspaceUpdateAnnouncementDelivery(
                query({ workspaceId, announcementId }),
              ),
            )
          : Effect.succeed(Option.some(row));
      },
      getWorkspaceConversations: (args) =>
        sheetApis.workspaceConfig
          .getWorkspaceConversations(query(args))
          .pipe(Effect.map((rows) => rawRows<ConfigWorkspaceConversationRow>(rows))),
      getWorkspaceConversationById: (args) => {
        const row = workspaceConversations.get(
          workspaceConversationKey(args.workspaceId, args.conversationId),
        );
        return Predicate.isUndefined(row)
          ? rawOptionalLegacyResult<ConfigWorkspaceConversationRow, unknown, never, never>(
              sheetApis.workspaceConfig.getWorkspaceConversationById(query(args)),
            ).pipe(
              Effect.flatMap((result) =>
                Option.isSome(result)
                  ? auditFieldDefaults(result.value).pipe(
                      Effect.map((fields) =>
                        Option.some({
                          ...result.value,
                          workspaceId: presentOr(result.value.workspaceId, args.workspaceId),
                          conversationId: presentOr(
                            result.value.conversationId,
                            args.conversationId,
                          ),
                          name: presentOr(result.value.name, null),
                          running: presentOr(result.value.running, null),
                          roleId: presentOr(result.value.roleId, null),
                          checkinConversationId: presentOr(
                            result.value.checkinConversationId,
                            null,
                          ),
                          ...fields,
                        }),
                      ),
                    )
                  : Effect.succeed(Option.none()),
              ),
            )
          : Effect.succeed(
              matchesRunningFilter(row, args.running) ? Option.some(row) : Option.none(),
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
            onNone: () =>
              rawOptionalLegacyResult<ConfigWorkspaceConversationRow, unknown, never, never>(
                sheetApis.workspaceConfig.getWorkspaceConversationByName(query(args)),
              ).pipe(
                Effect.flatMap((result) =>
                  Option.isSome(result)
                    ? auditFieldDefaults(result.value).pipe(
                        Effect.map((fields) =>
                          Option.some({
                            ...result.value,
                            workspaceId: presentOr(result.value.workspaceId, args.workspaceId),
                            name: presentOr(result.value.name, null),
                            running: presentOr(result.value.running, null),
                            roleId: presentOr(result.value.roleId, null),
                            checkinConversationId: presentOr(
                              result.value.checkinConversationId,
                              null,
                            ),
                            ...fields,
                          }),
                        ),
                      )
                    : Effect.succeed(Option.none()),
                ),
              ),
            onSome: (row) => Effect.succeed(Option.some(row)),
          }),
        ),
      getTeamSubmissionChannelByConversationId: (args) =>
        rawOptionalLegacyResult<ConfigWorkspaceTeamSubmissionChannelRow, unknown, never, never>(
          sheetApis.workspaceConfig.getTeamSubmissionChannelByConversationId(query(args)),
        ),
      getTeamSubmissionChannelsForWorkspace: (args) =>
        sheetApis.workspaceConfig
          .getTeamSubmissionChannelsForWorkspace(query(args))
          .pipe(Effect.map((rows) => rawRows<ConfigWorkspaceTeamSubmissionChannelRow>(rows))),
      upsertWorkspaceConfig: ({ workspaceId, ...config }) =>
        sheetApis.workspaceConfig.upsertWorkspaceConfig(payload({ workspaceId, config })).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              const existing = workspaceConfigs.get(workspaceId);
              workspaceConfigs.set(workspaceId, {
                workspaceId,
                sheetId: presentOr(config.sheetId, presentOr(existing?.sheetId, null)),
                autoCheckin: presentOr(config.autoCheckin, presentOr(existing?.autoCheckin, null)),
                monitorConversationId: presentOr(
                  config.monitorConversationId,
                  presentOr(existing?.monitorConversationId, null),
                ),
                ...(yield* auditFields()),
              });
            }),
          ),
          Effect.asVoid,
        ),
      addWorkspaceMonitorRole: (args) =>
        sheetApis.workspaceConfig.addWorkspaceMonitorRole(payload(args)).pipe(Effect.asVoid),
      removeWorkspaceMonitorRole: (args) =>
        sheetApis.workspaceConfig.removeWorkspaceMonitorRole(payload(args)).pipe(Effect.asVoid),
      addWorkspaceFeatureFlag: (args) =>
        sheetApis.workspaceConfig.addWorkspaceFeatureFlag(payload(args)).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              const key = workspaceFeatureFlagKey(args.workspaceId, args.flagName);
              removedWorkspaceFeatureFlags.delete(key);
              addedWorkspaceFeatureFlags.set(key, {
                ...args,
                ...(yield* auditFields()),
              });
            }),
          ),
          Effect.asVoid,
        ),
      removeWorkspaceFeatureFlag: (args) =>
        sheetApis.workspaceConfig.removeWorkspaceFeatureFlag(payload(args)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              const key = workspaceFeatureFlagKey(args.workspaceId, args.flagName);
              addedWorkspaceFeatureFlags.delete(key);
              removedWorkspaceFeatureFlags.add(key);
            }),
          ),
          Effect.asVoid,
        ),
      recordWorkspaceUpdateAnnouncementDelivery: ({ publishedAt, deliveredAt, ...args }) =>
        sheetApis.workspaceConfig
          .recordWorkspaceUpdateAnnouncementDelivery(
            payload({
              ...args,
              publishedAt: DateTime.makeUnsafe(publishedAt),
              deliveredAt: DateTime.makeUnsafe(deliveredAt),
            }),
          )
          .pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                const row =
                  toRawPersistenceValue<ConfigWorkspaceUpdateAnnouncementDeliveryRow>(result);
                workspaceUpdateAnnouncementDeliveries.set(
                  workspaceUpdateAnnouncementDeliveryKey(args.workspaceId, args.announcementId),
                  row,
                );
              }),
            ),
            Effect.asVoid,
          ),
      claimWorkspaceUpdateAnnouncementDelivery: ({ publishedAt, ...args }) =>
        sheetApis.workspaceConfig
          .claimWorkspaceUpdateAnnouncementDelivery(
            payload({ ...args, publishedAt: DateTime.makeUnsafe(publishedAt) }),
          )
          .pipe(
            Effect.tap((result) =>
              Effect.gen(function* () {
                if (
                  Predicate.hasProperty(result, "status") &&
                  result.status !== "already_delivered"
                ) {
                  const fields = yield* auditFields();
                  workspaceUpdateAnnouncementDeliveries.set(
                    workspaceUpdateAnnouncementDeliveryKey(args.workspaceId, args.announcementId),
                    {
                      workspaceId: args.workspaceId,
                      announcementId: args.announcementId,
                      publishedAt,
                      deliveredAt: fields.createdAt,
                      conversationId: updateAnnouncementDeliveryPendingConversationId,
                      messageId:
                        result.status === "claimed" ? args.claimToken : `${args.claimToken}-other`,
                      ...fields,
                    },
                  );
                } else if (Predicate.hasProperty(result, "delivery")) {
                  const row =
                    toRawPersistenceValue<ConfigWorkspaceUpdateAnnouncementDeliveryRow | null>(
                      result.delivery,
                    );
                  if (Predicate.isNotNull(row)) {
                    workspaceUpdateAnnouncementDeliveries.set(
                      workspaceUpdateAnnouncementDeliveryKey(args.workspaceId, args.announcementId),
                      row,
                    );
                  }
                }
              }),
            ),
            Effect.asVoid,
          ),
      releaseWorkspaceUpdateAnnouncementDeliveryClaim: (args) =>
        sheetApis.workspaceConfig
          .releaseWorkspaceUpdateAnnouncementDeliveryClaim(payload(args))
          .pipe(Effect.asVoid),
      upsertWorkspaceConversationConfig: ({ workspaceId, conversationId, ...config }) =>
        sheetApis.workspaceConfig
          .upsertWorkspaceConversationConfig(payload({ workspaceId, conversationId, config }))
          .pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                const key = workspaceConversationKey(workspaceId, conversationId);
                const existing = workspaceConversations.get(key);
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
                  ...(yield* auditFields()),
                });
              }),
            ),
            Effect.asVoid,
          ),
      upsertTeamSubmissionChannel: (args) =>
        sheetApis.workspaceConfig
          .upsertTeamSubmissionChannel(
            payload({
              workspaceId: args.workspaceId,
              conversationId: args.conversationId,
              config: {
                destinationTeamConfigName: args.destinationTeamConfigName,
                writeMode: args.writeMode,
                removedRowStrategy: args.removedRowStrategy,
                requireValidOshi: args.requireValidOshi,
              },
            }),
          )
          .pipe(Effect.asVoid),
      removeTeamSubmissionChannel: (args) =>
        sheetApis.workspaceConfig.removeTeamSubmissionChannel(payload(args)).pipe(Effect.asVoid),
    },
    preferences: {
      getUserPlatformConfig: (args) => {
        const row = userPlatformConfigs.get(userPlatformConfigKey(args.platform, args.userId));
        return Predicate.isUndefined(row)
          ? rawOptionalLegacyResult<ConfigUserPlatformRow, unknown, never, never>(
              sheetApis.userConfig.getUserPlatformConfig(payload(args)),
            )
          : Effect.succeed(Option.some(row));
      },
      getCheckinDmEnabledUserConfigs: (args) =>
        sheetApis.userConfig
          .getCheckinDmRecipients(payload(args))
          .pipe(Effect.map((rows) => rawRows<ConfigUserPlatformRow>(rows))),
      getMonitorDmEnabledUserConfigs: (args) =>
        sheetApis.userConfig
          .getMonitorDmRecipients(payload(args))
          .pipe(Effect.map((rows) => rawRows<ConfigUserPlatformRow>(rows))),
      upsertUserPlatformConfig: (args) =>
        sheetApis.userConfig.upsertUserPlatformConfig(payload(args)).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              const key = userPlatformConfigKey(args.platform, args.userId);
              const existing = userPlatformConfigs.get(key);
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
                ...(yield* auditFields()),
              });
            }),
          ),
          Effect.asVoid,
        ),
    },
    checkinState: {
      getMessageCheckinData: (args) => {
        const row = messageCheckins.get(
          messageKey(args.clientPlatform, args.clientId, args.messageId),
        );
        return Predicate.isUndefined(row)
          ? rawOptionalLegacyResult<MessageCheckinRow, unknown, never, never>(
              sheetApis.messageCheckin.getMessageCheckinData(query(args)),
            ).pipe(
              Effect.flatMap((result) =>
                Option.isSome(result)
                  ? auditFieldDefaults(result.value).pipe(
                      Effect.map((fields) =>
                        Option.some({
                          ...result.value,
                          ...args,
                          hour: presentOr(result.value.hour, 0),
                          roleId: presentOr(result.value.roleId, null),
                          workspaceId: presentOr(result.value.workspaceId, null),
                          conversationId: presentOr(result.value.conversationId, null),
                          createdByUserId: presentOr(result.value.createdByUserId, null),
                          ...fields,
                        }),
                      ),
                    )
                  : Effect.succeed(Option.none()),
              ),
            )
          : Effect.succeed(Option.some(row));
      },
      getMessageCheckinMembers: (args) =>
        sheetApis.messageCheckin.getMessageCheckinMembers(query(args)).pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rawRows<Partial<MessageCheckinMemberRow>>(rows), (row) =>
              auditFieldDefaults(row).pipe(
                Effect.map((fields) => ({
                  ...row,
                  ...args,
                  memberId: row.memberId ?? "",
                  checkinAt:
                    Predicate.isNull(row.checkinAt) || Predicate.isNumber(row.checkinAt)
                      ? row.checkinAt
                      : null,
                  ...fields,
                  checkinClaimId: row.checkinClaimId ?? null,
                })),
              ),
            ),
          ),
          Effect.map((persisted) => {
            return persisted.map((row) => {
              const key = messageMemberKey(
                row.clientPlatform,
                row.clientId,
                row.messageId,
                row.memberId,
              );
              const current = messageCheckinMembers.get(key) ?? row;
              messageCheckinMembers.set(key, current);
              return current;
            });
          }),
        ),
      persistMessageCheckin: (args) =>
        sheetApis.messageCheckin.persistMessageCheckin({ payload: args as never }).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              messageCheckins.set(
                messageKey(args.clientPlatform, args.clientId, args.messageId),
                toRawPersistenceValue<MessageCheckinRow>({
                  clientPlatform: args.clientPlatform,
                  clientId: args.clientId,
                  messageId: args.messageId,
                  ...args.data,
                  ...(yield* auditFields()),
                }),
              );
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
          ),
          Effect.asVoid,
        ),
      setMessageCheckinMemberCheckinAtIfUnset: (args) =>
        sheetApis.messageCheckin.setMessageCheckinMemberCheckinAtIfUnset(payload(args)).pipe(
          Effect.tap(() =>
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
                const timestamp = yield* Clock.currentTimeMillis;
                messageCheckinMembers.set(key, {
                  ...existing,
                  checkinAt: args.checkinAt,
                  checkinClaimId: args.checkinClaimId,
                  updatedAt: timestamp,
                });
              }
            }),
          ),
          Effect.asVoid,
        ),
      removeMessageCheckin: (args) =>
        sheetApis.messageCheckin.removeMessageCheckin(payload(args)).pipe(Effect.asVoid),
    },
    roomOrderState: {
      getMessageRoomOrder: (args) => {
        const key = messageKey(args.clientPlatform, args.clientId, args.messageId);
        const row = messageRoomOrders.get(key);
        return Predicate.isUndefined(row)
          ? rawOptionalLegacyResult<MessageRoomOrderRow, unknown, never, never>(
              sheetApis.messageRoomOrder.getMessageRoomOrder(query(args)),
            ).pipe(
              Effect.tap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: (fetched) =>
                    Effect.sync(() => {
                      messageRoomOrders.set(key, fetched);
                    }),
                }),
              ),
            )
          : Effect.succeed(Option.some(row));
      },
      getMessageRoomOrderEntry: (args) =>
        sheetApis.messageRoomOrder
          .getMessageRoomOrderEntry(query(args))
          .pipe(Effect.map((rows) => rawRows<MessageRoomOrderEntryRow>(rows))),
      getMessageRoomOrderRange: (args) =>
        sheetApis.messageRoomOrder.getMessageRoomOrderRange(query(args)).pipe(
          Effect.flatMap((range) =>
            Effect.gen(function* () {
              const value = (Option.isOption(range) ? Option.getOrUndefined(range) : range) as
                | { readonly minRank: number; readonly maxRank: number }
                | null
                | undefined;
              if (Predicate.isNullish(value)) return [];
              return yield* Effect.forEach([value.minRank, value.maxRank], (rank) =>
                auditFields().pipe(
                  Effect.map((fields) => ({
                    ...args,
                    rank,
                    position: 0,
                    hour: 0,
                    team: "",
                    tags: [],
                    effectValue: 0,
                    ...fields,
                  })),
                ),
              );
            }),
          ),
        ),
      decrementMessageRoomOrderRank: (args) =>
        retainRoomOrderMutationResult(
          args,
          sheetApis.messageRoomOrder.decrementMessageRoomOrderRank(payload(args)),
        ),
      incrementMessageRoomOrderRank: (args) =>
        retainRoomOrderMutationResult(
          args,
          sheetApis.messageRoomOrder.incrementMessageRoomOrderRank(payload(args)),
        ),
      claimMessageRoomOrderSend: (args) =>
        retainRoomOrderMutationResult(
          args,
          sheetApis.messageRoomOrder.claimMessageRoomOrderSend(payload(args)),
        ),
      completeMessageRoomOrderSend: ({ sentMessageId, sentConversationId, sentAt: _, ...args }) =>
        retainRoomOrderMutationResult(
          args,
          sheetApis.messageRoomOrder.completeMessageRoomOrderSend(
            payload({
              ...args,
              sentMessage: { id: sentMessageId, conversationId: sentConversationId },
            }),
          ),
        ),
      releaseMessageRoomOrderSendClaim: (args) =>
        sheetApis.messageRoomOrder
          .releaseMessageRoomOrderSendClaim(payload(args))
          .pipe(Effect.asVoid),
      claimMessageRoomOrderTentativeUpdate: (args) =>
        retainRoomOrderMutationResult(
          args,
          sheetApis.messageRoomOrder.claimMessageRoomOrderTentativeUpdate(payload(args)),
        ),
      releaseMessageRoomOrderTentativeUpdateClaim: (args) =>
        sheetApis.messageRoomOrder
          .releaseMessageRoomOrderTentativeUpdateClaim(payload(args))
          .pipe(Effect.asVoid),
      claimMessageRoomOrderTentativePin: (args) =>
        retainRoomOrderMutationResult(
          args,
          sheetApis.messageRoomOrder.claimMessageRoomOrderTentativePin(payload(args)),
        ),
      completeMessageRoomOrderTentativePin: ({ pinnedAt: _, ...args }) =>
        retainRoomOrderMutationResult(
          args,
          sheetApis.messageRoomOrder.completeMessageRoomOrderTentativePin(payload(args)),
        ),
      releaseMessageRoomOrderTentativePinClaim: (args) =>
        sheetApis.messageRoomOrder
          .releaseMessageRoomOrderTentativePinClaim(payload(args))
          .pipe(Effect.asVoid),
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
          yield* retainRoomOrderMutationResult(
            args,
            sheetApis.messageRoomOrder.markMessageRoomOrderTentative(
              payload({ ...args, workspaceId, conversationId }),
            ),
          );
        }),
      persistMessageRoomOrder: (args) =>
        sheetApis.messageRoomOrder.persistMessageRoomOrder(payload(args)).pipe(Effect.asVoid),
    },
    slotState: {
      getMessageSlotData: (args) => {
        const row = messageSlots.get(
          messageKey(args.clientPlatform, args.clientId, args.messageId),
        );
        return Predicate.isUndefined(row)
          ? rawOptionalLegacyResult<MessageSlotRow, unknown, never, never>(
              sheetApis.messageSlot.getMessageSlotData(query(args)),
            ).pipe(
              Effect.flatMap((result) =>
                Option.isSome(result)
                  ? auditFieldDefaults(result.value).pipe(
                      Effect.map((fields) =>
                        Option.some({
                          ...result.value,
                          ...args,
                          workspaceId: presentOr(result.value.workspaceId, null),
                          conversationId: presentOr(result.value.conversationId, null),
                          createdByUserId: presentOr(result.value.createdByUserId, null),
                          ...fields,
                        }),
                      ),
                    )
                  : Effect.succeed(Option.none()),
              ),
            )
          : Effect.succeed(Option.some(row));
      },
      upsertMessageSlotData: ({ clientPlatform, clientId, messageId, ...data }) =>
        sheetApis.messageSlot
          .upsertMessageSlotData(payload({ clientPlatform, clientId, messageId, data }))
          .pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                messageSlots.set(messageKey(clientPlatform, clientId, messageId), {
                  clientPlatform,
                  clientId,
                  messageId,
                  ...data,
                  ...(yield* auditFields()),
                });
              }),
            ),
            Effect.asVoid,
          ),
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
          const previousSubmission = currentSubmission;
          const timestamp = yield* Clock.currentTimeMillis;
          const nextSubmission: MessageTeamSubmissionRow = {
            ...submission,
            confirmationMessageId: presentOr(submission.confirmationMessageId, null),
            rollbackSnapshot: presentOr(submission.rollbackSnapshot, null),
            version: presentOr(existing?.version, 0) + 1,
            createdAt: presentOr(existing?.createdAt, timestamp),
            updatedAt: timestamp,
            deletedAt: null,
          };
          messageTeamSubmission = nextSubmission;
          if (args.status === "confirmed") {
            yield* sheetApis.teamSubmission
              .confirmFromDiscord({
                payload: {
                  client: { platform: args.clientPlatform, clientId: args.clientId },
                  workspaceId: args.workspaceId,
                  conversationId: args.conversationId,
                  messageId: args.messageId,
                  confirmationMessageId: presentOr(
                    args.confirmationMessageId,
                    "confirmation-message-1",
                  ),
                  requesterUserId: args.discordAuthorId,
                },
              })
              .pipe(
                Effect.onError(() =>
                  Effect.sync(() => {
                    messageTeamSubmission = previousSubmission;
                  }),
                ),
              );
          }
        }),
      setMessageTeamSubmissionConfirmation: (args) =>
        Effect.gen(function* () {
          const submission = yield* getMessageTeamSubmissionState;
          if (!hasMessageTeamSubmissionKey(submission, args)) return;
          yield* sheetApis.teamSubmission.setConfirmationMessage({ payload: args });
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
