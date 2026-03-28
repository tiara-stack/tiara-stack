import {
  SlashCommandSubcommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";

import { sdkClient } from "../../sdk/index";
import { isOwner } from "../../utils";
import { getValidWorkspaceByUserAndName } from "../../services/workspace";
import { createWorktree, isGitRepository } from "../../services/git";
import { getDb, schema } from "../../db/index";
import simpleGit from "simple-git";

const newData = new SlashCommandSubcommandBuilder()
  .setName("new")
  .setDescription("Create a new session")
  .addStringOption((option) =>
    option.setName("workspace").setDescription("Workspace name").setRequired(true),
  )
  .addBooleanOption((option) =>
    option
      .setName("use_worktree")
      .setDescription("Create a git worktree for this session (if workspace is a git repo)")
      .setRequired(false),
  );

async function executeNew(interaction: ChatInputCommandInteraction) {
  if (!isOwner(interaction)) {
    await interaction.reply({ content: "You are not the owner.", flags: MessageFlags.Ephemeral });
    return;
  }

  const workspaceName = interaction.options.getString("workspace", true);
  const useWorktree = interaction.options.getBoolean("use_worktree") ?? false;
  const userId = interaction.user.id;

  const { workspace, error } = await getValidWorkspaceByUserAndName(userId, workspaceName);
  if (error || !workspace) {
    await interaction.reply({
      content: error ?? "Unknown error",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Create a new Discord thread
  const channel = interaction.channel;
  if (!channel || !("threads" in channel)) {
    await interaction.reply({
      content: "This command must be used in a text channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defer reply since session creation may take a while
  await interaction.deferReply();

  const threadName = `session-${workspaceName}-${Date.now()}`;
  let thread;
  try {
    thread = await channel.threads.create({
      name: threadName,
      reason: `Session for workspace ${workspaceName}`,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as any).code === 50001) {
      await interaction.editReply({
        content:
          "I don't have permission to create threads in this channel. Please make sure I have the 'Create Public Threads' permission.",
      });
    } else {
      await interaction.editReply({
        content: `Failed to create thread: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
    return;
  }

  // Check if worktree should be created
  let worktreePath: string | null = null;
  let worktreeBranchName: string | null = null;

  if (useWorktree) {
    const isGitRepo = await isGitRepository(workspace.cwd);
    if (isGitRepo) {
      // Use thread ID for unique branch name (avoids creating throwaway SDK session)
      const worktreeResult = await createWorktree(workspace.cwd, thread.id);
      if (worktreeResult.error) {
        // Clean up the thread since session creation is being aborted
        try {
          await thread.delete("Worktree creation failed");
        } catch {
          /* ignore cleanup errors */
        }
        await interaction.editReply({
          content: `Failed to create git worktree: ${worktreeResult.error}\n\nSession creation aborted.`,
        });
        return;
      }
      worktreePath = worktreeResult.worktreePath;
      worktreeBranchName = worktreeResult.branchName;
    }
  }

  // Create SDK session with worktree cwd if available, otherwise workspace cwd
  const sessionCwd = worktreePath ?? workspace.cwd;
  let sessionResponse;
  try {
    sessionResponse = await sdkClient.createSession(sessionCwd);
  } catch (error) {
    // Clean up worktree and thread on session creation failure
    if (worktreePath) {
      const git = simpleGit(workspace.cwd);
      await git.raw(["worktree", "remove", worktreePath]).catch(() => {});
      await git.raw(["branch", "-D", worktreeBranchName!]).catch(() => {});
    }
    try {
      await thread.delete("SDK session creation failed");
    } catch {}
    await interaction.editReply({
      content: `Failed to create SDK session: ${error instanceof Error ? error.message : "Unknown error"}\n\nSession creation aborted.`,
    });
    return;
  }
  const sdkSessionId = sessionResponse.sessionId;

  // Extract model and mode information
  const currentModelId = sessionResponse.models?.currentModelId;
  const availableModels = sessionResponse.models?.availableModels ?? [];
  const currentModeId = sessionResponse.modes?.currentModeId;
  const availableModes = sessionResponse.modes?.availableModes ?? [];

  // Find the name for the current model
  const currentModel = currentModelId
    ? (availableModels.find((m) => m.modelId === currentModelId)?.name ?? currentModelId)
    : "Unknown";

  // Find the name for the current mode
  const currentMode = currentModeId
    ? (availableModes.find((m) => m.id === currentModeId)?.name ?? currentModeId)
    : "Unknown";

  const db = getDb();

  // Store session in db (without model/mode since SDK tracks them)
  await db.insert(schema.session).values({
    workspaceId: workspace.id,
    threadId: thread.id,
    acpSessionId: sdkSessionId,
    worktreePath: worktreePath,
  });

  // Format available models list
  const modelsList =
    availableModels.length > 0
      ? availableModels
          .map(
            (m: { modelId: string; name: string; description?: string }) =>
              `  - ${m.name}${m.description ? ` (${m.description})` : ""}`,
          )
          .join("\n")
      : "  No models available";

  // Format available modes list
  const modesList =
    availableModes.length > 0
      ? availableModes
          .map(
            (m: { id: string; name: string; description?: string }) =>
              `  - ${m.name}${m.description ? ` (${m.description})` : ""}`,
          )
          .join("\n")
      : "  No modes available";

  // Send initial info to the thread
  let worktreeInfo = "";
  if (worktreePath && worktreeBranchName) {
    worktreeInfo = `\n**Git Worktree:**\n- Path: \`${worktreePath}\`\n- Branch: \`${worktreeBranchName}\`\n`;
  }

  await thread.send(
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
  );

  // SDK client will look up the thread from the database automatically

  await interaction.editReply({
    content: `Session created! See ${thread.toString()}`,
  });
}

export const sessionNew = { data: newData, execute: executeNew };
