import { InteractionsRegistry } from "dfx/gateway";
import { DiscordREST, Ix } from "dfx";
import { MessageFlags } from "discord-api-types/v10";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { DiscordApplication } from "dfx-discord-utils/discord";
import { CommandHelper, Interaction, InteractionResponse } from "dfx-discord-utils/utils";
import { getDb, schema } from "../../db/index";
import { discordApplicationLayer } from "../../discord/application";
import { discordGatewayLayer } from "../../discord/gateway";
import { createOrUpdateWorkspace, getWorkspaceByUserAndName } from "../../services/workspace";
import { requireOwner } from "../../utils";

const getInteractionUserId = Effect.gen(function* () {
  const user = yield* Interaction.user();
  return (user as { id: string }).id;
});

const makeAddSubCommand = Effect.gen(function* () {
  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("add")
        .setDescription("Add a workspace")
        .addStringOption((option) =>
          option.setName("name").setDescription("Workspace name").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("cwd").setDescription("Working directory").setRequired(true),
        ),
    Effect.fn("workspace.add")(function* (command) {
      const response = yield* InteractionResponse;
      const userId = yield* getInteractionUserId;
      if (!(yield* requireOwner(userId, response))) {
        return;
      }

      const name = command.optionValue("name");
      const cwd = command.optionValue("cwd");
      const { action } = yield* Effect.tryPromise(() =>
        createOrUpdateWorkspace(userId, name, cwd),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = error instanceof Error ? error.message : "Unknown error";
            yield* response.reply({
              content: `Failed to save workspace "${name}": ${message}`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      yield* response.reply({
        content:
          action === "updated" ? `Workspace "${name}" updated!` : `Workspace "${name}" added!`,
      });
    }),
  );
});

const makeRemoveSubCommand = Effect.gen(function* () {
  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("remove")
        .setDescription("Remove a workspace")
        .addStringOption((option) =>
          option.setName("name").setDescription("Workspace name").setRequired(true),
        ),
    Effect.fn("workspace.remove")(function* (command) {
      const response = yield* InteractionResponse;
      const userId = yield* getInteractionUserId;
      if (!(yield* requireOwner(userId, response))) {
        return;
      }

      const name = command.optionValue("name");
      const workspace = yield* Effect.tryPromise(() =>
        getWorkspaceByUserAndName(userId, name),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = error instanceof Error ? error.message : "Unknown error";
            yield* response.reply({
              content: `Failed to load workspace "${name}": ${message}`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );

      if (!workspace) {
        yield* response.reply({
          content: `Workspace "${name}" not found!`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      yield* Effect.tryPromise(() =>
        getDb()
          .update(schema.workspace)
          .set({ deletedAt: new Date() })
          .where(and(eq(schema.workspace.userId, userId), eq(schema.workspace.name, name))),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = error instanceof Error ? error.message : "Unknown error";
            yield* response.reply({
              content: `Failed to remove workspace "${name}": ${message}`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      yield* response.reply({ content: `Workspace "${name}" removed!` });
    }),
  );
});

const makeWorkspaceCommand = Effect.gen(function* () {
  const addSubCommand = yield* makeAddSubCommand;
  const removeSubCommand = yield* makeRemoveSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("workspace")
        .setDescription("Manage workspaces")
        .addSubcommand(() => addSubCommand.data)
        .addSubcommand(() => removeSubCommand.data),
    (command) =>
      command.subCommands({
        add: addSubCommand.handler,
        remove: removeSubCommand.handler,
      }),
  );
});

export const workspaceCommandData = Effect.map(makeWorkspaceCommand, (command) => command.data);

export const workspaceCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeWorkspaceCommand;
    const rest = yield* DiscordREST;
    const application = yield* DiscordApplication;
    yield* registry.register(
      Ix.builder
        .add(
          CommandHelper.makeGlobalCommand(command.data, (helper) =>
            command
              .handler(helper)
              .pipe(
                Effect.provideService(DiscordREST, rest),
                Effect.provideService(DiscordApplication, application),
              ),
          ),
        )
        .catchAllCause(Effect.log),
    );
  }),
).pipe(Layer.provide(Layer.mergeAll(discordGatewayLayer, discordApplicationLayer)));
