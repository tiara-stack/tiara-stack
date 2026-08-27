import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx/index";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { Effect, Layer, Option, pipe } from "effect";
import { CHECKIN_ACTION_ID } from "sheet-bot-api/actions";
import { discordGatewayLayer } from "../../discord/gateway";
import { resolveGuildId } from "@/utils/commandHelpers";
import {
  Interaction,
  MessageComponentInteractionResponse,
  makeButton,
  makeButtonData,
  makeMessageComponent,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { prefixedUnstorageLayer } from "../../discord/cache";
import {
  BotCapabilityStore,
  enqueueCheckinsRespondWorkflow,
  SheetWorkflowHttpClient,
  type BotCapabilityStoreShape,
  type SheetWorkflowHttpClientShape,
} from "@/services";
import { discordApplicationLayer } from "../../discord/application";
import { enqueueSheetWorkflow } from "@/utils/sheetWorkflowMigration";
const checkinButtonEnqueueRejectedMessage = "I couldn't process your check-in. Please try again.";
const checkinButtonEnqueueUnauthorizedMessage = "You aren't allowed to check in from this message.";
const checkinButtonEnqueuePendingMessage =
  "Your check-in is still processing. I'll update this message when it finishes.";
const getInteractionMessage = Effect.gen(function* () {
  const interactionMessage = yield* Interaction.message();
  return pipe(
    interactionMessage,
    Option.map((message) => message as { id: string; channel_id: string }),
  );
});

const makeCheckinButtonData = (disabled = false) =>
  makeButtonData((b) =>
    b
      .setCustomId(CHECKIN_ACTION_ID)
      .setLabel("Check in")
      .setStyle(ButtonStyle.Primary)
      .setEmoji({ id: "907705464215711834", name: "Miku_Happy" })
      .setDisabled(disabled),
  );

const checkinButtonData = makeCheckinButtonData();

const enqueueCheckinButton = Effect.fn("checkinButton.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueCheckinsRespond">,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  messageId: string,
) {
  const workspaceId = yield* resolveGuildId(Option.none());
  yield* enqueueSheetWorkflow({
    response,
    operation: "check-in button",
    workspaceId,
    capabilityStore,
    makeInput: (responseReference) => ({ messageId, responseReference }),
    enqueue: (input, options) => enqueueCheckinsRespondWorkflow(workflowClient, input, options),
    rejectedMessage: checkinButtonEnqueueRejectedMessage,
    unauthorizedMessage: checkinButtonEnqueueUnauthorizedMessage,
    pendingMessage: checkinButtonEnqueuePendingMessage,
  });
});

const makeCheckinButtonHandler = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* makeButton(
    checkinButtonData.toJSON(),
    Effect.fn("checkinButton")(function* () {
      const response = yield* MessageComponentInteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const message = Option.getOrThrow(yield* getInteractionMessage);
      yield* enqueueCheckinButton(response, workflowClient, capabilityStore, message.id);
    })(),
  );
});

const makeCheckinButton = Effect.gen(function* () {
  const button = yield* makeCheckinButtonHandler;

  return makeMessageComponent(button.data, button.handler as never);
});

export const checkinButtonLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const button = yield* makeCheckinButton;

    yield* registry.register(Ix.builder.add(button).catchAllCause(Effect.log));
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
