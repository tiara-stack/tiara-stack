import { InteractionsRegistry } from "dfx/gateway";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Effect, Layer } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { InteractionToken } from "dfx-discord-utils/utils";
import { discordApplicationLayer } from "../discord/application";
import { discordGatewayLayer } from "../discord/gateway";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import { interactionDeadlineEpochMs } from "../utils/interactionDeadline";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";

const makeStatusCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("status")
        .setDescription("Show service readiness status")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        ),
    Effect.fn("status")(function* () {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      yield* runSheetWorkflowsDispatch(
        response,
        "the service status check",
        SheetWorkflowsRequestContext.asInteractionUser(
          Effect.fn("status.dispatch")(function* () {
            const interactionToken = yield* InteractionToken;
            const interaction = yield* Ix.Interaction;
            return yield* sheetWorkflowsClient.get().dispatch.serviceStatus({
              payload: {
                dispatchRequestId: `discord-interaction:${interaction.id}`,
                interactionToken: interactionToken.token,
                interactionDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
              },
            });
          }),
        )(),
      );
    }),
  );
});

const makeGlobalStatusCommand = Effect.gen(function* () {
  const statusCommand = yield* makeStatusCommand;

  return CommandHelper.makeGlobalCommand(statusCommand.data, statusCommand.handler as never);
});

export const statusCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalStatusCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetWorkflowsClient.layer),
  ),
);
