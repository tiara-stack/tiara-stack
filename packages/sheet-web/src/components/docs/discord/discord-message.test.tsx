import { renderToStaticMarkup } from "react-dom/server";
import type { SheetOutboundMessage } from "sheet-ingress-api/schemas/client";
import { describe, expect, it } from "vitest";
import { DiscordMessage } from "./discord-message";

const referenceEpochMs = Date.UTC(2026, 6, 18, 12);

const renderMessage = (message: SheetOutboundMessage) =>
  renderToStaticMarkup(<DiscordMessage message={message} referenceEpochMs={referenceEpochMs} />);

describe("DiscordMessage", () => {
  it("aligns command invocations with the bot name and connects them to the bot avatar", () => {
    const markup = renderToStaticMarkup(
      <DiscordMessage
        command={{ name: "room_order manual", userName: "Theerie" }}
        message={{ content: "Done" }}
        referenceEpochMs={referenceEpochMs}
      />,
    );

    expect(markup).toContain(
      'class="relative mx-4 flex items-center gap-1.5 pl-[52px] pt-3 text-[13px] leading-5"',
    );
    expect(markup).toContain("absolute left-0 top-3 h-7 w-[52px]");
    expect(markup).toContain('d="M20 25V17C20 14.24 22.24 12 25 12H49"');
    expect(markup).toContain('stroke-linecap="round"');
    expect(markup).toContain("flex size-4 shrink-0 items-center justify-center");
    expect(markup).toContain("block -translate-y-px leading-none");
  });

  it("renders relative timestamps from the explicit reference time", () => {
    const markup = renderMessage({
      content: [
        { type: "timestamp", epochMs: referenceEpochMs + 45 * 60_000, style: "relative" },
        { type: "text", text: " / " },
        { type: "timestamp", epochMs: referenceEpochMs - 90 * 60_000, style: "relative" },
      ],
    });

    expect(markup).toContain("in 45 minutes");
    expect(markup).toContain("2 hours ago");
  });

  it("renders only enabled URL buttons as interactive links", () => {
    const enabledLink = {
      type: "button" as const,
      actionId: "enabled-link",
      label: "Enabled link",
      url: "https://example.com/enabled",
    };
    const disabledLink = {
      type: "button" as const,
      actionId: "disabled-link",
      label: "Disabled link",
      url: "https://example.com/disabled",
      disabled: true,
    };
    const markup = renderMessage({
      components: [
        {
          type: "actionRow",
          components: [
            { type: "button", actionId: "preview", label: "Preview action" },
            disabledLink,
            enabledLink,
          ],
        },
      ],
    });

    expect(markup.match(/<a /g)).toHaveLength(1);
    expect(markup).toContain('href="https://example.com/enabled"');
    expect(markup).not.toContain('href="https://example.com/disabled"');
    expect(markup).not.toContain("<button");
    expect(markup).toMatch(/<span[^>]*>Preview action<\/span>/);
    expect(markup).toMatch(/<span[^>]*aria-disabled="true"[^>]*>Disabled link/);
  });
});
