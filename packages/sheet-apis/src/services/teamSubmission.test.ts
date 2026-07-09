import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Option } from "effect";
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
import { WorkspaceConfigService } from "./workspaceConfig";

type GoogleSheetsApi = Context.Service.Shape<typeof GoogleSheets>;
type SheetConfigServiceApi = Context.Service.Shape<typeof SheetConfigService>;
type WorkspaceConfigServiceApi = Context.Service.Shape<typeof WorkspaceConfigService>;
type SheetZeroClientApi = Context.Service.Shape<typeof SheetZeroClient>;

const teamConfig = new TeamConfig({
  name: Option.some("fill"),
  sheet: Option.some("Teams"),
  playerNameRange: Option.some("'Teams'!A2:A"),
  teamNameRange: Option.some("'Teams'!B2:B"),
  isvConfig: Option.none(),
  tagsConfig: Option.some(new TeamTagsConstantsConfig({ tags: ["full fill", "heal"] })),
  oshiRange: Option.some("'Teams'!D2:D"),
});

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
    confirmationMessageId: Option.none(),
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
  failAppend = false,
  failUpdate = false,
}: {
  readonly appendedRanges?: string[];
  readonly appendedValues?: string[][][];
  readonly updates?: Array<{ range: string; values: string[][] }>;
  readonly appendStartRow?: number;
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
              values: range === "'Oshis'!A2:A" ? [["Rin"], ["Miku Rin"]] : [],
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
}: {
  readonly existingSubmission?: Option.Option<MessageTeamSubmission>;
  readonly persisted?: unknown[];
  readonly confirmationUpdates?: unknown[];
} = {}) =>
  Layer.sync(
    SheetZeroClient,
    () =>
      ({
        messageTeamSubmission: {
          getMessageTeamSubmission: () => Effect.succeed(existingSubmission),
          upsertMessageTeamSubmission: (value: unknown) =>
            Effect.sync(() => {
              persisted?.push(value);
            }),
          setMessageTeamSubmissionConfirmation: (value: unknown) =>
            Effect.sync(() => {
              confirmationUpdates?.push(value);
            }),
        },
      }) as unknown as SheetZeroClientApi,
  );

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

const runConfirm = ({
  zero,
  requesterUserId = payload.authorId,
}: {
  readonly zero: Layer.Layer<SheetZeroClient>;
  readonly requesterUserId?: string;
}) =>
  Effect.gen(function* () {
    const service = yield* TeamSubmissionService.make;
    return yield* service.confirmFromDiscord({
      client: payload.client,
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      confirmationMessageId: "confirmation-message-1",
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
      "fullFill:1",
      "fullFill:2",
      "heal:1",
      "encore:1",
      "alt:1",
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
});

describe("TeamSubmissionService.upsertFromDiscord", () => {
  it.effect("appends new rows and persists returned row mappings", () =>
    Effect.gen(function* () {
      const appendedRanges: string[] = [];
      const appendedValues: string[][][] = [];
      const persisted: unknown[] = [];
      const googleSheets = makeGoogleSheetsMock({ appendedRanges, appendedValues });
      const zero = makeZeroMock({ persisted });

      const result = yield* runUpsert({ googleSheets, zero });

      expect(appendedRanges).toEqual(["'Teams'!A:D", "'Teams'!A:D"]);
      expect(appendedValues).toEqual([
        [["Player", "Full Team", "", "Rin"]],
        [["Player", "Heal Team", "", "Rin"]],
      ]);
      expect(result.rowMappings.map((mapping) => mapping.rowIndex)).toEqual([2, 3]);
      expect(result.parsedTeams.map((entry) => entry.oshi.status)).toEqual(["matched", "matched"]);
      expect(persisted).toHaveLength(1);
      expect(
        (persisted.at(-1) as { rowMappings: ReadonlyArray<unknown> }).rowMappings,
      ).toHaveLength(2);
      expect(result.rollbackSnapshot).toEqual([
        { stableKey: "fullFill:1", range: "'Teams'!A2", values: [] },
        { stableKey: "fullFill:1", range: "'Teams'!B2", values: [] },
        { stableKey: "fullFill:1", range: "'Teams'!D2", values: [] },
        { stableKey: "heal:1", range: "'Teams'!A3", values: [] },
        { stableKey: "heal:1", range: "'Teams'!B3", values: [] },
        { stableKey: "heal:1", range: "'Teams'!D3", values: [] },
      ]);
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
      const appendedRanges: string[] = [];
      const googleSheets = makeGoogleSheetsMock({ appendedRanges });
      const zero = makeZeroMock();

      const result = yield* runUpsert({
        googleSheets,
        zero,
        workspaceConfigService: makeWorkspaceConfigService({ requireValidOshi: true }),
        inputPayload: {
          ...payload,
          content: ["oshi: Miku Rin", "full fill: Full Team"].join("\n"),
        },
      });

      expect(appendedRanges).toEqual([]);
      expect(result.rowMappings).toEqual([]);
      expect(result.skippedTeams.map((entry) => entry.reason)).toEqual([
        "Oshi Miku Rin is not valid",
      ]);
    }),
  );

  it.effect("updates existing rows and blanks rows removed by message edits", () =>
    Effect.gen(function* () {
      const updates: Array<{ range: string; values: string[][] }> = [];
      const existingSubmission = makeExistingSubmissionFixture();
      const googleSheets = makeGoogleSheetsMock({ updates, failAppend: true });
      const zero = makeZeroMock({ existingSubmission: Option.some(existingSubmission) });

      const result = yield* runUpsert({
        googleSheets,
        zero,
        inputPayload: {
          ...payload,
          content: ["oshi: Rin", "full fill: Full Team"].join("\n"),
        },
      });

      expect(result.rowMappings.map((mapping) => mapping.rowIndex)).toEqual([2]);
      expect(updates).toContainEqual({ range: "'Teams'!A2", values: [["Player"]] });
      expect(updates).toContainEqual({ range: "'Teams'!B2", values: [["Full Team"]] });
      expect(updates).toContainEqual({ range: "'Teams'!D2", values: [["Rin"]] });
      expect(updates).toContainEqual({ range: "'Teams'!A3", values: [[""]] });
      expect(updates).toContainEqual({ range: "'Teams'!B3", values: [[""]] });
      expect(updates).toContainEqual({ range: "'Teams'!D3", values: [[""]] });
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
        const fullFillConfig = new TeamConfig({
          name: Option.some("fill"),
          sheet: Option.some("Teams"),
          playerNameRange: Option.some("'Teams'!A2:A"),
          teamNameRange: Option.some("'Teams'!B2:B"),
          isvConfig: Option.none(),
          tagsConfig: Option.some(new TeamTagsConstantsConfig({ tags: ["full fill"] })),
          oshiRange: Option.some("'Teams'!D2:D"),
        });
        const unwritableHealConfig = new TeamConfig({
          name: Option.some("heal"),
          sheet: Option.some("Teams"),
          playerNameRange: Option.some("'Teams'!A2:A"),
          teamNameRange: Option.some("auto"),
          isvConfig: Option.none(),
          tagsConfig: Option.some(new TeamTagsConstantsConfig({ tags: ["heal"] })),
          oshiRange: Option.some("'Teams'!D2:D"),
        });
        const existingSubmission = makeExistingSubmissionFixture();
        const googleSheets = makeGoogleSheetsMock({ updates, failAppend: true });
        const zero = makeZeroMock({ existingSubmission: Option.some(existingSubmission) });

        const result = yield* runUpsert({
          googleSheets,
          zero,
          sheetConfigService: makeSheetConfigService([fullFillConfig, unwritableHealConfig]),
        });

        expect(result.rowMappings.map((mapping) => mapping.stableKey)).toEqual(["fullFill:1"]);
        expect(result.skippedTeams.map((entry) => entry.stableKey)).toEqual(["heal:1"]);
        expect(result.confirmationText).toContain("skipped Player | heal | Heal Team");
        expect(updates).toContainEqual({ range: "'Teams'!A3", values: [[""]] });
        expect(updates).toContainEqual({ range: "'Teams'!B3", values: [[""]] });
        expect(updates).toContainEqual({ range: "'Teams'!D3", values: [[""]] });
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
      const persisted: unknown[] = [];
      const existingSubmission = makeExistingSubmissionFixture({
        status: "confirmed",
        rollbackSnapshot: Option.some([
          {
            stableKey: "fullFill:1",
            range: "'Teams'!A2:B2",
            values: [["Old Player", "Old Team"]],
          },
        ]),
      });
      const zero = makeZeroMock({
        existingSubmission: Option.some(existingSubmission),
        persisted,
      });
      const googleSheets = makeGoogleSheetsMock({ failAppend: true, failUpdate: true });

      const upsertExit = yield* Effect.exit(runUpsert({ googleSheets, zero }));
      const revertExit = yield* Effect.exit(runRevert({ googleSheets, zero }));
      const confirmExit = yield* Effect.exit(runConfirm({ zero }));

      expect(Exit.isFailure(upsertExit)).toBe(true);
      expect(Exit.isFailure(revertExit)).toBe(true);
      expect(Exit.isFailure(confirmExit)).toBe(true);
      expect(persisted).toEqual([]);
    }),
  );

  it.effect("rejects confirm and revert actions from a different requester", () =>
    Effect.gen(function* () {
      const persisted: unknown[] = [];
      const existingSubmission = makeExistingSubmissionFixture({
        rollbackSnapshot: Option.some([
          {
            stableKey: "fullFill:1",
            range: "'Teams'!A2:B2",
            values: [["Old Player", "Old Team"]],
          },
        ]),
      });
      const zero = makeZeroMock({
        existingSubmission: Option.some(existingSubmission),
        persisted,
      });
      const googleSheets = makeGoogleSheetsMock({ failUpdate: true });

      const revertExit = yield* Effect.exit(
        runRevert({ googleSheets, zero, requesterUserId: "different-user" }),
      );
      const confirmExit = yield* Effect.exit(
        runConfirm({ zero, requesterUserId: "different-user" }),
      );

      expect(Exit.isFailure(revertExit)).toBe(true);
      expect(Exit.isFailure(confirmExit)).toBe(true);
      expect(persisted).toEqual([]);
    }),
  );
});
