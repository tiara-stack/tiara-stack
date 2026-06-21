// fallow-ignore-file code-duplication
import { Effect } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import {
  makeDispatchBase,
  optionalPayloadField,
  resolveConversationTarget,
} from "../utils/commandHelpers";
import {
  makeSingleSubCommand,
  registerGlobalCommandLayer,
} from "../utils/registerGlobalCommandLayer";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";

const makeManualSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

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
    Effect.fn("kickout.manual")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const channelNameOption = command.optionValueOptional("channel_name");
      const target = yield* resolveConversationTarget(
        command.optionValueOptional("server_id"),
        channelNameOption,
      );
      const base = yield* makeDispatchBase;
      yield* runSheetWorkflowsDispatch(
        response,
        "the kickout",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.kickout({
            payload: {
              ...base,
              ...target,
              ...optionalPayloadField("hour", command.optionValueOptional("hour")),
            },
          }),
        )(),
      );
    }),
  );
});

const makeKickoutCommand = makeSingleSubCommand({
  commandName: "kickout",
  commandDescription: "Kick out commands",
  subCommandName: "manual",
  makeSubCommand: makeManualSubCommand,
});

export const kickoutCommandLayer = registerGlobalCommandLayer(makeKickoutCommand);
