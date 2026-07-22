import { MessageFlags } from "discord-api-types/v10";
import { Effect } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import {
  makeDispatchBase,
  optionalPayloadField,
  resolveConversationTarget,
} from "../utils/commandHelpers";
import { registerSingleSubCommandLayer } from "../utils/registerGlobalCommandLayer";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";

const makeManualSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

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

      const channelNameOption = command.optionValueOptional("channel_name");
      const target = yield* resolveConversationTarget(
        command.optionValueOptional("server_id"),
        channelNameOption,
      );
      const base = yield* makeDispatchBase;
      yield* runSheetWorkflowsDispatch(
        response,
        "the room order",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.roomOrder({
            payload: {
              ...base,
              ...target,
              ...optionalPayloadField("hour", command.optionValueOptional("hour")),
              ...optionalPayloadField("healNeeded", command.optionValueOptional("heal")),
            },
          }),
        )(),
      );
    }),
  );
});

export const roomOrderCommandLayer = registerSingleSubCommandLayer({
  commandName: "room_order",
  commandDescription: "Room order commands",
  subCommandName: "manual",
  makeSubCommand: makeManualSubCommand,
});
