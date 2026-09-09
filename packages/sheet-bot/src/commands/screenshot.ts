import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { MembersCache } from "dfx-discord-utils/discord/cache";
import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { Effect, Layer, Schema } from "effect";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import {
  BotCapabilityStore,
  enqueueScreenshotsCaptureAndDeliverWorkflow,
  SheetWorkflowHttpClient,
  type ScreenshotsCaptureAndDeliverInput,
  type SheetWorkflowHttpClientShape,
  SheetZeroClient,
} from "../services";
import { prefixedUnstorageLayer } from "../discord/cache";
import { discordConfigLayer } from "../discord/config";
import {
  optionalStringValue,
  requireNumber,
  requireString,
  requiredDayOption,
  resolveGuildId,
  serverIdOption,
} from "../utils/commandHelpers";
import { registerGlobalCommandLayer } from "../utils/registerGlobalCommandLayer";
import { enqueueSheetWorkflow } from "../utils/sheetWorkflowMigration";
import { channelNameOption, makeChannelNameAutocomplete } from "../utils/channelNameAutocomplete";
import { registerGlobalAutocompleteLayer } from "../utils/registerGlobalCommandLayer";

const screenshotEnqueueRejectedMessage = "I couldn't start the screenshot. Please try again.";
const screenshotEnqueueUnauthorizedMessage = "You aren't allowed to capture screenshots.";
const screenshotEnqueuePendingMessage =
  "The screenshot is still processing. I'll update this message when it finishes.";
export const enqueueScreenshot = Effect.fn("screenshot.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueScreenshotsCaptureAndDeliver">,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  input: Omit<ScreenshotsCaptureAndDeliverInput, "responseReference">,
) {
  yield* enqueueSheetWorkflow({
    response,
    operation: "screenshot",
    workspaceId: input.workspaceId,
    capabilityStore,
    makeInput: (responseReference) => ({ ...input, responseReference }),
    enqueue: (workflowInput, options) =>
      enqueueScreenshotsCaptureAndDeliverWorkflow(workflowClient, workflowInput, options),
    rejectedMessage: screenshotEnqueueRejectedMessage,
    unauthorizedMessage: screenshotEnqueueUnauthorizedMessage,
    pendingMessage: screenshotEnqueuePendingMessage,
  });
});

const makeScreenshotCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("screenshot")
        .setDescription("Day screenshot command")
        .addStringOption((option) =>
          channelNameOption("The channel to get the screenshot for")(option).setRequired(true),
        )
        .addNumberOption(requiredDayOption("The day to get the slots for"))
        .addStringOption(serverIdOption("The server to get the teams for"))
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        ),
    Effect.fn("screenshot")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const workspaceId = yield* resolveGuildId(
        optionalStringValue(command.optionValueOptional("server_id")),
      );
      const conversationName = yield* requireString(
        command.optionValue("channel_name"),
        "channel name",
      );
      const day = yield* requireNumber(command.optionValue("day"), "day");
      const typedWorkspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(workspaceId);
      const input = { workspaceId: typedWorkspaceId, conversationName, day };

      yield* enqueueScreenshot(response, workflowClient, capabilityStore, input);
    }),
  );
});

export const screenshotCommandLayer = Layer.merge(
  registerGlobalCommandLayer(makeScreenshotCommand),
  registerGlobalAutocompleteLayer(makeChannelNameAutocomplete("screenshot")),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetWorkflowHttpClient.layer,
      SheetZeroClient.layer,
      MembersCache.layer.pipe(Layer.provide([prefixedUnstorageLayer, discordConfigLayer])),
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
