import remend from "remend";
import {
  DISCORD_STREAM_EDIT_INTERVAL_MS,
  DISCORD_STREAM_SEGMENT_MAX_LENGTH,
  SAFE_SPLIT_THRESHOLD,
  STREAM_CHUNKING_MODE,
} from "../constants";

export type StreamDeltaKind = "text" | "reasoning";

export interface StreamDelta {
  sessionId: string;
  kind: StreamDeltaKind;
  text: string;
  partId: string;
}

export interface StreamAtomicEvent {
  sessionId: string;
  updateType: "todo" | "tool_call" | "diff";
  content?: string;
  todos?: Array<{ status: string; content: string }>;
}

export type ChunkingMode = "word" | "line";
type ChunkDetector = (buffer: string) => string | null;

export interface EditableDiscordMessage {
  id: string;
  edit: (content: { content: string }) => Promise<unknown>;
}

export interface DiscordStreamThread {
  send: (content: { content: string }) => Promise<EditableDiscordMessage>;
}

export interface DiscordStreamingMessageOptions {
  editIntervalMs?: number;
  logger?: Pick<Console, "warn">;
  maxSegmentLength?: number;
  thread: DiscordStreamThread;
}

const CHUNKING_REGEXP_SOURCES: Record<ChunkingMode, string> = {
  line: "\\n+",
  word: "\\S+\\s+",
};

function createChunkDetector(chunking: ChunkingMode = STREAM_CHUNKING_MODE): ChunkDetector {
  const regexp = new RegExp(CHUNKING_REGEXP_SOURCES[chunking]);
  return (buffer) => {
    const match = regexp.exec(buffer);
    if (!match) {
      return null;
    }
    return buffer.slice(0, match.index) + match[0];
  };
}

export class SmoothTextAccumulator {
  private buffer = "";
  private currentKind: StreamDeltaKind | null = null;
  private currentPartId = "";
  private readonly detectChunk: ChunkDetector;
  private readonly formatter = new DiscordDeltaFormatter();

  constructor(chunking: ChunkingMode = STREAM_CHUNKING_MODE) {
    this.detectChunk = createChunkDetector(chunking);
  }

  push(delta: StreamDelta): string[] {
    const chunks: string[] = [];

    if (
      this.buffer.length > 0 &&
      this.currentKind !== null &&
      (this.currentKind !== delta.kind || this.currentPartId !== delta.partId)
    ) {
      chunks.push(this.formatter.format(this.currentKind, this.buffer));
      this.buffer = "";
    }

    this.currentKind = delta.kind;
    this.currentPartId = delta.partId;
    this.buffer += delta.text;

    let match = this.detectChunk(this.buffer);
    while (match !== null) {
      chunks.push(this.formatter.format(delta.kind, match));
      this.buffer = this.buffer.slice(match.length);
      match = this.detectChunk(this.buffer);
    }

    return chunks.filter((chunk) => chunk.length > 0);
  }

  flush(): string[] {
    if (this.buffer.length === 0 || this.currentKind === null) {
      return [];
    }
    const chunk = this.formatter.format(this.currentKind, this.buffer);
    this.buffer = "";
    return chunk.length > 0 ? [chunk] : [];
  }
}

class DiscordDeltaFormatter {
  private atLineStart = true;
  private currentKind: StreamDeltaKind | null = null;
  private hasOutput = false;

  format(kind: StreamDeltaKind, text: string): string {
    let output = "";

    if (this.hasOutput && this.currentKind !== kind && !this.atLineStart) {
      output += "\n";
      this.atLineStart = true;
    }
    this.currentKind = kind;

    if (kind === "text") {
      output += text;
      if (text.length > 0) {
        this.atLineStart = text.endsWith("\n");
      }
      this.hasOutput = this.hasOutput || output.length > 0;
      return output;
    }

    for (const char of text) {
      if (this.atLineStart && char !== "\n") {
        output += "-# ";
        this.atLineStart = false;
      }
      output += char;
      if (char === "\n") {
        this.atLineStart = true;
      }
    }

    this.hasOutput = this.hasOutput || output.length > 0;
    return output;
  }
}

interface StreamingMarkdownRendererOptions {
  initialText?: string;
  initialInsideFence?: boolean;
}

export class StreamingMarkdownRenderer {
  private accumulated = "";
  private cachedRender = "";
  private dirty = true;
  private fenceToggles = 0;
  private incompleteLine = "";

  constructor(options: StreamingMarkdownRendererOptions = {}) {
    if (options.initialInsideFence) {
      this.fenceToggles = 1;
    }
    if (options.initialText) {
      this.push(options.initialText);
    }
  }

  push(chunk: string): void {
    this.accumulated += chunk;
    this.dirty = true;

    this.incompleteLine += chunk;
    const parts = this.incompleteLine.split("\n");
    this.incompleteLine = parts.pop() ?? "";

    for (const line of parts) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        this.fenceToggles++;
      }
    }
  }

  getText(): string {
    return this.accumulated;
  }

  renderIntermediate(): string {
    if (!this.dirty) {
      return this.cachedRender;
    }

    this.dirty = false;

    if (this.isAccumulatedInsideFence()) {
      this.cachedRender = remend(this.accumulated);
      return this.cachedRender;
    }

    this.cachedRender = remend(getCommittablePrefix(this.accumulated));
    return this.cachedRender;
  }

  renderFinal(): string {
    return this.accumulated;
  }

  private isAccumulatedInsideFence(): boolean {
    let inside = this.fenceToggles % 2 === 1;
    const trimmed = this.incompleteLine.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inside = !inside;
    }
    return inside;
  }
}

export class DiscordStreamingMessage {
  private accumulator = new SmoothTextAccumulator();
  private editIntervalMs: number;
  private lastEditContent = "";
  private logger: Pick<Console, "warn">;
  private maxSegmentLength: number;
  private message: EditableDiscordMessage | null = null;
  private pendingEdit: Promise<void> | null = null;
  private renderer = new StreamingMarkdownRenderer();
  private segmentStartsInsideFence = false;
  private thread: DiscordStreamThread;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: DiscordStreamingMessageOptions) {
    this.editIntervalMs = options.editIntervalMs ?? DISCORD_STREAM_EDIT_INTERVAL_MS;
    this.logger = options.logger ?? console;
    this.maxSegmentLength = options.maxSegmentLength ?? DISCORD_STREAM_SEGMENT_MAX_LENGTH;
    this.thread = options.thread;
  }

  updateThread(thread: DiscordStreamThread): void {
    this.thread = thread;
  }

  async pushDelta(delta: StreamDelta): Promise<void> {
    await this.appendChunks(this.accumulator.push(delta));
  }

  async flush(): Promise<void> {
    await this.appendChunks(this.accumulator.flush());
    this.clearTimer();
    if (this.pendingEdit) {
      await this.pendingEdit;
      this.clearTimer();
      this.pendingEdit = null;
    }
    await this.finalizeCurrentSegment();
  }

  async flushAndReset(): Promise<void> {
    await this.flush();
    this.resetSegment();
    this.accumulator = new SmoothTextAccumulator();
  }

  private async appendChunks(chunks: string[]): Promise<void> {
    for (const chunk of chunks) {
      this.renderer.push(chunk);
      await this.rollOverSegments();
    }

    if (chunks.length === 0) {
      return;
    }

    const content = this.renderer.renderIntermediate();
    if (content.trim().length > 0) {
      await this.ensureMessage(content);
      this.scheduleEdit();
    }
  }

  private async rollOverSegments(): Promise<void> {
    while (this.renderer.getText().length > this.maxSegmentLength) {
      const text = this.renderer.getText();
      const splitPoint = findSafeSplitPoint(
        text,
        this.maxSegmentLength,
        this.segmentStartsInsideFence,
      );
      const prefixText = text.slice(0, splitPoint);
      const isRemainderInsideFence = isInsideCodeFence(prefixText, this.segmentStartsInsideFence);
      const prefix = isRemainderInsideFence ? prefixText : prefixText.trimEnd();
      const remainderText = text.slice(splitPoint);
      const remainder = isRemainderInsideFence ? remainderText : remainderText.trimStart();

      if (prefix.length > 0) {
        await this.finalizeCurrentSegment(prefix);
      }

      this.resetSegment({ initialInsideFence: isRemainderInsideFence });
      if (remainder.length > 0) {
        this.renderer.push(remainder);
      }
    }
  }

  private scheduleEdit(): void {
    if (this.timer || this.pendingEdit || !this.message) {
      return;
    }

    if (!this.hasIntermediateChange()) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.pendingEdit = this.editIntermediate().finally(() => {
        this.pendingEdit = null;
        this.scheduleEdit();
      });
    }, this.editIntervalMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async editIntermediate(): Promise<void> {
    const content = this.renderer.renderIntermediate();
    if (content.trim().length === 0 || content === this.lastEditContent) {
      return;
    }

    try {
      await this.ensureMessage(content);
      if (!this.message || content === this.lastEditContent) {
        return;
      }
      await this.message.edit({ content });
      this.lastEditContent = content;
    } catch (error) {
      this.logger.warn("[SDK] Streaming message edit failed", error);
    }
  }

  private hasIntermediateChange(): boolean {
    const content = this.renderer.renderIntermediate();
    return content.trim().length > 0 && content !== this.lastEditContent;
  }

  private async ensureMessage(content: string): Promise<void> {
    if (this.message) {
      return;
    }

    try {
      this.message = await this.thread.send({ content });
      this.lastEditContent = content;
    } catch (error) {
      this.logger.warn("[SDK] Streaming message send failed", error);
    }
  }

  private async finalizeCurrentSegment(content = this.renderer.renderFinal()): Promise<void> {
    this.clearTimer();
    if (this.pendingEdit) {
      await this.pendingEdit;
      this.clearTimer();
      this.pendingEdit = null;
    }

    if (content.trim().length === 0) {
      return;
    }

    if (!this.message) {
      await this.ensureMessage(content);
      if (!this.message) {
        try {
          this.message = await this.thread.send({ content });
          this.lastEditContent = content;
        } catch (fallbackError) {
          this.logger.warn("[SDK] Final streaming message fallback send failed", fallbackError);
        }
      }
      return;
    }

    if (content === this.lastEditContent) {
      return;
    }

    try {
      await this.message.edit({ content });
      this.lastEditContent = content;
    } catch (error) {
      this.logger.warn("[SDK] Final streaming message edit failed", error);
      try {
        this.message = await this.thread.send({ content });
        this.lastEditContent = content;
      } catch (fallbackError) {
        this.logger.warn("[SDK] Final streaming message fallback send failed", fallbackError);
      }
    }
  }

  private resetSegment(options: StreamingMarkdownRendererOptions = {}): void {
    this.clearTimer();
    this.lastEditContent = "";
    this.message = null;
    this.pendingEdit = null;
    this.segmentStartsInsideFence = options.initialInsideFence ?? false;
    this.renderer = new StreamingMarkdownRenderer(options);
  }
}

export function findSafeSplitPoint(
  content: string,
  maxLength: number,
  initialInsideFence = false,
): number {
  const searchEnd = Math.min(maxLength, content.length);
  const searchStart = Math.max(0, Math.floor(maxLength * SAFE_SPLIT_THRESHOLD));

  let inCodeBlock = initialInsideFence;
  for (let i = 0; i < searchEnd; i++) {
    if (isFenceMarkerAtLineStart(content, i)) {
      inCodeBlock = !inCodeBlock;
      if (!inCodeBlock && i >= searchStart && i + 3 <= searchEnd) {
        return i + 3;
      }
    }
  }

  for (let i = searchEnd - 1; i >= searchStart; i--) {
    if (content.substring(i, i + 2) === "\n\n") {
      return i + 2;
    }
  }

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

  for (let i = searchEnd - 1; i >= searchStart; i--) {
    if (content[i] === "\n") {
      return i + 1;
    }
  }

  for (let i = searchEnd - 1; i >= searchStart; i--) {
    if (content[i] === " ") {
      return i + 1;
    }
  }

  return maxLength;
}

function isInsideCodeFence(text: string, initialInsideFence = false): boolean {
  let inside = initialInsideFence;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inside = !inside;
    }
  }
  return inside;
}

function isFenceMarkerAtLineStart(content: string, index: number): boolean {
  const marker = content.substring(index, index + 3);
  if (marker !== "```" && marker !== "~~~") {
    return false;
  }

  for (let i = index - 1; i >= 0 && content[i] !== "\n"; i--) {
    if (content[i] !== " " && content[i] !== "\t") {
      return false;
    }
  }

  return true;
}

function getCommittablePrefix(text: string): string {
  const endsWithNewline = text.endsWith("\n");
  const lines = text.split("\n");

  if (endsWithNewline && lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }

  if (!endsWithNewline) {
    const incompleteLine = lines.pop() ?? "";
    if (POTENTIAL_TABLE_ROW_RE.test(incompleteLine.trim())) {
      return lines.length > 0 ? `${lines.join("\n")}\n` : "";
    }
    return text;
  }

  let heldCount = 0;
  let separatorFound = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]?.trim() ?? "";
    if (!POTENTIAL_TABLE_ROW_RE.test(trimmed)) {
      break;
    }

    heldCount++;
    if (TABLE_SEPARATOR_RE.test(trimmed)) {
      separatorFound = true;
      break;
    }
  }

  if (heldCount > 0 && !separatorFound) {
    const keptLines = lines.slice(0, -heldCount);
    return keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "";
  }

  return text;
}

const POTENTIAL_TABLE_ROW_RE = /^\|.*$/;
const TABLE_SEPARATOR_RE = /^\|[\s:]*-{1,}[\s:]*(\|[\s:]*-{1,}[\s:]*)*\|?$/;
