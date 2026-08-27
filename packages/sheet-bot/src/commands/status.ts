import { InteractionsRegistry } from "dfx/gateway";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Effect, Layer } from "effect";
import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { prefixedUnstorageLayer } from "../discord/cache";
import { discordApplicationLayer } from "../discord/application";
import { discordGatewayLayer } from "../discord/gateway";
import {
  BotCapabilityStore,
  enqueueStatusWorkflow,
  SheetWorkflowHttpClient,
  type BotCapabilityStoreShape,
  type SheetWorkflowHttpClientShape,
} from "../services";
import { makeResponseReferenceInput } from "../utils/commandHelpers";
import { enqueueSheetWorkflow } from "../utils/sheetWorkflowMigration";

const statusEnqueueRejectedMessage = "I couldn't start the service status check. Please try again.";
const statusEnqueueUnauthorizedMessage =
  "Only the application owner can start the service status check.";
const statusEnqueuePendingMessage =
  "The service status check is still processing. I'll update this message when it finishes.";
export const makeStatusResponseReferenceInput = makeResponseReferenceInput;

export const enqueueStatus = Effect.fn("status.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueServicesDeliverStatus">,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
) {
  yield* enqueueSheetWorkflow({
    response,
    operation: "status",
    capabilityStore,
    makeInput: (responseReference) => ({ responseReference }),
    enqueue: (input, options) => enqueueStatusWorkflow(workflowClient, input, options),
    rejectedMessage: statusEnqueueRejectedMessage,
    unauthorizedMessage: statusEnqueueUnauthorizedMessage,
    pendingMessage: statusEnqueuePendingMessage,
  });
});

const makeStatusCommand = Effect.gen(function* () {
  const capabilityStore = yield* BotCapabilityStore;
  const workflowClient = yield* SheetWorkflowHttpClient;

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

      yield* enqueueStatus(response, workflowClient, capabilityStore);
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
    Layer.mergeAll(
      discordGatewayLayer,
      discordApplicationLayer,
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
