import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  DiscordStreamingMessage,
  SmoothTextAccumulator,
  StreamingMarkdownRenderer,
  findSafeSplitPoint,
  type DiscordStreamThread,
  type EditableDiscordMessage,
} from "./streaming";

function createThread(
  options: { editReject?: "once" | "always"; sendReject?: "once" | "always" } = {},
) {
  const messages: Array<EditableDiscordMessage & { edits: string[]; sentContent: string }> = [];
  let editFailures = 0;
  let sendFailures = 0;

  const thread: DiscordStreamThread = {
    send: vi.fn(async ({ content }: { content: string }) => {
      if (
        options.sendReject === "always" ||
        (options.sendReject === "once" && sendFailures === 0)
      ) {
        sendFailures++;
        throw new Error("send failed");
      }

      const message: EditableDiscordMessage & { edits: string[]; sentContent: string } = {
        id: `message-${messages.length + 1}`,
        edits: [],
        sentContent: content,
        edit: vi.fn(async ({ content: editContent }: { content: string }) => {
          if (
            options.editReject === "always" ||
            (options.editReject === "once" && editFailures === 0)
          ) {
            editFailures++;
            throw new Error("edit failed");
          }
          message.edits.push(editContent);
        }),
      };
      messages.push(message);
      return message;
    }),
  };

  return { messages, thread };
}

describe("SmoothTextAccumulator", () => {
  it("combines partial words and flushes trailing text", () => {
    const accumulator = new SmoothTextAccumulator();

    expect(accumulator.push({ sessionId: "s1", kind: "text", text: "Hel", partId: "t1" })).toEqual(
      [],
    );
    expect(accumulator.push({ sessionId: "s1", kind: "text", text: "lo, ", partId: "t1" })).toEqual(
      ["Hello, "],
    );
    expect(
      accumulator.push({ sessionId: "s1", kind: "text", text: "world", partId: "t1" }),
    ).toEqual([]);
    expect(accumulator.flush()).toEqual(["world"]);
  });

  it("formats reasoning deltas as Discord subtext", () => {
    const accumulator = new SmoothTextAccumulator();

    expect(
      accumulator.push({ sessionId: "s1", kind: "reasoning", text: "Let ", partId: "r1" }),
    ).toEqual(["-# Let "]);
    expect(
      accumulator.push({ sessionId: "s1", kind: "reasoning", text: "me\nNext ", partId: "r1" }),
    ).toEqual(["me\n", "-# Next "]);
  });

  it("flushes the active buffer when switching stream parts", () => {
    const accumulator = new SmoothTextAccumulator();

    expect(
      accumulator.push({ sessionId: "s1", kind: "text", text: "Hello", partId: "t1" }),
    ).toEqual([]);
    expect(
      accumulator.push({ sessionId: "s1", kind: "reasoning", text: "Thinking ", partId: "r1" }),
    ).toEqual(["Hello", "\n-# Thinking "]);
  });
});

describe("StreamingMarkdownRenderer", () => {
  it("repairs incomplete inline markdown for intermediate renders", () => {
    const renderer = new StreamingMarkdownRenderer();

    renderer.push("Hello **wor");

    expect(renderer.renderIntermediate()).toBe("Hello **wor**");
    expect(renderer.renderFinal()).toBe("Hello **wor");
  });

  it("holds back unconfirmed table rows", () => {
    const renderer = new StreamingMarkdownRenderer();

    renderer.push("| A | B |\n");
    expect(renderer.renderIntermediate()).toBe("");

    renderer.push("|---|---|\n| 1 | 2 |\n");
    expect(renderer.renderIntermediate()).toContain("| A | B |");
  });

  it("does not hold completed rows with a partial trailing table-like line", () => {
    const renderer = new StreamingMarkdownRenderer();

    renderer.push("| A | B |\n| C");

    expect(renderer.renderIntermediate()).toBe("| A | B |\n");
  });

  it("accepts table separators without a trailing pipe", () => {
    const renderer = new StreamingMarkdownRenderer();

    renderer.push("| A | B |\n");
    expect(renderer.renderIntermediate()).toBe("");

    renderer.push("|---|---\n| 1 | 2 |\n");
    expect(renderer.renderIntermediate()).toContain("| A | B |");
  });

  it("does not hold back pipe text inside code fences", () => {
    const renderer = new StreamingMarkdownRenderer();

    renderer.push("```\n| A | B |\n");

    expect(renderer.renderIntermediate()).toContain("| A | B |");
  });

  it("keeps code fence context when initialized mid-fence", () => {
    const renderer = new StreamingMarkdownRenderer({ initialInsideFence: true });

    renderer.push("| A | B |\n");

    expect(renderer.renderIntermediate()).toContain("| A | B |");
  });
});

describe("findSafeSplitPoint", () => {
  it("ignores inline fence markers when looking for code block boundaries", () => {
    const content = "Show ``` inline ``` code\n\nParagraph";

    expect(findSafeSplitPoint(content, 28)).toBe("Show ``` inline ``` code\n\n".length);
  });

  it("uses the initial fence state when detecting closing fence boundaries", () => {
    const content = "code inside\n```\n\nNext paragraph";

    expect(findSafeSplitPoint(content, 15, true)).toBe("code inside\n```".length);
  });
});

describe("DiscordStreamingMessage", () => {
  it("sends trailing text on final flush", async () => {
    const { messages, thread } = createThread();
    const streamingMessage = new DiscordStreamingMessage({ thread });

    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "Hello",
      partId: "t1",
    });
    expect(thread.send).not.toHaveBeenCalled();

    await streamingMessage.flush();

    expect(messages).toHaveLength(1);
    expect(messages[0].sentContent).toBe("Hello");
  });

  it("uses an updated thread for future sends", async () => {
    const first = createThread();
    const second = createThread();
    const streamingMessage = new DiscordStreamingMessage({ thread: first.thread });

    streamingMessage.updateThread(second.thread);
    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "Hello",
      partId: "t1",
    });
    await streamingMessage.flush();

    expect(first.thread.send).not.toHaveBeenCalled();
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].sentContent).toBe("Hello");
  });

  it("throttles intermediate edits", async () => {
    vi.useFakeTimers();
    const { messages, thread } = createThread();
    const streamingMessage = new DiscordStreamingMessage({ editIntervalMs: 500, thread });

    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "Hello ",
      partId: "t1",
    });
    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "world ",
      partId: "t1",
    });

    expect(thread.send).toHaveBeenCalledTimes(1);
    expect(messages[0].edits).toEqual([]);

    await vi.advanceTimersByTimeAsync(499);
    expect(messages[0].edits).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(messages[0].edits).toEqual(["Hello world"]);

    await streamingMessage.flush();
    vi.useRealTimers();
  });

  it("re-arms edits when chunks arrive during an in-flight edit", async () => {
    vi.useFakeTimers();
    let resolveFirstEdit: (() => void) | undefined;
    const messages: Array<EditableDiscordMessage & { edits: string[]; sentContent: string }> = [];
    const thread: DiscordStreamThread = {
      send: vi.fn(async ({ content }: { content: string }) => {
        const message: EditableDiscordMessage & { edits: string[]; sentContent: string } = {
          id: "message-1",
          edits: [],
          sentContent: content,
          edit: vi.fn(async ({ content: editContent }: { content: string }) => {
            message.edits.push(editContent);
            if (message.edits.length === 1) {
              await new Promise<void>((resolve) => {
                resolveFirstEdit = resolve;
              });
            }
          }),
        };
        messages.push(message);
        return message;
      }),
    };
    const streamingMessage = new DiscordStreamingMessage({ editIntervalMs: 500, thread });

    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "Hello ",
      partId: "t1",
    });
    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "there ",
      partId: "t1",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(messages[0].edits).toEqual(["Hello there"]);

    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "world ",
      partId: "t1",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(messages[0].edits).toEqual(["Hello there"]);

    resolveFirstEdit?.();
    await vi.advanceTimersByTimeAsync(500);

    expect(messages[0].edits).toEqual(["Hello there", "Hello there world"]);

    await streamingMessage.flush();
    vi.useRealTimers();
  });

  it("does not keep a re-armed intermediate timer after final flush", async () => {
    vi.useFakeTimers();
    let resolveFirstEdit: (() => void) | undefined;
    const messages: Array<EditableDiscordMessage & { edits: string[]; sentContent: string }> = [];
    const thread: DiscordStreamThread = {
      send: vi.fn(async ({ content }: { content: string }) => {
        const message: EditableDiscordMessage & { edits: string[]; sentContent: string } = {
          id: "message-1",
          edits: [],
          sentContent: content,
          edit: vi.fn(async ({ content: editContent }: { content: string }) => {
            message.edits.push(editContent);
            if (message.edits.length === 1) {
              await new Promise<void>((resolve) => {
                resolveFirstEdit = resolve;
              });
            }
          }),
        };
        messages.push(message);
        return message;
      }),
    };
    const streamingMessage = new DiscordStreamingMessage({ editIntervalMs: 500, thread });

    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "Hello ",
      partId: "t1",
    });
    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "there ",
      partId: "t1",
    });
    await vi.advanceTimersByTimeAsync(500);
    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "world ",
      partId: "t1",
    });

    resolveFirstEdit?.();
    await streamingMessage.flush();
    await vi.advanceTimersByTimeAsync(500);

    expect(messages[0].edits).toEqual(["Hello there", "Hello there world "]);

    vi.useRealTimers();
  });

  it("flushes and resets before a separate atomic event can be sent", async () => {
    const { messages, thread } = createThread();
    const streamingMessage = new DiscordStreamingMessage({ thread });

    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "Before",
      partId: "t1",
    });
    await streamingMessage.flushAndReset();
    await thread.send({ content: "`tool used read`" });
    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "After",
      partId: "t2",
    });
    await streamingMessage.flush();

    expect(messages.map((message) => message.sentContent)).toEqual([
      "Before",
      "`tool used read`",
      "After",
    ]);
  });

  it("rolls long output into multiple Discord messages", async () => {
    const { messages, thread } = createThread();
    const streamingMessage = new DiscordStreamingMessage({ maxSegmentLength: 20, thread });

    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "one two three four five six seven ",
      partId: "t1",
    });
    await streamingMessage.flush();

    const finalContents = messages.map((message) => message.edits.at(-1) ?? message.sentContent);
    expect(finalContents.length).toBeGreaterThan(1);
    expect(finalContents.every((content) => content.length <= 20)).toBe(true);
    expect(finalContents.join(" ")).toContain("one two three four five six seven");
  });

  it("preserves code fence context after rolling over mid-fence", async () => {
    const { messages, thread } = createThread();
    const streamingMessage = new DiscordStreamingMessage({ maxSegmentLength: 10, thread });

    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "```\n12345 | A | B |\n",
      partId: "t1",
    });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages[1].sentContent).toContain("| A | B |");

    await streamingMessage.flush();
  });

  it("uses code fence context for repeated rollovers inside the same fence", async () => {
    const { messages, thread } = createThread();
    const streamingMessage = new DiscordStreamingMessage({ maxSegmentLength: 16, thread });

    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "```\n1111111111\n2222222222\n```\nAfter ",
      partId: "t1",
    });
    await streamingMessage.flush();

    const finalContents = messages.map((message) => message.edits.at(-1) ?? message.sentContent);

    expect(finalContents).toContain("2222222222\n```");
  });

  it("does not send empty streams", async () => {
    const { thread } = createThread();
    const streamingMessage = new DiscordStreamingMessage({ thread });

    await streamingMessage.flush();

    expect(thread.send).not.toHaveBeenCalled();
  });

  it("logs intermediate edit failures and still sends final content", async () => {
    vi.useFakeTimers();
    const logger = { warn: vi.fn() };
    const { messages, thread } = createThread({ editReject: "once" });
    const streamingMessage = new DiscordStreamingMessage({
      editIntervalMs: 500,
      logger,
      thread,
    });

    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "Hello ",
      partId: "t1",
    });
    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "world ",
      partId: "t1",
    });
    await vi.advanceTimersByTimeAsync(500);
    await streamingMessage.flush();

    expect(logger.warn).toHaveBeenCalledWith(
      "[SDK] Streaming message edit failed",
      expect.any(Error),
    );
    expect(messages[0].edits.at(-1)).toBe("Hello world ");
    vi.useRealTimers();
  });

  it("falls back to a new message when final edit fails", async () => {
    const logger = { warn: vi.fn() };
    const { messages, thread } = createThread({ editReject: "always" });
    const streamingMessage = new DiscordStreamingMessage({ logger, thread });

    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "Hello ",
      partId: "t1",
    });
    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "world",
      partId: "t1",
    });
    await streamingMessage.flush();

    expect(messages).toHaveLength(2);
    expect(messages[1].sentContent).toBe("Hello world");
    expect(logger.warn).toHaveBeenCalledWith(
      "[SDK] Final streaming message edit failed",
      expect.any(Error),
    );
  });

  it("retries final send when the first send fails", async () => {
    const logger = { warn: vi.fn() };
    const { messages, thread } = createThread({ sendReject: "once" });
    const streamingMessage = new DiscordStreamingMessage({ logger, thread });

    await streamingMessage.pushDelta({
      sessionId: "s1",
      kind: "text",
      text: "Hello",
      partId: "t1",
    });
    await streamingMessage.flush();

    expect(thread.send).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(1);
    expect(messages[0].sentContent).toBe("Hello");
    expect(logger.warn).toHaveBeenCalledWith(
      "[SDK] Streaming message send failed",
      expect.any(Error),
    );
  });
});
