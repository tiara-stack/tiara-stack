import {
  Client,
  GatewayIntentBits,
  Collection,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { Config } from "../config/config";
import { commands } from "../commands/index";
import { sdkClient } from "../sdk/index";
import { Effect, pipe } from "effect";
import { APPLICATION_COMMAND_OPTION_TYPE } from "../constants";

// Properly typed command interface
interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// Command option type from Discord.js
interface CommandOption {
  type: number;
  name: string;
  options?: CommandOption[];
}

// JSON representation of command data
interface CommandJson {
  name: string;
  options?: CommandOption[];
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const commandMap = new Collection<string, Command>();

for (const cmd of commands) {
  const command = cmd as Command;
  const json = command.data.toJSON() as CommandJson;

  if (json.options) {
    for (const option of json.options) {
      if (option.type === APPLICATION_COMMAND_OPTION_TYPE.SUB_COMMAND) {
        commandMap.set(`${json.name} ${option.name}`, command);
      } else if (
        option.type === APPLICATION_COMMAND_OPTION_TYPE.SUB_COMMAND_GROUP &&
        option.options
      ) {
        for (const subOption of option.options) {
          if (subOption.type === APPLICATION_COMMAND_OPTION_TYPE.SUB_COMMAND) {
            commandMap.set(`${json.name} ${option.name} ${subOption.name}`, command);
          }
        }
      }
    }
  } else {
    commandMap.set(json.name, command);
  }
}

const botProgram = pipe(
  Effect.gen(function* () {
    client.on("ready", async () => {
      console.log(`Logged in as ${client.user?.tag}!`);

      await client.application?.fetch();
      console.log(`Owner ID: ${client.application?.owner?.id}`);

      // Set Discord client for SDK client to use for thread lookups
      sdkClient.setDiscordClient(client);

      // Connect to OpenCode SDK
      try {
        await sdkClient.connect();
      } catch (err) {
        console.error("Failed to connect to OpenCode:", err);
      }
    });

    client.on("interactionCreate", async (interaction) => {
      // Handle button interactions first
      if (interaction.isButton()) {
        const permissionHandled = await sdkClient.handlePermissionButton(interaction);
        if (permissionHandled) return;

        const questionHandled = await sdkClient.handleQuestionButton(interaction);
        if (questionHandled) return;
      }

      if (!interaction.isChatInputCommand()) return;

      const commandName = interaction.commandName;
      const subcommand = interaction.options.getSubcommand(false);
      const subcommandGroup = interaction.options.getSubcommandGroup(false);

      let key: string;
      if (subcommandGroup && subcommand) {
        key = `${commandName} ${subcommandGroup} ${subcommand}`;
      } else if (subcommand) {
        key = `${commandName} ${subcommand}`;
      } else {
        key = commandName;
      }

      const cmd = commandMap.get(key);
      if (cmd) {
        await cmd.execute(interaction);
      }
    });

    const config = yield* Config;
    yield* Effect.tryPromise(() => client.login(config.discordToken));
  }),
  Effect.provide(Config.Default),
);

void Effect.runPromise(botProgram);
