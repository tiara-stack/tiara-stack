import { Context, DateTime, Duration, Effect, Layer, Option, pipe } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import {
  formatTentativeRoomOrderContent,
  shouldSendTentativeRoomOrder,
} from "sheet-ingress-api/discordComponents";
import { makeArgumentError } from "typhoon-core/error";
import {
  checkinActionRow,
  tentativeRoomOrderActionRow,
  tentativeRoomOrderPinActionRow,
} from "./discordComponents";
import { IngressBotClient } from "./ingressBotClient";
import { SheetApisClient } from "./sheetApisClient";
import {
  AutoCheckinChannelPayload,
  AutoCheckinChannelResult,
  AutoCheckinChannelWorkflow,
} from "@/workflows/autoCheckinContract";
import { config } from "@/config";

type DiscordMessage = {
  readonly id: string;
  readonly channel_id: string;
};

const autoCheckinNotice = "Sent automatically via auto check-in.";

const subtext = (value: string): string => `-# ${value}`;

const mentionUser = (userId: string): string => `<@${userId}>`;

const makeEmbed = (embed: {
  readonly title?: string;
  readonly description?: string | null;
  readonly fields?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly color?: number;
}) => embed;

const formatCheckinContent = (content: string): string =>
  [content, subtext(autoCheckinNotice)].join("\n");

const uniqueChannelNames = (channels: ReadonlyArray<{ readonly name: Option.Option<string> }>) => {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const channel of channels) {
    const name = Option.getOrUndefined(channel.name);
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) {
      continue;
    }

    seen.add(name);
    names.push(name);
  }

  return names;
};

const deriveTargetHour = (eventStart: DateTime.DateTime, target: DateTime.DateTime): number => {
  const targetHourStart = pipe(target, DateTime.startOf("hour"));
  return Math.floor(Duration.toHours(DateTime.distance(eventStart, targetHourStart))) + 1;
};

const makeSheetApisServices = (sheetApisClient: typeof SheetApisClient.Service) => {
  const sheetApis = sheetApisClient.get();

  return {
    checkinService: {
      generate: (payload: {
        readonly guildId: string;
        readonly channelName: string;
        readonly hour: number;
      }) => sheetApis.checkin.generate({ payload }),
    },
    guildConfigService: {
      getAutoCheckinGuilds: () => sheetApis.guildConfig.getAutoCheckinGuilds(),
      getGuildChannels: (guildId: string, running: boolean) =>
        sheetApis.guildConfig.getGuildChannels({ query: { guildId, running } }),
    },
    messageCheckinService: {
      persistMessageCheckin: (
        messageId: string,
        payload: Omit<
          Parameters<typeof sheetApis.messageCheckin.persistMessageCheckin>[0]["payload"],
          "messageId"
        >,
      ) =>
        sheetApis.messageCheckin.persistMessageCheckin({
          payload: { messageId, ...payload },
        }),
    },
    messageRoomOrderService: {
      persistMessageRoomOrder: (
        messageId: string,
        payload: Omit<
          Parameters<typeof sheetApis.messageRoomOrder.persistMessageRoomOrder>[0]["payload"],
          "messageId"
        >,
      ) =>
        sheetApis.messageRoomOrder.persistMessageRoomOrder({
          payload: { messageId, ...payload },
        }),
    },
    roomOrderService: {
      generate: (payload: {
        readonly guildId: string;
        readonly channelId: string;
        readonly hour: number;
      }) => sheetApis.roomOrder.generate({ payload }),
    },
    sheetService: {
      getEventConfig: (guildId: string) => sheetApis.sheet.getEventConfig({ query: { guildId } }),
    },
  };
};

const sendTentativeRoomOrder = Effect.fn("AutoCheckinService.sendTentativeRoomOrder")(function* ({
  guildId,
  runningChannelId,
  hour,
  fillCount,
  botClient,
  roomOrderService,
  messageRoomOrderService,
}: {
  readonly guildId: string;
  readonly runningChannelId: string;
  readonly hour: number;
  readonly fillCount: number;
  readonly botClient: typeof IngressBotClient.Service;
  readonly roomOrderService: ReturnType<typeof makeSheetApisServices>["roomOrderService"];
  readonly messageRoomOrderService: ReturnType<
    typeof makeSheetApisServices
  >["messageRoomOrderService"];
}) {
  if (!shouldSendTentativeRoomOrder(fillCount)) {
    return null;
  }

  return yield* Effect.gen(function* () {
    const generated = yield* roomOrderService.generate({
      guildId,
      channelId: runningChannelId,
      hour,
    });

    const sentMessage = yield* botClient.sendMessage(runningChannelId, {
      content: formatTentativeRoomOrderContent(generated.content),
      components: [tentativeRoomOrderActionRow(generated.range, generated.rank)],
    });

    yield* Effect.gen(function* () {
      yield* messageRoomOrderService.persistMessageRoomOrder(sentMessage.id, {
        data: {
          previousFills: generated.previousFills,
          fills: generated.fills,
          hour: generated.hour,
          rank: generated.rank,
          tentative: true,
          monitor: generated.monitor,
          guildId,
          messageChannelId: sentMessage.channel_id,
          createdByUserId: null,
        },
        entries: generated.entries,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Failed to persist auto check-in tentative room order").pipe(
          Effect.annotateLogs({
            guildId,
            runningChannelId,
            hour,
            messageId: sentMessage.id,
          }),
          Effect.andThen(Effect.logError(cause)),
          Effect.andThen(
            botClient
              .updateMessage(sentMessage.channel_id, sentMessage.id, {
                components: [tentativeRoomOrderPinActionRow()],
              })
              .pipe(
                Effect.catchCause((updateCause) =>
                  Effect.logError(
                    "Failed to persist auto check-in tentative room order and downgrade buttons",
                  ).pipe(
                    Effect.annotateLogs({
                      guildId,
                      runningChannelId,
                      hour,
                      messageId: sentMessage.id,
                    }),
                    Effect.andThen(Effect.logError(cause)),
                    Effect.andThen(Effect.logError(updateCause)),
                  ),
                ),
              ),
          ),
        ),
      ),
    );

    return {
      messageId: sentMessage.id,
      messageChannelId: sentMessage.channel_id,
    };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Failed to send auto check-in tentative room order").pipe(
        Effect.annotateLogs({
          guildId,
          runningChannelId,
          hour,
        }),
        Effect.andThen(Effect.logError(cause)),
        Effect.as(null),
      ),
    ),
  );
});

export class AutoCheckinWorkflowClient extends Context.Service<AutoCheckinWorkflowClient>()(
  "AutoCheckinWorkflowClient",
  {
    make: Effect.succeed({
      enqueueChannel: Effect.fn("AutoCheckinWorkflowClient.enqueueChannel")(
        (payload: AutoCheckinChannelPayload) =>
          AutoCheckinChannelWorkflow.execute(payload, { discard: true }),
      ),
    }).pipe(
      Effect.andThen((service) =>
        Effect.gen(function* () {
          const workflowEngine = yield* WorkflowEngine.WorkflowEngine;
          return {
            enqueueChannel: (payload: AutoCheckinChannelPayload) =>
              service
                .enqueueChannel(payload)
                .pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)),
          };
        }),
      ),
    ),
  },
) {
  static layer = Layer.effect(AutoCheckinWorkflowClient, this.make);
}

export class AutoCheckinService extends Context.Service<AutoCheckinService>()(
  "AutoCheckinService",
  {
    make: Effect.gen(function* () {
      const botClient = yield* IngressBotClient;
      const sheetApisClient = yield* SheetApisClient;
      const workflowClient = yield* AutoCheckinWorkflowClient;
      const autoCheckinConcurrency = yield* config.autoCheckinConcurrency;
      const {
        checkinService,
        guildConfigService,
        messageCheckinService,
        messageRoomOrderService,
        roomOrderService,
        sheetService,
      } = makeSheetApisServices(sheetApisClient);

      const enqueueGuild = Effect.fn("AutoCheckinService.enqueueGuild")(function* (
        guildId: string,
      ) {
        const eventConfig = yield* sheetService.getEventConfig(guildId);
        const targetDateTime = yield* DateTime.now.pipe(
          Effect.map(DateTime.addDuration("20 minutes")),
        );
        const hour = deriveTargetHour(eventConfig.startTime, targetDateTime);
        const eventStartEpochMs = DateTime.toEpochMillis(eventConfig.startTime);
        const channels = yield* guildConfigService.getGuildChannels(guildId, true);
        const channelNames = uniqueChannelNames(channels);

        const results = yield* Effect.forEach(
          channelNames,
          (channelName) =>
            workflowClient
              .enqueueChannel({
                guildId,
                channelName,
                hour,
                eventStartEpochMs,
              })
              .pipe(
                Effect.as(1),
                Effect.catchCause((cause) =>
                  Effect.logError("Failed to enqueue auto check-in channel workflow").pipe(
                    Effect.annotateLogs({ guildId, channelName, hour }),
                    Effect.andThen(Effect.logError(cause)),
                    Effect.as(0),
                  ),
                ),
              ),
          { concurrency: autoCheckinConcurrency },
        );

        return results.reduce((sum, count) => sum + count, 0);
      });

      return {
        enqueueGuild,
        enqueueDueChannels: Effect.fn("AutoCheckinService.enqueueDueChannels")(function* () {
          const guildConfigs = yield* guildConfigService.getAutoCheckinGuilds();
          const counts = yield* Effect.forEach(
            guildConfigs,
            (guildConfig) =>
              enqueueGuild(guildConfig.guildId).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Failed to enqueue auto check-in guild").pipe(
                    Effect.annotateLogs({ guildId: guildConfig.guildId }),
                    Effect.andThen(Effect.logError(cause)),
                    Effect.as(0),
                  ),
                ),
              ),
            { concurrency: autoCheckinConcurrency },
          );

          return counts.reduce((sum, count) => sum + count, 0);
        }),
        processChannel: Effect.fn("AutoCheckinService.processChannel")(function* (
          payload: AutoCheckinChannelPayload,
        ) {
          if (payload.channelName.length === 0) {
            return yield* Effect.fail(makeArgumentError("Cannot auto check-in an unnamed channel"));
          }

          const generated = yield* checkinService.generate({
            guildId: payload.guildId,
            channelName: payload.channelName,
            hour: payload.hour,
          });

          let checkinMessage: DiscordMessage | null = null;
          if (generated.initialMessage !== null) {
            const initialMessage = formatCheckinContent(generated.initialMessage);
            checkinMessage = yield* botClient.sendMessage(generated.checkinChannelId, {
              content: initialMessage,
            });

            yield* messageCheckinService.persistMessageCheckin(checkinMessage.id, {
              data: {
                initialMessage,
                hour: generated.hour,
                channelId: generated.runningChannelId,
                roleId: generated.roleId,
                guildId: payload.guildId,
                messageChannelId: generated.checkinChannelId,
                createdByUserId: null,
              },
              memberIds: generated.fillIds,
            });

            yield* botClient
              .updateMessage(checkinMessage.channel_id, checkinMessage.id, {
                components: [checkinActionRow()],
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Failed to enable auto check-in message after persistence").pipe(
                    Effect.annotateLogs({
                      guildId: payload.guildId,
                      channelName: payload.channelName,
                      messageId: checkinMessage?.id ?? "unknown",
                    }),
                    Effect.andThen(Effect.logError(cause)),
                  ),
                ),
              );
          }

          const embedDescriptionParts = [
            generated.monitorCheckinMessage,
            ...Option.match(Option.fromNullishOr(generated.monitorFailureMessage), {
              onSome: (failure) => [subtext(failure)],
              onNone: () => [],
            }),
            subtext(autoCheckinNotice),
          ];
          const monitorUserId = Option.getOrUndefined(
            Option.fromNullishOr(generated.monitorUserId),
          );
          const monitorMessage = yield* botClient.sendMessage(generated.runningChannelId, {
            content: typeof monitorUserId === "string" ? mentionUser(monitorUserId) : undefined,
            embeds: [
              makeEmbed({
                title: "Auto check-in summary for monitors",
                description: embedDescriptionParts.join("\n"),
              }),
            ],
            allowed_mentions:
              typeof monitorUserId === "string"
                ? { users: [monitorUserId] as const }
                : { parse: [] as const },
          });
          const tentativeRoomOrderMessage =
            generated.initialMessage !== null
              ? yield* sendTentativeRoomOrder({
                  guildId: payload.guildId,
                  runningChannelId: generated.runningChannelId,
                  hour: generated.hour,
                  fillCount: generated.fillCount,
                  botClient,
                  roomOrderService,
                  messageRoomOrderService,
                })
              : null;

          return {
            guildId: payload.guildId,
            channelName: payload.channelName,
            hour: generated.hour,
            status: generated.initialMessage !== null ? "sent" : "skipped",
            checkinMessageId: checkinMessage?.id ?? null,
            monitorMessageId: monitorMessage.id,
            tentativeRoomOrderMessageId: tentativeRoomOrderMessage?.messageId ?? null,
          } satisfies AutoCheckinChannelResult;
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(AutoCheckinService, this.make).pipe(
    Layer.provide([AutoCheckinWorkflowClient.layer, IngressBotClient.layer, SheetApisClient.layer]),
  );
}
