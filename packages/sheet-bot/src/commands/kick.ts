import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { Effect, Layer, Schema } from "effect";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import {
  BotCapabilityStore,
  enqueueMembersKickWorkflow,
  SheetWorkflowHttpClient,
  type MembersKickInput,
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

const kickEnqueueRejectedMessage = "I couldn't start member cleanup. Please try again.";
const kickEnqueueUnauthorizedMessage = "You aren't allowed to run member cleanup.";
const kickEnqueuePendingMessage =
  "Member cleanup is still processing. I'll update this message when it finishes.";
export const enqueueKick = Effect.fn("kick.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueMembersKick">,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  input: Omit<MembersKickInput, "responseReference">,
) {
  yield* enqueueSheetWorkflow({
    response,
    operation: "member cleanup",
    workspaceId: input.workspaceId,
    capabilityStore,
    makeInput: (responseReference) => ({ ...input, responseReference }),
    enqueue: (workflowInput, options) =>
      enqueueMembersKickWorkflow(workflowClient, workflowInput, options),
    rejectedMessage: kickEnqueueRejectedMessage,
    unauthorizedMessage: kickEnqueueUnauthorizedMessage,
    pendingMessage: kickEnqueuePendingMessage,
  });
});

const makeManualSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("manual")
        .setDescription("Manually kick out users")
        .addNumberOption((builder) =>
          builder.setName("hour").setDescription("The hour to kick out users for"),
        )
        .addStringOption((builder) =>
          builder.setName("channel_name").setDescription("The name of the running channel"),
        )
        .addStringOption((builder) =>
          builder.setName("server_id").setDescription("The server to kick out users for"),
        ),
    Effect.fn("kick.manual")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const target = yield* resolveConversationTarget(
        optionalStringValue(command.optionValueOptional("server_id")),
        optionalStringValue(command.optionValueOptional("channel_name")),
      );
      const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(target.workspaceId);
      const optionalFields = optionalPayloadField(
        "hour",
        optionalNumberValue(command.optionValueOptional("hour")),
      );
      const input = { ...target, ...optionalFields, workspaceId };

      yield* enqueueKick(response, workflowClient, capabilityStore, input);
    }),
  );
});

export const kickCommandLayer = registerSingleSubCommandLayer({
  commandName: "kick",
  commandDescription: "Kick commands",
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
