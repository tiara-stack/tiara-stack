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

const defaultSheetWebBaseUrl = new URL("https://schedule.theerapakg.moe");

const makeSheetWebDocumentationUrl = (sheetWebBaseUrl: URL, path: string) => {
  const baseUrl = new URL(sheetWebBaseUrl);
  if (!baseUrl.pathname.endsWith("/")) {
    baseUrl.pathname += "/";
  }

  return new URL(path, baseUrl).href;
};

export const makeUpdateAnnouncements = (sheetWebBaseUrl: URL = defaultSheetWebBaseUrl) =>
  [
    {
      id: "update-announcements-2026-06-05",
      publishedAt: "2026-06-04T17:00:00.000Z",
      title: "TiaraBot update announcements",
      description:
        "TiaraBot can now share occasional product updates in this server. Each update is sent once to the server's system channel when available, otherwise #general or the first sendable text channel. Updates are only sent for releases published after TiaraBot joined and never use mass mentions. Read the TiaraDocs guide for details: https://schedule.theerapakg.moe/docs/tiarabot/monitors/update-announcements",
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
        "Team submission channels require the team-submission-confirmations workspace feature flag. When enabled, Tiara previews submissions with the reaction, progress embed, and submitter-owned confirm/reject flow, then writes only after Confirm; without it, messages are ignored.",
      color: 0x57f287,
    },
    {
      id: "web-sheet-configuration-2026-09-01",
      publishedAt: "2026-09-01T07:09:33.000Z",
      title: "Web Sheet Configuration editor",
      description: `Server managers and monitors can now manage TiaraBot's sheet mappings from Dashboard → Server settings → Sheet mappings. Import the legacy Settings tab into a draft, type or drag tab-qualified A1 ranges on the read-only grid, review changed fields and fresh samples, then activate a versioned revision when it is ready. The current source stays live until activation, and earlier web revisions or the retained legacy source can be restored. Read the TiaraDocs guide: ${makeSheetWebDocumentationUrl(sheetWebBaseUrl, "docs/sheetweb/sheet-configuration")}`,
      color: 0x33ccbb,
    },
    {
      id: "sheetweb-dashboard-navigation-2026-09-04",
      publishedAt: "2026-09-04T00:00:00.000Z",
      title: "SheetWeb dashboard navigation",
      description: `SheetWeb's dashboard navigation is now organized around your current server. Use the named server chooser or the server rail to switch servers, SCHEDULE for schedule navigation, and SERVER SETTINGS for server administration. Sheet mappings are grouped with server administration, while personal notification settings live under Settings. Read the TiaraDocs guide: ${makeSheetWebDocumentationUrl(sheetWebBaseUrl, "docs/sheetweb/navigation")}`,
      color: 0x33ccbb,
    },
    {
      id: "sticky-slot-buttons-2026-09-05",
      publishedAt: "2026-09-05T00:00:00.000Z",
      title: "Sticky slot buttons",
      description: `The /slot button now stays easy to reach in its configured channel. TiaraBot reposts it after each new human message to keep it at or near the bottom, while each press still refreshes the current open slots. Read the TiaraDocs guide: ${makeSheetWebDocumentationUrl(sheetWebBaseUrl, "docs/tiarabot/monitors/post-schedule")}`,
      color: 0x33ccbb,
    },
    {
      id: "team-submission-deferred-writes-2026-09-05",
      publishedAt: "2026-09-05T03:24:04.000Z",
      title: "Team submission writes now wait for confirmation",
      description:
        "TiaraBot now previews team submissions and waits for the original submitter to press Confirm before writing to the sheet. Press Reject to discard a pending plan without changing the sheet.",
      color: 0x57f287,
    },
    {
      id: "remove-sticky-slot-buttons-2026-09-05",
      publishedAt: "2026-09-05T04:00:00.000Z",
      title: "Remove sticky slot buttons",
      description:
        "Monitors can now run /slot remove in a channel to delete its Open slots button and stop it from reposting. Run /slot button again when the channel needs the button back.",
      color: 0x33ccbb,
    },
  ] as const satisfies ReadonlyArray<UpdateAnnouncementSource>;

export const updateAnnouncements = makeUpdateAnnouncements();

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
    const sheetWebBaseUrl = yield* config.sheetWebBaseUrl;
    const announcements = makeUpdateAnnouncements(sheetWebBaseUrl);

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
            announcements,
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
