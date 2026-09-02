import { Context, Data, Effect, Layer, Match, Option, Predicate, Schema } from "effect";
import type { EffectivePrincipal } from "sheet-auth/identity";
import type { BotCollectionCursor } from "sheet-bot-api";
import { WebSheetConfiguration } from "sheet-domain";
import {
  SheetSnapshotDeclaredFailure,
  type DataAcquisitionDeclaredFailure,
  type DiscordLoadProfileSuccess,
  type DiscordLoadWorkspaceChannelsSuccess,
  type DiscordLoadWorkspaceRolesSuccess,
  type NotificationsLoadSupportedClientsSuccess,
  type SchedulesLoadWorkspaceSuccess,
  type SheetsDescribeSuccess,
  type SheetsReadSnapshotInput,
  type SheetsReadSnapshotSuccess,
  type SheetsDescribeInput,
  SpreadsheetId,
  type WorkspaceCapabilities,
  type WorkspaceId,
} from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { config } from "@/config";
import { SheetDataProvider } from "@/services/sheetDataProvider";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { ReadOnlyWorkflowAuthorization } from "./authorization";
import {
  SheetSnapshotProvider,
  SheetSnapshotProviderCode,
  SheetSnapshotProviderError,
} from "./sheetSnapshotProvider";

class ReadOnlyWorkflowDataSourceError extends Data.TaggedError("ReadOnlyWorkflowDataSourceError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

const isReadOnlyWorkflowDataSourceError = (
  error: unknown,
): error is ReadOnlyWorkflowDataSourceError =>
  Predicate.isTagged("ReadOnlyWorkflowDataSourceError")(error) &&
  Predicate.hasProperty(error, "operation") &&
  Predicate.isString(error.operation) &&
  Predicate.hasProperty(error, "cause");

type ReadResult<A> = Effect.Effect<
  A,
  DataAcquisitionDeclaredFailure | ReadOnlyWorkflowDataSourceError
>;

type SnapshotReadResult<A> = Effect.Effect<
  A,
  SheetSnapshotDeclaredFailure | ReadOnlyWorkflowDataSourceError
>;

interface ReadOnlyWorkflowDataSourceShape {
  readonly loadProfile: (principal: EffectivePrincipal) => ReadResult<DiscordLoadProfileSuccess>;
  readonly loadWorkspaceChannels: (
    workspaceId: WorkspaceId,
  ) => ReadResult<DiscordLoadWorkspaceChannelsSuccess>;
  readonly loadWorkspaceRoles: (
    workspaceId: WorkspaceId,
  ) => ReadResult<DiscordLoadWorkspaceRolesSuccess>;
  readonly loadWorkspaceCapabilities: (
    principal: EffectivePrincipal,
    workspaceId: WorkspaceId,
  ) => ReadResult<WorkspaceCapabilities>;
  readonly loadWorkspaceSchedules: (
    workspaceId: WorkspaceId,
  ) => ReadResult<SchedulesLoadWorkspaceSuccess>;
  readonly loadSupportedClients: (
    platform: string,
  ) => ReadResult<NotificationsLoadSupportedClientsSuccess>;
  readonly describeSheets: (
    input: SheetsDescribeInput,
  ) => SnapshotReadResult<SheetsDescribeSuccess>;
  readonly readSheetSnapshot: (
    input: SheetsReadSnapshotInput,
  ) => SnapshotReadResult<SheetsReadSnapshotSuccess>;
}

export class ReadOnlyWorkflowDataSource extends Context.Service<
  ReadOnlyWorkflowDataSource,
  ReadOnlyWorkflowDataSourceShape
>()("sheet-workflows/ReadOnlyWorkflowDataSource") {}

const maximumWorkspaceConversationPages = 100;

const authorizationRevoked = (policy: string): DataAcquisitionDeclaredFailure => ({
  _tag: "AuthorizationRevoked",
  policy,
});

const mapBotDeclaredFailure = (operation: string) => (error: unknown) =>
  Match.value(error).pipe(
    Match.when(Predicate.isTagged("BotResourceNotFound"), () => ({
      _tag: "ResourceNotFound" as const,
      resource: operation,
    })),
    Match.when(Predicate.isTagged("BotRequestRejected"), () => ({
      _tag: "ExternalOperationRejected" as const,
      operation,
      code: "Rejected",
      message: `${operation} was rejected`,
    })),
    Match.when(
      Predicate.or(
        Predicate.isTagged("BotUnauthenticated"),
        Predicate.isTagged("BotAdmissionDenied"),
      ),
      () => authorizationRevoked(`sheet.workflow.${operation}.invoke`),
    ),
    Match.orElse(() => new ReadOnlyWorkflowDataSourceError({ operation, cause: error })),
  );

const isSheetSnapshotProviderError = (error: unknown): error is SheetSnapshotProviderError =>
  Predicate.isTagged("SheetSnapshotProviderError")(error) &&
  Predicate.hasProperty(error, "code") &&
  Schema.is(SheetSnapshotProviderCode)(error.code);

const mapSnapshotFailure = (
  error: unknown,
): SheetSnapshotDeclaredFailure | ReadOnlyWorkflowDataSourceError => {
  if (Schema.is(SheetSnapshotDeclaredFailure)(error)) return error;
  if (isReadOnlyWorkflowDataSourceError(error)) return error;
  if (!isSheetSnapshotProviderError(error)) {
    return new ReadOnlyWorkflowDataSourceError({ operation: "sheets.snapshot", cause: error });
  }
  const providerError = error;
  return Match.value(providerError.code).pipe(
    Match.when("SheetMissing", () => ({
      _tag: "ResourceNotFound" as const,
      resource: "sheet",
    })),
    Match.when("UnsupportedSheetType", () => ({
      _tag: "InvalidRequest" as const,
      code: "UnsupportedSheetType",
      message: "Only Google Sheets GRID tabs can be previewed.",
    })),
    Match.when("WindowOutOfBounds", () => ({
      _tag: "InvalidRequest" as const,
      code: "WindowOutOfBounds",
      message: "The requested snapshot window is outside the selected tab.",
    })),
    Match.when("SnapshotTooLarge", () => ({
      _tag: "InvalidRequest" as const,
      code: "SnapshotTooLarge",
      message: "The selected snapshot is too large. Choose a smaller window.",
    })),
    Match.orElse((code: SheetSnapshotProviderCode) => ({
      _tag: "ExternalOperationRejected" as const,
      operation: "sheets.snapshot",
      code,
      message: "Google Sheets rejected the snapshot request.",
    })),
  );
};

export const readOnlyWorkflowDataSourceLayer = Layer.effect(
  ReadOnlyWorkflowDataSource,
  Effect.gen(function* () {
    const bot = yield* SheetBotCacheClient;
    const dataProvider = yield* SheetDataProvider;
    const snapshotProvider = yield* SheetSnapshotProvider;
    const authorization = yield* ReadOnlyWorkflowAuthorization;
    const persistence = yield* TrustedSheetPersistence;
    const clientId = yield* config.sheetBotClientId;
    const client = { platform: "discord", clientId } as const;

    const loadProfile: ReadOnlyWorkflowDataSourceShape["loadProfile"] = (principal) => {
      if (principal.kind !== "user" || Predicate.isUndefined(principal.discordAccount)) {
        return Effect.fail(authorizationRevoked("sheet.workflow.discord.loadProfile.invoke"));
      }
      return bot
        .get()
        .cache.getUserProfile({
          params: { ...client, userId: principal.discordAccount.accountId },
        })
        .pipe(
          Effect.map(({ user, workspaces }) => ({ user, guilds: workspaces })),
          Effect.mapError(mapBotDeclaredFailure("discord.loadProfile")),
        );
    };

    const loadWorkspaceChannels: ReadOnlyWorkflowDataSourceShape["loadWorkspaceChannels"] = (
      workspaceId,
    ) =>
      Effect.gen(function* () {
        const items = [] as Array<DiscordLoadWorkspaceChannelsSuccess[number]>;
        let cursor: BotCollectionCursor | undefined;
        let pageCount = 0;
        while (pageCount < maximumWorkspaceConversationPages) {
          const currentCursor = cursor;
          const page = yield* bot.get().cache.listConversations({
            params: { ...client, workspaceId },
            query: { limit: 100, ...(Predicate.isUndefined(cursor) ? {} : { cursor }) },
          });
          pageCount += 1;
          for (const conversation of page.items) {
            if (Predicate.isUndefined(conversation.name)) continue;
            items.push({
              id: conversation.id,
              name: conversation.name,
              type: conversation.type,
              parentId: null,
              position: conversation.position ?? 0,
            });
          }
          if (Predicate.isUndefined(page.nextCursor) || page.nextCursor === currentCursor) {
            break;
          }
          cursor = page.nextCursor;
        }
        return items;
      }).pipe(Effect.mapError(mapBotDeclaredFailure("discord.loadWorkspaceChannels")));

    const loadWorkspaceRoles: ReadOnlyWorkflowDataSourceShape["loadWorkspaceRoles"] = (
      workspaceId,
    ) =>
      bot
        .get()
        .cache.listRoles({ params: { ...client, workspaceId } })
        .pipe(
          Effect.map((roles) =>
            roles.map(({ id, name, position, color, managed }) => ({
              id,
              name,
              position,
              color,
              managed,
            })),
          ),
          Effect.mapError(mapBotDeclaredFailure("discord.loadWorkspaceRoles")),
        );

    const loadWorkspaceCapabilities: ReadOnlyWorkflowDataSourceShape["loadWorkspaceCapabilities"] =
      (principal, workspaceId) =>
        authorization.workspaceCapabilities(principal, workspaceId).pipe(
          Effect.map((snapshot) => ({
            workspaceId,
            capabilities: [
              ...(snapshot.member ? (["member"] as const) : []),
              ...(snapshot.monitor ? (["monitor"] as const) : []),
              ...(snapshot.manage ? (["manage"] as const) : []),
              ...(snapshot.participant ? (["participant"] as const) : []),
              ...(snapshot.appOwner ? (["app_owner"] as const) : []),
            ],
          })),
          Effect.mapError(mapBotDeclaredFailure("authorization.loadWorkspaceCapabilities")),
        );

    const loadWorkspaceSchedules: ReadOnlyWorkflowDataSourceShape["loadWorkspaceSchedules"] = (
      workspaceId,
    ) =>
      dataProvider.loadWorkspaceSchedules(workspaceId).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("schedules.loadWorkspace rejected").pipe(
            Effect.annotateLogs({ error, workspaceId }),
          ),
        ),
        Effect.mapError(() => ({
          _tag: "ExternalOperationRejected" as const,
          operation: "schedules.loadWorkspace",
          code: "ProviderRejected",
          message: "Schedule provider rejected the read",
        })),
      );

    const loadSupportedClients: ReadOnlyWorkflowDataSourceShape["loadSupportedClients"] = (
      platform,
    ) =>
      platform === "discord"
        ? bot
            .get()
            .cache.getApplication({ params: client })
            .pipe(
              Effect.as([{ platform, clientId }]),
              Effect.mapError(mapBotDeclaredFailure("notifications.loadSupportedClients")),
            )
        : Effect.succeed([]);

    const resolveSpreadsheetId = (workspaceId: WorkspaceId) => {
      return dataProvider.resolveSpreadsheetId(workspaceId).pipe(
        Effect.mapError(
          (cause) => new ReadOnlyWorkflowDataSourceError({ operation: "sheets.snapshot", cause }),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail<SheetSnapshotDeclaredFailure>({
                _tag: "ConfigurationMissing",
                configuration: "spreadsheet",
              }),
            onSome: Effect.succeed,
          }),
        ),
      );
    };

    const resolveSnapshotSpreadsheetId = (
      workspaceId: WorkspaceId,
      candidateSpreadsheetId: typeof SpreadsheetId.Type | undefined,
    ) => {
      const configurationPersistence = persistence.sheetConfiguration;
      const candidateNotBound = Effect.fail<SheetSnapshotDeclaredFailure>({
        _tag: "ConfigurationMissing",
        configuration: "spreadsheet",
      });
      // A candidate is valid only when it is the same authoritative spreadsheet bound to the workspace.
      const matchCandidate = (spreadsheetId: typeof SpreadsheetId.Type) =>
        Predicate.isUndefined(candidateSpreadsheetId)
          ? Effect.succeed(spreadsheetId)
          : spreadsheetId === candidateSpreadsheetId
            ? Effect.succeed(spreadsheetId)
            : candidateNotBound;
      const resolveAuthoritativeCandidate = () =>
        resolveSpreadsheetId(workspaceId).pipe(Effect.flatMap(matchCandidate));
      if (Predicate.isUndefined(configurationPersistence)) return resolveAuthoritativeCandidate();
      return configurationPersistence.getSheetConfiguration({ workspaceId }).pipe(
        Effect.mapError(
          (cause) =>
            new ReadOnlyWorkflowDataSourceError({
              operation: "sheets.snapshot",
              cause,
            }),
        ),
        Effect.flatMap(
          Option.match({
            onNone: resolveAuthoritativeCandidate,
            onSome: (row) => {
              if (Predicate.isUndefined(candidateSpreadsheetId)) {
                return resolveAuthoritativeCandidate();
              }
              if (Predicate.isNullish(row.draft)) {
                return resolveAuthoritativeCandidate();
              }
              return Schema.decodeUnknownEffect(WebSheetConfiguration)(row.draft).pipe(
                Effect.flatMap(({ spreadsheetId }) =>
                  Schema.decodeUnknownEffect(SpreadsheetId)(spreadsheetId),
                ),
                // A malformed draft must not take down the read-only preview. The active
                // authoritative binding remains the safe fallback until the draft is repaired.
                Effect.flatMap(matchCandidate),
                Effect.catch(() => resolveAuthoritativeCandidate()),
              );
            },
          }),
        ),
      );
    };

    const describeSheets: ReadOnlyWorkflowDataSourceShape["describeSheets"] = (input) =>
      resolveSnapshotSpreadsheetId(input.workspaceId, input.spreadsheetId).pipe(
        Effect.flatMap((spreadsheetId) =>
          snapshotProvider.describe(spreadsheetId, input.readPolicy),
        ),
        Effect.map((result) => ({ ...result, workspaceId: input.workspaceId })),
        Effect.mapError(mapSnapshotFailure),
      );

    const readSheetSnapshot: ReadOnlyWorkflowDataSourceShape["readSheetSnapshot"] = (input) =>
      resolveSnapshotSpreadsheetId(input.workspaceId, input.spreadsheetId).pipe(
        Effect.flatMap((spreadsheetId) =>
          snapshotProvider.readSnapshot(
            spreadsheetId,
            input.sheetId,
            input.window,
            input.readPolicy,
          ),
        ),
        Effect.map((result) => ({ ...result, workspaceId: input.workspaceId })),
        Effect.mapError(mapSnapshotFailure),
      );

    return {
      loadProfile,
      loadSupportedClients,
      loadWorkspaceCapabilities,
      loadWorkspaceChannels,
      loadWorkspaceRoles,
      loadWorkspaceSchedules,
      describeSheets,
      readSheetSnapshot,
    };
  }),
);
