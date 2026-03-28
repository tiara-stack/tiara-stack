import { REST, Routes } from "discord.js";
import { Config } from "./config/config";
import { commands } from "./commands";
import { Effect, pipe } from "effect";
import { DISCORD_API_VERSION } from "./constants";

const program = pipe(
  Effect.gen(function* () {
    const config = yield* Config;

    const rest = new REST({ version: DISCORD_API_VERSION }).setToken(config.discordToken);

    console.log("Started refreshing application (/) commands.");

    yield* Config.use(async (config) => {
      await rest.put(Routes.applicationCommands(config.discordClientId), {
        body: commands.map((cmd) => cmd.data.toJSON()),
      });
    });

    console.log("Successfully reloaded application (/) commands.");
  }),
  Effect.provide(Config.Default),
);

void Effect.runPromise(program);
