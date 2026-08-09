import { Context, DateTime, Effect, Layer, Match, Option, Predicate } from "effect";
import { Data } from "effect";
import type { EffectivePrincipal } from "sheet-auth/identity";
import type { BotCollectionCursor } from "sheet-bot-api";
import {
  type DataAcquisitionDeclaredFailure,
  type DiscordLoadProfileSuccess,
  type DiscordLoadWorkspaceChannelsSuccess,
  type DiscordLoadWorkspaceRolesSuccess,
  type NotificationsLoadSupportedClientsSuccess,
  type SchedulesLoadWorkspaceSuccess,
  type WorkspaceCapabilities,
  type WorkspaceId,
} from "sheet-workflow-contracts";
import { config } from "@/config";
import { SheetApisClient } from "@/services/sheetApisClient";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { ReadOnlyWorkflowAuthorization } from "./authorization";

class ReadOnlyWorkflowDataSourceError extends Data.TaggedError("ReadOnlyWorkflowDataSourceError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type ReadResult<A> = Effect.Effect<
  A,
  DataAcquisitionDeclaredFailure | ReadOnlyWorkflowDataSourceError
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

export const readOnlyWorkflowDataSourceLayer = Layer.effect(
  ReadOnlyWorkflowDataSource,
  Effect.gen(function* () {
    const bot = yield* SheetBotCacheClient;
    const sheetApis = yield* SheetApisClient;
    const authorization = yield* ReadOnlyWorkflowAuthorization;
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
      Effect.all(
        {
          eventConfig: sheetApis.get().sheet.getEventConfig({ query: { workspaceId } }),
          scheduleResponse: sheetApis
            .get()
            .sheet.getAllSchedules({ query: { workspaceId, view: "monitor" } }),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(({ eventConfig, scheduleResponse }) => ({
          eventConfig: { startTimeEpochMs: DateTime.toEpochMillis(eventConfig.startTime) },
          populatedSchedules: scheduleResponse.schedules.map((schedule) =>
            Match.valueTags(schedule, {
              BreakSchedule: (value) => ({
                conversationName: value.channel,
                day: value.day,
                visible: value.visible,
                hour: Option.getOrNull(value.hour),
                playerNames: [],
                monitorName: null,
              }),
              Schedule: (value) => ({
                conversationName: value.channel,
                day: value.day,
                visible: value.visible,
                hour: Option.getOrNull(value.hour),
                playerNames: [
                  ...value.fills.flatMap(
                    Option.match({ onNone: () => [], onSome: (fill) => [fill.player] }),
                  ),
                  ...value.overfills.map(({ player }) => player),
                  ...value.standbys.map(({ player }) => player),
                  ...value.runners.map(({ player }) => player),
                ],
                monitorName: Option.getOrNull(value.monitor),
              }),
            }),
          ),
        })),
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

    return {
      loadProfile,
      loadSupportedClients,
      loadWorkspaceCapabilities,
      loadWorkspaceChannels,
      loadWorkspaceRoles,
      loadWorkspaceSchedules,
    };
  }),
);
