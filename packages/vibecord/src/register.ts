import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { DiscordREST, DiscordRESTMemoryLive } from "dfx";
import { Effect, Layer, pipe } from "effect";
import { sessionCommandData, workspaceCommandData } from "./commands";
import { DiscordApplication } from "dfx-discord-utils/discord";
import { discordApplicationLayer } from "./discord/application";
import { discordConfigLayer } from "./discord/config";

const program = Effect.gen(function* () {
  const application = yield* DiscordApplication;
  const rest = yield* DiscordREST;
  const commands = yield* Effect.all([workspaceCommandData, sessionCommandData]);

  console.log("Started refreshing application (/) commands.");
  yield* rest.bulkSetApplicationCommands(application.id, commands);
  console.log("Successfully reloaded application (/) commands.");
});

pipe(
  program,
  Effect.provide(
    Layer.mergeAll(
      discordApplicationLayer,
      DiscordRESTMemoryLive.pipe(Layer.provide(discordConfigLayer)),
    ).pipe(Layer.provideMerge(NodeHttpClient.layerFetch)),
  ),
  Effect.scoped,
  NodeRuntime.runMain(),
);
