import { createOpencode, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk/v2";
import type { OpencodeClient, Event } from "@opencode-ai/sdk/v2";
import * as Diff from "diff";
import { eq } from "drizzle-orm";
import {
  Client,
  ThreadChannel,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type ButtonInteraction,
} from "discord.js";
import {
  BATCH_INTERVAL_MS,
  DIFF_TRUNCATION_LINES,
  SAFE_SPLIT_THRESHOLD,
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

interface BatchEntry {
  sessionId: string;
  updateType: string;
  content: string;
}

// Raw event data for merging before formatting
// updateType is determined upfront so merging only happens for same output type
interface RawBatchEntry {
  sessionId: string;
  updateType: "agent_message" | "agent_thought" | "todo" | "tool_call" | "diff";
  deltas: string[]; // Accumulated deltas for merging
  // For todo.updated, stores the latest todo list
  todos?: Array<{ status: string; content: string }>;
}

interface ServerInstance {
  url: string;
  close: () => void;
}

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
  private discordClient: Client | null = null;
  private batch: Map<string, RawBatchEntry[]> = new Map();
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  private batchIntervalMs = BATCH_INTERVAL_MS;
  private isFlushing = false;
  private eventStreamAbort: AbortController | null = null;
  private activePrompts: Set<string> = new Set();
  private sessionDirectories: Map<string, string> = new Map();

  setDiscordClient(client: Client): void {
    this.discordClient = client;
  }

  private async getThreadForSession(sessionId: string): Promise<ThreadChannel | null> {
    if (!this.discordClient) {
      return null;
    }

    // Look up session to get threadId
    const session = await getSessionByAcpSessionId(sessionId);

    if (!session || !session.threadId) {
      return null;
    }

    // Fetch the thread from Discord
    try {
      const channel = await this.discordClient.channels.fetch(session.threadId);
      if (channel && "send" in channel) {
        return channel as ThreadChannel;
      }
    } catch {
      // Silently fail - channel may have been deleted
    }

    return null;
  }

  // Tool part formatting (used when we add tool handling to raw batch)
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
      const diffResult = this.computeDiff(filediff.before, filediff.after);
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

  private computeDiff(oldText: string, newText: string): { lines: string[] } {
    const changes = Diff.diffLines(oldText, newText);
    const result: string[] = [];

    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      const lines = change.value.split("\n");
      // Remove the last empty line that comes from the split
      if (lines[lines.length - 1] === "") {
        lines.pop();
      }

      if (change.added) {
        // Show all added lines
        for (const line of lines) {
          result.push(`+${line}`);
        }
      } else if (change.removed) {
        // Show all removed lines
        for (const line of lines) {
          result.push(`-${line}`);
        }
      } else {
        // Unchanged lines - only show context around changes
        const prevChange = i > 0 ? changes[i - 1] : null;
        const nextChange = i < changes.length - 1 ? changes[i + 1] : null;
        const hasAdjacentChange =
          (prevChange && (prevChange.added || prevChange.removed)) ||
          (nextChange && (nextChange.added || nextChange.removed));

        if (!hasAdjacentChange) {
          // No adjacent changes - omit this block entirely or show count
          if (lines.length > 0) {
            result.push(` (${lines.length} lines omitted)`);
          }
        } else {
          // Show context lines around the adjacent change
          const prevLines =
            prevChange && (prevChange.added || prevChange.removed)
              ? lines.slice(-DIFF_CONTEXT_LINES)
              : [];
          const nextLines =
            nextChange && (nextChange.added || nextChange.removed)
              ? lines.slice(0, DIFF_CONTEXT_LINES)
              : [];

          // If both prev and next changes exist, we need to be careful not to duplicate
          if (prevChange && nextChange && lines.length > DIFF_CONTEXT_LINES * 2) {
            // Show trailing context for prev change
            for (const line of prevLines) {
              result.push(` ${line}`);
            }
            result.push(` (${lines.length - DIFF_CONTEXT_LINES * 2} lines omitted)`);
            // Show leading context for next change
            for (const line of nextLines) {
              result.push(` ${line}`);
            }
          } else {
            // Just show all lines (small unchanged block)
            for (const line of lines) {
              result.push(` ${line}`);
            }
          }
        }
      }
    }

    return { lines: result };
  }

  private formatEntryToLines(entry: BatchEntry): string[] {
    const { updateType, content } = entry;

    switch (updateType) {
      case UPDATE_TYPE.AGENT_MESSAGE: {
        // Regular text - split by lines, each line is a separate unit
        return content.split("\n");
      }
      case UPDATE_TYPE.AGENT_THOUGHT: {
        // Thinking/reasoning - add "-# " prefix to each line
        return content.split("\n").map((line) => (line.length > 0 ? `-# ${line}` : line));
      }
      case UPDATE_TYPE.TOOL_CALL: {
        // Tool calls are atomic - single line
        return [`\`tool used ${content}\``];
      }
      case UPDATE_TYPE.DIFF: {
        // Diffs are atomic - keep as single unit (already has code blocks)
        return [content];
      }
      case UPDATE_TYPE.TODO: {
        // Todo lists are atomic
        return [`[todo]\n${content}`];
      }
      case UPDATE_TYPE.USER_MESSAGE: {
        // User messages - wrap in bold, split by lines
        return content.split("\n").map((line) => (line.length > 0 ? `**${line}**` : line));
      }
      default: {
        return content.split("\n");
      }
    }
  }

  private startBatchTimer(): void {
    if (this.batchTimer) return;

    this.batchTimer = setInterval(() => {
      void this.flushBatch(false);
    }, this.batchIntervalMs);
  }

  private stopBatchTimer(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private async flushBatch(forceAll = false): Promise<void> {
    // Prevent concurrent flushes
    if (this.isFlushing) return;
    this.isFlushing = true;

    try {
      // If there's nothing to flush, return early
      if (this.batch.size === 0) {
        this.stopBatchTimer();
        return;
      }

      // Take current batch and replace with new empty one
      const currentBatch = this.batch;
      this.batch = new Map();

      // Process each session's batch
      for (const [sessionId, rawEntries] of currentBatch) {
        const thread = await this.getThreadForSession(sessionId);
        if (!thread) continue;

        // Split into complete and incomplete entries
        const { complete, incomplete } = this.splitCompleteAndIncomplete(
          rawEntries,
          forceAll || !this.activePrompts.has(sessionId),
        );

        // Put incomplete entries back into batch for next flush
        if (incomplete.length > 0) {
          const existing = this.batch.get(sessionId);
          if (existing) {
            existing.unshift(...incomplete);
          } else {
            this.batch.set(sessionId, [...incomplete]);
          }
          // Restart timer since we have pending entries
          this.startBatchTimer();
        }

        // Format and send complete entries
        if (complete.length > 0) {
          const formattedEntries = this.formatRawEntries(complete, sessionId);
          const concatenatedEntries = this.concatenateEntries(formattedEntries);
          if (concatenatedEntries.length > 0) {
            await this.sendEntriesAsLineBasedMessages(
              concatenatedEntries,
              thread,
              DISCORD_MESSAGE_MAX_LENGTH,
            );
          }
        }
      }
    } finally {
      this.isFlushing = false;
    }
  }

  private splitCompleteAndIncomplete(
    entries: RawBatchEntry[],
    forceAll: boolean,
  ): { complete: RawBatchEntry[]; incomplete: RawBatchEntry[] } {
    if (forceAll || entries.length === 0) {
      return { complete: entries, incomplete: [] };
    }

    // Find the last entry that is "complete" (safe to split after)
    let lastCompleteIndex = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];

      // Atomic types are always complete
      if (entry.updateType === UPDATE_TYPE.TODO || entry.updateType === UPDATE_TYPE.DIFF) {
        lastCompleteIndex = i;
        break;
      }

      // Check if this entry is followed by a different type
      const nextEntry = entries[i + 1];
      if (nextEntry && nextEntry.updateType !== entry.updateType) {
        lastCompleteIndex = i;
        break;
      }

      // Check if content ends at a safe boundary
      const content = entry.deltas.join("");
      if (this.isAtSafeBoundary(content)) {
        lastCompleteIndex = i;
        break;
      }
    }

    if (lastCompleteIndex === entries.length - 1) {
      // Last entry is complete
      return { complete: entries, incomplete: [] };
    } else if (lastCompleteIndex >= 0) {
      // Some entries are complete, rest are incomplete
      return {
        complete: entries.slice(0, lastCompleteIndex + 1),
        incomplete: entries.slice(lastCompleteIndex + 1),
      };
    } else {
      // No complete entries
      return { complete: [], incomplete: entries };
    }
  }

  private isAtSafeBoundary(content: string): boolean {
    // Must end with newline to avoid mid-line cuts
    if (!content.endsWith("\n")) return false;

    // Check if we're inside a code block (odd number of ```)
    const codeBlockMatches = content.match(/```/g);
    const inCodeBlock = codeBlockMatches ? codeBlockMatches.length % 2 !== 0 : false;
    if (inCodeBlock) return false;

    return true;
  }

  private formatRawEntries(rawEntries: RawBatchEntry[], sessionId: string): BatchEntry[] {
    return rawEntries.map((raw) => {
      if (raw.updateType === UPDATE_TYPE.TODO && raw.todos) {
        const planContent = raw.todos
          .map((t) => {
            const status =
              t.status === SESSION_STATUS.COMPLETED
                ? STATUS_EMOJI.COMPLETED
                : t.status === SESSION_STATUS.IN_PROGRESS
                  ? STATUS_EMOJI.IN_PROGRESS
                  : STATUS_EMOJI.PENDING;
            return `${status} ${t.content}`;
          })
          .join("\n");
        return { sessionId, updateType: UPDATE_TYPE.TODO, content: planContent };
      }
      // For message types, just join the deltas
      const mergedContent = raw.deltas.join("");
      return { sessionId, updateType: raw.updateType, content: mergedContent };
    });
  }

  private concatenateEntries(entries: BatchEntry[]): BatchEntry[] {
    const result: BatchEntry[] = [];
    let currentRun: BatchEntry[] = [];

    const pushCurrentRun = () => {
      if (currentRun.length === 0) return;
      if (currentRun.length === 1) {
        result.push(currentRun[0]);
      } else {
        const first = currentRun[0];
        const shouldNotConcat = first.updateType === UPDATE_TYPE.DIFF;
        const shouldCommaConcat = first.updateType === UPDATE_TYPE.TOOL_CALL;

        if (shouldNotConcat) {
          result.push(...currentRun);
        } else if (shouldCommaConcat) {
          const concatenated = currentRun.map((e) => e.content).join(", ");
          result.push({ ...first, content: concatenated });
        } else {
          const concatenated = currentRun.map((e) => e.content).join("");
          result.push({ ...first, content: concatenated });
        }
      }
      currentRun = [];
    };

    for (const entry of entries) {
      if (currentRun.length === 0 || entry.updateType === currentRun[0].updateType) {
        currentRun.push(entry);
      } else {
        pushCurrentRun();
        currentRun.push(entry);
      }
    }
    pushCurrentRun();

    return result;
  }

  private async sendEntriesAsLineBasedMessages(
    entries: BatchEntry[],
    thread: ThreadChannel,
    maxLength: number,
  ): Promise<void> {
    const textEntries: BatchEntry[] = [];
    const todoEntries: BatchEntry[] = [];

    // Separate text and todo entries
    for (const entry of entries) {
      if (entry.updateType === UPDATE_TYPE.TODO) {
        todoEntries.push(entry);
      } else {
        textEntries.push(entry);
      }
    }

    // Send todo entries as embeds
    for (const todoEntry of todoEntries) {
      const todos = todoEntry.content
        .split("\n")
        .map((line) => {
          const match = line.match(/^([✓◐○])\s+(.+)$/);
          if (match) {
            const status =
              match[1] === STATUS_EMOJI.COMPLETED
                ? SESSION_STATUS.COMPLETED
                : match[1] === STATUS_EMOJI.IN_PROGRESS
                  ? SESSION_STATUS.IN_PROGRESS
                  : "pending";
            return { status, content: match[2] };
          }
          return { status: "pending", content: line };
        })
        .filter((t) => t.content.length > 0);

      if (todos.length > 0) {
        const embed = this.createTodoEmbed(todos);
        await this.sendEmbed(embed, thread);
      }
    }

    // Process text entries as before
    if (textEntries.length === 0) return;

    // Format entries (adds -# prefix for thoughts, etc.)
    const lines: string[] = [];
    for (const entry of textEntries) {
      lines.push(...this.formatEntryToLines(entry));
    }

    // Build formatted content
    const fullContent = lines.join("\n");
    if (fullContent.length === 0) return;

    // Split into safe chunks
    const chunks = this.splitIntoSafeChunks(fullContent, maxLength);

    for (const chunk of chunks) {
      await this.sendChunk(chunk, thread);
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
    // Look for split points in priority order
    const searchEnd = Math.min(maxLength, content.length);
    const searchStart = Math.max(0, Math.floor(maxLength * SAFE_SPLIT_THRESHOLD));

    // Priority 1: Code block boundary (```)
    let inCodeBlock = false;
    for (let i = 0; i < searchEnd; i++) {
      if (content.substring(i, i + 3) === "```") {
        inCodeBlock = !inCodeBlock;
        if (!inCodeBlock && i >= searchStart && i + 3 <= searchEnd) {
          // Found end of code block within safe range
          return i + 3;
        }
      }
    }

    // Priority 2: Paragraph break (double newline)
    for (let i = searchEnd - 1; i >= searchStart; i--) {
      if (content.substring(i, i + 2) === "\n\n") {
        return i + 2;
      }
    }

    // Priority 3: Sentence end (. ! ?) followed by space or newline
    for (let i = searchEnd - 1; i >= searchStart; i--) {
      const char = content[i];
      const nextChar = content[i + 1];
      if (
        (char === "." || char === "!" || char === "?") &&
        (nextChar === " " || nextChar === "\n" || i + 1 === content.length)
      ) {
        return i + 1;
      }
    }

    // Priority 4: Line break
    for (let i = searchEnd - 1; i >= searchStart; i--) {
      if (content[i] === "\n") {
        return i + 1;
      }
    }

    // Priority 5: Word boundary (space)
    for (let i = searchEnd - 1; i >= searchStart; i--) {
      if (content[i] === " ") {
        return i + 1;
      }
    }

    // Fallback: hard split at maxLength
    return maxLength;
  }

  private async sendChunk(content: string, thread: ThreadChannel): Promise<void> {
    try {
      await thread.send(content);
    } catch {
      // Silently fail - thread may have been deleted
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
      void this.flushBatch(true);
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
          await thread.setName(truncatedTitle);
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

    // Extract raw data for merging, defer formatting
    const rawEntry = this.extractRawEvent(event, sessionId);
    if (!rawEntry) return;

    // Try to merge with previous entry of same type
    const existing = this.batch.get(sessionId);
    if (existing && existing.length > 0) {
      const lastEntry = existing[existing.length - 1];
      if (this.canMergeEntries(lastEntry, rawEntry)) {
        // Merge deltas
        lastEntry.deltas.push(...rawEntry.deltas);
        if (rawEntry.todos) {
          lastEntry.todos = rawEntry.todos;
        }
      } else {
        existing.push(rawEntry);
      }
    } else {
      this.batch.set(sessionId, [rawEntry]);
    }

    // Start batch timer if not already running
    this.startBatchTimer();
  }

  private extractRawEvent(event: Event, sessionId: string): RawBatchEntry | null {
    switch (event.type) {
      case "message.part.updated": {
        const part = event.properties.part;

        if (part.type === "text" || part.type === "reasoning") {
          const delta = (event.properties as { delta?: string }).delta;
          const content = delta ?? "";
          if (content === "") return null;

          if (part.type === "text") {
            return {
              sessionId,
              updateType: UPDATE_TYPE.AGENT_MESSAGE,
              deltas: [content],
            };
          }
          return {
            sessionId,
            updateType: UPDATE_TYPE.AGENT_THOUGHT,
            deltas: [content],
          };
        }

        if (part.type === "tool") {
          if (part.state.status === "completed") {
            const formatted = this.formatToolPart(part as ToolPart & { state: ToolStateCompleted });
            if (formatted) {
              return {
                sessionId,
                updateType: formatted.type as "diff" | "tool_call",
                deltas: [formatted.content],
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
            deltas: [],
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

  private canMergeEntries(a: RawBatchEntry, b: RawBatchEntry): boolean {
    // Only merge same updateType, and only message types (not todos or tool calls)
    if (a.updateType !== b.updateType) return false;
    return a.updateType === UPDATE_TYPE.AGENT_MESSAGE || a.updateType === UPDATE_TYPE.AGENT_THOUGHT;
  }

  // Create an embed for displaying todo lists
  private createTodoEmbed(todos: Array<{ status: string; content: string }>): EmbedBuilder {
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
    return new EmbedBuilder().setTitle("Todo List").setDescription(description).setColor(0x5865f2);
  }

  // Send an embed to a thread
  private async sendEmbed(embed: EmbedBuilder, thread: ThreadChannel): Promise<void> {
    try {
      await thread.send({ embeds: [embed] });
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
  ): { embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[] } {
    const permissionInfo = this.getPermissionDetails(type);
    const embed = new EmbedBuilder()
      .setTitle(permissionInfo.title)
      .setDescription(permissionInfo.description)
      .addFields(
        { name: "Permission Type", value: this.formatPermissionType(type), inline: true },
        {
          name: "Details",
          value: details.length > 1000 ? details.substring(0, 1000) + "..." : details,
          inline: false,
        },
      )
      .setColor(0xffa500)
      .setFooter({ text: requestId })
      .setTimestamp();

    const allowButton = new ButtonBuilder()
      .setCustomId(`p_${allowButtonId}`)
      .setLabel("Allow")
      .setStyle(ButtonStyle.Success);

    const denyButton = new ButtonBuilder()
      .setCustomId(`p_${denyButtonId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(allowButton, denyButton);

    return { embed, components: [row] };
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
      await thread.send({ embeds: [embed], components });

      console.log(`[SDK] Sent permission request ${requestID} for session ${sessionID}`);
    } catch (err) {
      console.error(`[SDK] Error handling permission request:`, err);
    }
  }

  // Handle button clicks for permissions
  async handlePermissionButton(interaction: ButtonInteraction): Promise<boolean> {
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
          ephemeral: true,
        });
        return true;
      }

      // Check authorization - only the session owner can click permission buttons
      if (mapping.userId && mapping.userId !== interaction.user.id) {
        await interaction.reply({
          content: "You are not authorized to respond to this permission request.",
          ephemeral: true,
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
      const updatedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(allowed ? "Allowed" : "Denied")
          .setStyle(allowed ? ButtonStyle.Success : ButtonStyle.Danger)
          .setDisabled(true),
      );

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
          ephemeral: true,
        });
        return true;
      }

      console.log(
        `[SDK] Permission ${allowed ? "granted" : "denied"} for session ${mapping.sessionId}`,
      );
      return true;
    } catch (err) {
      console.error(`[SDK] Error handling permission button:`, err);
      await interaction.reply({
        content: "Failed to process permission. Please try again.",
        ephemeral: true,
      });
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
    thread: ThreadChannel,
    requestId: string,
    sessionId: string,
    question: string,
    options: Array<{ value: string; label: string }>,
    _allowCustom: boolean,
  ): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("Question")
      .setDescription(question || "Please select an option:")
      .setColor(0x5865f2)
      .setFooter({ text: requestId || "Question" });

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let currentRow = new ActionRowBuilder<ButtonBuilder>();
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
      const button = new ButtonBuilder()
        .setCustomId(`q_${id}`)
        .setLabel(label)
        .setStyle(ButtonStyle.Primary);

      currentRow.addComponents(button);
      buttonCount++;

      // Discord allows max 5 buttons per row
      if (buttonCount === 5) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder<ButtonBuilder>();
        buttonCount = 0;
      }
    }

    if (buttonCount > 0) {
      rows.push(currentRow);
    }

    // Add cancel button with stored mapping (5th row)
    const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`qc_${cancelButtonId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    );
    rows.push(cancelRow);

    await thread.send({ embeds: [embed], components: rows });
  }

  // Handle button clicks for questions
  async handleQuestionButton(interaction: ButtonInteraction): Promise<boolean> {
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
          ephemeral: true,
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
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMessage, ephemeral: true });
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
      return true;
    }
  }

  // Submit question answer
  private async submitQuestionAnswer(
    interaction: ButtonInteraction,
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
        ephemeral: true,
      });

      console.log(`[SDK] Question ${requestId} answered with: ${optionValue}`);
    } catch (err) {
      console.error(`[SDK] Error submitting question answer:`, err);
      // Try to reply if we haven't already
      try {
        await interaction.reply({
          content: "Failed to submit your answer. Please try again.",
          ephemeral: true,
        });
      } catch {
        // If reply fails, try followUp
        try {
          await interaction.followUp({
            content: "Failed to submit your answer. Please try again.",
            ephemeral: true,
          });
        } catch {
          // Ignore if both fail
        }
      }
    }
  }

  // Cancel question
  private async cancelQuestion(
    interaction: ButtonInteraction,
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
        ephemeral: true,
      });

      console.log(`[SDK] Question ${requestId} cancelled`);
    } catch (err) {
      console.error(`[SDK] Error cancelling question:`, err);
      // Try to reply if we haven't already
      try {
        await interaction.reply({
          content: "Failed to cancel the question.",
          ephemeral: true,
        });
      } catch {
        // If reply fails, try followUp
        try {
          await interaction.followUp({
            content: "Failed to cancel the question.",
            ephemeral: true,
          });
        } catch {
          // Ignore if both fail
        }
      }
    }
  }

  // Disable all buttons
  private async disableQuestionButtons(interaction: ButtonInteraction): Promise<void> {
    const message = interaction.message;
    const disabledComponents: ActionRowBuilder<ButtonBuilder>[] = [];

    for (const row of message.components) {
      // Cast to unknown first, then to the expected type
      const actionRow = row as unknown as {
        components: Array<{
          type: number;
          customId?: string;
          label?: string;
          style?: number;
          disabled?: boolean;
        }>;
      };
      const newRow = new ActionRowBuilder<ButtonBuilder>();
      for (const component of actionRow.components) {
        if (component.type === 2) {
          // Button component
          const button = new ButtonBuilder()
            .setCustomId(component.customId || "")
            .setLabel(component.label || "")
            .setStyle(component.style || 1)
            .setDisabled(true);
          newRow.addComponents(button);
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

    // Get current mode from config
    const currentModeId = config?.agent ? Object.keys(config.agent)[0] : undefined;

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

    // Update the model based on the mode's configured model
    if (config?.agent) {
      const currentAgent = config.agent[modeId];
      if (currentAgent?.model) {
        await this.client.config.update({
          directory: cwd,
          config: {
            model: currentAgent.model,
          },
        });
      }
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
      currentModeId: config?.agent ? Object.keys(config.agent)[0] : undefined,
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
    this.stopBatchTimer();

    // Flush all remaining entries (forceAll=true to send everything)
    await this.flushBatch();

    if (this.eventStreamAbort) {
      this.eventStreamAbort.abort();
      this.eventStreamAbort = null;
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.client = null;
  }
}

export const sdkClient: VibecordClient = new VibecordClient();
