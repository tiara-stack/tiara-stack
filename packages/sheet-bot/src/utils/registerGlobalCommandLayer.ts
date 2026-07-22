import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { InteractionsRegistry } from "dfx/gateway";
import { Ix } from "dfx/index";
import { CommandHelper } from "dfx-discord-utils/utils";
import { Effect, Layer } from "effect";
import { discordApplicationLayer } from "../discord/application";
import { discordGatewayLayer } from "../discord/gateway";
import { SheetWorkflowsClient } from "../services";

type BuiltCommand = {
  readonly data: Parameters<typeof CommandHelper.makeGlobalCommand>[0];
  readonly handler: Parameters<typeof CommandHelper.makeGlobalCommand>[1];
};

type BuiltSubCommand = Effect.Success<ReturnType<typeof CommandHelper.makeSubCommand>>;

const makeSingleSubCommand = <
  const CommandName extends string,
  const CommandDescription extends string,
  const SubCommandName extends string,
  E,
  R,
>({
  commandName,
  commandDescription,
  subCommandName,
  makeSubCommand,
}: {
  readonly commandName: CommandName;
  readonly commandDescription: CommandDescription;
  readonly subCommandName: SubCommandName;
  readonly makeSubCommand: Effect.Effect<BuiltSubCommand, E, R>;
}) =>
  Effect.gen(function* () {
    const subCommand = yield* makeSubCommand;

    return yield* CommandHelper.makeCommand(
      (builder) =>
        builder
          .setName(commandName)
          .setDescription(commandDescription)
          .setIntegrationTypes(
            ApplicationIntegrationType.GuildInstall,
            ApplicationIntegrationType.UserInstall,
          )
          .setContexts(
            InteractionContextType.BotDM,
            InteractionContextType.Guild,
            InteractionContextType.PrivateChannel,
          )
          .addSubcommand(() => subCommand.data as never) as never,
      (command) =>
        command.subCommands({
          [subCommandName]: subCommand.handler,
        } as never),
    );
  });

export const registerGlobalCommandLayer = <E, R>(makeCommand: Effect.Effect<BuiltCommand, E, R>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* InteractionsRegistry;
      const commandDefinition = yield* makeCommand;
      const command = CommandHelper.makeGlobalCommand(
        commandDefinition.data,
        commandDefinition.handler as never,
      );

      yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetWorkflowsClient.layer),
    ),
  );

export const registerSingleSubCommandLayer = <
  const CommandName extends string,
  const CommandDescription extends string,
  const SubCommandName extends string,
  E,
  R,
>(options: {
  readonly commandName: CommandName;
  readonly commandDescription: CommandDescription;
  readonly subCommandName: SubCommandName;
  readonly makeSubCommand: Effect.Effect<BuiltSubCommand, E, R>;
}) => registerGlobalCommandLayer(makeSingleSubCommand(options));
