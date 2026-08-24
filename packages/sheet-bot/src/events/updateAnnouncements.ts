import { DiscordGateway } from "dfx/gateway";
import { Duration, Effect, Layer, Predicate, Schedule, Schema } from "effect";
import { workflowWorkspaceIdFromString } from "sheet-workflow-http-client";
import { config } from "../config";
import { discordGatewayLayer } from "../discord/gateway";
import {
  enqueueAnnouncementsDeliverUpdateWorkflow,
  SheetWorkflowHttpClient,
  type AnnouncementsDeliverUpdateInput,
} from "../services";
import { makeDeterministicWorkflowInvocationId } from "../utils/workflowInvocationId";

const GuildCreateEvent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  joined_at: Schema.String,
  unavailable: Schema.optional(Schema.Boolean),
  system_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
});

type GuildCreateEvent = typeof GuildCreateEvent.Type;

interface UpdateAnnouncementSource {
  readonly id: string;
  readonly publishedAt: string;
  readonly title: string;
  readonly description: string;
  readonly color?: number;
}

export const updateAnnouncements = [
  {
    id: "update-announcements-2026-06-05",
    publishedAt: "2026-06-04T17:00:00.000Z",
    title: "Update announcements",
    description:
      "This server can now receive occasional bot update announcements here. Announcements are sent once per server and only for updates published after the bot joined.",
    color: 0x5865f2,
  },
  {
    id: "auth-update-2026-06-12",
    publishedAt: "2026-06-12T02:30:00.000Z",
    title: "Sign-in and access update",
    description:
      "Hi! Tiara has an update to sign-in and service access. You can keep signing in with Discord like before, and developers can now create and manage OAuth clients from the dashboard for their own Sheet integrations. The dashboard and bot also use the same OAuth-based access behind the scenes now, which should make access more reliable and easier to build on. If anything feels off, signing out and back in should refresh your access.",
    color: 0x57f287,
  },
  {
    id: "team-submission-confirmations-2026-07-08",
    publishedAt: "2026-07-08T00:00:00.000Z",
    title: "Team submission confirmations",
    description:
      "Team submission channels require the team-submission-confirmations workspace feature flag. When enabled, Tiara writes submissions with the reaction, progress embed, and submitter-owned confirm/reject flow; without it, messages are ignored.",
    color: 0x57f287,
  },
] as const satisfies ReadonlyArray<UpdateAnnouncementSource>;

export const makeUpdateAnnouncementWorkflowRequests = (
  guild: GuildCreateEvent,
  announcements: ReadonlyArray<UpdateAnnouncementSource> = updateAnnouncements,
  clientId = "discord-main",
) => {
  if (guild.unavailable === true) {
    return [];
  }

  const joinedAtEpochMs = Date.parse(guild.joined_at);
  if (Number.isNaN(joinedAtEpochMs)) {
    return [];
  }

  return announcements
    .filter((announcement) => {
      const publishedAtEpochMs = Date.parse(announcement.publishedAt);
      return !Number.isNaN(publishedAtEpochMs) && publishedAtEpochMs > joinedAtEpochMs;
    })
    .map((announcement) => ({
      input: {
        workspaceId: workflowWorkspaceIdFromString(guild.id),
        workspaceName: guild.name,
        joinedAt: new Date(joinedAtEpochMs),
        ...(Predicate.isString(guild.system_channel_id)
          ? { systemConversationId: guild.system_channel_id }
          : {}),
        announcement: {
          ...announcement,
          publishedAt: new Date(announcement.publishedAt),
        },
      } satisfies AnnouncementsDeliverUpdateInput,
      invocationId: makeDeterministicWorkflowInvocationId([
        "discord-update-announcement",
        clientId,
        guild.id,
        announcement.id,
      ]),
    }));
};

const updateAnnouncementDispatchRetrySchedule = Schedule.spaced(Duration.seconds(5)).pipe(
  Schedule.take(12),
);

export const updateAnnouncementsEventLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* DiscordGateway;
    const workflowClient = yield* SheetWorkflowHttpClient;
    const clientId = yield* config.sheetBotClientId;

    yield* gateway
      .handleDispatch("GUILD_CREATE", (guild) => {
        return Effect.gen(function* () {
          const decodedGuild = yield* Schema.decodeUnknownEffect(GuildCreateEvent)(guild).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Skipping invalid update announcement guild create payload").pipe(
                Effect.andThen(Effect.logDebug(cause)),
                Effect.as(null),
              ),
            ),
          );
          if (decodedGuild === null) {
            return;
          }

          const requests = makeUpdateAnnouncementWorkflowRequests(
            decodedGuild,
            updateAnnouncements,
            clientId,
          );
          if (requests.length === 0) {
            return;
          }

          yield* Effect.forEach(
            requests,
            (request) =>
              enqueueAnnouncementsDeliverUpdateWorkflow(workflowClient, request.input, {
                invocationId: request.invocationId,
              }).pipe(
                Effect.retry(updateAnnouncementDispatchRetrySchedule),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Failed to enqueue update announcement workflow").pipe(
                    Effect.annotateLogs({
                      workspaceId: request.input.workspaceId,
                      workspaceName: request.input.workspaceName,
                      announcementId: request.input.announcement.id,
                      invocationId: request.invocationId,
                    }),
                    Effect.andThen(Effect.logDebug(cause)),
                  ),
                ),
              ),
            { discard: true },
          );
        });
      })
      .pipe(Effect.forkScoped);
  }),
).pipe(Layer.provide(Layer.mergeAll(discordGatewayLayer, SheetWorkflowHttpClient.layer)));
