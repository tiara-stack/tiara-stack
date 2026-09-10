import { describe, expect, it } from "@effect/vitest";
import type { sheets_v4 } from "@googleapis/sheets";
import { Effect, Schema } from "effect";
import {
  SchedulesDeliverChannelFillers,
  type SchedulesDeliverChannelFillersInput,
} from "sheet-workflow-contracts";
import { renderTextForTest } from "../../services/testHelpers";
import { makeChannelFillersMessage, selectUniqueChannelFillers } from "./channelFillersDefinition";
import { makeUserScheduleProvider } from "./provider";
import type { UserScheduleView } from "./schema";

const input = Schema.decodeUnknownSync(SchedulesDeliverChannelFillers.input)({
  workspaceId: "workspace-1",
  responseReference: "response-1",
  conversationName: "running-alpha",
  startHour: 2,
  finishHour: 4,
}) satisfies SchedulesDeliverChannelFillersInput;

const view: UserScheduleView = {
  eventStartEpochMs: 0,
  players: [
    { accountId: "account-alpha", name: "Alpha" },
    { accountId: "account-alpha", name: "Alpha" },
    { accountId: "account-beta", name: "Beta" },
  ],
  monitors: [],
  schedules: [
    {
      channel: "running-alpha",
      day: 1,
      visible: true,
      hour: 2,
      break: false,
      fills: ["Alpha", "Beta", "Ghost", "Ghost"],
      overfills: [],
      standbys: [],
      monitor: null,
    },
    {
      channel: "running-alpha",
      day: 1,
      visible: true,
      hour: 4,
      break: false,
      fills: ["Alpha"],
      overfills: [],
      standbys: [],
      monitor: null,
    },
    {
      channel: "running-alpha",
      day: 1,
      visible: true,
      hour: 3,
      break: true,
      fills: ["Break filler"],
      overfills: [],
      standbys: [],
      monitor: null,
    },
    {
      channel: "running-alpha",
      day: 1,
      visible: true,
      hour: 5,
      break: false,
      fills: ["Outside range"],
      overfills: [],
      standbys: [],
      monitor: null,
    },
    {
      channel: "running-beta",
      day: 1,
      visible: true,
      hour: 2,
      break: false,
      fills: ["Other channel filler"],
      overfills: [],
      standbys: [],
      monitor: null,
    },
  ],
};

describe("channel filler selection", () => {
  it.effect("includes populated Fill rows while the schedule is not yet visible", () =>
    Effect.gen(function* () {
      const responses = [
        [
          {
            values: [
              ["User IDs", "'Players'!A1:A2"],
              ["User Sheet Names", "'Players'!B1:B2"],
            ],
          },
          { values: [["Start Time", "1767225600"]] },
          {
            values: [
              [
                "running-alpha",
                "1",
                "Runner's Schedule",
                "A1:A2",
                "auto",
                undefined,
                "none",
                "B1:B2",
                "C1:C2",
                "D1:D2",
                undefined,
                undefined,
                "E1",
              ],
            ],
          },
          {
            values: [
              ["Target", "1-3"],
              ["Other", "1-3"],
            ],
          },
        ],
        [
          { values: [["2"], ["3"]] },
          { values: [["Target"], ["Other"]] },
          { values: [[], []] },
          { values: [[], []] },
          { values: [[false]] },
          { values: [["account-target"], ["account-other"]] },
          { values: [["Target"], ["Other"]] },
        ],
      ] as const;
      let request = 0;
      const client = {
        spreadsheets: {
          values: {
            batchGet: () => Promise.resolve({ data: { valueRanges: responses[request++] ?? [] } }),
          },
        },
      } as unknown as sheets_v4.Sheets;

      const loaded = yield* makeUserScheduleProvider(client).loadAll("sheet-1");

      expect(loaded.schedules).toEqual([
        expect.objectContaining({
          channel: "running-alpha",
          visible: false,
          hour: 2,
          break: false,
          fills: ["Target"],
        }),
        expect.objectContaining({
          channel: "running-alpha",
          visible: false,
          hour: 3,
          break: false,
          fills: ["Other"],
        }),
      ]);

      expect(selectUniqueChannelFillers(loaded, input)).toEqual([
        { accountId: "account-other", name: "Other" },
        { accountId: "account-target", name: "Target" },
      ]);
    }),
  );

  it("filters the selected channel and inclusive hour boundaries, skips breaks, and deduplicates identities", () => {
    expect(selectUniqueChannelFillers(view, input)).toEqual([
      { accountId: "account-alpha", name: "Alpha" },
      { accountId: "account-beta", name: "Beta" },
      { accountId: null, name: "Ghost" },
    ]);
  });

  it("does not mention ambiguous identities and includes hidden schedule rows", () => {
    const ambiguousView: UserScheduleView = {
      ...view,
      players: [...view.players, { accountId: "account-beta-other", name: "Beta" }],
      schedules: [
        ...view.schedules,
        {
          channel: "running-alpha",
          day: 1,
          visible: false,
          hour: 3,
          break: false,
          fills: ["Hidden"],
          overfills: [],
          standbys: [],
          monitor: null,
        },
      ],
    };

    expect(selectUniqueChannelFillers(ambiguousView, input)).toEqual([
      { accountId: "account-alpha", name: "Alpha" },
      { accountId: null, name: "Beta" },
      { accountId: null, name: "Ghost" },
      { accountId: null, name: "Hidden" },
    ]);
  });

  it("rejects a reversed hour range at the contract boundary", () => {
    expect(() =>
      Schema.decodeUnknownSync(SchedulesDeliverChannelFillers.input)({
        ...input,
        startHour: 5,
        finishHour: 4,
      }),
    ).toThrow();
  });

  it("renders copyable raw mentions and unknown fillers in a non-pinging code block", () => {
    expect(makeChannelFillersMessage(input, selectUniqueChannelFillers(view, input))).toMatchObject(
      {
        allowedMentions: "none",
        embeds: [
          {
            fields: [
              {
                name: [{ type: "text", text: "Hours" }],
                value: [{ type: "text", text: "2-4" }],
                inline: true,
              },
              {
                name: [{ type: "text", text: "Fillers" }],
                value: [
                  {
                    type: "text",
                    text: "```\n<@account-alpha>\n<@account-beta>\nGhost\n```",
                  },
                ],
              },
            ],
          },
        ],
      },
    );
  });

  it("uses a complete copyable text fallback when filler chunks exceed Discord embed limits", () => {
    const fillers = Array.from({ length: 600 }, (_, index) => ({
      accountId: null,
      name: `Filler ${index}`,
    }));
    const message = makeChannelFillersMessage(input, fillers);
    const fields = message.embeds?.[0]?.fields ?? [];
    expect(fields.length).toBeLessThanOrEqual(25);
    expect(fields).toHaveLength(1);
    expect(message.files).toHaveLength(1);
    expect(message.files?.[0]?.name).toBe("fillers.txt");
    expect(message.files?.[0]?.contentType).toBe("text/plain");
    const text = new TextDecoder().decode(message.files?.[0]?.content);
    expect(text.split("\n")).toHaveLength(600);
    expect(text).toContain("Filler 0");
    expect(text).toContain("Filler 199");
    expect(message.allowedMentions).toBe("none");
  });

  it("preserves a multi-field list without an attachment when it fits Discord limits", () => {
    const fillers = Array.from({ length: 40 }, (_, index) => ({
      accountId: null,
      name: `Filler ${index} ${"x".repeat(30)}`,
    }));
    const message = makeChannelFillersMessage(input, fillers);
    const fields = message.embeds?.[0]?.fields ?? [];
    const fillerFields = fields.slice(1);

    expect(message.files).toBeUndefined();
    expect(fillerFields.map(({ name }) => renderTextForTest(name))).toEqual([
      "Fillers",
      "Fillers (continued)",
    ]);
    const renderedFillers = fillerFields
      .map(({ value }) => renderTextForTest(value) ?? "")
      .join("\n");
    for (const { name } of fillers) {
      expect(renderedFillers).toContain(name);
    }
  });

  it("budgets mention fields using their serialized Discord length", () => {
    const fillers = Array.from({ length: 43 }, (_, index) => ({
      accountId: "123456789012345678",
      name: `Filler ${index}`,
    }));
    const message = makeChannelFillersMessage(input, fillers);
    const fillerFields = (message.embeds?.[0]?.fields ?? []).slice(1);

    expect(message.files).toBeUndefined();
    expect(fillerFields.map(({ name }) => renderTextForTest(name))).toEqual([
      "Fillers",
      "Fillers (continued)",
    ]);
  });

  it("uses the complete text fallback for one name too long for an embed field", () => {
    const longName = "Filler ".concat("x".repeat(2_000));
    const message = makeChannelFillersMessage(input, [{ accountId: null, name: longName }]);

    expect(message.embeds?.[0]?.fields).toHaveLength(1);
    expect(message.files).toHaveLength(1);
    expect(new TextDecoder().decode(message.files?.[0]?.content)).toBe(longName);
  });

  it("uses the complete text fallback when an unlinked name contains a code fence", () => {
    const fillers = [
      { accountId: "account-alpha", name: "Alpha" },
      { accountId: null, name: "Name with ``` inside" },
      { accountId: null, name: "Name with ` inside" },
    ];
    const message = makeChannelFillersMessage(input, fillers);
    const text = new TextDecoder().decode(message.files?.[0]?.content);

    expect(message.embeds?.[0]?.fields).toHaveLength(1);
    expect(message.files?.[0]?.name).toBe("fillers.txt");
    expect(text).toBe("<@account-alpha>\nName with ``` inside\nName with ` inside");
    expect(message.allowedMentions).toBe("none");
  });

  it("neutralizes mention syntax in unlinked names while preserving resolved mention tokens", () => {
    const fillers = [
      { accountId: "resolved-user", name: "Resolved" },
      { accountId: null, name: "Unlinked <@123456789012345678>" },
      { accountId: null, name: "Unlinked <@&987654321098765432>" },
      { accountId: null, name: "Unlinked @everyone and @here" },
    ];
    const message = makeChannelFillersMessage(input, fillers);
    const rendered = renderTextForTest(message.embeds?.[0]?.fields?.[1]?.value);

    expect(rendered).toContain("<@resolved-user>");
    expect(rendered).toContain("<@\u200b123456789012345678>");
    expect(rendered).toContain("<@\u200b&987654321098765432>");
    expect(rendered).toContain("@\u200beveryone");
    expect(rendered).toContain("@\u200bhere");
    expect(rendered).not.toContain("<@123456789012345678>");
    expect(rendered).not.toContain("<@&987654321098765432>");
    expect(rendered).not.toContain("@everyone");
    expect(rendered).not.toContain("@here");
    expect(message.allowedMentions).toBe("none");
  });

  it("normalizes unlinked line breaks in embeds and text fallbacks", () => {
    const linked = { accountId: "resolved-user", name: "Resolved" };
    const unlinked = {
      accountId: null,
      name: "Unlinked\r\nline\nbreak\u2028paragraph\u2029end",
    };
    const inlineMessage = makeChannelFillersMessage(input, [linked, unlinked]);
    const inlineText = renderTextForTest(inlineMessage.embeds?.[0]?.fields?.[1]?.value);

    expect(inlineText).toContain("<@resolved-user>");
    expect(inlineText).toContain("Unlinked line break paragraph end");
    expect(inlineText).not.toContain("\r");
    expect(inlineText).not.toContain("\nline\n");
    expect(inlineText).not.toContain("\u2028");
    expect(inlineText).not.toContain("\u2029");

    const fillers = [
      linked,
      unlinked,
      ...Array.from({ length: 600 }, (_, index) => ({
        accountId: `account-${index}`,
        name: `Filler ${index}`,
      })),
    ];
    const fallbackMessage = makeChannelFillersMessage(input, fillers);
    const fallbackText = new TextDecoder().decode(fallbackMessage.files?.[0]?.content);

    expect(fallbackText.split("\n")).toHaveLength(fillers.length);
    expect(fallbackText).toContain("<@resolved-user>");
    expect(fallbackText).toContain("Unlinked line break paragraph end");
    expect(fallbackText).not.toContain("\r");
    expect(fallbackText).not.toContain("\nline\n");
    expect(fallbackText).not.toContain("\u2028");
    expect(fallbackText).not.toContain("\u2029");
  });

  it("keeps every raw mention and unlinked name in the text fallback", () => {
    const fillers = [
      { accountId: "resolved-user", name: "Resolved" },
      { accountId: null, name: "Unknown <@123456789012345678> @everyone ` filler" },
      ...Array.from({ length: 600 }, (_, index) => ({
        accountId: `account-${index}`,
        name: `Filler ${index}`,
      })),
    ];
    const message = makeChannelFillersMessage(input, fillers);
    const text = new TextDecoder().decode(message.files?.[0]?.content);

    expect(text.split("\n")).toHaveLength(fillers.length);
    expect(text).toContain("<@resolved-user>");
    expect(text).toContain("Unknown <@\u200b123456789012345678> @\u200beveryone ` filler");
    expect(text).not.toContain("<@123456789012345678>");
    expect(text).not.toContain("@everyone");
    expect(text).toContain("<@account-599>");
    expect(message.allowedMentions).toBe("none");
  });
});
