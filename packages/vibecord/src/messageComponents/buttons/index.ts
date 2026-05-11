import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx";
import type { MessageComponent } from "dfx/Interactions/definitions";
import { MessageFlags } from "discord-api-types/v10";
import { Effect, Layer, Option } from "effect";
import {
  Interaction,
  MessageComponentInteractionResponse,
  provideInteractionResponse,
  provideInteractionToken,
} from "dfx-discord-utils/utils";
import type { MessageComponentInteractionResponseContext } from "dfx-discord-utils/utils";
import { discordApplicationLayer } from "../../discord/application";
import { discordGatewayLayer } from "../../discord/gateway";
import { sdkClient, type VibecordButtonInteraction } from "../../sdk/index";

const makeAdapter = (response: MessageComponentInteractionResponseContext, customId: string) =>
  Effect.gen(function* () {
    const effects: Array<Effect.Effect<unknown, unknown, never>> = [];
    let initialResponseQueued = false;
    const user = (yield* Interaction.user()) as { id: string };
    const message = (yield* Interaction.message().pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new Error("Interaction has no message")),
          onSome: Effect.succeed,
        }),
      ),
    )) as VibecordButtonInteraction["message"];

    const enqueue = (effect: Effect.Effect<unknown, unknown, never>) => {
      effects.push(effect);
      return Promise.resolve();
    };
    const enqueueInitialResponse = (effect: Effect.Effect<unknown, unknown, never>) => {
      if (initialResponseQueued) {
        return Promise.reject(new Error("Interaction initial response already queued"));
      }
      initialResponseQueued = true;
      return enqueue(effect);
    };

    return {
      adapter: {
        customId,
        userId: user.id,
        message,
        reply: (payload) =>
          enqueueInitialResponse(
            response.reply({
              content: payload.content,
              flags: payload.flags ?? (payload.ephemeral ? MessageFlags.Ephemeral : undefined),
            }),
          ),
        update: (payload) =>
          enqueueInitialResponse(response.update({ components: payload.components })),
        followUp: (payload) => {
          const payloadWithFlags = {
            content: payload.content,
            flags: payload.flags ?? (payload.ephemeral ? MessageFlags.Ephemeral : undefined),
          };
          if (!initialResponseQueued) {
            return enqueueInitialResponse(response.reply(payloadWithFlags));
          }

          return enqueue(response.followUp(payloadWithFlags));
        },
      } satisfies VibecordButtonInteraction,
      flush: Effect.suspend(() => Effect.forEach(effects, (effect) => effect, { discard: true })),
    };
  });

const makeButtonLayer = (prefix: "p_" | "q_" | "qc_") =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* InteractionsRegistry;
      const component = Ix.messageComponent(
        Ix.idStartsWith(prefix),
        provideInteractionToken(
          provideInteractionResponse(
            "message-component",
            Effect.gen(function* () {
              const response = yield* MessageComponentInteractionResponse;
              yield* Effect.gen(function* () {
                const data = yield* Ix.MessageComponentData;
                const customId = data.custom_id;
                const { adapter, flush } = yield* makeAdapter(response, customId);
                const handled =
                  prefix === "p_"
                    ? yield* Effect.tryPromise(() => sdkClient.handlePermissionButton(adapter))
                    : yield* Effect.tryPromise(() => sdkClient.handleQuestionButton(adapter));

                if (!handled) {
                  yield* response.reply({
                    content: "Unknown button.",
                    flags: MessageFlags.Ephemeral,
                  });
                  return;
                }

                yield* flush;
                const acknowledgementState = yield* response.getAcknowledgementState;
                if (acknowledgementState === "none") {
                  yield* response.reply({
                    content: "The button did not set a response.",
                    flags: MessageFlags.Ephemeral,
                  });
                }
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError(cause).pipe(
                    Effect.andThen(response.respondWithError(cause)),
                    Effect.asVoid,
                  ),
                ),
              );

              const { files, payload } = yield* response.awaitInitialResponse;
              return {
                files,
                ...payload,
              };
            }),
          ),
        ),
      );
      yield* registry.register(
        Ix.builder.add(component as MessageComponent<never, unknown>).catchAllCause(Effect.log),
      );
    }),
  ).pipe(Layer.provide(Layer.mergeAll(discordGatewayLayer, discordApplicationLayer)));

export const permissionButtonLayer = makeButtonLayer("p_");
export const questionButtonLayer = Layer.mergeAll(makeButtonLayer("q_"), makeButtonLayer("qc_"));
