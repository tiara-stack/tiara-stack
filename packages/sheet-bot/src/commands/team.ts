import { Effect, Layer } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  BotCapabilityStore,
  enqueueTeamsDeliverListWorkflow,
  SheetWorkflowHttpClient,
  type TeamsDeliverListInput,
} from "../services";
import {
  decodeWorkflowWorkspaceId,
  resolveGuildId,
  resolveTargetUserIdentity,
  serverIdOption,
} from "../utils/commandHelpers";
import { registerSingleSubCommandLayer } from "../utils/registerGlobalCommandLayer";
import { enqueueSheetWorkflow } from "../utils/sheetWorkflowMigration";

const teamRejectedMessage = "I couldn't load the team list. Please try again.";
const teamUnauthorizedMessage = "You aren't allowed to view that user's teams.";
const teamPendingMessage =
  "The team list is still processing. I'll update this message when it finishes.";

const makeListSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("list")
        .setDescription("Get the teams for a user")
        .addUserOption((option) =>
          option.setName("user").setDescription("The user to get the teams for"),
        )
        .addStringOption(serverIdOption("The server to get the teams for")),
    Effect.fn("team.list")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const workspaceId = yield* decodeWorkflowWorkspaceId(guildId);
      const targetUser = yield* resolveTargetUserIdentity(command.optionUserValueOptional("user"));

      yield* enqueueSheetWorkflow({
        response,
        operation: "the team list",
        workspaceId,
        capabilityStore,
        makeInput: (responseReference): TeamsDeliverListInput => ({
          workspaceId,
          targetUserId: targetUser.id,
          targetUsername: targetUser.username,
          responseReference,
        }),
        enqueue: (input, options) =>
          enqueueTeamsDeliverListWorkflow(workflowClient, input, options),
        rejectedMessage: teamRejectedMessage,
        unauthorizedMessage: teamUnauthorizedMessage,
        pendingMessage: teamPendingMessage,
      });
    }),
  );
});

export const teamCommandLayer = registerSingleSubCommandLayer({
  commandName: "team",
  commandDescription: "Team commands",
  subCommandName: "list",
  makeSubCommand: makeListSubCommand,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
