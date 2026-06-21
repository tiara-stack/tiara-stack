// fallow-ignore-file code-duplication
import { Effect } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import {
  makeDispatchBase,
  resolveGuildId,
  resolveTargetUserIdentity,
  serverIdOption,
} from "../utils/commandHelpers";
import {
  makeSingleSubCommand,
  registerGlobalCommandLayer,
} from "../utils/registerGlobalCommandLayer";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";

const makeListSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

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
      const targetUser = yield* resolveTargetUserIdentity(command.optionUserValueOptional("user"));
      const base = yield* makeDispatchBase;

      yield* runSheetWorkflowsDispatch(
        response,
        "the team list",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.teamList({
            payload: {
              ...base,
              workspaceId: guildId,
              targetUserId: targetUser.id,
              targetUsername: targetUser.username,
            },
          }),
        )(),
      );
    }),
  );
});

const makeTeamCommand = makeSingleSubCommand({
  commandName: "team",
  commandDescription: "Team commands",
  subCommandName: "list",
  makeSubCommand: makeListSubCommand,
});

export const teamCommandLayer = registerGlobalCommandLayer(makeTeamCommand);
