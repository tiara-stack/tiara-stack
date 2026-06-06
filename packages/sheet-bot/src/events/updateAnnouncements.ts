import { DiscordGateway } from "dfx/gateway";
import { Effect, Layer, Schema } from "effect";
import type {
  UpdateAnnouncement,
  UpdateAnnouncementDispatchPayload,
} from "sheet-ingress-api/handlers/dispatch/schema";
import { discordGatewayLayer } from "../discord/gateway";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";

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
] as const satisfies ReadonlyArray<UpdateAnnouncement>;

export const makeUpdateAnnouncementDispatchPayloads = (
  guild: GuildCreateEvent,
  announcements: ReadonlyArray<UpdateAnnouncement> = updateAnnouncements,
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
      dispatchRequestId: `discord-update-announcement:${guild.id}:${announcement.id}`,
      guildId: guild.id,
      guildName: guild.name,
      joinedAt: guild.joined_at,
      ...(typeof guild.system_channel_id === "string"
        ? { systemChannelId: guild.system_channel_id }
        : {}),
      announcement,
    }));
};

export const updateAnnouncementsEventLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* DiscordGateway;
    const sheetWorkflowsClient = yield* SheetWorkflowsClient;

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

          const payloads = makeUpdateAnnouncementDispatchPayloads(decodedGuild);
          if (payloads.length === 0) {
            return;
          }

          yield* Effect.forEach(
            payloads,
            (payload) =>
              SheetWorkflowsRequestContext.asService(() =>
                sheetWorkflowsClient.get().dispatch.updateAnnouncement({ payload }),
              )().pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Failed to dispatch update announcement").pipe(
                    Effect.annotateLogs({
                      guildId: payload.guildId,
                      guildName: payload.guildName,
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
