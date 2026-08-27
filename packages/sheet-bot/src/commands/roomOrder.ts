import { MessageFlags } from "discord-api-types/v10";
import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { Effect, Layer, Schema } from "effect";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import {
  BotCapabilityStore,
  enqueueRoomOrdersCreateWorkflow,
  SheetWorkflowHttpClient,
  type RoomOrdersCreateInput,
  type SheetWorkflowHttpClientShape,
} from "../services";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  optionalPayloadField,
  optionalNumberValue,
  optionalStringValue,
  resolveConversationTarget,
} from "../utils/commandHelpers";
import { registerSingleSubCommandLayer } from "../utils/registerGlobalCommandLayer";
import { enqueueSheetWorkflow } from "../utils/sheetWorkflowMigration";

const roomOrderEnqueueRejectedMessage = "I couldn't start the room order. Please try again.";
const roomOrderEnqueueUnauthorizedMessage = "You aren't allowed to create a room order.";
const roomOrderEnqueuePendingMessage =
  "The room order is still processing. I'll update this message when it finishes.";
export const enqueueRoomOrder = Effect.fn("roomOrder.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersCreate">,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  input: Omit<RoomOrdersCreateInput, "responseReference">,
) {
  yield* enqueueSheetWorkflow({
    response,
    operation: "room order",
    workspaceId: input.workspaceId,
    capabilityStore,
    makeInput: (responseReference) => ({ ...input, responseReference }),
    enqueue: (workflowInput, options) =>
      enqueueRoomOrdersCreateWorkflow(workflowClient, workflowInput, options),
    rejectedMessage: roomOrderEnqueueRejectedMessage,
    unauthorizedMessage: roomOrderEnqueueUnauthorizedMessage,
    pendingMessage: roomOrderEnqueuePendingMessage,
  });
});

const makeManualSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("manual")
        .setDescription("Manual room order commands")
        .addStringOption((option) =>
          option.setName("channel_name").setDescription("The name of the running channel"),
        )
        .addNumberOption((option) =>
          option.setName("hour").setDescription("The hour to order rooms for"),
        )
        .addNumberOption((option) => option.setName("heal").setDescription("The healer needed"))
        .addStringOption((option) =>
          option.setName("server_id").setDescription("The server to order rooms for"),
        ),
    Effect.fn("room_order.manual")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const target = yield* resolveConversationTarget(
        optionalStringValue(command.optionValueOptional("server_id")),
        optionalStringValue(command.optionValueOptional("channel_name")),
      );
      const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(target.workspaceId);
      const optionalFields = {
        ...optionalPayloadField("hour", optionalNumberValue(command.optionValueOptional("hour"))),
        ...optionalPayloadField(
          "healNeeded",
          optionalNumberValue(command.optionValueOptional("heal")),
        ),
      };
      const input = { ...target, ...optionalFields, workspaceId };

      yield* enqueueRoomOrder(response, workflowClient, capabilityStore, input);
    }),
  );
});

export const roomOrderCommandLayer = registerSingleSubCommandLayer({
  commandName: "room_order",
  commandDescription: "Room order commands",
  subCommandName: "manual",
  makeSubCommand: makeManualSubCommand,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
