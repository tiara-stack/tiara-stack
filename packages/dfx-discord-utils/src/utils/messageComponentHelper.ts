import { Discord, Ix } from "dfx";
import { MessageFlags } from "discord-api-types/v10";
import type { MessageComponent as DfxMessageComponent } from "dfx/Interactions/definitions";
import type { DiscordInteraction, DiscordMessageComponent } from "dfx/Interactions/context";
import { Effect, FiberMap, pipe, type Scope } from "effect";
import {
  ActionRowBuilder,
  ButtonBuilder,
  MessageActionRowComponentBuilder,
} from "./messageComponentBuilder";
import { InteractionToken, provideInteractionToken } from "./interaction";
import {
  InteractionResponse,
  MessageComponentInteractionResponse,
  provideInteractionResponse,
} from "./interactionResponse";

export const makeForkedMessageComponentHandler = Effect.fnUntraced(function* <E = never, R = never>(
  handler: Effect.Effect<unknown, E, R>,
) {
  const fiberMap = yield* FiberMap.make<Discord.Snowflake>();

  return Effect.fnUntraced(function* () {
    const context = yield* Ix.Interaction;

    yield* pipe(handler, provideInteractionToken, FiberMap.run(fiberMap, context.id));
  });
});

export const makeButtonData = <
  const A extends { type: typeof Discord.MessageComponentTypes.BUTTON; readonly custom_id: string },
>(
  data: (builder: ButtonBuilder) => ButtonBuilder<A>,
) => data(new ButtonBuilder());

export const makeMessageActionRowData = <
  const A extends {
    type: typeof Discord.MessageComponentTypes.ACTION_ROW;
    readonly components: ReadonlyArray<{ type: typeof Discord.MessageComponentTypes.BUTTON }>;
  },
>(
  data: (
    builder: ActionRowBuilder<MessageActionRowComponentBuilder>,
  ) => ActionRowBuilder<MessageActionRowComponentBuilder, A>,
) => data(new ActionRowBuilder());

type MessageComponentEnv<R> = Exclude<
  Exclude<
    Exclude<Exclude<R, InteractionResponse>, MessageComponentInteractionResponse>,
    InteractionToken
  >,
  DiscordInteraction | DiscordMessageComponent | Scope.Scope
>;

const makeButtonInternal = Effect.fnUntraced(function* <E = never, R = never>(
  data: { readonly custom_id: string },
  handler: Effect.Effect<unknown, E, R>,
) {
  const forkedHandler = yield* makeForkedMessageComponentHandler(
    Effect.gen(function* () {
      const response = yield* MessageComponentInteractionResponse;
      const handlerCompleted = yield* handler.pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logError(cause).pipe(
            Effect.andThen(response.respondWithError(cause)),
            Effect.as(false),
          ),
        ),
      );

      if (!handlerCompleted) {
        return;
      }

      yield* response.reply({
        content: "The button did not set a response.",
        flags: MessageFlags.Ephemeral,
      });
    }),
  );
  const builtMessageComponent = {
    data,
    handler: Effect.gen(function* () {
      const response = yield* InteractionResponse;
      yield* forkedHandler();
      const { files, payload } = yield* response.awaitInitialResponse;
      return {
        files,
        ...payload,
      };
    }),
  };

  return builtMessageComponent;
});

export const makeButton = makeButtonInternal;

export const makeMessageComponent = <E = never, R = never>(
  data: { readonly custom_id: string },
  handler: Effect.Effect<Discord.CreateInteractionResponseRequest, E, R>,
): DfxMessageComponent<MessageComponentEnv<R>, E> =>
  Ix.messageComponent(
    Ix.id(data.custom_id),
    provideInteractionToken(provideInteractionResponse("message-component", handler)),
  ) as DfxMessageComponent<MessageComponentEnv<R>, E>;
