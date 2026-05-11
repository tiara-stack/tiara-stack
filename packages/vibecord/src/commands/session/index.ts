import { InteractionsRegistry } from "dfx/gateway";
import { Discord, DiscordREST, Ix } from "dfx";
import { MessageFlags } from "discord-api-types/v10";
import { Effect, Layer, Option } from "effect";
import { DiscordApplication } from "dfx-discord-utils/discord";
import { CommandHelper, Interaction, InteractionResponse } from "dfx-discord-utils/utils";
import { sdkClient } from "../../sdk/index";
import { requireOwner } from "../../utils";
import { closeSession, getValidSessionByThreadId, getWorkspaceById } from "../../services/session";
import { getValidWorkspaceByUserAndName } from "../../services/workspace";
import { createWorktree, isGitRepository, removeWorktree } from "../../services/git";
import { getDb, schema } from "../../db/index";
import simpleGit from "simple-git";
import { discordGatewayLayer } from "../../discord/gateway";
import { discordApplicationLayer } from "../../discord/application";

const getInteractionUserId = Effect.gen(function* () {
  const user = yield* Interaction.user();
  return (user as { id: string }).id;
});

const getInteractionChannelId = () =>
  Effect.gen(function* () {
    const response = yield* InteractionResponse;
    const channel = yield* Interaction.channel();
    if (Option.isSome(channel)) {
      return (channel.value as { id: string }).id;
    }

    yield* response.reply({
      content: "This command must be used in a Discord channel.",
      flags: MessageFlags.Ephemeral,
    });
    return undefined;
  });

const makeNewSubCommand = Effect.gen(function* () {
  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("new")
        .setDescription("Create a new session")
        .addStringOption((option) =>
          option.setName("workspace").setDescription("Workspace name").setRequired(true),
        )
        .addBooleanOption((option) =>
          option
            .setName("use_worktree")
            .setDescription("Create a git worktree for this session (if workspace is a git repo)"),
        ),
    Effect.fn("session.new")(function* (command) {
      const response = yield* InteractionResponse;
      const rest = yield* DiscordREST;
      const userId = yield* getInteractionUserId;
      if (!(yield* requireOwner(userId, response))) {
        return;
      }

      const workspaceName = command.optionValue("workspace");
      const useWorktree = command
        .optionValueOptional("use_worktree")
        .pipe(Option.getOrElse(() => false));

      const { workspace, error } = yield* Effect.tryPromise(() =>
        getValidWorkspaceByUserAndName(userId, workspaceName),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.reply({
              content: `Failed to load workspace: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      if (error || !workspace) {
        yield* response.reply({ content: error ?? "Unknown error", flags: MessageFlags.Ephemeral });
        return;
      }

      const channelId = yield* getInteractionChannelId();
      if (!channelId) {
        return;
      }

      yield* response.deferReply();

      const threadName = `session-${workspaceName}-${Date.now()}`;
      const thread = yield* rest
        .createThread(channelId, {
          name: threadName,
          type: Discord.ChannelTypes.PUBLIC_THREAD,
        })
        .pipe(
          Effect.catchCause((cause) =>
            response
              .editReply({
                payload: {
                  content:
                    "Failed to create session thread. Make sure I can create public threads in this channel.",
                },
              })
              .pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );

      let worktreePath: string | null = null;
      let worktreeBranchName: string | null = null;

      const shouldUseWorktree =
        useWorktree &&
        (yield* Effect.tryPromise(() => isGitRepository(workspace.cwd)).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* rest.deleteChannel(thread.id).pipe(Effect.catch(() => Effect.void));
              yield* response.editReply({
                payload: {
                  content: `Failed to inspect workspace git repository: ${
                    error instanceof Error ? error.message : "Unknown error"
                  }\n\nSession creation aborted.`,
                },
              });
              return yield* Effect.fail(error);
            }),
          ),
        ));

      if (shouldUseWorktree) {
        const worktreeResult = yield* Effect.tryPromise(() =>
          createWorktree(workspace.cwd, thread.id),
        ).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* rest.deleteChannel(thread.id).pipe(Effect.catch(() => Effect.void));
              yield* response.editReply({
                payload: {
                  content: `Failed to create git worktree: ${
                    error instanceof Error ? error.message : "Unknown error"
                  }\n\nSession creation aborted.`,
                },
              });
              return yield* Effect.fail(error);
            }),
          ),
        );
        if (worktreeResult.error) {
          yield* rest.deleteChannel(thread.id).pipe(Effect.catch(() => Effect.void));
          yield* response.editReply({
            payload: {
              content: `Failed to create git worktree: ${worktreeResult.error}\n\nSession creation aborted.`,
            },
          });
          return;
        }
        worktreePath = worktreeResult.worktreePath;
        worktreeBranchName = worktreeResult.branchName;
      }

      const sessionCwd = worktreePath ?? workspace.cwd;
      const sessionResponse = yield* Effect.tryPromise({
        try: () => sdkClient.createSession(sessionCwd),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (worktreePath) {
              const git = simpleGit(workspace.cwd);
              yield* Effect.promise(() =>
                git.raw(["worktree", "remove", worktreePath!]).catch(() => ""),
              );
              yield* Effect.promise(() =>
                git.raw(["branch", "-D", worktreeBranchName!]).catch(() => ""),
              );
            }
            yield* rest.deleteChannel(thread.id).pipe(Effect.catch(() => Effect.void));
            yield* response.editReply({
              payload: {
                content: `Failed to create SDK session: ${
                  error instanceof Error ? error.message : "Unknown error"
                }\n\nSession creation aborted.`,
              },
            });
            return yield* Effect.fail(error);
          }),
        ),
      );

      const sdkSessionId = sessionResponse.sessionId;
      const currentModelId = sessionResponse.models?.currentModelId;
      const availableModels = sessionResponse.models?.availableModels ?? [];
      const currentModeId = sessionResponse.modes?.currentModeId;
      const availableModes = sessionResponse.modes?.availableModes ?? [];
      const currentModel = currentModelId
        ? (availableModels.find((m) => m.modelId === currentModelId)?.name ?? currentModelId)
        : "Unknown";
      const currentMode = currentModeId
        ? (availableModes.find((m) => m.id === currentModeId)?.name ?? currentModeId)
        : "Unknown";

      yield* Effect.tryPromise(() =>
        getDb().insert(schema.session).values({
          workspaceId: workspace.id,
          threadId: thread.id,
          acpSessionId: sdkSessionId,
          worktreePath,
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              sdkClient.deleteSession(sdkSessionId, sessionCwd).catch(() => undefined),
            );
            if (worktreePath) {
              const git = simpleGit(workspace.cwd);
              yield* Effect.promise(() =>
                git.raw(["worktree", "remove", worktreePath!]).catch(() => ""),
              );
              yield* Effect.promise(() =>
                git.raw(["branch", "-D", worktreeBranchName!]).catch(() => ""),
              );
            }
            yield* rest.deleteChannel(thread.id).pipe(Effect.catch(() => Effect.void));
            yield* response.editReply({
              payload: {
                content: `Failed to save session: ${
                  error instanceof Error ? error.message : "Unknown error"
                }\n\nSession creation aborted.`,
              },
            });
            return yield* Effect.fail(error);
          }),
        ),
      );

      const modelsList =
        availableModels.length > 0
          ? availableModels
              .map(
                (m: { modelId: string; name: string; description?: string }) =>
                  `  - ${m.name}${m.description ? ` (${m.description})` : ""}`,
              )
              .join("\n")
          : "  No models available";
      const modesList =
        availableModes.length > 0
          ? availableModes
              .map(
                (m: { id: string; name: string; description?: string }) =>
                  `  - ${m.name}${m.description ? ` (${m.description})` : ""}`,
              )
              .join("\n")
          : "  No modes available";
      const worktreeInfo =
        worktreePath && worktreeBranchName
          ? `\n**Git Worktree:**\n- Path: \`${worktreePath}\`\n- Branch: \`${worktreeBranchName}\`\n`
          : "";

      const welcomeSent = yield* rest
        .createMessage(thread.id, {
          content:
            `## New Session Created\n` +
            `**Workspace:** ${workspaceName}\n` +
            `**CWD:** ${sessionCwd}\n` +
            `**Session ID:** ${sdkSessionId}\n` +
            worktreeInfo +
            `\n### Current Settings\n` +
            `**Model:** ${currentModel}\n` +
            `**Mode:** ${currentMode}\n\n` +
            `### Available Models\n` +
            `${modelsList}\n\n` +
            `### Available Modes\n` +
            `${modesList}\n\n` +
            `Use \`/session close\` in this thread to close the session and remove the worktree.`,
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* Effect.logError(
                `Failed to send session welcome message: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              );
              return false;
            }),
          ),
        );

      const confirmation = welcomeSent
        ? `Session created! See <#${thread.id}>`
        : `Session created! See <#${thread.id}>\n\nWarning: failed to send the welcome message in the thread.`;

      yield* response.editReply({ payload: { content: confirmation } }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const application = yield* DiscordApplication;
            const interaction = yield* Ix.Interaction;
            yield* rest
              .executeWebhook(application.id, interaction.token, {
                payload: { content: confirmation },
              })
              .pipe(Effect.catch(() => Effect.void));
            return yield* Effect.fail(error);
          }),
        ),
      );
    }),
  );
});

const makeCloseSubCommand = Effect.gen(function* () {
  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("close")
        .setDescription("Close the current session and remove the git worktree if one exists"),
    Effect.fn("session.close")(function* () {
      const response = yield* InteractionResponse;
      const rest = yield* DiscordREST;
      if (!(yield* requireOwner(yield* getInteractionUserId, response))) {
        return;
      }

      const threadId = yield* getInteractionChannelId();
      if (!threadId) {
        return;
      }

      yield* response.deferReply();
      const { session, error } = yield* Effect.tryPromise(() =>
        getValidSessionByThreadId(threadId),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.editReply({
              payload: {
                content: `Failed to load session: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      if (error || !session) {
        yield* response.editReply({ payload: { content: error ?? "Unknown error" } });
        return;
      }

      const workspace = yield* Effect.tryPromise(() => getWorkspaceById(session.workspaceId)).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.editReply({
              payload: {
                content: `Failed to load workspace: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      if (!workspace) {
        yield* response.editReply({
          payload: { content: "Workspace not found for this session." },
        });
        return;
      }

      if (session.worktreePath) {
        const result = yield* Effect.tryPromise(() =>
          removeWorktree(workspace.cwd, session.worktreePath!),
        ).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* response.editReply({
                payload: {
                  content: `Failed to remove git worktree: ${
                    error instanceof Error ? error.message : "Unknown error"
                  }\n\nSession close aborted.`,
                },
              });
              return yield* Effect.fail(error);
            }),
          ),
        );
        if (!result.success) {
          yield* response.editReply({
            payload: {
              content: `Failed to remove git worktree: ${result.error}\n\nSession close aborted.`,
            },
          });
          return;
        }
      }

      const closeResult = yield* Effect.tryPromise(() => closeSession(session.id)).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.editReply({
              payload: {
                content: `Failed to close session: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              },
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      if (!closeResult.success) {
        yield* response.editReply({
          payload: { content: `Failed to close session: ${closeResult.error}` },
        });
        return;
      }

      let responseMessage = "Session closed successfully.";
      if (session.worktreePath) {
        responseMessage += `\nGit worktree at \`${session.worktreePath}\` has been removed.`;
      }

      const locked = yield* rest.updateChannel(threadId, { locked: true }).pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      );
      responseMessage += locked
        ? "\n\nThis thread has been locked."
        : "\n\nNote: Could not lock the thread.";

      yield* response.editReply({ payload: { content: responseMessage } });
    }),
  );
});

const makeSessionCommand = Effect.gen(function* () {
  const newSubCommand = yield* makeNewSubCommand;
  const closeSubCommand = yield* makeCloseSubCommand;

  const promptSubCommand = yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("prompt")
        .setDescription("Send a prompt to the session")
        .addStringOption((option) =>
          option.setName("text").setDescription("Prompt text").setRequired(true),
        ),
    Effect.fn("session.prompt")(function* (command) {
      const response = yield* InteractionResponse;
      if (!(yield* requireOwner(yield* getInteractionUserId, response))) {
        return;
      }
      const promptText = command.optionValue("text");
      const threadId = yield* getInteractionChannelId();
      if (!threadId) {
        return;
      }
      const { session, error } = yield* Effect.tryPromise(() =>
        getValidSessionByThreadId(threadId),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.reply({
              content: `Failed to load session: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      if (error || !session) {
        yield* response.reply({ content: error ?? "Unknown error", flags: MessageFlags.Ephemeral });
        return;
      }
      yield* Effect.tryPromise(() => sdkClient.sendPrompt(session.acpSessionId, promptText)).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.reply({
              content: `Failed to send prompt: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      yield* response.reply({ content: "Prompt sent to the session." });
    }),
  );

  const modelSetSubCommand = yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("set")
        .setDescription("Set the model")
        .addStringOption((option) =>
          option.setName("model").setDescription("Model name to set").setRequired(true),
        ),
    Effect.fn("session.model.set")(function* (command) {
      const response = yield* InteractionResponse;
      if (!(yield* requireOwner(yield* getInteractionUserId, response))) {
        return;
      }
      const modelName = command.optionValue("model");
      const threadId = yield* getInteractionChannelId();
      if (!threadId) {
        return;
      }
      const { session, error } = yield* Effect.tryPromise(() =>
        getValidSessionByThreadId(threadId),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.reply({
              content: `Failed to load session: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      if (error || !session) {
        yield* response.reply({ content: error ?? "Unknown error", flags: MessageFlags.Ephemeral });
        return;
      }
      const workspace = yield* Effect.tryPromise(() => getWorkspaceById(session.workspaceId)).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.reply({
              content: `Failed to load workspace: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      if (!workspace) {
        yield* response.reply({
          content: "Workspace not found for this session.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const sessionInfo = yield* Effect.tryPromise(() =>
        sdkClient.getSessionInfo(session.worktreePath ?? workspace.cwd),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.reply({
              content: `Failed to load session info: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      const model = sessionInfo.models.find(
        (m) => m.name.toLowerCase() === modelName.toLowerCase(),
      );
      if (!model) {
        yield* response.reply({
          content: `Model "${modelName}" not found. Available models: ${sessionInfo.models.map((m) => m.name).join(", ")}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      yield* Effect.tryPromise(() =>
        sdkClient.setSessionModel(session.acpSessionId, model.id),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.reply({
              content: `Failed to set model: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      yield* response.reply({ content: `Model set to "${model.name}" for this session.` });
    }),
  );

  const modeSetSubCommand = yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("set")
        .setDescription("Set the mode")
        .addStringOption((option) =>
          option.setName("mode").setDescription("Mode name to set").setRequired(true),
        ),
    Effect.fn("session.mode.set")(function* (command) {
      const response = yield* InteractionResponse;
      if (!(yield* requireOwner(yield* getInteractionUserId, response))) {
        return;
      }
      const modeName = command.optionValue("mode");
      const threadId = yield* getInteractionChannelId();
      if (!threadId) {
        return;
      }
      const { session, error } = yield* Effect.tryPromise(() =>
        getValidSessionByThreadId(threadId),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.reply({
              content: `Failed to load session: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      if (error || !session) {
        yield* response.reply({ content: error ?? "Unknown error", flags: MessageFlags.Ephemeral });
        return;
      }
      const workspace = yield* Effect.tryPromise(() => getWorkspaceById(session.workspaceId)).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.reply({
              content: `Failed to load workspace: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      if (!workspace) {
        yield* response.reply({
          content: "Workspace not found for this session.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const sessionInfo = yield* Effect.tryPromise(() =>
        sdkClient.getSessionInfo(session.worktreePath ?? workspace.cwd),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.reply({
              content: `Failed to load session info: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      const mode = sessionInfo.modes.find((m) => m.name.toLowerCase() === modeName.toLowerCase());
      if (!mode) {
        yield* response.reply({
          content: `Mode "${modeName}" not found. Available modes: ${sessionInfo.modes.map((m) => m.name).join(", ")}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      yield* Effect.tryPromise(() => sdkClient.setSessionMode(session.acpSessionId, mode.id)).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* response.reply({
              content: `Failed to set mode: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
              flags: MessageFlags.Ephemeral,
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      yield* response.reply({ content: `Mode set to "${mode.name}" for this session.` });
    }),
  );

  const modelGroup = yield* CommandHelper.makeSubCommandGroup(
    (builder) =>
      builder
        .setName("model")
        .setDescription("Manage session model")
        .addSubcommand(() => modelSetSubCommand.data),
    (command) => command.subCommands({ set: modelSetSubCommand.handler }),
  );
  const modeGroup = yield* CommandHelper.makeSubCommandGroup(
    (builder) =>
      builder
        .setName("mode")
        .setDescription("Manage session mode")
        .addSubcommand(() => modeSetSubCommand.data),
    (command) => command.subCommands({ set: modeSetSubCommand.handler }),
  );

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("session")
        .setDescription("Manage sessions")
        .addSubcommand(() => newSubCommand.data)
        .addSubcommand(() => closeSubCommand.data)
        .addSubcommand(() => promptSubCommand.data)
        .addSubcommandGroup(() => modelGroup.data)
        .addSubcommandGroup(() => modeGroup.data),
    (command) =>
      command.subCommands({
        new: newSubCommand.handler,
        close: closeSubCommand.handler,
        prompt: promptSubCommand.handler,
        model: modelGroup.handler,
        mode: modeGroup.handler,
      }),
  );
});

export const sessionCommandData = Effect.map(makeSessionCommand, (command) => command.data);

export const sessionCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeSessionCommand;
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
