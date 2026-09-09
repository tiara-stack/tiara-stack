import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  SchedulesDeliverChannelFillers,
  type SchedulesDeliverChannelFillersInput,
} from "sheet-workflow-contracts";
import { renderTextForTest } from "../../services/testHelpers";
import { makeChannelFillersMessage, selectUniqueChannelFillers } from "./channelFillersDefinition";
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
  it("filters the selected channel and inclusive hour boundaries, skips breaks, and deduplicates identities", () => {
    expect(selectUniqueChannelFillers(view, input)).toEqual([
      { accountId: "account-alpha", name: "Alpha" },
      { accountId: "account-beta", name: "Beta" },
      { accountId: null, name: "Ghost" },
    ]);
  });

  it("does not mention ambiguous identities and skips hidden schedule rows", () => {
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

  it("renders known fillers as mentions and unknown fillers as names", () => {
    expect(makeChannelFillersMessage(input, selectUniqueChannelFillers(view, input))).toMatchObject(
      {
        allowedMentions: "default",
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
                  { type: "userMention", userId: "account-alpha" },
                  { type: "text", text: "\n" },
                  { type: "userMention", userId: "account-beta" },
                  { type: "text", text: "\n" },
                  { type: "text", text: "Ghost" },
                ],
              },
            ],
          },
        ],
      },
    );
  });

  it("uses the CSV fallback when filler chunks exceed Discord embed limits", () => {
    const fillers = Array.from({ length: 600 }, (_, index) => ({
      accountId: null,
      name: `Filler ${index}`,
    }));
    const message = makeChannelFillersMessage(input, fillers);
    const fields = message.embeds?.[0]?.fields ?? [];
    expect(fields.length).toBeLessThanOrEqual(25);
    expect(fields).toHaveLength(1);
    expect(message.files).toHaveLength(1);
    const csv = new TextDecoder().decode(message.files?.[0]?.content);
    expect(csv.split("\n")).toHaveLength(601);
    expect(csv).toContain('"Filler 0"');
    expect(csv).toContain('"Filler 199"');
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

  it("uses the complete CSV fallback for one name too long for an embed field", () => {
    const longName = "Filler ".concat("x".repeat(2_000));
    const message = makeChannelFillersMessage(input, [{ accountId: null, name: longName }]);

    expect(message.embeds?.[0]?.fields).toHaveLength(1);
    expect(message.files).toHaveLength(1);
    expect(new TextDecoder().decode(message.files?.[0]?.content)).toContain(longName);
  });

  it("neutralizes spreadsheet formula triggers while preserving CSV quoting", () => {
    const triggerNames = [
      "=formula",
      "+formula",
      "-formula",
      "@formula",
      "\tformula",
      "\rformula",
      " =formula",
      "  +formula",
      " \t-formula",
      "\n@formula",
    ];
    const whitespaceNames = [" plain", "  safe", "\tsafe", "\rsafe"];
    const fillers = [
      ...triggerNames.map((name) => ({ accountId: null, name })),
      ...whitespaceNames.map((name) => ({ accountId: null, name })),
      { accountId: null, name: 'quoted "name"\ncontinued' },
      ...Array.from({ length: 600 }, (_, index) => ({
        accountId: null,
        name: `Filler ${index}`,
      })),
    ];
    const message = makeChannelFillersMessage(input, fillers);
    const csv = new TextDecoder().decode(message.files?.[0]?.content);

    for (const name of triggerNames) {
      expect(csv).toContain(`"'${name.replaceAll('"', '""')}"`);
    }
    for (const name of whitespaceNames) {
      const safeName = name[0] === "\t" || name[0] === "\r" ? `'${name}` : name;
      expect(csv).toContain(`"${safeName.replaceAll('"', '""')}"`);
    }
    expect(csv).toContain('"quoted ""name""\ncontinued"');
  });
});
