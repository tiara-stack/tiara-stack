import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { Effect, Option } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import type { StringOptionBuilder } from "dfx-discord-utils/utils";
import { config } from "../config";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";
import { makeDispatchBase } from "../utils/commandHelpers";
import { registerGlobalCommandLayer } from "../utils/registerGlobalCommandLayer";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";

const platformOption = (description: string) => (option: StringOptionBuilder) =>
  option
    .setName("platform")
    .setDescription(description)
    .addChoices({ name: "discord", value: "discord" });

const selectedPlatform = (platform: Option.Option<string>) =>
  Option.getOrElse(platform, () => "discord");

const dispatchPreferenceCommand = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const response = yield* InteractionResponse;
    yield* response.deferReply({ flags: MessageFlags.Ephemeral });
    yield* runSheetWorkflowsDispatch(response, operation, effect);
  });

const makeStatusSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("status")
        .setDescription("Show check-in DM reminder preferences")
        .addStringOption(platformOption("The platform to inspect")),
    Effect.fn("preference.dm.status")(function* (command) {
      const base = yield* makeDispatchBase;
      const platform = selectedPlatform(command.optionValueOptional("platform"));

      yield* dispatchPreferenceCommand(
        "the DM preference status check",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.preferenceDmStatus({
            payload: { ...base, platform },
          }),
        )(),
      );
    }),
  );
});

const makeEnableSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("enable")
        .setDescription("Enable check-in DM reminders")
        .addStringOption(platformOption("The platform to configure"))
        .addStringOption((option) =>
          option.setName("client_id").setDescription("The bot client id to send DMs from"),
        ),
    Effect.fn("preference.dm.enable")(function* (command) {
      const base = yield* makeDispatchBase;
      const platform = selectedPlatform(command.optionValueOptional("platform"));
      const clientIdOption = command.optionValueOptional("client_id");
      const defaultClientId = Option.isSome(clientIdOption)
        ? clientIdOption.value
        : yield* config.sheetBotClientId;

      yield* dispatchPreferenceCommand(
        "the DM preference enable update",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.preferenceDmEnable({
            payload: { ...base, platform, defaultClientId },
          }),
        )(),
      );
    }),
  );
});

const makeDisableSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("disable")
        .setDescription("Disable check-in DM reminders")
        .addStringOption(platformOption("The platform to configure")),
    Effect.fn("preference.dm.disable")(function* (command) {
      const base = yield* makeDispatchBase;
      const platform = selectedPlatform(command.optionValueOptional("platform"));

      yield* dispatchPreferenceCommand(
        "the DM preference disable update",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.preferenceDmDisable({
            payload: { ...base, platform },
          }),
        )(),
      );
    }),
  );
});

const makeClientSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("client")
        .setDescription("Set the default check-in DM client")
        .addStringOption((option) =>
          option
            .setName("client_id")
            .setDescription("The bot client id to send DMs from")
            .setRequired(true),
        )
        .addStringOption(platformOption("The platform to configure")),
    Effect.fn("preference.dm.client")(function* (command) {
      const base = yield* makeDispatchBase;
      const platform = selectedPlatform(command.optionValueOptional("platform"));
      const defaultClientId = command.optionValue("client_id");

      yield* dispatchPreferenceCommand(
        "the DM preference client update",
        SheetWorkflowsRequestContext.asInteractionUser(() =>
          sheetWorkflowsClient.get().dispatch.preferenceDmSetClient({
            payload: { ...base, platform, defaultClientId },
          }),
        )(),
      );
    }),
  );
});

const makeDmCommandGroup = Effect.gen(function* () {
  const statusSubCommand = yield* makeStatusSubCommand;
  const enableSubCommand = yield* makeEnableSubCommand;
  const disableSubCommand = yield* makeDisableSubCommand;
  const clientSubCommand = yield* makeClientSubCommand;

  return yield* CommandHelper.makeSubCommandGroup(
    (builder) =>
      builder
        .setName("dm")
        .setDescription("Configure check-in DM reminders")
        .addSubcommand(() => statusSubCommand.data)
        .addSubcommand(() => enableSubCommand.data)
        .addSubcommand(() => disableSubCommand.data)
        .addSubcommand(() => clientSubCommand.data),
    (command) =>
      command.subCommands({
        status: statusSubCommand.handler,
        enable: enableSubCommand.handler,
        disable: disableSubCommand.handler,
        client: clientSubCommand.handler,
      }),
  );
});

const makePreferenceCommand = Effect.gen(function* () {
  const dmCommandGroup = yield* makeDmCommandGroup;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("preference")
        .setDescription("Configure personal Sheet preferences")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        )
        .addSubcommandGroup(() => dmCommandGroup.data),
    (command) =>
      command.subCommands({
        dm: dmCommandGroup.handler,
      }),
  );
});

export const preferenceCommandLayer = registerGlobalCommandLayer(makePreferenceCommand);
