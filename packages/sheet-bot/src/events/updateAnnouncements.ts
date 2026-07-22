import { DiscordGateway } from "dfx/gateway";
import { Duration, Effect, Layer, Predicate, Schedule, Schema } from "effect";
import type {
  UpdateAnnouncement,
  UpdateAnnouncementDispatchPayload,
} from "sheet-ingress-api/dispatch";
import { config } from "../config";
import { discordGatewayLayer } from "../discord/gateway";
import {
  SheetWorkflowsClient,
  SheetWorkflowsRequestContext,
  type SheetWorkflowsServicesStatus,
} from "../services";
import * as Data from "effect/Data";

class SheetBotEventsUpdateAnnouncementsError extends Data.TaggedError(
  "SheetBotEventsUpdateAnnouncementsError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const GuildCreateEvent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  joined_at: Schema.String,
  unavailable: Schema.optional(Schema.Boolean),
  system_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
});

type GuildCreateEvent = typeof GuildCreateEvent.Type;

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
] as const satisfies ReadonlyArray<UpdateAnnouncement>;

export const makeUpdateAnnouncementDispatchPayloads = (
  guild: GuildCreateEvent,
  announcements: ReadonlyArray<UpdateAnnouncement> = updateAnnouncements,
  clientId = "discord-main",
): ReadonlyArray<UpdateAnnouncementDispatchPayload> => {
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
      client: { platform: "discord", clientId },
      dispatchRequestId: `discord-update-announcement:${guild.id}:${announcement.id}`,
      workspaceId: guild.id,
      workspaceName: guild.name,
      joinedAt: guild.joined_at,
      ...(Predicate.isString(guild.system_channel_id)
        ? { systemConversationId: guild.system_channel_id }
        : {}),
      announcement,
    }));
};

export const areUpdateAnnouncementServicesHealthy = (
  status: SheetWorkflowsServicesStatus,
): boolean =>
  status.overallStatus === "ok" && status.services.every((service) => service.status === "ok");

const waitForUpdateAnnouncementServices = Effect.fn("waitForUpdateAnnouncementServices")(function* (
  sheetWorkflowsClient: typeof SheetWorkflowsClient.Service,
) {
  const status = yield* sheetWorkflowsClient.getServicesStatus();
  if (areUpdateAnnouncementServicesHealthy(status)) {
    return status;
  }

  const downServices = status.services
    .filter((service) => service.status !== "ok")
    .map((service) => service.name)
    .join(", ");
  return yield* new SheetBotEventsUpdateAnnouncementsError({
    message: `Update announcement dependencies are not healthy: ${downServices}`,
  });
});

const updateAnnouncementDispatchRetrySchedule = Schedule.spaced(Duration.seconds(5)).pipe(
  Schedule.take(12),
);

export const updateAnnouncementsEventLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* DiscordGateway;
    const sheetWorkflowsClient = yield* SheetWorkflowsClient;
    const clientId = yield* config.sheetBotClientId;
    const waitForHealthyServices = yield* Effect.cached(
      waitForUpdateAnnouncementServices(sheetWorkflowsClient).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Waiting to dispatch update announcements until services are healthy", {
            error: String(error),
          }),
        ),
        Effect.retry({
          schedule: Schedule.spaced(Duration.seconds(5)),
        }),
      ),
    );

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

          const payloads = makeUpdateAnnouncementDispatchPayloads(
            decodedGuild,
            updateAnnouncements,
            clientId,
          );
          if (payloads.length === 0) {
            return;
          }

          yield* waitForHealthyServices;

          yield* Effect.forEach(
            payloads,
            (payload) =>
              SheetWorkflowsRequestContext.asService(() =>
                sheetWorkflowsClient.get().dispatch.updateAnnouncement({ payload }),
              )().pipe(
                Effect.retry(updateAnnouncementDispatchRetrySchedule),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Failed to dispatch update announcement").pipe(
                    Effect.annotateLogs({
                      workspaceId: payload.workspaceId,
                      workspaceName: payload.workspaceName,
                      announcementId: payload.announcement.id,
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
).pipe(Layer.provide(Layer.mergeAll(discordGatewayLayer, SheetWorkflowsClient.layer)));
