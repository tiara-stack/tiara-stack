import {
  ApplicationCommandOptionType,
  ButtonStyle,
  ChannelType,
  ComponentType,
} from "discord-api-types/v10";
import { Effect } from "effect";
import { expectError, expectType } from "tsd";
import { CommandHelper } from "dfx-discord-utils/utils";
import {
  ActionRowBuilder,
  ButtonBuilder,
  CommandBuilder,
  type MessageActionRowComponentBuilder,
} from "dfx-discord-utils/utils/builders";

const command = new CommandBuilder()
  .setName("search")
  .setDescription("Search the index")
  .addStringOption((option) =>
    option
      .setName("query")
      .setDescription("Search query")
      .setRequired(true)
      .addChoices({ name: "Docs", value: "docs" }),
  )
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("Result channel")
      .addChannelTypes(ChannelType.GuildText),
  );

expectType<{
  name: "search";
  description: "Search the index";
  options: [
    {
      type: ApplicationCommandOptionType.String;
      name: "query";
      description: "Search query";
      required: true;
      choices: readonly [{ readonly name: "Docs"; readonly value: "docs" }];
    },
    {
      type: ApplicationCommandOptionType.Channel;
      name: "channel";
      description: "Result channel";
      channel_types: readonly [ChannelType.GuildText];
    },
  ];
}>(command.toJSON());

const subcommands = new CommandBuilder()
  .setName("admin")
  .setDescription("Administration")
  .addSubcommand((subcommand) =>
    subcommand.setName("refresh").setDescription("Refresh cached state"),
  );

expectType<{
  name: "admin";
  description: "Administration";
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand;
      name: "refresh";
      description: "Refresh cached state";
    },
  ];
}>(subcommands.toJSON());

CommandHelper.makeSubCommand(
  (subcommand) =>
    subcommand
      .setName("search")
      .setDescription("Search the index")
      .addStringOption((option) =>
        option.setName("query").setDescription("Search query").setRequired(true),
      ),
  (commandHelper) => {
    expectType<string>(commandHelper.optionValue("query"));
    expectError(commandHelper.optionValue("missing"));
    return Effect.void;
  },
);

const button = new ButtonBuilder()
  .setCustomId("approve")
  .setLabel("Approve")
  .setStyle(ButtonStyle.Success)
  .setDisabled(false);

expectType<{
  type: ComponentType.Button;
  custom_id: "approve";
  label: "Approve";
  style: ButtonStyle.Success;
  disabled: false;
}>(button.toJSON());

const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button);

expectType<{
  type: ComponentType.ActionRow;
  components: [
    {
      type: ComponentType.Button;
      custom_id: "approve";
      label: "Approve";
      style: ButtonStyle.Success;
      disabled: false;
    },
  ];
}>(row.toJSON());

expectError(new ButtonBuilder().setStyle("primary"));
expectError(new ButtonBuilder().setStyle(999));
expectError(
  new CommandBuilder().addStringOption((option) => option.addChoices({ name: "one", value: 1 })),
);
expectError(
  new CommandBuilder().addChannelOption((option) => option.addChannelTypes(ChannelType.DM)),
);
expectError(
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(new CommandBuilder()),
);
expectError(
  new CommandBuilder().addStringOption((option) => option.setName("query")).addSubcommand,
);
