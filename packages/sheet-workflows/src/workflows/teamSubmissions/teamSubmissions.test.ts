import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { sheets_v4 } from "@googleapis/sheets";
import { messageRefFrom } from "sheet-bot-api";
import { MessageTeamSubmission } from "sheet-ingress-api/schemas/teamSubmission";
import { TeamSubmissionsDecide, TeamSubmissionsProcess } from "sheet-workflow-contracts";
import {
  appendRangeForCells,
  matchOshi,
  parseA1Start,
  parseTeamSubmissionMessage,
  preserveExistingStableKeys,
  renderConfirmation,
  rollbackValuesForRange,
} from "./pure";
import {
  TeamSubmissionsSheetWorkflows,
  TeamSubmissionsSheetWorkflowDefinitions,
} from "./definitions";
import { makeTeamSubmissionsSerializationKey } from "./keys";
import { makeTeamSubmissionProvider, type TeamSubmissionProviderShape } from "./provider";

const makeMessageTeamSubmission = ({
  parsedSubmission = [],
  rowMappings = [],
}: {
  readonly parsedSubmission?: (typeof MessageTeamSubmission.Type)["parsedSubmission"];
  readonly rowMappings?: (typeof MessageTeamSubmission.Type)["rowMappings"];
} = {}) => {
  const now = Schema.decodeUnknownSync(Schema.DateTimeUtcFromMillis)(0);
  return new MessageTeamSubmission({
    _tag: "MessageTeamSubmission",
    clientPlatform: "discord",
    clientId: "sheet-bot",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    discordGuildId: "workspace-1",
    discordChannelId: "conversation-1",
    discordAuthorId: "author-1",
    sheetId: "sheet-1",
    confirmationMessageId: Option.none(),
    parsedSubmission,
    rowMappings,
    rollbackSnapshot: Option.none(),
    version: 1,
    status: "registered" as const,
    createdAt: now,
    updatedAt: now,
    deletedAt: Option.none(),
  });
};

type SheetsOperation = () => Promise<unknown>;
type SheetsOperationCounts = {
  batchUpdate: number;
  batchGet: number;
  append: number;
};

const makeSheetsClient = (operations: {
  readonly batchUpdate?: SheetsOperation | undefined;
  readonly batchGet?: SheetsOperation | undefined;
  readonly append?: SheetsOperation | undefined;
}) => {
  const calls: SheetsOperationCounts = { batchUpdate: 0, batchGet: 0, append: 0 };
  const counted = (name: keyof SheetsOperationCounts, operation?: SheetsOperation) => () => {
    calls[name] += 1;
    return operation?.() ?? Promise.resolve({ data: {} });
  };
  const client = {
    spreadsheets: {
      values: {
        batchUpdate: counted("batchUpdate", operations.batchUpdate),
        batchGet: counted("batchGet", operations.batchGet),
        append: counted("append", operations.append),
      },
    },
  } as unknown as sheets_v4.Sheets;
  return { calls, client };
};

const expectFailureWithError = <A, E>(exit: Exit.Exit<A, E>, expected: unknown) =>
  Exit.match(exit, {
    onSuccess: () => {
      throw new Error("Expected effect to fail");
    },
    onFailure: (cause) =>
      expect(Cause.findErrorOption(cause)).toMatchObject({
        _tag: "Some",
        value: expected,
      }),
  });

const runProviderWrite = (provider: TeamSubmissionProviderShape) =>
  Effect.exit(provider.write("sheet-1", [{ range: "'Teams'!A2", values: [["written"]] }]));

const runProviderAppend = (provider: TeamSubmissionProviderShape, range: string) =>
  Effect.exit(provider.append("sheet-1", range, [["marked", "team", ""]]));

const expectSuccessfulWrite = <A, E>(
  exit: Exit.Exit<A, E>,
  calls: SheetsOperationCounts,
  batchUpdateCalls: number,
) => {
  expect(Exit.isSuccess(exit)).toBe(true);
  expect(calls.batchUpdate).toBe(batchUpdateCalls);
  expect(calls.batchGet).toBe(1);
};

const expectDeterministicWriteFailure = <A, E>(
  exit: Exit.Exit<A, E>,
  calls: SheetsOperationCounts,
) => {
  expect(Exit.isFailure(exit)).toBe(true);
  expect(calls.batchUpdate).toBe(1);
  expect(calls.batchGet).toBe(0);
};

const expectAmbiguousWriteFailure = <A, E>(exit: Exit.Exit<A, E>, calls: SheetsOperationCounts) => {
  expectFailureWithError(exit, {
    _tag: "TeamSubmissionWriteError",
    operation: "write",
    ambiguous: true,
  });
  expect(calls.batchUpdate).toBe(2);
  expect(calls.batchGet).toBe(1);
};

type WriteExpectation = "deterministic" | "success" | "retrySuccess" | "ambiguous";

const runProviderWriteCase = ({
  batchUpdate,
  batchGet,
  expectation,
}: {
  readonly batchUpdate: SheetsOperation;
  readonly batchGet?: SheetsOperation;
  readonly expectation: WriteExpectation;
}) =>
  Effect.gen(function* () {
    const { calls, client } = makeSheetsClient({ batchUpdate, batchGet });
    const exit = yield* runProviderWrite(makeTeamSubmissionProvider(client));
    if (expectation === "deterministic") expectDeterministicWriteFailure(exit, calls);
    else if (expectation === "ambiguous") expectAmbiguousWriteFailure(exit, calls);
    else expectSuccessfulWrite(exit, calls, expectation === "retrySuccess" ? 2 : 1);
  });

const expectAppendResult = <A, E>(
  exit: Exit.Exit<A, E>,
  calls: SheetsOperationCounts,
  expectedRange: string | null,
  batchGetCalls: number,
) => {
  if (expectedRange === null) {
    expect(Exit.isFailure(exit)).toBe(true);
  } else {
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe(expectedRange);
  }
  expect(calls.append).toBe(1);
  expect(calls.batchGet).toBe(batchGetCalls);
};

const runProviderAppendCase = ({
  range,
  append,
  batchGet,
  expectedRange,
  batchGetCalls,
}: {
  readonly range: string;
  readonly append: SheetsOperation;
  readonly batchGet?: SheetsOperation;
  readonly expectedRange: string | null;
  readonly batchGetCalls: number;
}) =>
  Effect.gen(function* () {
    const { calls, client } = makeSheetsClient({ append, batchGet });
    const exit = yield* runProviderAppend(makeTeamSubmissionProvider(client), range);
    expectAppendResult(exit, calls, expectedRange, batchGetCalls);
  });

describe("team-submission workflow definitions", () => {
  const client = { platform: "discord", clientId: "sheet-bot" } as const;

  it("publishes the process and decision workflows without an action side channel", () => {
    expect(
      TeamSubmissionsSheetWorkflowDefinitions.map(({ contract }) => contract.identity),
    ).toEqual([TeamSubmissionsProcess.identity, TeamSubmissionsDecide.identity]);
    expect(TeamSubmissionsSheetWorkflows).toHaveLength(2);
    expect(
      TeamSubmissionsSheetWorkflowDefinitions.every(({ actions }) => actions.length === 0),
    ).toBe(true);
  });

  it("serializes process and decision invocations by the canonical source message", () => {
    const sourceMessage = messageRefFrom(client, "workspace-1", "conversation-1", "message-1");
    const processInput = {
      sourceMessage,
      authorId: "author-1",
      authorDisplayName: "Player",
      content: "ff: 150/700",
    };
    const decideInput = {
      responseReference: "response-1",
      sourceMessage,
      confirmationMessage: messageRefFrom(
        client,
        "workspace-1",
        "conversation-1",
        "confirmation-1",
      ),
      decision: "confirm" as const,
    };
    const processKey = makeTeamSubmissionsSerializationKey(processInput.sourceMessage);
    const decideKey = makeTeamSubmissionsSerializationKey(decideInput.sourceMessage);

    expect(processKey).toBe(decideKey);
    expect(processKey).toBe(
      JSON.stringify(["discord", "sheet-bot", "workspace-1", "conversation-1", "message-1"]),
    );
  });

  it("bounds long serialization keys without collapsing distinct messages", () => {
    const first = messageRefFrom(client, "w".repeat(300), "conversation-1", "message-1");
    const second = messageRefFrom(client, "w".repeat(300), "conversation-1", "message-2");

    const firstKey = makeTeamSubmissionsSerializationKey(first);
    const secondKey = makeTeamSubmissionsSerializationKey(second);

    expect(Buffer.byteLength(firstKey, "utf8")).toBeLessThanOrEqual(255);
    expect(firstKey).not.toBe(secondKey);

    const boundary = messageRefFrom(client, "w".repeat(200), "conversation-1", "message-1");
    const boundaryCanonical = JSON.stringify([
      client.platform,
      client.clientId,
      boundary.conversation.workspace.workspaceId,
      boundary.conversation.conversationId,
      boundary.messageId,
    ]);
    expect(Buffer.byteLength(boundaryCanonical, "utf8")).toBe(255);
    expect(makeTeamSubmissionsSerializationKey(boundary)).toBe(boundaryCanonical);
    expect(firstKey).toMatch(/^teamSubmissions:[A-Za-z0-9_-]+$/);
  });
});

describe("team-submission pure rules", () => {
  it("parses labeled alternatives, role notes, and an exact oshi candidate", () => {
    const result = parseTeamSubmissionMessage(
      [
        "oshi: Rin",
        "full fill: 150/700 or 150/710",
        "heal: 100/690 4* or 80/670 BD",
        "encore: 150/620 Encore",
        "alt: 150/680 Backup",
      ].join("\n"),
      "Theerie",
    );

    expect(result.disposition).toBe("accepted");
    expect(result.oshiCandidate).toBe("Rin");
    expect(result.entries.map(({ teamType }) => teamType)).toEqual([
      "fullFill",
      "fullFill",
      "heal",
      "heal",
      "encore",
      "alt",
    ]);
    expect(result.entries[2]?.notes).toContain("4-star");
    expect(result.entries[3]?.notes).toContain("birthday");
  });

  it("keeps inline role markers and splits heal alternatives", () => {
    const result = parseTeamSubmissionMessage(
      ["150/645", "130/580 alt", "heal: 80/595 or 70/580"].join("\n"),
      "Player",
    );

    expect(result.entries.map(({ teamType, teamName }) => [teamType, teamName])).toEqual([
      ["fullFill", "150/645"],
      ["alt", "130/580"],
      ["heal", "80/595"],
      ["heal", "70/580"],
    ]);
  });

  it("preserves stable keys when same-type entries are reordered", () => {
    const first = parseTeamSubmissionMessage(
      ["full fill: 140/700/324k", "full fill: 150/690 325k"].join("\n"),
      "Player",
    );
    const reordered = parseTeamSubmissionMessage(
      ["full fill: 150/690 325k", "full fill: 140/700/324k"].join("\n"),
      "Player",
    );
    const existing = makeMessageTeamSubmission({
      parsedSubmission: first.entries.map((entry, index) => ({
        ...entry,
        stableKey: `fullFill:legacy-${index + 1}`,
      })),
    });

    const preserved = preserveExistingStableKeys(existing, reordered.entries);
    expect(
      Object.fromEntries(preserved.map(({ teamName, stableKey }) => [teamName, stableKey])),
    ).toEqual(
      Object.fromEntries([
        ["150/690 325k", "fullFill:legacy-2"],
        ["140/700/324k", "fullFill:legacy-1"],
      ]),
    );
  });

  it("falls back to row mapping stable keys when parsed submission is unavailable", () => {
    const parsed = parseTeamSubmissionMessage(
      ["full fill: 140/700/324k", "full fill: 150/690 325k"].join("\n"),
      "Player",
    );
    const existing = makeMessageTeamSubmission({
      rowMappings: [1, 2].map((rowIndex) => ({
        stableKey: `fullFill:legacy-${rowIndex}`,
        playerNameRange: `'Teams'!A${rowIndex}`,
        teamNameRange: `'Teams'!B${rowIndex}`,
        oshiRange: null,
        rowIndex,
      })),
    });

    expect(
      preserveExistingStableKeys(existing, parsed.entries).map(({ stableKey }) => stableKey),
    ).toEqual(["fullFill:legacy-1", "fullFill:legacy-2"]);
  });

  it("handles quoted sheets and bounded oshi matching", () => {
    expect(
      appendRangeForCells("'Manager''s Teams'!A2:A", "'Manager''s Teams'!B2:B", null)?.range,
    ).toBe("'Manager''s Teams'!A:B");
    expect(parseA1Start("'Manager''s Teams'!A:B")).toEqual({
      sheet: "Manager's Teams",
      column: "A",
      row: 1,
    });
    expect(matchOshi("Miku <:miku:123>", ["Miku", "Mik"])).toEqual({
      candidate: "Miku <:miku:123>",
      value: "Miku",
      status: "matched",
    });
    expect(matchOshi("MikMiku and Mik", ["Mik"])).toEqual({
      candidate: "MikMiku and Mik",
      value: "Mik",
      status: "matched",
    });
  });

  it("truncates long confirmation messages within the platform budget", () => {
    const sourceMessage = messageRefFrom(
      { platform: "discord", clientId: "sheet-bot" },
      "workspace-1",
      "conversation-1",
      "message-1",
    );
    const entries = parseTeamSubmissionMessage(
      globalThis.Array.from(
        { length: 120 },
        (_, index) => `full fill: ${100 + index}/${600 + index} ${"long-team ".repeat(12)}`,
      ).join("\n"),
      "Player",
    ).entries;
    const confirmation = renderConfirmation(sourceMessage, entries);

    expect(entries).toHaveLength(120);
    expect(confirmation).toMatch(/- … and \d+ more$/);
    expect(confirmation.length).toBeLessThanOrEqual(2_000);
  });

  it("restores open and bounded rollback ranges to their configured shapes", () => {
    expect(rollbackValuesForRange("'Teams'!A2:A", [["Alice"]])).toEqual([["Alice"]]);
    expect(
      rollbackValuesForRange("'Teams'!A2:C5", [
        ["a", "b"],
        ["c", "d"],
      ]),
    ).toEqual([
      ["a", "b", ""],
      ["c", "d", ""],
      ["", "", ""],
      ["", "", ""],
    ]);
    expect(rollbackValuesForRange("'Teams'!A2:C", [["a", "b"]])).toEqual([["a", "b", ""]]);
    expect(
      rollbackValuesForRange("'Teams'!A2:C", [
        ["a", "b"],
        ["c", "d"],
      ]),
    ).toEqual([
      ["a", "b", ""],
      ["c", "d", ""],
    ]);
  });

  it("does not treat ordinary conversation as a submission", () => {
    expect(parseTeamSubmissionMessage("will do!", "Player")).toMatchObject({
      entries: [],
      oshiCandidate: null,
      disposition: "notSubmission",
    });
  });
});

describe("team-submission sheet provider", () => {
  it.effect("does not read back a deterministic transport rejection", () =>
    runProviderWriteCase({
      batchUpdate: () => Promise.reject({ code: "ECONNREFUSED" }),
      batchGet: () => Promise.resolve({ data: { valueRanges: [] } }),
      expectation: "deterministic",
    }),
  );

  it.effect("does not read back a deterministic write rejection", () =>
    Effect.gen(function* () {
      for (const status of [400, 401, 404]) {
        yield* runProviderWriteCase({
          batchUpdate: () => Promise.reject({ response: { status } }),
          batchGet: () => Promise.resolve({ data: { valueRanges: [] } }),
          expectation: "deterministic",
        });
      }
    }),
  );

  it.effect("reads back a bodyless forbidden write response before retrying", () =>
    runProviderWriteCase({
      batchUpdate: () => Promise.reject({ response: { status: 403 } }),
      batchGet: () => Promise.resolve({ data: { valueRanges: [{ values: [["written"]] }] } }),
      expectation: "success",
    }),
  );

  it.effect("resolves a non-deterministic transport failure through read-back", () =>
    runProviderWriteCase({
      batchUpdate: () => Promise.reject({ code: "ECONNRESET" }),
      batchGet: () => Promise.resolve({ data: { valueRanges: [{ values: [["written"]] }] } }),
      expectation: "success",
    }),
  );

  it.effect("resolves an unrecognized transport code through read-back", () =>
    runProviderWriteCase({
      batchUpdate: () => Promise.reject({ code: "UNRECOGNIZED_TRANSPORT" }),
      batchGet: () => Promise.resolve({ data: { valueRanges: [{ values: [["written"]] }] } }),
      expectation: "success",
    }),
  );

  it.effect("does not repeat an ambiguous write that is already visible", () =>
    runProviderWriteCase({
      batchUpdate: () => Promise.reject({ response: { status: 500 } }),
      batchGet: () => Promise.resolve({ data: { valueRanges: [{ values: [["written"]] }] } }),
      expectation: "success",
    }),
  );

  it.effect("succeeds when the ambiguous write retry commits", () =>
    runProviderWriteCase({
      batchUpdate: (() => {
        let attempts = 0;
        return () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject({ response: { status: 500 } })
            : Promise.resolve({ data: {} });
        };
      })(),
      batchGet: () => Promise.resolve({ data: { valueRanges: [{ values: [["different"]] }] } }),
      expectation: "retrySuccess",
    }),
  );

  it.effect("retries an ambiguous write once when read-back does not match", () =>
    runProviderWriteCase({
      batchUpdate: () => Promise.reject({ response: { status: 500 } }),
      batchGet: () => Promise.resolve({ data: { valueRanges: [{ values: [["different"]] }] } }),
      expectation: "ambiguous",
    }),
  );

  it.effect("retries an ambiguous write when read-back fails", () =>
    runProviderWriteCase({
      batchUpdate: () => Promise.reject({ response: { status: 503 } }),
      batchGet: () => Promise.reject({ response: { status: 400 } }),
      expectation: "ambiguous",
    }),
  );

  it.effect("reconciles an ambiguous append when Sheets omits trailing empty cells", () =>
    runProviderAppendCase({
      range: "'Teams'!A2:C",
      append: () => Promise.reject({ response: { status: 500 } }),
      batchGet: () =>
        Promise.resolve({ data: { valueRanges: [{ values: [["marked", "team"]] }] } }),
      expectedRange: "'Teams'!A2",
      batchGetCalls: 1,
    }),
  );

  it.effect("returns an empty row when append omits its updated range", () =>
    runProviderAppendCase({
      range: "'Teams'!A2:C",
      append: () => Promise.resolve({ data: {} }),
      expectedRange: "",
      batchGetCalls: 0,
    }),
  );

  it.effect("derives rowless append reconciliation rows from the append range", () =>
    runProviderAppendCase({
      range: "'Teams'!A:C",
      append: () => Promise.reject({ response: { status: 500 } }),
      batchGet: () =>
        Promise.resolve({
          data: {
            valueRanges: [
              {
                values: [
                  ["header", "team"],
                  ["other", "team"],
                  ["marked", "team"],
                ],
              },
            ],
          },
        }),
      expectedRange: "'Teams'!A3",
      batchGetCalls: 1,
    }),
  );

  it.effect("does not reconcile an append when multiple rows match", () =>
    runProviderAppendCase({
      range: "'Teams'!A2:C",
      append: () => Promise.reject({ response: { status: 500 } }),
      batchGet: () =>
        Promise.resolve({
          data: {
            valueRanges: [
              {
                values: [
                  ["marked", "team"],
                  ["marked", "team"],
                ],
              },
            ],
          },
        }),
      expectedRange: null,
      batchGetCalls: 1,
    }),
  );
});
