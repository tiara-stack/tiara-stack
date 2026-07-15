import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Option, Predicate } from "effect";
import {
  RangesConfig,
  TeamConfig,
  TeamTagsConstantsConfig,
} from "sheet-ingress-api/schemas/sheetConfig";
import { WorkspaceConfig } from "sheet-ingress-api/schemas/workspaceConfig";
import type {
  MessageTeamSubmission,
  TeamSubmissionRollbackSnapshot,
  TeamSubmissionUpsertFromDiscordPayload,
} from "sheet-ingress-api/schemas/teamSubmission";
import { GoogleSheets } from "./google/sheets";
import { SheetConfigService } from "./sheetConfig";
import { SheetZeroClient } from "./sheetZeroClient";
import { parseTeamSubmissionMessage, TeamSubmissionService } from "./teamSubmission";
import {
  appendRangeForCells,
  cellForRow,
  parseA1Start,
  renderConfirmation,
} from "./teamSubmission/pure";
import { WorkspaceConfigService } from "./workspaceConfig";

type GoogleSheetsApi = Context.Service.Shape<typeof GoogleSheets>;
type SheetConfigServiceApi = Context.Service.Shape<typeof SheetConfigService>;
type WorkspaceConfigServiceApi = Context.Service.Shape<typeof WorkspaceConfigService>;
type SheetZeroClientApi = Context.Service.Shape<typeof SheetZeroClient>;

const makeTeamConfig = ({
  name = "fill",
  tags = ["full fill", "heal"],
  teamNameRange = "'Teams'!B2:B",
}: {
  readonly name?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly teamNameRange?: string;
} = {}) =>
  new TeamConfig({
    name: Option.some(name),
    sheet: Option.some("Teams"),
    playerNameRange: Option.some("'Teams'!A2:A"),
    teamNameRange: Option.some(teamNameRange),
    isvConfig: Option.none(),
    tagsConfig: Option.some(new TeamTagsConstantsConfig({ tags: [...tags] })),
    oshiRange: Option.some("'Teams'!D2:D"),
  });

const teamConfig = makeTeamConfig();

const rangesConfig = new RangesConfig({
  userIds: "Users!A2:A",
  userSheetNames: "Users!B2:B",
  userNotes: Option.none(),
  monitorIds: Option.none(),
  monitorNames: Option.none(),
  oshis: Option.some("'Oshis'!A2:A"),
});

const payload = {
  client: { platform: "discord", clientId: "discord-main" },
  dispatchRequestId: "dispatch-1",
  workspaceId: "guild-1",
  conversationId: "channel-1",
  messageId: "message-1",
  authorId: "user-1",
  authorDisplayName: "Player",
  content: ["oshi: Rin", "full fill: Full Team", "heal: Heal Team"].join("\n"),
} as const satisfies TeamSubmissionUpsertFromDiscordPayload;

const workspaceConfig = new WorkspaceConfig({
  workspaceId: "guild-1",
  sheetId: Option.some("sheet-1"),
  autoCheckin: Option.none(),
  createdAt: Option.none(),
  updatedAt: Option.none(),
  deletedAt: Option.none(),
});

const makeWorkspaceConfigService = ({
  requireValidOshi = false,
}: { readonly requireValidOshi?: boolean } = {}) =>
  Layer.succeed(WorkspaceConfigService, {
    getWorkspaceConfig: () => Effect.succeed(Option.some(workspaceConfig)),
    getTeamSubmissionChannelByConversationId: () =>
      Effect.succeed(
        Option.some({
          destinationTeamConfigName: Option.none(),
          writeMode: "upsert" as const,
          removedRowStrategy: "blank" as const,
          requireValidOshi,
        }),
      ),
  } as unknown as WorkspaceConfigServiceApi);

const makeSheetConfigService = (teamConfigs: ReadonlyArray<TeamConfig> = [teamConfig]) =>
  Layer.succeed(SheetConfigService, {
    getRangesConfig: () => Effect.succeed(rangesConfig),
    getTeamConfig: () => Effect.succeed(teamConfigs),
  } as unknown as SheetConfigServiceApi);

const defaultRowMappings = [
  {
    stableKey: "fullFill:1",
    playerNameRange: "'Teams'!A2",
    teamNameRange: "'Teams'!B2",
    oshiRange: "'Teams'!D2",
    rowIndex: 2,
  },
  {
    stableKey: "heal:1",
    playerNameRange: "'Teams'!A3",
    teamNameRange: "'Teams'!B3",
    oshiRange: "'Teams'!D3",
    rowIndex: 3,
  },
] as const;

const makeExistingSubmissionFixture = ({
  parsedSubmission = [],
  rowMappings = defaultRowMappings,
  rollbackSnapshot = Option.none<TeamSubmissionRollbackSnapshot>(),
  status = "registered",
}: {
  readonly parsedSubmission?: MessageTeamSubmission["parsedSubmission"];
  readonly rowMappings?: MessageTeamSubmission["rowMappings"];
  readonly rollbackSnapshot?: MessageTeamSubmission["rollbackSnapshot"];
  readonly status?: MessageTeamSubmission["status"];
} = {}) =>
  ({
    workspaceId: payload.workspaceId,
    conversationId: payload.conversationId,
    messageId: payload.messageId,
    clientPlatform: payload.client.platform,
    confirmationMessageId: Option.some("confirmation-message-1"),
    rowMappings,
    parsedSubmission,
    version: 1,
    clientId: "discord-main",
    discordGuildId: payload.workspaceId,
    discordChannelId: payload.conversationId,
    discordAuthorId: "user-1",
    sheetId: "sheet-1",
    rollbackSnapshot,
    status,
  }) as unknown as MessageTeamSubmission;

const makeGoogleSheetsMock = ({
  appendedRanges,
  appendedValues,
  updates,
  appendStartRow = 2,
  existingRangeValues = {},
  failAppend = false,
  failUpdate = false,
}: {
  readonly appendedRanges?: string[];
  readonly appendedValues?: string[][][];
  readonly updates?: Array<{ range: string; values: string[][] }>;
  readonly appendStartRow?: number;
  readonly existingRangeValues?: Readonly<Record<string, string[][]>>;
  readonly failAppend?: boolean;
  readonly failUpdate?: boolean;
}) =>
  Layer.sync(GoogleSheets, () => {
    let appendRow = appendStartRow;
    return {
      get: ({ ranges }: { ranges: string[] }) =>
        Effect.succeed({
          data: {
            valueRanges: ranges.map((range) => ({
              range,
              values:
                range === "'Oshis'!A2:A"
                  ? [["Rin"], ["Miku Rin"]]
                  : (existingRangeValues[range] ?? []),
            })),
          },
        }),
      append: ({
        range,
        requestBody,
      }: {
        range?: string;
        requestBody?: { values?: string[][] };
      }) => {
        if (failAppend) {
          return Effect.die("append should not be called for existing row mappings");
        }
        appendedRanges?.push(range ?? "");
        if (requestBody?.values) {
          appendedValues?.push(requestBody.values);
        }
        const row = appendRow++;
        return Effect.succeed({
          data: { updates: { updatedRange: `'Teams'!A${row}:D${row}` } },
        });
      },
      update: ({
        requestBody,
      }: {
        requestBody: { data: Array<{ range: string; values: string[][] }> };
      }) =>
        Effect.sync(() => {
          if (failUpdate) {
            throw new Error("Google Sheets update failed");
          }
          updates?.push(...requestBody.data);
          return { data: {} };
        }),
    } as unknown as GoogleSheetsApi;
  });

const makeZeroMock = ({
  existingSubmission = Option.none<MessageTeamSubmission>(),
  persisted,
  confirmationUpdates,
  failPersistAt,
}: {
  readonly existingSubmission?: Option.Option<MessageTeamSubmission>;
  readonly persisted?: unknown[];
  readonly confirmationUpdates?: unknown[];
  readonly failPersistAt?: number;
} = {}) =>
  Layer.sync(SheetZeroClient, () => {
    let persistCount = 0;
    return {
      messageTeamSubmission: {
        getMessageTeamSubmission: () => Effect.succeed(existingSubmission),
        upsertMessageTeamSubmission: (value: unknown) =>
          Effect.gen(function* () {
            persistCount += 1;
            if (persistCount === failPersistAt) {
              return yield* Effect.fail(new Error("Persistence failed"));
            }
            persisted?.push(value);
          }),
        setMessageTeamSubmissionConfirmation: (value: unknown) =>
          Effect.sync(() => {
            confirmationUpdates?.push(value);
          }),
      },
    } as unknown as SheetZeroClientApi;
  });

const runUpsert = ({
  googleSheets,
  zero,
  workspaceConfigService = makeWorkspaceConfigService(),
  sheetConfigService = makeSheetConfigService(),
  inputPayload = payload,
}: {
  readonly googleSheets: Layer.Layer<GoogleSheets>;
  readonly zero: Layer.Layer<SheetZeroClient>;
  readonly workspaceConfigService?: Layer.Layer<WorkspaceConfigService>;
  readonly sheetConfigService?: Layer.Layer<SheetConfigService>;
  readonly inputPayload?: TeamSubmissionUpsertFromDiscordPayload;
}) =>
  Effect.gen(function* () {
    const service = yield* TeamSubmissionService.make;
    return yield* service.upsertFromDiscord(inputPayload);
  }).pipe(
    Effect.provide(Layer.mergeAll(googleSheets, sheetConfigService, workspaceConfigService, zero)),
  );

const runRevert = ({
  googleSheets,
  zero,
  requesterUserId = payload.authorId,
}: {
  readonly googleSheets: Layer.Layer<GoogleSheets>;
  readonly zero: Layer.Layer<SheetZeroClient>;
  readonly requesterUserId?: string;
}) =>
  Effect.gen(function* () {
    const service = yield* TeamSubmissionService.make;
    return yield* service.revertFromDiscord({
      client: payload.client,
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      confirmationMessageId: "confirmation-message-1",
      requesterUserId,
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(googleSheets, makeSheetConfigService(), makeWorkspaceConfigService(), zero),
    ),
  );

const runRollbackSnapshot = (
  rollbackSnapshot: TeamSubmissionRollbackSnapshot,
  status: MessageTeamSubmission["status"] = "registered",
) => {
  const updates: Array<{ range: string; values: string[][] }> = [];
  const existingSubmission = makeExistingSubmissionFixture({
    status,
    rollbackSnapshot: Option.some(rollbackSnapshot),
  });
  return runRevert({
    googleSheets: makeGoogleSheetsMock({ updates }),
    zero: makeZeroMock({ existingSubmission: Option.some(existingSubmission) }),
  }).pipe(Effect.map((result) => ({ result, updates })));
};

const runConfirm = ({
  zero,
  requesterUserId = payload.authorId,
  confirmationMessageId = "confirmation-message-1",
}: {
  readonly zero: Layer.Layer<SheetZeroClient>;
  readonly requesterUserId?: string;
  readonly confirmationMessageId?: string;
}) =>
  Effect.gen(function* () {
    const service = yield* TeamSubmissionService.make;
    return yield* service.confirmFromDiscord({
      client: payload.client,
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      confirmationMessageId,
      requesterUserId,
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        makeGoogleSheetsMock({}),
        makeSheetConfigService(),
        makeWorkspaceConfigService(),
        zero,
      ),
    ),
  );

const runSetConfirmation = ({ zero }: { readonly zero: Layer.Layer<SheetZeroClient> }) =>
  Effect.gen(function* () {
    const service = yield* TeamSubmissionService.make;
    return yield* service.setConfirmationMessage({
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      confirmationMessageId: "confirmation-message-1",
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        makeGoogleSheetsMock({}),
        makeSheetConfigService(),
        makeWorkspaceConfigService(),
        zero,
      ),
    ),
  );

const runInvalidOshiUpsert = (content: string, expectedReason: string) =>
  Effect.gen(function* () {
    const appendedRanges: string[] = [];
    const result = yield* runUpsert({
      googleSheets: makeGoogleSheetsMock({ appendedRanges }),
      zero: makeZeroMock(),
      workspaceConfigService: makeWorkspaceConfigService({ requireValidOshi: true }),
      inputPayload: { ...payload, content },
    });

    expect(appendedRanges).toEqual([]);
    expect(result.rowMappings).toEqual([]);
    expect(result.skippedTeams.map((entry) => entry.reason)).toEqual([expectedReason]);
    return result;
  });

const runExistingUpsert = (
  updates: Array<{ range: string; values: string[][] }>,
  options: {
    readonly sheetConfigService?: Layer.Layer<SheetConfigService>;
    readonly inputPayload?: TeamSubmissionUpsertFromDiscordPayload;
  } = {},
) =>
  runUpsert({
    googleSheets: makeGoogleSheetsMock({ updates, failAppend: true }),
    zero: makeZeroMock({
      existingSubmission: Option.some(makeExistingSubmissionFixture()),
    }),
    ...options,
  });

const expectBlankedRow = (
  updates: ReadonlyArray<{ range: string; values: string[][] }>,
  row: number,
) => {
  for (const column of ["A", "B", "D"]) {
    expect(updates).toContainEqual({ range: `'Teams'!${column}${row}`, values: [[""]] });
  }
};

const existingRollbackSnapshot = [
  {
    stableKey: "fullFill:1",
    range: "'Teams'!A2:B2",
    values: [["Old Player", "Old Team"]],
  },
] as const;

const makeRejectedActionFixture = (status: MessageTeamSubmission["status"] = "registered") => {
  const persisted: unknown[] = [];
  const existingSubmission = makeExistingSubmissionFixture({
    status,
    rollbackSnapshot: Option.some(existingRollbackSnapshot),
  });
  const zero = makeZeroMock({ existingSubmission: Option.some(existingSubmission), persisted });
  return {
    persisted,
    zero,
    googleSheets: makeGoogleSheetsMock({ failAppend: true, failUpdate: true }),
  };
};

const expectFailedExits = (...exits: ReadonlyArray<Exit.Exit<unknown, unknown>>) => {
  for (const exit of exits) {
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(Predicate.isTagged("ArgumentError")(failure)).toBe(true);
    }
  }
};

describe("parseTeamSubmissionMessage", () => {
  it("parses labeled submissions with multiple full fill options and exact oshi candidate", () => {
    const result = parseTeamSubmissionMessage(
      [
        "oshi: Rin",
        "full fill: Hero Team or Hero Team 2",
        "heal: Nurse Team (bd)",
        "encore: Encore Team",
        "alt: Backup Team",
      ].join("\n"),
      "Theerie",
    );

    expect(result.oshiCandidate).toBe("Rin");
    expect(result.entries.map((entry) => entry.stableKey)).toEqual([
      "fullFill:hero%20team",
      "fullFill:hero%20team%202",
      "heal:nurse%20team",
      "encore:encore%20team",
      "alt:backup%20team",
    ]);
    expect(result.entries.map((entry) => entry.playerName)).toEqual([
      "Theerie (full fill 1)",
      "Theerie (full fill 2)",
      "Theerie",
      "Theerie",
      "Theerie (alt 1)",
    ]);
    expect(result.entries[2]?.notes).toEqual(["bd"]);
  });

  it("infers full fill and heal when encore is omitted", () => {
    const result = parseTeamSubmissionMessage(
      ["Full team", "Heal team (4* lead)"].join("\n"),
      "Player",
    );

    expect(
      result.entries.map((entry) => [entry.teamType, entry.playerName, entry.teamName]),
    ).toEqual([
      ["fullFill", "Player", "Full team"],
      ["heal", "Player", "Heal team (4* lead)"],
    ]);
  });

  it("keeps stable keys attached to team content when same-type entries are reordered", () => {
    const first = parseTeamSubmissionMessage(
      ["full fill: Alpha", "full fill: Beta"].join("\n"),
      "Player",
    );
    const reordered = parseTeamSubmissionMessage(
      ["full fill: Beta", "full fill: Alpha"].join("\n"),
      "Player",
    );

    const keysByTeam = (entries: ReadonlyArray<{ teamName: string; stableKey: string }>) =>
      Object.fromEntries(entries.map((entry) => [entry.teamName, entry.stableKey]));
    expect(keysByTeam(reordered.entries)).toEqual(keysByTeam(first.entries));
  });

  it("preserves unknown colon prefixes as part of inferred team names", () => {
    const result = parseTeamSubmissionMessage("Team: Alpha", "Player");

    expect(result.entries.map((entry) => [entry.teamType, entry.teamName])).toEqual([
      ["fullFill", "Team: Alpha"],
    ]);
  });

  it("omits labeled entries whose team name is blank", () => {
    const result = parseTeamSubmissionMessage("heal:   ", "Player");

    expect(result.entries).toEqual([]);
  });

  it("parses and emits quoted A1 ranges containing apostrophes", () => {
    expect(parseA1Start("'Manager''s Teams'!A2:A")).toEqual({
      sheet: "Manager's Teams",
      column: "A",
      row: 2,
    });
    expect(cellForRow("'Manager''s Teams'!A2:A", 7)).toBe("'Manager''s Teams'!A7");
    expect(
      appendRangeForCells("'Manager''s Teams'!A2:A", "'Manager''s Teams'!B2:B", null)?.range,
    ).toBe("'Manager''s Teams'!A:B");
  });

  it("bounds confirmation messages and reports omitted entries", () => {
    const parsed = parseTeamSubmissionMessage(
      Array.from({ length: 100 }, (_, index) => `alt: ${"Team ".repeat(8)}${index}`).join("\n"),
      "Player",
    );
    const confirmation = renderConfirmation(payload, parsed.entries);

    expect(confirmation.length).toBeLessThanOrEqual(2_000);
    expect(confirmation).toMatch(/- … and \d+ more$/);
  });
});

describe("TeamSubmissionService.upsertFromDiscord", () => {
  it.effect("appends new rows and persists returned row mappings", () =>
    Effect.gen(function* () {
      const appendedRanges: string[] = [];
      const appendedValues: string[][][] = [];
      const updates: Array<{ range: string; values: string[][] }> = [];
      const persisted: unknown[] = [];
      const googleSheets = makeGoogleSheetsMock({ appendedRanges, appendedValues, updates });
      const zero = makeZeroMock({ persisted });

      const result = yield* runUpsert({ googleSheets, zero });

      expect(appendedRanges).toEqual(["'Teams'!A:D", "'Teams'!A:D"]);
      expect(appendedValues).toEqual([
        [
          [
            "Player\u2063tiara:guild-1:channel-1:message-1:fullFill:full%20team\u2063",
            "Full Team",
            "",
            "Rin",
          ],
        ],
        [
          [
            "Player\u2063tiara:guild-1:channel-1:message-1:heal:heal%20team\u2063",
            "Heal Team",
            "",
            "Rin",
          ],
        ],
      ]);
      expect(result.rowMappings.map((mapping) => mapping.rowIndex)).toEqual([2, 3]);
      expect(result.parsedTeams.map((entry) => entry.oshi.status)).toEqual(["matched", "matched"]);
      expect(updates).toContainEqual({ range: "'Teams'!A2", values: [["Player"]] });
      expect(persisted).toHaveLength(6);
      expect(persisted.map((entry) => (entry as { status: string }).status)).toEqual([
        "applying",
        "applying",
        "applying",
        "applying",
        "applying",
        "registered",
      ]);
      expect(
        (persisted.at(-1) as { rowMappings: ReadonlyArray<unknown> }).rowMappings,
      ).toHaveLength(2);
      expect(result.rollbackSnapshot).toEqual([
        { stableKey: "fullFill:full%20team", range: "'Teams'!A2", values: [] },
        { stableKey: "fullFill:full%20team", range: "'Teams'!B2", values: [] },
        { stableKey: "fullFill:full%20team", range: "'Teams'!D2", values: [] },
        { stableKey: "heal:heal%20team", range: "'Teams'!A3", values: [] },
        { stableKey: "heal:heal%20team", range: "'Teams'!B3", values: [] },
        { stableKey: "heal:heal%20team", range: "'Teams'!D3", values: [] },
      ]);
    }),
  );

  it.effect("does not append when pending recovery persistence fails", () =>
    Effect.gen(function* () {
      const appendedRanges: string[] = [];
      const exit = yield* Effect.exit(
        runUpsert({
          googleSheets: makeGoogleSheetsMock({ appendedRanges }),
          zero: makeZeroMock({ failPersistAt: 1 }),
          inputPayload: { ...payload, content: "full fill: Full Team" },
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Persistence failed");
      }
      expect(appendedRanges).toEqual([]);
    }),
  );

  it.effect("reconciles an append that succeeded before finalization", () =>
    Effect.gen(function* () {
      const firstPersisted: unknown[] = [];
      const firstAppends: string[] = [];
      const inputPayload = { ...payload, content: "full fill: Full Team" };
      const firstExit = yield* Effect.exit(
        runUpsert({
          googleSheets: makeGoogleSheetsMock({ appendedRanges: firstAppends }),
          zero: makeZeroMock({ persisted: firstPersisted, failPersistAt: 2 }),
          inputPayload,
        }),
      );

      expect(Exit.isFailure(firstExit)).toBe(true);
      expect(firstAppends).toEqual(["'Teams'!A:D"]);
      const pending = firstPersisted[0] as {
        parsedSubmission: MessageTeamSubmission["parsedSubmission"];
        rowMappings: MessageTeamSubmission["rowMappings"];
        rollbackSnapshot: TeamSubmissionRollbackSnapshot;
      };
      expect(pending.rowMappings[0]?.rowIndex).toBe(0);

      const retryAppends: string[] = [];
      const result = yield* runUpsert({
        googleSheets: makeGoogleSheetsMock({
          appendedRanges: retryAppends,
          existingRangeValues: {
            "'Teams'!A:D": [
              [],
              [
                "Player\u2063tiara:guild-1:channel-1:message-1:fullFill:full%20team\u2063",
                "Full Team",
                "",
                "",
              ],
            ],
          },
        }),
        zero: makeZeroMock({
          existingSubmission: Option.some(
            makeExistingSubmissionFixture({
              parsedSubmission: pending.parsedSubmission,
              rowMappings: pending.rowMappings,
              rollbackSnapshot: Option.some(pending.rollbackSnapshot),
              status: "applying",
            }),
          ),
        }),
        inputPayload,
      });

      expect(retryAppends).toEqual([]);
      expect(result.rowMappings[0]?.rowIndex).toBe(2);
    }),
  );

  it.effect("retries a finalized submission without appending duplicate rows", () =>
    Effect.gen(function* () {
      const appendedRanges: string[] = [];
      const result = yield* runUpsert({
        googleSheets: makeGoogleSheetsMock({ appendedRanges, failAppend: true }),
        zero: makeZeroMock({
          existingSubmission: Option.some(makeExistingSubmissionFixture()),
        }),
      });

      expect(appendedRanges).toEqual([]);
      expect(result.rowMappings).toEqual(defaultRowMappings);
    }),
  );

  it.effect("skips entries with invalid oshi candidates when valid oshi is required", () =>
    Effect.gen(function* () {
      const appendedRanges: string[] = [];
      const persisted: unknown[] = [];
      const googleSheets = makeGoogleSheetsMock({ appendedRanges });
      const zero = makeZeroMock({ persisted });

      const result = yield* runUpsert({
        googleSheets,
        zero,
        workspaceConfigService: makeWorkspaceConfigService({ requireValidOshi: true }),
        inputPayload: {
          ...payload,
          content: ["oshi: Miku", "full fill: Full Team"].join("\n"),
        },
      });

      expect(appendedRanges).toEqual([]);
      expect(result.rowMappings).toEqual([]);
      expect((persisted.at(-1) as { rowMappings: ReadonlyArray<unknown> }).rowMappings).toEqual([]);
      expect(result.skippedTeams.map((entry) => entry.reason)).toEqual(["Oshi Miku is not valid"]);
      expect(result.confirmationText).toContain("skipped Player | fullFill | Full Team");
    }),
  );

  it.effect("skips entries without an oshi when valid oshi is required", () =>
    Effect.gen(function* () {
      yield* runInvalidOshiUpsert("full fill: Full Team", "Oshi is required");
    }),
  );

  it.effect("matches oshi candidates by substring while returning the sheet value", () =>
    Effect.gen(function* () {
      const googleSheets = makeGoogleSheetsMock({ appendedRanges: [] });
      const zero = makeZeroMock();

      const result = yield* runUpsert({
        googleSheets,
        zero,
        inputPayload: {
          ...payload,
          content: ["oshi: my rin oshi", "full fill: Full Team"].join("\n"),
        },
      });

      expect(result.parsedTeams.map((entry) => entry.oshi)).toEqual([
        { candidate: "my rin oshi", value: "Rin", status: "matched" },
      ]);
    }),
  );

  it.effect("skips oshi candidates that match more than one configured oshi", () =>
    Effect.gen(function* () {
      yield* runInvalidOshiUpsert(
        ["oshi: Miku Rin", "full fill: Full Team"].join("\n"),
        "Oshi Miku Rin is not valid",
      );
    }),
  );

  it.effect("updates existing rows and blanks rows removed by message edits", () =>
    Effect.gen(function* () {
      const updates: Array<{ range: string; values: string[][] }> = [];
      const result = yield* runExistingUpsert(updates, {
        inputPayload: {
          ...payload,
          content: ["oshi: Rin", "full fill: Full Team"].join("\n"),
        },
      });

      expect(result.rowMappings.map((mapping) => mapping.rowIndex)).toEqual([2]);
      expect(updates).toContainEqual({ range: "'Teams'!A2", values: [["Player"]] });
      expect(updates).toContainEqual({ range: "'Teams'!B2", values: [["Full Team"]] });
      expect(updates).toContainEqual({ range: "'Teams'!D2", values: [["Rin"]] });
      expectBlankedRow(updates, 3);
    }),
  );

  it.effect("allows editing an empty persisted submission", () =>
    Effect.gen(function* () {
      const appendedRanges: string[] = [];
      const existingSubmission = makeExistingSubmissionFixture({
        rowMappings: [],
        status: "empty",
      });
      const googleSheets = makeGoogleSheetsMock({ appendedRanges });
      const zero = makeZeroMock({ existingSubmission: Option.some(existingSubmission) });

      const result = yield* runUpsert({ googleSheets, zero });

      expect(result.status).toBe("updated");
      expect(appendedRanges).toEqual(["'Teams'!A:D", "'Teams'!A:D"]);
    }),
  );

  it.effect(
    "blanks a previously mapped row when a stable key is dropped by validation on edit",
    () =>
      Effect.gen(function* () {
        const updates: Array<{ range: string; values: string[][] }> = [];
        const fullFillConfig = makeTeamConfig({ tags: ["full fill"] });
        const unwritableHealConfig = makeTeamConfig({
          name: "heal",
          tags: ["heal"],
          teamNameRange: "auto",
        });
        const result = yield* runExistingUpsert(updates, {
          sheetConfigService: makeSheetConfigService([fullFillConfig, unwritableHealConfig]),
        });

        expect(result.rowMappings.map((mapping) => mapping.stableKey)).toEqual(["fullFill:1"]);
        expect(result.skippedTeams.map((entry) => entry.stableKey)).toEqual(["heal:1"]);
        expect(result.confirmationText).toContain("skipped Player | heal | Heal Team");
        expectBlankedRow(updates, 3);
      }),
  );

  it.effect("marks rollback failed and retains the snapshot when sheet rollback update fails", () =>
    Effect.gen(function* () {
      const persisted: unknown[] = [];
      const rollbackSnapshot = [
        {
          stableKey: "fullFill:1",
          range: "'Teams'!A2:B2",
          values: [["Old Player", "Old Team"]],
        },
      ];
      const existingSubmission = makeExistingSubmissionFixture({
        rowMappings: [],
        rollbackSnapshot: Option.some(rollbackSnapshot),
      });
      const googleSheets = makeGoogleSheetsMock({ failUpdate: true });
      const zero = makeZeroMock({
        existingSubmission: Option.some(existingSubmission),
        persisted,
      });

      const result = yield* runRevert({ googleSheets, zero });

      expect(result.status).toBe("rollbackFailed");
      expect(result.rollbackSnapshot).toEqual(rollbackSnapshot);
      expect((persisted.at(-1) as { status: string; rollbackSnapshot: unknown }).status).toBe(
        "rollbackFailed",
      );
      expect((persisted.at(-1) as { rollbackSnapshot: unknown }).rollbackSnapshot).toEqual(
        rollbackSnapshot,
      );
      expect(persisted.map((entry) => (entry as { status: string }).status)).toEqual([
        "reverting",
        "rollbackFailed",
      ]);
    }),
  );

  it.effect("ignores pending append sentinels when reverting concrete ranges", () =>
    Effect.gen(function* () {
      const rollbackSnapshot = [
        { stableKey: "fullFill:1", range: "", values: [] },
        { stableKey: "heal:1", range: "'Teams'!A3:B3", values: [["Old Player"]] },
      ];
      const { result, updates } = yield* runRollbackSnapshot(rollbackSnapshot);

      expect(result.status).toBe("rejected");
      expect(updates).toEqual([{ range: "'Teams'!A3:B3", values: [["Old Player", ""]] }]);
    }),
  );

  it.effect("retries a rejection left in reverting after the sheet was restored", () =>
    Effect.gen(function* () {
      const { result, updates } = yield* runRollbackSnapshot(existingRollbackSnapshot, "reverting");

      expect(result.status).toBe("rejected");
      expect(updates).not.toHaveLength(0);
    }),
  );

  it.effect("returns the persisted status when setting the confirmation message", () =>
    Effect.gen(function* () {
      const confirmationUpdates: unknown[] = [];
      const existingSubmission = makeExistingSubmissionFixture({
        parsedSubmission: [],
        status: "confirmed",
      });
      const zero = makeZeroMock({
        existingSubmission: Option.some(existingSubmission),
        confirmationUpdates,
      });

      const result = yield* runSetConfirmation({ zero });

      expect(result.status).toBe("confirmed");
      expect(confirmationUpdates).toEqual([
        {
          workspaceId: "guild-1",
          conversationId: "channel-1",
          messageId: "message-1",
          confirmationMessageId: "confirmation-message-1",
        },
      ]);
    }),
  );

  it.effect("rejects upsert, confirm, and revert actions for terminal submissions", () =>
    Effect.gen(function* () {
      const { googleSheets, persisted, zero } = makeRejectedActionFixture("confirmed");

      const upsertExit = yield* Effect.exit(runUpsert({ googleSheets, zero }));
      const revertExit = yield* Effect.exit(runRevert({ googleSheets, zero }));
      const confirmExit = yield* Effect.exit(runConfirm({ zero }));

      expectFailedExits(upsertExit, revertExit, confirmExit);
      expect(persisted).toEqual([]);
    }),
  );

  it.effect("rejects confirm and revert actions from a different requester", () =>
    Effect.gen(function* () {
      const { googleSheets, persisted, zero } = makeRejectedActionFixture();

      const revertExit = yield* Effect.exit(
        runRevert({ googleSheets, zero, requesterUserId: "different-user" }),
      );
      const confirmExit = yield* Effect.exit(
        runConfirm({ zero, requesterUserId: "different-user" }),
      );

      expectFailedExits(revertExit, confirmExit);
      expect(persisted).toEqual([]);
    }),
  );

  it.effect("rejects confirmation from a different confirmation message", () =>
    Effect.gen(function* () {
      const { persisted, zero } = makeRejectedActionFixture();

      const confirmExit = yield* Effect.exit(
        runConfirm({ zero, confirmationMessageId: "different-confirmation-message" }),
      );

      expectFailedExits(confirmExit);
      expect(persisted).toEqual([]);
    }),
  );
});
