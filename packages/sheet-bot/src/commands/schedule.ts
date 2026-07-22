import { MessageFlags } from "discord-api-types/v10";
import { Effect } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import {
  makeDispatchBase,
  requireNumber,
  resolveGuildId,
  resolveTargetUserIdentity,
  serverIdOption,
} from "../utils/commandHelpers";
import { registerSingleSubCommandLayer } from "../utils/registerGlobalCommandLayer";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";

const makeListSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("list")
        .setDescription("Get your schedule (fill/overfill/standby) for a day")
        .addNumberOption((option) =>
          option.setName("day").setDescription("The day to get the schedule for").setRequired(true),
        )
        .addUserOption((option) =>
          option.setName("user").setDescription("The user to get the schedule for"),
        )
        .addStringOption(serverIdOption("The server to get the schedule for")),
    Effect.fn("schedule.list")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const guildId = yield* resolveGuildId(command.optionValueOptional("server_id"));
      const day = yield* requireNumber(command.optionValue("day"), "day");
      const targetUser = yield* resolveTargetUserIdentity(command.optionUserValueOptional("user"));
      const base = yield* makeDispatchBase;

      yield* runSheetWorkflowsDispatch(
        response,
        "the schedule list",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.scheduleList({
            payload: {
              ...base,
              workspaceId: guildId,
              day,
              targetUserId: targetUser.id,
              targetUsername: targetUser.username,
            },
          }),
        )(),
      );
    }),
  );
});

export const scheduleCommandLayer = registerSingleSubCommandLayer({
  commandName: "schedule",
  commandDescription: "Schedule commands",
  subCommandName: "list",
  makeSubCommand: makeListSubCommand,
});
