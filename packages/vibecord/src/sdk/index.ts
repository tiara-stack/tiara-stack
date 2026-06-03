import { createOpencode, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk/v2";
import type { OpencodeClient, Event } from "@opencode-ai/sdk/v2";
import type { Discord } from "dfx";
import type { DiscordRestService } from "dfx/DiscordREST";
import type { APIEmbed } from "discord-api-types/v10";
import { ButtonStyle, ComponentType, MessageFlags } from "discord-api-types/v10";
import * as Diff from "diff";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import {
  DIFF_TRUNCATION_LINES,
  DIFF_CONTEXT_LINES,
  STATUS_EMOJI,
  UPDATE_TYPE,
  SESSION_STATUS,
  DISCORD_THREAD_NAME_MAX_LENGTH,
  DISCORD_MESSAGE_MAX_LENGTH,
} from "../constants";
import {
  getSessionByAcpSessionId,
  getWorkspaceById,
  getSessionWithWorkspace,
} from "../services/session";
import { getDb, schema } from "../db/index";
import { randomUUID } from "crypto";
import {
  DiscordStreamingMessage,
  findSafeSplitPoint,
  type DiscordStreamThread,
  type StreamAtomicEvent,
  type StreamDelta,
} from "./streaming";

interface ServerInstance {
  url: string;
  close: () => void;
}

type RestThread = DiscordStreamThread & {
  readonly id: string;
};

type DiscordMessageActionRow = Discord.ActionRowComponentForMessageRequest;
type DiscordMessageButton = Discord.ButtonComponentForMessageRequest;
type MutableDiscordMessageActionRow = Omit<DiscordMessageActionRow, "components"> & {
  components: DiscordMessageButton[];
};
type RunDiscordEffect = <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;
type DiffChange = ReturnType<typeof Diff.diffLines>[number];

export interface VibecordButtonInteraction {
  readonly customId: string;
  readonly userId: string;
  readonly message: {
    readonly components: ReadonlyArray<Discord.ActionRowComponentResponse>;
  };
  readonly reply: (payload: {
    readonly content: string;
    readonly flags?: MessageFlags;
    readonly ephemeral?: boolean;
  }) => Promise<void>;
  readonly update: (payload: {
    readonly components: ReadonlyArray<DiscordMessageActionRow>;
  }) => Promise<void>;
  readonly followUp: (payload: {
    readonly content: string;
    readonly flags?: MessageFlags;
    readonly ephemeral?: boolean;
  }) => Promise<void>;
}

interface CachedStreamingMessage {
  streamingMessage: DiscordStreamingMessage;
  threadId: string;
}

const trimTrailingSplitLine = (lines: string[]): string[] => {
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
};

const pushChangedLines = (result: string[], lines: ReadonlyArray<string>, prefix: "+" | "-") => {
  for (const line of lines) {
    result.push(`${prefix}${line}`);
  }
};

const isChangedBlock = (change: DiffChange | null | undefined): boolean =>
  Boolean(change?.added || change?.removed);

const pushUnchangedContextLines = (
  result: string[],
  lines: ReadonlyArray<string>,
  prevChange: DiffChange | null,
  nextChange: DiffChange | null,
) => {
  const hasAdjacentChange = isChangedBlock(prevChange) || isChangedBlock(nextChange);

  if (!hasAdjacentChange) {
    if (lines.length > 0) {
      result.push(` (${lines.length} lines omitted)`);
    }
    return;
  }

  if (
    isChangedBlock(prevChange) &&
    isChangedBlock(nextChange) &&
    lines.length > DIFF_CONTEXT_LINES * 2
  ) {
    for (const line of lines.slice(0, DIFF_CONTEXT_LINES)) {
      result.push(` ${line}`);
    }
    result.push(` (${lines.length - DIFF_CONTEXT_LINES * 2} lines omitted)`);
    for (const line of lines.slice(-DIFF_CONTEXT_LINES)) {
      result.push(` ${line}`);
    }
    return;
  }

  for (const line of lines) {
    result.push(` ${line}`);
  }
};

const computeDiff = (oldText: string, newText: string): { lines: string[] } => {
  const changes = Diff.diffLines(oldText, newText);
  const result: string[] = [];

  changes.forEach((change, index) => {
    const lines = trimTrailingSplitLine(change.value.split("\n"));

    if (change.added) {
      pushChangedLines(result, lines, "+");
      return;
    }

    if (change.removed) {
      pushChangedLines(result, lines, "-");
      return;
    }

    pushUnchangedContextLines(
      result,
      lines,
      index > 0 ? changes[index - 1] : null,
      index < changes.length - 1 ? changes[index + 1] : null,
    );
  });

  return { lines: result };
};

// Generate a unique button ID using UUID v4
function generateButtonId(): string {
  return randomUUID();
}

// Batch store multiple button mappings
async function storeButtonMappings(
  mappings: Array<{
    buttonId: string;
    sessionId: string;
    requestId: string;
    optionValue: string;
    userId?: string;
  }>,
): Promise<void> {
  const db = getDb();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // UUID v4 collisions are astronomically unlikely, so we don't handle them
  await Promise.all(
    mappings.map((m) =>
      db.insert(schema.buttonMapping).values({
        buttonId: m.buttonId,
        sessionId: m.sessionId,
        requestId: m.requestId,
        optionValue: m.optionValue,
        userId: m.userId,
        expiresAt,
      }),
    ),
  );
}

// Lookup button mapping from database
async function lookupButtonMapping(buttonId: string): Promise<{
  sessionId: string;
  requestId: string;
  optionValue: string;
  userId: string | null;
} | null> {
  const db = getDb();

  const mapping = db
    .select()
    .from(schema.buttonMapping)
    .where(eq(schema.buttonMapping.buttonId, buttonId))
    .get();

  if (!mapping) {
    return null;
  }

  // Check if expired and clean up
  if (mapping.expiresAt && new Date() > mapping.expiresAt) {
    // Delete expired entry asynchronously (don't await)
    void db
      .delete(schema.buttonMapping)
      .where(eq(schema.buttonMapping.buttonId, buttonId))
      .catch(() => {
        // Silently ignore delete errors
      });
    return null;
  }

  return {
    sessionId: mapping.sessionId,
    requestId: mapping.requestId,
    optionValue: mapping.optionValue,
    userId: mapping.userId,
  };
}

class VibecordClient {
  private client: OpencodeClient | null = null;
  private server: ServerInstance | null = null;
  private discordRest: DiscordRestService | null = null;
  private runDiscordEffect: RunDiscordEffect | null = null;
  private streamingMessages: Map<string, CachedStreamingMessage> = new Map();
  private eventStreamAbort: AbortController | null = null;
  private activePrompts: Set<string> = new Set();
  private sessionDirectories: Map<string, string> = new Map();
  private readonly logger: Pick<Console, "warn"> = console;

  setDiscordRest(rest: DiscordRestService, runDiscordEffect: RunDiscordEffect): void {
    this.discordRest = rest;
    this.runDiscordEffect = runDiscordEffect;
  }

  private async getThreadForSession(sessionId: string): Promise<RestThread | null> {
    if (!this.discordRest) {
      return null;
    }

    // Look up session to get threadId
    const session = await getSessionByAcpSessionId(sessionId);

    if (!session || !session.threadId) {
      return null;
    }

    return this.makeThread(session.threadId);
  }

  private makeThread(threadId: string): RestThread {
    return {
      id: threadId,
      send: async ({ content }) => {
        if (!this.discordRest || !this.runDiscordEffect) {
          throw new Error("Discord REST is not configured");
        }
        const rest = this.discordRest;
        const runDiscordEffect = this.runDiscordEffect;
        const message = await runDiscordEffect(rest.createMessage(threadId, { content }));
        return {
          id: message.id,
          edit: ({ content }) =>
            runDiscordEffect(rest.updateMessage(threadId, message.id, { content })),
        };
      },
    };
  }

  // Tool part formatting for completed tool events.
  private formatToolPart(
    part: ToolPart & { state: ToolStateCompleted },
  ): { type: string; content: string } | null {
    // Check for diff in state.metadata (where edit tool stores it)
    if (part.state.metadata?.diff && part.state.metadata?.filediff) {
      const filediff = part.state.metadata.filediff as {
        before: string;
        after: string;
        file: string;
      };
      const diffResult = computeDiff(filediff.before, filediff.after);
      const path = filediff.file;
      const truncated = diffResult.lines.length > DIFF_TRUNCATION_LINES;
      const displayLines = truncated
        ? diffResult.lines.slice(0, DIFF_TRUNCATION_LINES)
        : diffResult.lines;
      const displayContent = displayLines.join("\n");
      const suffix = truncated
        ? `\n... (${diffResult.lines.length - DIFF_TRUNCATION_LINES} more lines)`
        : "";
      return {
        type: "diff",
        content: `\`modified ${path}\`\n\`\`\`diff\n${displayContent}\n\`\`\`${suffix}`,
      };
    }

    // Fall back to title if no diff
    if (part.state.title) {
      return { type: "tool_call", content: part.state.title };
    }

    return null;
  }

  private getStreamingMessage(sessionId: string, thread: RestThread): DiscordStreamingMessage {
    const cached = this.streamingMessages.get(sessionId);
    if (cached) {
      if (cached.threadId !== thread.id) {
        this.logger.warn(
          `[SDK] Streaming thread changed for session ${sessionId}; updating active stream target`,
          { nextThreadId: thread.id, previousThreadId: cached.threadId },
        );
        cached.streamingMessage.updateThread(thread);
        cached.threadId = thread.id;
      }
      return cached.streamingMessage;
    }

    const streamingMessage = new DiscordStreamingMessage({
      logger: this.logger,
      thread,
    });
    this.streamingMessages.set(sessionId, {
      streamingMessage,
      threadId: thread.id,
    });
    return streamingMessage;
  }

  private async pushStreamDelta(delta: StreamDelta): Promise<void> {
    const thread = await this.getThreadForSession(delta.sessionId);
    if (!thread) return;

    await this.getStreamingMessage(delta.sessionId, thread).pushDelta(delta);
  }

  private async flushStreamingMessage(sessionId: string): Promise<void> {
    const cached = this.streamingMessages.get(sessionId);
    if (!cached) return;

    await cached.streamingMessage.flushAndReset();
    this.streamingMessages.delete(sessionId);
  }

  private async sendAtomicEvent(event: StreamAtomicEvent): Promise<void> {
    const thread = await this.getThreadForSession(event.sessionId);
    if (!thread) return;

    await this.flushStreamingMessage(event.sessionId);

    if (event.updateType === UPDATE_TYPE.TODO) {
      if (event.todos && event.todos.length > 0) {
        await this.sendEmbed(this.createTodoEmbed(event.todos), thread);
      }
      return;
    }

    if (event.updateType === UPDATE_TYPE.TOOL_CALL && event.content) {
      await this.sendTextContent(`\`tool used ${event.content}\``, thread);
      return;
    }

    if (event.updateType === UPDATE_TYPE.DIFF && event.content) {
      await this.sendTextContent(event.content, thread);
    }
  }

  private splitIntoSafeChunks(content: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > maxLength) {
      // Find the best split point before maxLength
      const splitPoint = this.findSafeSplitPoint(remaining, maxLength);
      chunks.push(remaining.substring(0, splitPoint).trimEnd());
      remaining = remaining.substring(splitPoint).trimStart();
    }

    if (remaining.length > 0) {
      chunks.push(remaining);
    }

    return chunks;
  }

  private findSafeSplitPoint(content: string, maxLength: number): number {
    return findSafeSplitPoint(content, maxLength);
  }

  private async sendTextContent(content: string, thread: RestThread): Promise<void> {
    const chunks = this.splitIntoSafeChunks(content, DISCORD_MESSAGE_MAX_LENGTH);
    for (const chunk of chunks) {
      try {
        await thread.send({ content: chunk });
      } catch {
        // Silently fail - thread may have been deleted
      }
    }
  }

  private async startGlobalEventStream(): Promise<void> {
    if (!this.client) return;

    const abortController = new AbortController();
    this.eventStreamAbort = abortController;

    console.log(`[SDK] Starting global event stream`);

    // Subscribe to global events
    const response = await this.client.global.event({
      signal: abortController.signal,
    });
    console.log(`[SDK] Global subscription response received`);

    // Process events from the stream
    const processEvents = async () => {
      console.log(`[SDK] Entering global event processing loop`);
      try {
        for await (const globalEvent of response.stream) {
          const event = (globalEvent as { directory: string; payload: Event }).payload;
          // Skip logging for message.part.updated to avoid spam (too many tokens)
          if (abortController.signal.aborted) break;

          try {
            await this.handleEvent(event);
          } catch (err) {
            console.error(`[SDK] Error handling global event:`, err);
          }
        }
      } catch (err) {
        console.error(`[SDK] Global event stream error:`, err);
      }
    };

    void processEvents();
  }

  private async handleEvent(event: Event): Promise<void> {
    // Log all events for debugging (except the spammy ones)
    if (event.type !== "message.part.updated") {
      console.log(`[SDK] Received event: ${event.type}`);
    }

    // Handle session idle - flush immediately to send remaining entries
    if (event.type === "session.idle") {
      const idleSessionId = event.properties.sessionID;
      this.activePrompts.delete(idleSessionId);
      // Flush immediately to avoid delay in showing final response
      await this.flushStreamingMessage(idleSessionId);
      return;
    }

    // Handle session title update - update Discord thread name
    if (event.type === "session.updated") {
      const sessionInfo = (event.properties as { info: { id: string; title: string } }).info;
      const updatedSessionId = sessionInfo.id;
      const newTitle = sessionInfo.title;

      // Update the thread name if we have a thread for this session
      const thread = await this.getThreadForSession(updatedSessionId);
      if (thread && newTitle) {
        try {
          // Discord thread names have a 100 character limit
          const truncatedTitle = newTitle.substring(0, DISCORD_THREAD_NAME_MAX_LENGTH);
          if (this.discordRest && this.runDiscordEffect) {
            await this.runDiscordEffect(
              this.discordRest.updateChannel(thread.id, { name: truncatedTitle }),
            );
          }
        } catch (err) {
          console.error(`[SDK] Failed to update thread name:`, err);
        }
      }
      return;
    }

    // Handle permission requests
    if (event.type === "permission.asked") {
      await this.handlePermissionRequest(event);
      return;
    }

    // Handle question requests
    if (event.type === "question.asked") {
      await this.handleQuestionRequest(event);
      return;
    }

    // Extract session ID from event
    let sessionId: string | undefined;

    switch (event.type) {
      case "message.part.updated": {
        const part = (event.properties as { part: { sessionID: string } }).part;
        sessionId = part.sessionID;
        break;
      }
      case "message.updated": {
        const msgEvent = event.properties as { info?: { sessionID: string } };
        sessionId = msgEvent.info?.sessionID;
        break;
      }
      case "todo.updated":
        sessionId = event.properties.sessionID;
        break;
      case "session.diff":
        sessionId = event.properties.sessionID;
        break;
    }

    if (!sessionId) return;

    const streamDelta = this.extractStreamDelta(event, sessionId);
    if (streamDelta) {
      await this.pushStreamDelta(streamDelta);
      return;
    }

    const atomicEvent = this.extractAtomicEvent(event, sessionId);
    if (atomicEvent) {
      await this.sendAtomicEvent(atomicEvent);
    }
  }

  private extractStreamDelta(event: Event, sessionId: string): StreamDelta | null {
    if (event.type !== "message.part.updated") {
      return null;
    }

    const part = event.properties.part;
    if (part.type !== "text" && part.type !== "reasoning") {
      return null;
    }

    const delta = (event.properties as { delta?: string }).delta;
    const content = delta ?? "";
    if (content === "") {
      return null;
    }

    return {
      sessionId,
      kind: part.type === "text" ? "text" : "reasoning",
      text: content,
      partId:
        "id" in part && typeof part.id === "string"
          ? part.id
          : `${sessionId}:${part.type === "text" ? "text" : "reasoning"}`,
    };
  }

  private extractAtomicEvent(event: Event, sessionId: string): StreamAtomicEvent | null {
    switch (event.type) {
      case "message.part.updated": {
        const part = event.properties.part;

        if (part.type === "tool") {
          if (part.state.status === "completed") {
            const formatted = this.formatToolPart(part as ToolPart & { state: ToolStateCompleted });
            if (formatted) {
              return {
                sessionId,
                updateType: formatted.type as "diff" | "tool_call",
                content: formatted.content,
              };
            }
          }
        }

        return null;
      }
      case "todo.updated": {
        const todos = event.properties.todos;
        if (todos && todos.length > 0) {
          return {
            sessionId,
            updateType: UPDATE_TYPE.TODO,
            todos: todos.map((t: { status: string; content: string }) => ({
              status: t.status,
              content: t.content,
            })),
          };
        }
        return null;
      }
      default:
        return null;
    }
  }

  // Create an embed for displaying todo lists
  private createTodoEmbed(todos: Array<{ status: string; content: string }>): APIEmbed {
    const todoItems = todos.map((todo) => {
      const status =
        todo.status === SESSION_STATUS.COMPLETED
          ? STATUS_EMOJI.COMPLETED
          : todo.status === SESSION_STATUS.IN_PROGRESS
            ? STATUS_EMOJI.IN_PROGRESS
            : STATUS_EMOJI.PENDING;
      return `${status} ${todo.content}`;
    });

    const fullDescription = todoItems.join("\n") || "No todos";
    const description =
      fullDescription.length > 4096 ? fullDescription.substring(0, 4093) + "..." : fullDescription;
    if (fullDescription.length > 4096) {
      console.warn(`[SDK] Todo list truncated from ${fullDescription.length} to 4096 characters`);
    }
    return { title: "Todo List", description, color: 0x5865f2 };
  }

  // Send an embed to a thread
  private async sendEmbed(embed: APIEmbed, thread: RestThread): Promise<void> {
    try {
      if (this.discordRest && this.runDiscordEffect) {
        await this.runDiscordEffect(this.discordRest.createMessage(thread.id, { embeds: [embed] }));
      }
    } catch {
      // Silently fail - thread may have been deleted
    }
  }

  // Format permission type with emoji
  private formatPermissionType(type: string): string {
    const emojiMap: Record<string, string> = {
      tool: "🔧",
      file_read: "📖",
      file_write: "✏️",
      command: "⚡",
      browser: "🌐",
      shell: "🐚",
    };
    return `${emojiMap[type] || "🔒"} ${type}`;
  }

  // Get detailed description for permission type
  private getPermissionDetails(type: string): { title: string; description: string } {
    const details: Record<string, { title: string; description: string }> = {
      tool: {
        title: "Tool Execution Request",
        description:
          "The agent wants to execute a tool. Tools can perform various actions like file operations, web searches, and more.",
      },
      file_read: {
        title: "File Read Request",
        description: "The agent wants to read a file from your workspace.",
      },
      file_write: {
        title: "File Write Request",
        description: "The agent wants to modify or create a file in your workspace.",
      },
      command: {
        title: "Command Execution Request",
        description: "The agent wants to execute a command in your terminal.",
      },
      browser: {
        title: "Browser Action Request",
        description: "The agent wants to perform an action in the browser.",
      },
      shell: {
        title: "Shell Command Request",
        description: "The agent wants to run a shell command.",
      },
    };
    return (
      details[type] || {
        title: "Permission Request",
        description: `The agent is requesting ${type} permission.`,
      }
    );
  }

  // Create permission request embed
  private createPermissionEmbed(
    type: string,
    details: string,
    allowButtonId: string,
    denyButtonId: string,
    requestId: string,
  ): { embed: APIEmbed; components: Array<DiscordMessageActionRow> } {
    const permissionInfo = this.getPermissionDetails(type);
    const embed: APIEmbed = {
      title: permissionInfo.title,
      description: permissionInfo.description,
      fields: [
        { name: "Permission Type", value: this.formatPermissionType(type), inline: true },
        {
          name: "Details",
          value: details.length > 1000 ? details.substring(0, 1000) + "..." : details,
          inline: false,
        },
      ],
      color: 0xffa500,
      footer: { text: requestId },
      timestamp: new Date().toISOString(),
    };

    return {
      embed,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              custom_id: `p_${allowButtonId}`,
              label: "Allow",
              style: ButtonStyle.Success,
            },
            {
              type: ComponentType.Button,
              custom_id: `p_${denyButtonId}`,
              label: "Deny",
              style: ButtonStyle.Danger,
            },
          ],
        },
      ],
    };
  }

  // Handle permission.asked events
  private async handlePermissionRequest(event: Event): Promise<void> {
    if (event.type !== "permission.asked") return;

    const props = event.properties as unknown as {
      requestID: string;
      sessionID: string;
      type?: string;
      details?: string;
    };
    const requestID = props.requestID;
    const sessionID = props.sessionID;
    const type = props.type || "tool";
    const details = props.details || "";

    try {
      const thread = await this.getThreadForSession(sessionID);
      if (!thread) {
        console.error(`[SDK] No thread found for session ${sessionID}`);
        return;
      }

      // Get the session owner (Discord user ID) for authorization
      const sessionWithWorkspace = await getSessionWithWorkspace(sessionID);
      const ownerUserId = sessionWithWorkspace?.workspace?.userId;

      // Generate button IDs and batch store mappings
      const allowButtonId = generateButtonId();
      const denyButtonId = generateButtonId();
      await storeButtonMappings([
        {
          buttonId: allowButtonId,
          sessionId: sessionID,
          requestId: requestID,
          optionValue: "__allow__",
          userId: ownerUserId,
        },
        {
          buttonId: denyButtonId,
          sessionId: sessionID,
          requestId: requestID,
          optionValue: "__deny__",
          userId: ownerUserId,
        },
      ]);

      const { embed, components } = this.createPermissionEmbed(
        type,
        details,
        allowButtonId,
        denyButtonId,
        requestID,
      );
      if (this.discordRest && this.runDiscordEffect) {
        await this.runDiscordEffect(
          this.discordRest.createMessage(thread.id, {
            embeds: [embed],
            components,
          }),
        );
      }

      console.log(`[SDK] Sent permission request ${requestID} for session ${sessionID}`);
    } catch (err) {
      console.error(`[SDK] Error handling permission request:`, err);
    }
  }

  // Handle button clicks for permissions
  async handlePermissionButton(interaction: VibecordButtonInteraction): Promise<boolean> {
    const customId = interaction.customId;

    if (!customId.startsWith("p_")) {
      return false;
    }

    const buttonId = customId.replace("p_", "");

    try {
      // Look up the button mapping from database
      const mapping = await lookupButtonMapping(buttonId);

      if (!mapping) {
        console.error(`[SDK] Button mapping not found for: ${buttonId}`);
        await interaction.reply({
          content: "This button has expired. Please try again.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      // Check authorization - only the session owner can click permission buttons
      if (mapping.userId && mapping.userId !== interaction.userId) {
        await interaction.reply({
          content: "You are not authorized to respond to this permission request.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const allowed = mapping.optionValue === "__allow__";

      // Get the directory for this session
      let cwd: string | undefined;
      try {
        cwd = await this.resolveSessionCwd(mapping.sessionId);
      } catch {
        console.log(
          `[SDK] Session ${mapping.sessionId} not found in bot's directory map, continuing without directory`,
        );
      }

      // Update the button state
      const updatedRow: DiscordMessageActionRow = {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            custom_id: customId,
            label: allowed ? "Allowed" : "Denied",
            style: allowed ? ButtonStyle.Success : ButtonStyle.Danger,
            disabled: true,
          },
        ],
      };

      await interaction.update({ components: [updatedRow] });

      // Send the permission response to the SDK
      if (this.client) {
        const replyData: { requestID: string; reply: "always" | "reject"; directory?: string } = {
          requestID: mapping.requestId,
          reply: allowed ? "always" : "reject",
        };
        if (cwd) {
          replyData.directory = cwd;
        }
        await this.client.permission.reply(replyData);
      } else {
        console.error(`[SDK] Cannot send permission reply - SDK client not connected`);
        await interaction.followUp({
          content: "Error: Cannot process permission. SDK connection unavailable.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      console.log(
        `[SDK] Permission ${allowed ? "granted" : "denied"} for session ${mapping.sessionId}`,
      );
      return true;
    } catch (err) {
      console.error(`[SDK] Error handling permission button:`, err);
      try {
        await interaction.reply({
          content: "Failed to process permission. Please try again.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        try {
          await interaction.followUp({
            content: "Failed to process permission. Please try again.",
            flags: MessageFlags.Ephemeral,
          });
        } catch {
          // Ignore if both fail
        }
      }
      return true;
    }
  }

  // Handle question.asked events
  private async handleQuestionRequest(event: Event): Promise<void> {
    if (event.type !== "question.asked") return;

    const props = event.properties as unknown as {
      id: string;
      sessionID: string;
      questions: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string }>;
        multiple?: boolean;
        custom?: boolean;
      }>;
    };

    // Extract the first question info
    const requestID = props.id;
    const sessionID = props.sessionID;

    // Warn if multiple questions are present (only first is handled)
    if (props.questions && props.questions.length > 1) {
      console.warn(
        `[SDK] Question request contains ${props.questions.length} questions, but only the first will be handled`,
      );
    }

    const firstQuestion = props.questions?.[0];
    const question = firstQuestion?.question || "";
    const options =
      firstQuestion?.options.map((opt) => ({
        value: opt.label,
        label: opt.label,
      })) || [];
    const _allowCustom = firstQuestion?.custom || false;

    console.log(`[SDK] Received question request:`, {
      requestID,
      sessionID,
      question: question || "(empty)",
      optionsCount: options.length,
    });

    try {
      const thread = await this.getThreadForSession(sessionID);
      if (!thread) {
        console.error(`[SDK] No thread found for session ${sessionID}`);
        return;
      }

      await this.sendQuestionMessage(thread, requestID, sessionID, question, options, _allowCustom);

      console.log(`[SDK] Sent question ${requestID} for session ${sessionID}`);
    } catch (err) {
      console.error(`[SDK] Error handling question request:`, err);
    }
  }

  // Send a question message with buttons
  private async sendQuestionMessage(
    thread: RestThread,
    requestId: string,
    sessionId: string,
    question: string,
    options: Array<{ value: string; label: string }>,
    _allowCustom: boolean,
  ): Promise<void> {
    const embed: APIEmbed = {
      title: "Question",
      description: question || "Please select an option:",
      color: 0x5865f2,
      footer: { text: requestId || "Question" },
    };

    const rows: Array<DiscordMessageActionRow> = [];
    let currentRow: MutableDiscordMessageActionRow = {
      type: ComponentType.ActionRow,
      components: [],
    };
    let buttonCount = 0;

    // Discord allows max 5 action rows, reserve 1 for cancel button = max 4 option rows (20 buttons)
    const MAX_BUTTONS = 20;
    const limitedOptions = options.slice(0, MAX_BUTTONS);

    if (options.length > MAX_BUTTONS) {
      console.warn(
        `[SDK] Question has ${options.length} options, truncating to ${MAX_BUTTONS} to fit Discord limits`,
      );
    }

    // Generate all button IDs first
    const buttonIds: Array<{ id: string; option: { value: string; label: string } }> = [];
    for (const option of limitedOptions) {
      buttonIds.push({ id: generateButtonId(), option });
    }
    const cancelButtonId = generateButtonId();

    // Batch store all mappings in parallel
    const mappings = [
      ...buttonIds.map((b) => ({
        buttonId: b.id,
        sessionId,
        requestId,
        optionValue: b.option.value,
      })),
      { buttonId: cancelButtonId, sessionId, requestId, optionValue: "__cancel__" },
    ];
    await storeButtonMappings(mappings);

    // Build buttons with label length validation (max 80 chars)
    for (const { id, option } of buttonIds) {
      const label = option.label.length > 80 ? option.label.substring(0, 77) + "..." : option.label;
      const button: DiscordMessageButton = {
        type: ComponentType.Button,
        custom_id: `q_${id}`,
        label,
        style: ButtonStyle.Primary,
      };

      currentRow.components.push(button);
      buttonCount++;

      // Discord allows max 5 buttons per row
      if (buttonCount === 5) {
        rows.push(currentRow);
        currentRow = {
          type: ComponentType.ActionRow,
          components: [],
        };
        buttonCount = 0;
      }
    }

    if (buttonCount > 0) {
      rows.push(currentRow);
    }

    // Add cancel button with stored mapping (5th row)
    const cancelRow: DiscordMessageActionRow = {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          custom_id: `qc_${cancelButtonId}`,
          label: "Cancel",
          style: ButtonStyle.Secondary,
        },
      ],
    };
    rows.push(cancelRow);

    if (this.discordRest && this.runDiscordEffect) {
      await this.runDiscordEffect(
        this.discordRest.createMessage(thread.id, { embeds: [embed], components: rows }),
      );
    }
  }

  // Handle button clicks for questions
  async handleQuestionButton(interaction: VibecordButtonInteraction): Promise<boolean> {
    const customId = interaction.customId;

    // Check if this is a question button (q_<buttonId> or qc_<buttonId>)
    if (!customId.startsWith("q_") && !customId.startsWith("qc_")) {
      return false;
    }

    try {
      const buttonId = customId.replace("q_", "").replace("qc_", "");
      const isCancel = customId.startsWith("qc_");

      // Look up the button mapping from database
      const mapping = await lookupButtonMapping(buttonId);

      if (!mapping) {
        console.error(`[SDK] Button mapping not found for: ${buttonId}`);
        await interaction.reply({
          content: "This button has expired. Please try the question again.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      if (isCancel || mapping.optionValue === "__cancel__") {
        await this.cancelQuestion(interaction, mapping.sessionId, mapping.requestId);
        return true;
      }

      await this.submitQuestionAnswer(
        interaction,
        mapping.sessionId,
        mapping.requestId,
        mapping.optionValue,
      );
      return true;
    } catch (err) {
      console.error(`[SDK] Error handling question button:`, err);
      const errorMessage = "Failed to process your answer. Please try again.";
      await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral });
      return true;
    }
  }

  // Submit question answer
  private async submitQuestionAnswer(
    interaction: VibecordButtonInteraction,
    sessionId: string,
    requestId: string,
    optionValue: string,
  ): Promise<void> {
    try {
      // Get session directory if available (may not be for CLI-created sessions)
      let cwd: string | undefined;
      try {
        cwd = await this.resolveSessionCwd(sessionId);
      } catch {
        console.log(
          `[SDK] Session ${sessionId} not found in bot's directory map, continuing without directory`,
        );
      }

      await this.disableQuestionButtons(interaction);

      if (this.client) {
        const replyData: {
          requestID: string;
          answers: string[][];
          directory?: string;
        } = {
          requestID: requestId,
          answers: [[optionValue]],
        };
        if (cwd) {
          replyData.directory = cwd;
        }
        console.log(`[SDK] Sending question reply:`, JSON.stringify(replyData));
        try {
          const result = await this.client.question.reply(replyData);
          console.log(`[SDK] Question reply result:`, result);
        } catch (replyErr) {
          console.error(`[SDK] Error from question.reply:`, replyErr);
          throw replyErr;
        }
      } else {
        console.error(`[SDK] No client available to send reply`);
      }

      await interaction.followUp({
        content: `Selected: **${optionValue}**`,
        flags: MessageFlags.Ephemeral,
      });

      console.log(`[SDK] Question ${requestId} answered with: ${optionValue}`);
    } catch (err) {
      console.error(`[SDK] Error submitting question answer:`, err);
      // Try to reply if we haven't already
      try {
        await interaction.reply({
          content: "Failed to submit your answer. Please try again.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // If reply fails, try followUp
        try {
          await interaction.followUp({
            content: "Failed to submit your answer. Please try again.",
            flags: MessageFlags.Ephemeral,
          });
        } catch {
          // Ignore if both fail
        }
      }
    }
  }

  // Cancel question
  private async cancelQuestion(
    interaction: VibecordButtonInteraction,
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    try {
      // Get session directory if available (may not be for CLI-created sessions)
      let cwd: string | undefined;
      try {
        cwd = await this.resolveSessionCwd(sessionId);
      } catch {
        console.log(
          `[SDK] Session ${sessionId} not found in bot's directory map, continuing without directory`,
        );
      }

      await this.disableQuestionButtons(interaction);

      if (this.client) {
        const rejectData: { requestID: string; directory?: string } = {
          requestID: requestId,
        };
        if (cwd) {
          rejectData.directory = cwd;
        }
        await this.client.question.reject(
          rejectData as unknown as Parameters<typeof this.client.question.reject>[0],
        );
      }

      await interaction.followUp({
        content: "Question cancelled.",
        flags: MessageFlags.Ephemeral,
      });

      console.log(`[SDK] Question ${requestId} cancelled`);
    } catch (err) {
      console.error(`[SDK] Error cancelling question:`, err);
      // Try to reply if we haven't already
      try {
        await interaction.reply({
          content: "Failed to cancel the question.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // If reply fails, try followUp
        try {
          await interaction.followUp({
            content: "Failed to cancel the question.",
            flags: MessageFlags.Ephemeral,
          });
        } catch {
          // Ignore if both fail
        }
      }
    }
  }

  // Disable all buttons
  private async disableQuestionButtons(interaction: VibecordButtonInteraction): Promise<void> {
    const message = interaction.message;
    const disabledComponents: Array<DiscordMessageActionRow> = [];

    for (const row of message.components) {
      // Cast to unknown first, then to the expected type
      const actionRow = row as unknown as {
        components: Array<{
          type: number;
          custom_id?: string;
          label?: string;
          style?: number;
          disabled?: boolean;
        }>;
      };
      const newRow: MutableDiscordMessageActionRow = {
        type: ComponentType.ActionRow,
        components: [],
      };
      for (const component of actionRow.components) {
        if (component.type === ComponentType.Button) {
          // Button component
          newRow.components.push({
            type: ComponentType.Button,
            custom_id: component.custom_id ?? "",
            label: component.label || "",
            style: (component.style || ButtonStyle.Primary) as ButtonStyle,
            disabled: true,
          } as DiscordMessageButton);
        }
      }
      if (newRow.components.length > 0) {
        disabledComponents.push(newRow);
      }
    }

    await interaction.update({ components: disabledComponents });
  }

  async connect(): Promise<void> {
    // Create opencode server and client
    const opencode = await createOpencode();
    this.server = opencode.server;
    this.client = opencode.client;

    console.log(`[SDK] Connected to OpenCode at ${this.server.url}`);

    // Start global event stream for server-level events
    await this.startGlobalEventStream();
  }

  async createSession(cwd: string): Promise<{
    sessionId: string;
    models?: {
      currentModelId?: string;
      availableModels: Array<{ modelId: string; name: string; description?: string }>;
    };
    modes?: {
      currentModeId?: string;
      availableModes: Array<{ id: string; name: string; description?: string }>;
    };
  }> {
    if (!this.client) {
      throw new Error("Not connected to OpenCode");
    }

    // Create session using the main client
    const response = await this.client.session.create({
      directory: cwd,
    });

    const session = response.data;
    if (!session) {
      throw new Error("Failed to create session");
    }

    // Store the session -> directory mapping
    this.sessionDirectories.set(session.id, cwd);

    // Get config to retrieve models and modes
    const configResponse = await this.client.config.get({
      directory: cwd,
    });

    const config = configResponse.data;
    const providersResponse = await this.client.config.providers({
      directory: cwd,
    });
    const providers = providersResponse.data;

    // Extract available models from providers
    const availableModels: Array<{ modelId: string; name: string; description?: string }> = [];
    if (providers?.providers) {
      for (const provider of providers.providers) {
        for (const [modelId, model] of Object.entries(provider.models)) {
          availableModels.push({
            modelId: `${provider.id}/${modelId}`,
            name: model.name,
            description: `Provider: ${provider.name}`,
          });
        }
      }
    }

    // Get current model from config
    const currentModelId = config?.model;

    // Extract available modes from config
    const availableModes: Array<{ id: string; name: string; description?: string }> = [];
    if (config?.agent) {
      for (const [modeId, agentConfig] of Object.entries(config.agent)) {
        if (agentConfig?.description) {
          availableModes.push({
            id: modeId,
            name: modeId.charAt(0).toUpperCase() + modeId.slice(1),
            description: agentConfig.description as string,
          });
        }
      }
    }

    const currentModeId = config?.default_agent;

    return {
      sessionId: session.id,
      models: {
        currentModelId,
        availableModels,
      },
      modes: {
        currentModeId,
        availableModes,
      },
    };
  }

  async deleteSession(sessionId: string, cwd: string): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.client.session.delete({
      sessionID: sessionId,
      directory: cwd,
    });
    this.sessionDirectories.delete(sessionId);
  }

  private async resolveSessionCwd(sessionId: string): Promise<string> {
    // Get the directory from our mapping or the database
    let cwd = this.sessionDirectories.get(sessionId);
    if (!cwd) {
      const session = await getSessionByAcpSessionId(sessionId);

      if (!session) {
        throw new Error("Session not found");
      }

      const workspace = await getWorkspaceById(session.workspaceId);

      if (!workspace) {
        throw new Error("Workspace not found");
      }

      // Use worktree path if available, otherwise use workspace cwd
      cwd = session.worktreePath ?? workspace.cwd;
      this.sessionDirectories.set(sessionId, cwd);
    }
    return cwd;
  }

  async setSessionModel(_sessionId: string, modelId: string): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected to OpenCode");
    }

    const cwd = await this.resolveSessionCwd(_sessionId);

    // Update the config with the new model using the main client
    await this.client.config.update({
      directory: cwd,
      config: { model: modelId },
    });
  }

  async setSessionMode(_sessionId: string, modeId: string): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected to OpenCode");
    }

    const cwd = await this.resolveSessionCwd(_sessionId);

    // Get current config using the main client
    const configResponse = await this.client.config.get({
      directory: cwd,
    });
    const config = configResponse.data;

    // Update the default agent and model based on the mode's configured model
    if (config?.agent) {
      const currentAgent = config.agent[modeId];
      await this.client.config.update({
        directory: cwd,
        config: {
          default_agent: modeId,
          ...(currentAgent?.model ? { model: currentAgent.model } : {}),
        },
      });
    }
  }

  async getSessionInfo(cwd: string): Promise<{
    models: Array<{ id: string; name: string }>;
    modes: Array<{ id: string; name: string }>;
    currentModelId?: string;
    currentModeId?: string;
  }> {
    if (!this.client) {
      throw new Error("Not connected to OpenCode");
    }

    // Get config to retrieve models and modes using the main client
    const configResponse = await this.client.config.get({
      directory: cwd,
    });
    const config = configResponse.data;

    const providersResponse = await this.client.config.providers({
      directory: cwd,
    });
    const providers = providersResponse.data;

    // Extract available models from providers
    const models: Array<{ id: string; name: string }> = [];
    if (providers?.providers) {
      for (const provider of providers.providers) {
        for (const [modelId, model] of Object.entries(provider.models)) {
          models.push({
            id: `${provider.id}/${modelId}`,
            name: model.name,
          });
        }
      }
    }

    // Extract available modes from config
    const modes: Array<{ id: string; name: string }> = [];
    if (config?.agent) {
      for (const modeId of Object.keys(config.agent)) {
        modes.push({
          id: modeId,
          name: modeId.charAt(0).toUpperCase() + modeId.slice(1),
        });
      }
    }

    return {
      models,
      modes,
      currentModelId: config?.model,
      currentModeId: config?.default_agent,
    };
  }

  async sendPrompt(sessionId: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected to OpenCode");
    }

    const cwd = await this.resolveSessionCwd(sessionId);

    // Mark prompt as active for this session
    this.activePrompts.add(sessionId);

    console.log(`[SDK] Sending prompt to session: ${sessionId} in directory: ${cwd}`);

    // Send prompt using async endpoint with the main client
    await this.client.session.promptAsync({
      sessionID: sessionId,
      directory: cwd,
      parts: [{ type: "text", text }],
    });
  }

  async disconnect(): Promise<void> {
    await Promise.all(
      Array.from(this.streamingMessages.values()).map((cached) =>
        cached.streamingMessage.flushAndReset(),
      ),
    );
    this.streamingMessages.clear();

    if (this.eventStreamAbort) {
      this.eventStreamAbort.abort();
      this.eventStreamAbort = null;
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.client = null;
    this.discordRest = null;
    this.runDiscordEffect = null;
  }
}

export const sdkClient: VibecordClient = new VibecordClient();
