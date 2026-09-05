import type { HumanReadable, MutateRequest, QueryOrQueryRequest } from "@rocicorp/zero";
import { addContextToQuery } from "@rocicorp/zero/bindings";
import { zeroDrizzle, type DrizzleDatabase } from "@rocicorp/zero/server/adapters/drizzle";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import postgres from "postgres";
import { schema, type Schema as SheetZeroSchema } from "sheet-zero-api";
import { makeSheetServiceClient, type SheetServiceClient } from "sheet-zero-api/server";
import type {
  ConfigUserPlatformRow,
  ConfigWorkspaceCheckinMessageMutationReceiptRow,
  ConfigWorkspaceCheckinMessageRow,
  ConfigWorkspaceCheckinMessageSetRow,
  ConfigWorkspaceConversationRow,
  ConfigWorkspaceFeatureFlagRow,
  ConfigWorkspaceMonitorRoleRow,
  ConfigWorkspaceRow,
  ConfigWorkspaceSheetImportAttemptRow,
  ConfigWorkspaceSheetRevisionRow,
  ConfigWorkspaceSheetRow,
  ConfigWorkspaceTeamSubmissionChannelRow,
  ConfigWorkspaceUpdateAnnouncementDeliveryRow,
  MessageCheckinMemberRow,
  MessageCheckinRow,
  MessageRoomOrderEntryRow,
  MessageRoomOrderRow,
  MessageTeamSubmissionRow,
} from "sheet-zero-api/rows";
import { ZeroClient } from "typhoon-zero/client";

export const MessageSlotRow = Schema.Struct({
  clientPlatform: Schema.String,
  clientId: Schema.String,
  messageId: Schema.String,
  day: Schema.Number,
  workspaceId: Schema.String,
  conversationId: Schema.String,
  createdByUserId: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  deletedAt: Schema.NullOr(Schema.Number),
});
export type MessageSlotRow = typeof MessageSlotRow.Type;

type GroupedSheetClient = SheetServiceClient["grouped"];

type ClientMethod<
  Group extends keyof GroupedSheetClient,
  Method extends keyof GroupedSheetClient[Group],
> = GroupedSheetClient[Group][Method];

type ClientMethodWithSuccess<
  Group extends keyof GroupedSheetClient,
  Method extends keyof GroupedSheetClient[Group],
  Success,
> =
  ClientMethod<Group, Method> extends (
    ...args: infer Args
  ) => Effect.Effect<any, infer Error, infer Requirements>
    ? (...args: Args) => Effect.Effect<Success, Error, Requirements>
    : never;

type ClientMutation<
  Group extends keyof GroupedSheetClient,
  Method extends keyof GroupedSheetClient[Group],
> = ClientMethodWithSuccess<Group, Method, void>;

type PersistenceGroup<Group extends keyof TrustedSheetPersistenceShape> = NonNullable<
  TrustedSheetPersistenceShape[Group]
>;

export interface TrustedSheetPersistenceShape {
  readonly workspaces: {
    readonly getAutoCheckinWorkspaces: ClientMethodWithSuccess<
      "workspaceConfig",
      "getAutoCheckinWorkspaces",
      ReadonlyArray<ConfigWorkspaceRow>
    >;
    readonly getWorkspaceConfigByWorkspaceId: ClientMethodWithSuccess<
      "workspaceConfig",
      "getWorkspaceConfigByWorkspaceId",
      Option.Option<ConfigWorkspaceRow>
    >;
    readonly getWorkspaceMonitorRoles: ClientMethodWithSuccess<
      "workspaceConfig",
      "getWorkspaceMonitorRoles",
      ReadonlyArray<ConfigWorkspaceMonitorRoleRow>
    >;
    readonly getWorkspaceFeatureFlags: ClientMethodWithSuccess<
      "workspaceConfig",
      "getWorkspaceFeatureFlags",
      ReadonlyArray<ConfigWorkspaceFeatureFlagRow>
    >;
    readonly getWorkspacesForFeatureFlag: ClientMethodWithSuccess<
      "workspaceConfig",
      "getWorkspacesForFeatureFlag",
      ReadonlyArray<ConfigWorkspaceFeatureFlagRow>
    >;
    readonly getWorkspaceFeatureFlag: ClientMethodWithSuccess<
      "workspaceConfig",
      "getWorkspaceFeatureFlag",
      Option.Option<ConfigWorkspaceFeatureFlagRow>
    >;
    readonly getWorkspaceUpdateAnnouncementDelivery: ClientMethodWithSuccess<
      "workspaceConfig",
      "getWorkspaceUpdateAnnouncementDelivery",
      Option.Option<ConfigWorkspaceUpdateAnnouncementDeliveryRow>
    >;
    readonly getWorkspaceConversations: ClientMethodWithSuccess<
      "workspaceConfig",
      "getWorkspaceConversations",
      ReadonlyArray<ConfigWorkspaceConversationRow>
    >;
    readonly getWorkspaceConversationById: ClientMethodWithSuccess<
      "workspaceConfig",
      "getWorkspaceConversationById",
      Option.Option<ConfigWorkspaceConversationRow>
    >;
    readonly getWorkspaceConversationByName: ClientMethodWithSuccess<
      "workspaceConfig",
      "getWorkspaceConversationByName",
      Option.Option<ConfigWorkspaceConversationRow>
    >;
    readonly getTeamSubmissionChannelByConversationId: ClientMethodWithSuccess<
      "workspaceConfig",
      "getTeamSubmissionChannelByConversationId",
      Option.Option<ConfigWorkspaceTeamSubmissionChannelRow>
    >;
    readonly getTeamSubmissionChannelsForWorkspace: ClientMethodWithSuccess<
      "workspaceConfig",
      "getTeamSubmissionChannelsForWorkspace",
      ReadonlyArray<ConfigWorkspaceTeamSubmissionChannelRow>
    >;
    readonly upsertWorkspaceConfig: ClientMutation<"workspaceConfig", "upsertWorkspaceConfig">;
    readonly addWorkspaceMonitorRole: ClientMutation<"workspaceConfig", "addWorkspaceMonitorRole">;
    readonly removeWorkspaceMonitorRole: ClientMutation<
      "workspaceConfig",
      "removeWorkspaceMonitorRole"
    >;
    readonly addWorkspaceFeatureFlag: ClientMutation<"workspaceConfig", "addWorkspaceFeatureFlag">;
    readonly removeWorkspaceFeatureFlag: ClientMutation<
      "workspaceConfig",
      "removeWorkspaceFeatureFlag"
    >;
    readonly recordWorkspaceUpdateAnnouncementDelivery: ClientMutation<
      "workspaceConfig",
      "recordWorkspaceUpdateAnnouncementDelivery"
    >;
    readonly claimWorkspaceUpdateAnnouncementDelivery: ClientMutation<
      "workspaceConfig",
      "claimWorkspaceUpdateAnnouncementDelivery"
    >;
    readonly releaseWorkspaceUpdateAnnouncementDeliveryClaim: ClientMutation<
      "workspaceConfig",
      "releaseWorkspaceUpdateAnnouncementDeliveryClaim"
    >;
    readonly upsertWorkspaceConversationConfig: ClientMutation<
      "workspaceConfig",
      "upsertWorkspaceConversationConfig"
    >;
    readonly upsertTeamSubmissionChannel: ClientMutation<
      "workspaceConfig",
      "upsertTeamSubmissionChannel"
    >;
    readonly removeTeamSubmissionChannel: ClientMutation<
      "workspaceConfig",
      "removeTeamSubmissionChannel"
    >;
  };
  /** Configuration persistence resolves the authoritative sheet-backed source. */
  readonly sheetConfiguration: {
    readonly getSheetConfiguration: ClientMethodWithSuccess<
      "sheetConfiguration",
      "getSheetConfiguration",
      Option.Option<ConfigWorkspaceSheetRow>
    >;
    readonly getSheetConfigurationRevisions: ClientMethodWithSuccess<
      "sheetConfiguration",
      "getSheetConfigurationRevisions",
      ReadonlyArray<ConfigWorkspaceSheetRevisionRow>
    >;
    readonly getSheetConfigurationRevisionById: ClientMethodWithSuccess<
      "sheetConfiguration",
      "getSheetConfigurationRevisionById",
      Option.Option<ConfigWorkspaceSheetRevisionRow>
    >;
    readonly getSheetConfigurationRevisionsBySpreadsheetId: ClientMethodWithSuccess<
      "sheetConfiguration",
      "getSheetConfigurationRevisionsBySpreadsheetId",
      ReadonlyArray<ConfigWorkspaceSheetRevisionRow>
    >;
    readonly getSheetConfigurationImportAttempt: ClientMethodWithSuccess<
      "sheetConfiguration",
      "getSheetConfigurationImportAttempt",
      Option.Option<ConfigWorkspaceSheetImportAttemptRow>
    >;
    readonly upsertSheetConfigurationDraft: ClientMutation<
      "sheetConfiguration",
      "upsertSheetConfigurationDraft"
    >;
    readonly saveSheetConfigurationRevision: ClientMutation<
      "sheetConfiguration",
      "saveSheetConfigurationRevision"
    >;
    readonly activateSheetConfigurationRevision: ClientMutation<
      "sheetConfiguration",
      "activateSheetConfigurationRevision"
    >;
    readonly rollbackSheetConfiguration: ClientMutation<
      "sheetConfiguration",
      "rollbackSheetConfiguration"
    >;
    readonly discardSheetConfigurationDraft: ClientMutation<
      "sheetConfiguration",
      "discardSheetConfigurationDraft"
    >;
    readonly upsertSheetConfigurationImportAttempt: ClientMutation<
      "sheetConfiguration",
      "upsertSheetConfigurationImportAttempt"
    >;
    readonly recordSheetConfigurationAudit: ClientMutation<
      "sheetConfiguration",
      "recordSheetConfigurationAudit"
    >;
  };
  /** Operational hourly check-in message configuration, isolated from Sheet Configuration. */
  readonly checkinMessages: {
    readonly getMessageSet: ClientMethodWithSuccess<
      "checkinMessages",
      "getMessageSet",
      Option.Option<ConfigWorkspaceCheckinMessageSetRow>
    >;
    readonly getHourlyMessage: ClientMethodWithSuccess<
      "checkinMessages",
      "getHourlyMessage",
      Option.Option<ConfigWorkspaceCheckinMessageRow>
    >;
    readonly listHourlyMessages: ClientMethodWithSuccess<
      "checkinMessages",
      "listHourlyMessages",
      ReadonlyArray<ConfigWorkspaceCheckinMessageRow>
    >;
    readonly getSaveReceipt: ClientMethodWithSuccess<
      "checkinMessages",
      "getSaveReceipt",
      Option.Option<ConfigWorkspaceCheckinMessageMutationReceiptRow>
    >;
    readonly reconcileMessageSet: ClientMutation<"checkinMessages", "reconcileMessageSet">;
    readonly saveHourlyMessage: ClientMutation<"checkinMessages", "saveHourlyMessage">;
  };
  readonly preferences: {
    readonly getUserPlatformConfig: ClientMethodWithSuccess<
      "userConfig",
      "getUserPlatformConfig",
      Option.Option<ConfigUserPlatformRow>
    >;
    readonly getCheckinDmEnabledUserConfigs: ClientMethodWithSuccess<
      "userConfig",
      "getCheckinDmEnabledUserConfigs",
      ReadonlyArray<ConfigUserPlatformRow>
    >;
    readonly getMonitorDmEnabledUserConfigs: ClientMethodWithSuccess<
      "userConfig",
      "getMonitorDmEnabledUserConfigs",
      ReadonlyArray<ConfigUserPlatformRow>
    >;
    readonly upsertUserPlatformConfig: ClientMutation<"userConfig", "upsertUserPlatformConfig">;
  };
  readonly checkinState: {
    readonly getMessageCheckinData: ClientMethodWithSuccess<
      "messageCheckin",
      "getMessageCheckinData",
      Option.Option<MessageCheckinRow>
    >;
    readonly getMessageCheckinMembers: ClientMethodWithSuccess<
      "messageCheckin",
      "getMessageCheckinMembers",
      ReadonlyArray<MessageCheckinMemberRow>
    >;
    readonly persistMessageCheckin: ClientMutation<"messageCheckin", "persistMessageCheckin">;
    readonly setMessageCheckinMemberCheckinAtIfUnset: ClientMutation<
      "messageCheckin",
      "setMessageCheckinMemberCheckinAtIfUnset"
    >;
    readonly removeMessageCheckin: ClientMutation<"messageCheckin", "removeMessageCheckin">;
  };
  readonly roomOrderState: {
    readonly getMessageRoomOrder: ClientMethodWithSuccess<
      "messageRoomOrder",
      "getMessageRoomOrder",
      Option.Option<MessageRoomOrderRow>
    >;
    readonly getMessageRoomOrderEntry: ClientMethodWithSuccess<
      "messageRoomOrder",
      "getMessageRoomOrderEntry",
      ReadonlyArray<MessageRoomOrderEntryRow>
    >;
    readonly getMessageRoomOrderRange: ClientMethodWithSuccess<
      "messageRoomOrder",
      "getMessageRoomOrderRange",
      ReadonlyArray<MessageRoomOrderEntryRow>
    >;
    readonly decrementMessageRoomOrderRank: ClientMutation<
      "messageRoomOrder",
      "decrementMessageRoomOrderRank"
    >;
    readonly incrementMessageRoomOrderRank: ClientMutation<
      "messageRoomOrder",
      "incrementMessageRoomOrderRank"
    >;
    readonly claimMessageRoomOrderSend: ClientMutation<
      "messageRoomOrder",
      "claimMessageRoomOrderSend"
    >;
    readonly completeMessageRoomOrderSend: ClientMutation<
      "messageRoomOrder",
      "completeMessageRoomOrderSend"
    >;
    readonly releaseMessageRoomOrderSendClaim: ClientMutation<
      "messageRoomOrder",
      "releaseMessageRoomOrderSendClaim"
    >;
    readonly claimMessageRoomOrderTentativeUpdate: ClientMutation<
      "messageRoomOrder",
      "claimMessageRoomOrderTentativeUpdate"
    >;
    readonly releaseMessageRoomOrderTentativeUpdateClaim: ClientMutation<
      "messageRoomOrder",
      "releaseMessageRoomOrderTentativeUpdateClaim"
    >;
    readonly claimMessageRoomOrderTentativePin: ClientMutation<
      "messageRoomOrder",
      "claimMessageRoomOrderTentativePin"
    >;
    readonly completeMessageRoomOrderTentativePin: ClientMutation<
      "messageRoomOrder",
      "completeMessageRoomOrderTentativePin"
    >;
    readonly releaseMessageRoomOrderTentativePinClaim: ClientMutation<
      "messageRoomOrder",
      "releaseMessageRoomOrderTentativePinClaim"
    >;
    readonly markMessageRoomOrderTentative: ClientMutation<
      "messageRoomOrder",
      "markMessageRoomOrderTentative"
    >;
    readonly persistMessageRoomOrder: ClientMutation<"messageRoomOrder", "persistMessageRoomOrder">;
    readonly bindMessageRoomOrderIfAbsent: ClientMutation<
      "messageRoomOrder",
      "bindMessageRoomOrderIfAbsent"
    >;
  };
  readonly slotState: {
    readonly getMessageSlotData: ClientMethodWithSuccess<
      "messageSlot",
      "getMessageSlotData",
      Option.Option<MessageSlotRow>
    >;
    readonly getMessageSlotDataByConversation: ClientMethodWithSuccess<
      "messageSlot",
      "getMessageSlotDataByConversation",
      Option.Option<MessageSlotRow>
    >;
    readonly upsertMessageSlotData: ClientMutation<"messageSlot", "upsertMessageSlotData">;
  };
  readonly teamSubmissionState: {
    readonly getMessageTeamSubmission: ClientMethodWithSuccess<
      "messageTeamSubmission",
      "getMessageTeamSubmission",
      Option.Option<MessageTeamSubmissionRow>
    >;
    readonly getMessageTeamSubmissionByDiscordMessage: ClientMethodWithSuccess<
      "messageTeamSubmission",
      "getMessageTeamSubmissionByDiscordMessage",
      Option.Option<MessageTeamSubmissionRow>
    >;
    readonly upsertMessageTeamSubmission: ClientMutation<
      "messageTeamSubmission",
      "upsertMessageTeamSubmission"
    >;
    readonly setMessageTeamSubmissionConfirmation: ClientMutation<
      "messageTeamSubmission",
      "setMessageTeamSubmissionConfirmation"
    >;
  };
}

export const trustedSheetPersistenceCatalog = {
  workspaces: [
    "getAutoCheckinWorkspaces",
    "getWorkspaceConfigByWorkspaceId",
    "getWorkspaceMonitorRoles",
    "getWorkspaceFeatureFlags",
    "getWorkspacesForFeatureFlag",
    "getWorkspaceFeatureFlag",
    "getWorkspaceUpdateAnnouncementDelivery",
    "getWorkspaceConversations",
    "getWorkspaceConversationById",
    "getWorkspaceConversationByName",
    "getTeamSubmissionChannelByConversationId",
    "getTeamSubmissionChannelsForWorkspace",
    "upsertWorkspaceConfig",
    "addWorkspaceMonitorRole",
    "removeWorkspaceMonitorRole",
    "addWorkspaceFeatureFlag",
    "removeWorkspaceFeatureFlag",
    "recordWorkspaceUpdateAnnouncementDelivery",
    "claimWorkspaceUpdateAnnouncementDelivery",
    "releaseWorkspaceUpdateAnnouncementDeliveryClaim",
    "upsertWorkspaceConversationConfig",
    "upsertTeamSubmissionChannel",
    "removeTeamSubmissionChannel",
  ],
  sheetConfiguration: [
    "getSheetConfiguration",
    "getSheetConfigurationRevisions",
    "getSheetConfigurationRevisionById",
    "getSheetConfigurationRevisionsBySpreadsheetId",
    "getSheetConfigurationImportAttempt",
    "upsertSheetConfigurationDraft",
    "saveSheetConfigurationRevision",
    "activateSheetConfigurationRevision",
    "rollbackSheetConfiguration",
    "discardSheetConfigurationDraft",
    "upsertSheetConfigurationImportAttempt",
    "recordSheetConfigurationAudit",
  ],
  checkinMessages: [
    "getMessageSet",
    "getHourlyMessage",
    "listHourlyMessages",
    "getSaveReceipt",
    "reconcileMessageSet",
    "saveHourlyMessage",
  ],
  preferences: [
    "getUserPlatformConfig",
    "getCheckinDmEnabledUserConfigs",
    "getMonitorDmEnabledUserConfigs",
    "upsertUserPlatformConfig",
  ],
  checkinState: [
    "getMessageCheckinData",
    "getMessageCheckinMembers",
    "persistMessageCheckin",
    "setMessageCheckinMemberCheckinAtIfUnset",
    "removeMessageCheckin",
  ],
  roomOrderState: [
    "getMessageRoomOrder",
    "getMessageRoomOrderEntry",
    "getMessageRoomOrderRange",
    "decrementMessageRoomOrderRank",
    "incrementMessageRoomOrderRank",
    "claimMessageRoomOrderSend",
    "completeMessageRoomOrderSend",
    "releaseMessageRoomOrderSendClaim",
    "claimMessageRoomOrderTentativeUpdate",
    "releaseMessageRoomOrderTentativeUpdateClaim",
    "claimMessageRoomOrderTentativePin",
    "completeMessageRoomOrderTentativePin",
    "releaseMessageRoomOrderTentativePinClaim",
    "markMessageRoomOrderTentative",
    "persistMessageRoomOrder",
    "bindMessageRoomOrderIfAbsent",
  ],
  slotState: ["getMessageSlotData", "getMessageSlotDataByConversation", "upsertMessageSlotData"],
  teamSubmissionState: [
    "getMessageTeamSubmission",
    "getMessageTeamSubmissionByDiscordMessage",
    "upsertMessageTeamSubmission",
    "setMessageTeamSubmissionConfirmation",
  ],
} as const satisfies {
  readonly [Group in keyof TrustedSheetPersistenceShape]: ReadonlyArray<
    keyof PersistenceGroup<Group>
  >;
};

type MissingCatalogEntries = {
  readonly [Group in keyof TrustedSheetPersistenceShape]: Exclude<
    keyof PersistenceGroup<Group>,
    (typeof trustedSheetPersistenceCatalog)[Group][number]
  >;
};
type AssertCatalogIsExhaustive<
  _Entries extends { readonly [Group in keyof MissingCatalogEntries]: never },
> = true;
type _CatalogIsExhaustive = AssertCatalogIsExhaustive<MissingCatalogEntries>;

type TrustedClientGroup<Group extends keyof TrustedSheetPersistenceShape> = {
  readonly [Method in (typeof trustedSheetPersistenceCatalog)[Group][number]]: unknown;
};

type ClientGroupByPersistenceGroup = {
  readonly [Group in keyof TrustedSheetPersistenceShape]: (
    client: GroupedSheetClient,
  ) => TrustedClientGroup<Group>;
};

const clientGroupByPersistenceGroup = {
  workspaces: (client: GroupedSheetClient) => client.workspaceConfig,
  sheetConfiguration: (client: GroupedSheetClient) => client.sheetConfiguration,
  checkinMessages: (client: GroupedSheetClient) => client.checkinMessages,
  preferences: (client: GroupedSheetClient) => client.userConfig,
  checkinState: (client: GroupedSheetClient) => client.messageCheckin,
  roomOrderState: (client: GroupedSheetClient) => client.messageRoomOrder,
  slotState: (client: GroupedSheetClient) => client.messageSlot,
  teamSubmissionState: (client: GroupedSheetClient) => client.messageTeamSubmission,
} as const satisfies ClientGroupByPersistenceGroup;

const persistenceGroups = Object.keys(clientGroupByPersistenceGroup) as ReadonlyArray<
  keyof TrustedSheetPersistenceShape
>;

const makeTrustedGroup = <Group extends keyof TrustedSheetPersistenceShape>(
  group: Group,
  client: GroupedSheetClient,
): TrustedSheetPersistenceShape[Group] => {
  const selectClientGroup = clientGroupByPersistenceGroup[
    group
  ] as ClientGroupByPersistenceGroup[Group];
  if (selectClientGroup === undefined) {
    throw new Error(`No trusted persistence client group registered for ${String(group)}`);
  }
  const source = selectClientGroup(client);
  const methods = trustedSheetPersistenceCatalog[group] as unknown as ReadonlyArray<
    keyof TrustedClientGroup<Group>
  >;
  return Object.fromEntries(
    methods.map((method) => [method, source[method]]),
  ) as TrustedSheetPersistenceShape[Group];
};

const makeTrustedView = (client: GroupedSheetClient): TrustedSheetPersistenceShape =>
  Object.fromEntries(
    persistenceGroups.map((group) => [group, makeTrustedGroup(group, client)]),
  ) as unknown as TrustedSheetPersistenceShape;

export class TrustedSheetPersistence extends Context.Service<
  TrustedSheetPersistence,
  TrustedSheetPersistenceShape
>()("sheet-zero-server/TrustedSheetPersistence") {}

export const makeTrustedSheetPersistence = <ClientContext>(
  executor: ZeroClient.ZeroClientExecutor<SheetZeroSchema, ClientContext>,
): Effect.Effect<TrustedSheetPersistenceShape> =>
  makeSheetServiceClient(executor).pipe(Effect.map((client) => makeTrustedView(client.grouped)));

export const makeTrustedSheetPersistenceLayer = <ClientContext>(
  executor: ZeroClient.ZeroClientExecutor<SheetZeroSchema, ClientContext>,
) => Layer.effect(TrustedSheetPersistence, makeTrustedSheetPersistence(executor));

export interface PostgresTrustedSheetPersistenceOptions<ClientContext> {
  readonly url: Redacted.Redacted<string>;
  readonly context: ClientContext;
  readonly applicationName?: string | undefined;
  readonly maxConnections?: number | undefined;
  readonly statementTimeoutMillis?: number | undefined;
}

const executorError = (operation: string) => (cause: unknown) =>
  ZeroClient.makeExecutorError(
    operation,
    `Sheet PostgreSQL executor failed to ${operation}`,
    cause,
  );

const retryableTransactionFailureCodes = new Set(["40001", "40P01"]);
const isRetryableTransactionFailure = (cause: unknown) =>
  Predicate.hasProperty(cause, "code") &&
  Predicate.isString(cause.code) &&
  retryableTransactionFailureCodes.has(cause.code);

const makePostgresExecutor = <ClientContext>({
  applicationName = "sheet-zero-server",
  context,
  maxConnections = 10,
  statementTimeoutMillis = 30_000,
  url,
}: PostgresTrustedSheetPersistenceOptions<ClientContext>): Effect.Effect<
  ZeroClient.ZeroClientExecutor<SheetZeroSchema, ClientContext>,
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const postgresClient = yield* Effect.acquireRelease(
      Effect.sync(() =>
        postgres(Redacted.value(url), {
          connection: {
            application_name: applicationName,
          },
          max: maxConnections,
        }),
      ),
      (client) =>
        Effect.tryPromise({
          try: () => client.end({ timeout: 5 }),
          catch: executorError("close PostgreSQL client"),
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to close trusted sheet persistence PostgreSQL client", error),
          ),
        ),
    );
    const drizzleDatabase = drizzle(postgresClient);
    const database = zeroDrizzle(schema, {
      transaction: (transaction) =>
        drizzleDatabase.transaction(
          async (drizzleTransaction) => {
            await drizzleTransaction.execute(
              drizzleSql`select set_config('statement_timeout', ${`${statementTimeoutMillis}ms`}, true)`,
            );
            return transaction(drizzleTransaction as unknown as Parameters<typeof transaction>[0]);
          },
          { isolationLevel: "serializable" },
        ),
    } as DrizzleDatabase);
    const resolveQuery = <Return>(
      request: QueryOrQueryRequest<any, any, any, SheetZeroSchema, Return, ClientContext>,
    ) => addContextToQuery(request, context);
    const runQuery = <Return>(
      request: QueryOrQueryRequest<any, any, any, SheetZeroSchema, Return, ClientContext>,
    ) =>
      Effect.tryPromise({
        try: async () => (await database.run(resolveQuery(request))) as HumanReadable<Return>,
        catch: (cause) => cause,
      }).pipe(
        Effect.retry({
          times: 2,
          while: isRetryableTransactionFailure,
          schedule: Schedule.exponential("10 millis").pipe(Schedule.jittered),
        }),
        Effect.mapError(executorError("run query")),
      );

    return {
      run: runQuery,
      stream: <Return>(
        request: QueryOrQueryRequest<any, any, any, SheetZeroSchema, Return, ClientContext>,
      ) => Stream.fromEffect(runQuery(request)),
      mutate: (request: MutateRequest<any, SheetZeroSchema, ClientContext, any>) =>
        Effect.succeed({
          client: () => Effect.void,
          server: () =>
            Effect.tryPromise({
              try: () =>
                database.transaction((transaction) =>
                  request.mutator.fn({ args: request.args, ctx: context, tx: transaction }),
                ),
              catch: (cause) => cause,
            }).pipe(
              Effect.retry({
                times: 2,
                while: isRetryableTransactionFailure,
                schedule: Schedule.exponential("10 millis").pipe(Schedule.jittered),
              }),
              Effect.mapError(executorError("run mutation")),
              Effect.asVoid,
            ),
        }),
    } satisfies ZeroClient.ZeroClientExecutor<SheetZeroSchema, ClientContext>;
  });

/**
 * Production PostgreSQL composition for the policy-filtered trusted view.
 * The underlying executor remains private so runtimes cannot bypass the reviewed catalog.
 */
export const makePostgresTrustedSheetPersistenceLayer = <ClientContext>(
  options: PostgresTrustedSheetPersistenceOptions<ClientContext>,
) =>
  Layer.effect(TrustedSheetPersistence)(
    makePostgresExecutor(options).pipe(Effect.flatMap(makeTrustedSheetPersistence)),
  );
