import { subtext, userMention } from "@discordjs/formatters";
import { Array, DateTime, Effect, Layer, Option, Schedule, Cron, pipe } from "effect";
import { DiscordREST } from "dfx";
import { checkinButtonData } from "../messageComponents/buttons/checkin";
import { DiscordGatewayLayerLive } from "dfx-discord-utils/discord";
import {
  CheckinService,
  ConverterService,
  EmbedService,
  GuildConfigService,
  MessageCheckinService,
  SheetApisRequestContext,
} from "../services";
import { ActionRowBuilder } from "dfx-discord-utils/utils";

const autoCheckinNotice = "Sent automatically via auto check-in.";

const formatCheckinContent = (content: string): string =>
  [content, subtext(autoCheckinNotice)].join("\n");

const processChannel = Effect.fn("processChannel")(function* (
  guildId: string,
  hour: number,
  channelName: string,
) {
  const generated = yield* CheckinService.generate({
    guildId,
    channelName,
    hour,
  });

  const discordRest = yield* DiscordREST;

  yield* pipe(
    generated.initialMessage,
    Option.fromNullable,
    Option.match({
      onNone: () => Effect.succeed(undefined),
      onSome: (initialMessage) =>
        pipe(
          discordRest.createMessage(generated.checkinChannelId, {
            content: formatCheckinContent(initialMessage),
            components: [new ActionRowBuilder().addComponent(checkinButtonData).toJSON()],
          }),
          Effect.flatMap((messageResult) =>
            Effect.all([
              MessageCheckinService.upsertMessageCheckinData(messageResult.id, {
                initialMessage: formatCheckinContent(initialMessage),
                hour: generated.hour,
                channelId: generated.runningChannelId,
                roleId: generated.roleId,
                guildId,
                messageChannelId: generated.checkinChannelId,
                createdByUserId: null,
              }),
              generated.fillIds.length > 0
                ? MessageCheckinService.addMessageCheckinMembers(
                    messageResult.id,
                    generated.fillIds,
                  )
                : Effect.succeed(undefined),
            ]),
          ),
        ),
    }),
  );

  const embedDescriptionParts = [
    generated.monitorCheckinMessage,
    ...pipe(
      generated.monitorFailureMessage,
      Option.fromNullable,
      Option.match({
        onSome: (failure) => [subtext(failure)],
        onNone: () => [],
      }),
    ),
    subtext(autoCheckinNotice),
  ];

  const embed = yield* EmbedService.makeBaseEmbedBuilder().pipe(
    Effect.map((builder) =>
      builder
        .setTitle("Auto check-in summary for monitors")
        .setDescription(embedDescriptionParts.join("\n"))
        .toJSON(),
    ),
  );

  yield* discordRest.createMessage(generated.runningChannelId, {
    content: pipe(
      generated.monitorUserId,
      Option.fromNullable,
      Option.map(userMention),
      Option.getOrUndefined,
    ),
    embeds: [embed],
    allowed_mentions: Option.match(Option.fromNullable(generated.monitorUserId), {
      onSome: (uid) => ({ users: [uid] as const }),
      onNone: () => ({ parse: [] as const }),
    }),
  });

  return generated.initialMessage !== null ? 1 : 0;
});

const processGuild = (guildId: string) =>
  Effect.gen(function* () {
    const hour = yield* pipe(
      DateTime.now,
      Effect.map(DateTime.addDuration("20 minutes")),
      Effect.flatMap((dt) => ConverterService.convertDateTimeToHour(guildId, dt)),
    );

    const channelNames: string[] = pipe(
      yield* GuildConfigService.getGuildChannels(guildId, true),
      Array.filterMap((channel) =>
        pipe(
          channel.name,
          Option.filter((name): name is string => name.length > 0),
        ),
      ),
      Array.dedupe,
    );

    const sentCount = yield* pipe(
      channelNames,
      Effect.forEach(
        (channelName) =>
          pipe(
            processChannel(guildId, hour, channelName),
            Effect.catchAll((err) => pipe(Effect.logError(err), Effect.as(0))),
          ),
        { concurrency: "unbounded" },
      ),
      Effect.map((counts) => counts.reduce((acc: number, n: number) => acc + n, 0)),
    );

    return sentCount;
  });

export const AutoCheckinTaskLive = Layer.scopedDiscard(
  pipe(
    SheetApisRequestContext.asBot(
      Effect.fn("autoCheckinTask", { attributes: { task: "autoCheckin" } })(
        function* () {
          yield* Effect.log("running auto check-in task...");

          const guildConfigs = yield* GuildConfigService.getAutoCheckinGuilds();

          const totalSent = yield* pipe(
            guildConfigs,
            Effect.forEach(
              (guildConfig) =>
                pipe(
                  processGuild(guildConfig.guildId),
                  Effect.provide(
                    Layer.mergeAll(
                      DiscordGatewayLayerLive,
                      CheckinService.Default,
                      ConverterService.Default,
                      EmbedService.Default,
                      MessageCheckinService.Default,
                    ),
                  ),
                  Effect.catchAll((err) => pipe(Effect.logError(err), Effect.as(0))),
                ),
              { concurrency: "unbounded" },
            ),
            Effect.map((counts) => counts.reduce((acc: number, n: number) => acc + n, 0)),
          );

          yield* Effect.log(
            `sent ${totalSent} check-in message(s) across all ${guildConfigs.length} guilds`,
          );
        },
        Effect.annotateLogs({ task: "autoCheckin" }),
      ),
    )(),
    Effect.schedule(
      Schedule.cron(
        Cron.make({
          seconds: [0],
          minutes: [45],
          hours: [],
          days: [],
          months: [],
          weekdays: [],
        }),
      ),
    ),
    Effect.forkDaemon,
  ),
).pipe(Layer.provide(GuildConfigService.Default));
