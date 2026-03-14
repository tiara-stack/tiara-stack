import { Ix } from "dfx";
import { InteractionsRegistry } from "dfx/gateway";
import { Array, Chunk, Effect, Layer, Number, Option, Order, pipe, String } from "effect";
import { DiscordGatewayLayer } from "dfx-discord-utils/discord";
import { makeButton, makeButtonData, makeMessageComponent } from "dfx-discord-utils/utils";
import {
  EmbedService,
  FormatService,
  MessageSlotService,
  ScheduleService,
  SheetApisRequestContext,
} from "@/services";
import { Interaction } from "dfx-discord-utils/utils";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";

class SlotHelper extends Effect.Service<SlotHelper>()("SlotHelper", {
  effect: pipe(
    Effect.all({
      scheduleService: ScheduleService,
      formatService: FormatService,
    }),
    Effect.map(({ scheduleService, formatService }) => ({
      getSlotMessage: Effect.fn("SlotHelper.getSlotMessage")(function* (
        guildId: string,
        day: number,
      ) {
        const daySchedule = yield* scheduleService.dayPopulatedFillerSchedules(guildId, day);

        const filteredSchedules = pipe(
          daySchedule,
          Array.filterMap((s) =>
            pipe(
              s.hour,
              Option.map(() => s),
            ),
          ),
        );

        const sortedSchedules = pipe(
          filteredSchedules,
          Array.sortBy(Order.mapInput(Option.getOrder(Number.Order), (s) => s.hour)),
        );

        const openSlots = yield* pipe(
          sortedSchedules,
          Effect.forEach((s) => formatService.formatOpenSlot(guildId, s)),
          Effect.map(Chunk.fromIterable),
          Effect.map(Chunk.dedupeAdjacent),
          Effect.map(Chunk.join("\n")),
          Effect.map((description) =>
            String.Equivalence(description, String.empty) ? "All Filled :3" : description,
          ),
        );

        const filledSlots = yield* pipe(
          sortedSchedules,
          Effect.forEach((s) => formatService.formatFilledSlot(guildId, s)),
          Effect.map(Chunk.fromIterable),
          Effect.map(Chunk.dedupeAdjacent),
          Effect.map(Chunk.join("\n")),
          Effect.map((description) =>
            String.Equivalence(description, String.empty) ? "All Open :3" : description,
          ),
        );

        return {
          open: {
            title: `Day ${day} Open Slots~`,
            description: openSlots,
          },
          filled: {
            title: `Day ${day} Filled Slots~`,
            description: filledSlots,
          },
        };
      }),
    })),
  ),
  dependencies: [ScheduleService.Default, FormatService.Default],
  accessors: true,
}) {}

export const slotButtonData = makeButtonData((b) =>
  b.setCustomId("interaction:slot").setLabel("Open slots").setStyle(ButtonStyle.Primary),
);

const makeSlotButtonHandler = Effect.gen(function* () {
  const slotHelper = yield* SlotHelper;
  const messageSlotService = yield* MessageSlotService;
  const embedService = yield* EmbedService;

  return yield* makeButton(
    slotButtonData.toJSON(),
    SheetApisRequestContext.asInteractionUser(
      Effect.fn("slotButton")(function* (msgHelper) {
        yield* msgHelper.deferReply({ flags: MessageFlags.Ephemeral });

        const guild = yield* Interaction.guild();
        const message = yield* Interaction.message();

        const guildId = Option.map(guild, (g) => g.id).pipe(Option.getOrThrow);
        const messageId = Option.map(message, (m) => m.id).pipe(Option.getOrThrow);

        const messageSlotData = yield* messageSlotService.getMessageSlotData(messageId);

        const slotMessage = yield* slotHelper.getSlotMessage(guildId, messageSlotData.day);

        const embeds = [
          (yield* embedService.makeBaseEmbedBuilder())
            .setTitle(slotMessage.open.title)
            .setDescription(slotMessage.open.description)
            .toJSON(),
          (yield* embedService.makeBaseEmbedBuilder())
            .setTitle(slotMessage.filled.title)
            .setDescription(slotMessage.filled.description)
            .toJSON(),
        ];

        yield* msgHelper.editReply({ payload: { embeds } });
      }),
    ),
  );
});

const makeSlotButton = Effect.gen(function* () {
  const button = yield* makeSlotButtonHandler;

  return makeMessageComponent(button.data, button.handler);
});

export const SlotButtonLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const button = yield* makeSlotButton;

    yield* registry.register(Ix.builder.add(button).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      DiscordGatewayLayer,
      MessageSlotService.Default,
      ScheduleService.Default,
      FormatService.Default,
      EmbedService.Default,
      SlotHelper.Default,
    ),
  ),
);
