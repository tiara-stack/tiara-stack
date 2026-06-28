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

type PreferenceDmKind = "checkin" | "monitor";

const dmKindLabels = {
  checkin: "check-in DM reminders",
  monitor: "monitor DM pings",
} satisfies Record<PreferenceDmKind, string>;

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

const dmKindLabel = (kind: PreferenceDmKind) => dmKindLabels[kind];

const makeStatusSubCommand = (kind: PreferenceDmKind) =>
  Effect.gen(function* () {
    const sheetWorkflowsClient = yield* SheetWorkflowsClient;

    return yield* CommandHelper.makeSubCommand(
      (builder) =>
        builder
          .setName("status")
          .setDescription(`Show ${dmKindLabel(kind)} preferences`)
          .addStringOption(platformOption("The platform to inspect")),
      Effect.fn(`preference.${kind}Dm.status`)(function* (command) {
        const base = yield* makeDispatchBase;
        const platform = selectedPlatform(command.optionValueOptional("platform"));

        yield* dispatchPreferenceCommand(
          `the ${dmKindLabel(kind)} preference status check`,
          SheetWorkflowsRequestContext.asInteractionUser(() =>
            sheetWorkflowsClient.get().dispatch.preferenceDmStatus({
              payload: { ...base, kind, platform },
            }),
          )(),
        );
      }),
    );
  });

const makeEnableSubCommand = (kind: PreferenceDmKind) =>
  Effect.gen(function* () {
    const sheetWorkflowsClient = yield* SheetWorkflowsClient;

    return yield* CommandHelper.makeSubCommand(
      (builder) =>
        builder
          .setName("enable")
          .setDescription(`Enable ${dmKindLabel(kind)}`)
          .addStringOption(platformOption("The platform to configure"))
          .addStringOption((option) =>
            option.setName("client_id").setDescription("The bot client id to send DMs from"),
          ),
      Effect.fn(`preference.${kind}Dm.enable`)(function* (command) {
        const base = yield* makeDispatchBase;
        const platform = selectedPlatform(command.optionValueOptional("platform"));
        const clientIdOption = command.optionValueOptional("client_id");
        const defaultClientId = Option.isSome(clientIdOption)
          ? clientIdOption.value
          : yield* config.sheetBotClientId;

        yield* dispatchPreferenceCommand(
          `the ${dmKindLabel(kind)} preference enable update`,
          SheetWorkflowsRequestContext.asInteractionUser(() =>
            sheetWorkflowsClient.get().dispatch.preferenceDmEnable({
              payload: { ...base, kind, platform, defaultClientId },
            }),
          )(),
        );
      }),
    );
  });

const makeDisableSubCommand = (kind: PreferenceDmKind) =>
  Effect.gen(function* () {
    const sheetWorkflowsClient = yield* SheetWorkflowsClient;

    return yield* CommandHelper.makeSubCommand(
      (builder) =>
        builder
          .setName("disable")
          .setDescription(`Disable ${dmKindLabel(kind)}`)
          .addStringOption(platformOption("The platform to configure")),
      Effect.fn(`preference.${kind}Dm.disable`)(function* (command) {
        const base = yield* makeDispatchBase;
        const platform = selectedPlatform(command.optionValueOptional("platform"));

        yield* dispatchPreferenceCommand(
          `the ${dmKindLabel(kind)} preference disable update`,
          SheetWorkflowsRequestContext.asInteractionUser(() =>
            sheetWorkflowsClient.get().dispatch.preferenceDmDisable({
              payload: { ...base, kind, platform },
            }),
          )(),
        );
      }),
    );
  });

const makeDmKindCommandGroup = (params: {
  readonly groupName: string;
  readonly description: string;
  readonly kind: PreferenceDmKind;
}) =>
  Effect.gen(function* () {
    const statusSubCommand = yield* makeStatusSubCommand(params.kind);
    const enableSubCommand = yield* makeEnableSubCommand(params.kind);
    const disableSubCommand = yield* makeDisableSubCommand(params.kind);

    return yield* CommandHelper.makeSubCommandGroup(
      (builder) =>
        builder
          .setName(params.groupName)
          .setDescription(params.description)
          .addSubcommand(() => statusSubCommand.data)
          .addSubcommand(() => enableSubCommand.data)
          .addSubcommand(() => disableSubCommand.data),
      (command) =>
        command.subCommands({
          status: statusSubCommand.handler,
          enable: enableSubCommand.handler,
          disable: disableSubCommand.handler,
        }),
    );
  });

const makeClientSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("client")
        .setDescription("Set the default DM client")
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
  const clientSubCommand = yield* makeClientSubCommand;

  return yield* CommandHelper.makeSubCommandGroup(
    (builder) =>
      builder
        .setName("dm")
        .setDescription("Configure shared DM delivery settings")
        .addSubcommand(() => clientSubCommand.data),
    (command) =>
      command.subCommands({
        client: clientSubCommand.handler,
      }),
  );
});

const makePreferenceCommand = Effect.gen(function* () {
  const checkinDmCommandGroup = yield* makeDmKindCommandGroup({
    groupName: "checkin-dm",
    description: "Configure check-in DM reminders",
    kind: "checkin",
  });
  const monitorDmCommandGroup = yield* makeDmKindCommandGroup({
    groupName: "monitor-dm",
    description: "Configure monitor DM pings",
    kind: "monitor",
  });
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
        .addSubcommandGroup(() => checkinDmCommandGroup.data)
        .addSubcommandGroup(() => monitorDmCommandGroup.data)
        .addSubcommandGroup(() => dmCommandGroup.data),
    (command) =>
      command.subCommands({
        "checkin-dm": checkinDmCommandGroup.handler,
        "monitor-dm": monitorDmCommandGroup.handler,
        dm: dmCommandGroup.handler,
      }),
  );
});

export const preferenceCommandLayer = registerGlobalCommandLayer(makePreferenceCommand);
