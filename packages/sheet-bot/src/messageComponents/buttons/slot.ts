import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx/index";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { Effect, Layer, Option, pipe } from "effect";
import { SLOT_OPEN_ACTION_ID } from "sheet-bot-api/actions";
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
  enqueueSlotsOpenWorkflow,
  SheetWorkflowHttpClient,
  type BotCapabilityStoreShape,
  type SheetWorkflowHttpClientShape,
} from "@/services";
import { discordApplicationLayer } from "../../discord/application";
import { enqueueSheetWorkflow } from "@/utils/sheetWorkflowMigration";
const slotButtonEnqueueRejectedMessage = "I couldn't open those slots. Please try again.";
const slotButtonEnqueueUnauthorizedMessage = "You aren't allowed to open slots from this message.";
const slotButtonEnqueuePendingMessage =
  "The slot list is still processing. I'll update this message when it finishes.";
const getInteractionMessageId = Effect.gen(function* () {
  const interactionMessage = yield* Interaction.message();
  return pipe(
    interactionMessage,
    Option.map((message) => (message as { id: string }).id),
  );
});

const slotButtonData = makeButtonData((b) =>
  b.setCustomId(SLOT_OPEN_ACTION_ID).setLabel("Open slots").setStyle(ButtonStyle.Primary),
);

const enqueueSlotOpenButton = Effect.fn("slotButton.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueSlotsOpen">,
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  messageId: string,
) {
  const workspaceId = yield* resolveGuildId(Option.none());
  yield* enqueueSheetWorkflow({
    response,
    operation: "slot-open button",
    workspaceId,
    capabilityStore,
    makeInput: (responseReference) => ({ messageId, responseReference }),
    enqueue: (input, options) => enqueueSlotsOpenWorkflow(workflowClient, input, options),
    rejectedMessage: slotButtonEnqueueRejectedMessage,
    unauthorizedMessage: slotButtonEnqueueUnauthorizedMessage,
    pendingMessage: slotButtonEnqueuePendingMessage,
  });
});

const makeSlotButtonHandler = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* makeButton(
    slotButtonData.toJSON(),
    Effect.fn("slotButton")(function* () {
      const response = yield* MessageComponentInteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const messageId = Option.getOrThrow(yield* getInteractionMessageId);
      yield* enqueueSlotOpenButton(response, workflowClient, capabilityStore, messageId);
    })(),
  );
});

const makeSlotButton = Effect.gen(function* () {
  const button = yield* makeSlotButtonHandler;

  return makeMessageComponent(button.data, button.handler as never);
});

export const slotButtonLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const button = yield* makeSlotButton;

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
