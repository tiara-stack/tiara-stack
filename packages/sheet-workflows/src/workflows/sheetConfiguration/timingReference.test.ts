import { Context, Effect, Exit, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  SheetConfigurationSource,
  ScheduleTimeReferenceMetadata,
  scheduleTimeReferenceMetadataForSource,
  type SheetConfigurationSource as SheetConfigurationSourceValue,
  type WebSheetConfiguration,
} from "sheet-domain";
import type { SheetSnapshotTab, SheetSnapshotWindow } from "sheet-workflow-contracts";
import { SpreadsheetId, WorkspaceId } from "sheet-workflow-contracts";
import { UserId } from "sheet-auth/identity";
import {
  SheetConfigurationWorkflowOperations,
  sheetConfigurationWorkflowOperationsLayer,
  type Attribution,
} from "./operations";
import { SheetSnapshotProvider } from "../readOnly/sheetSnapshotProvider";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import { SheetDataProvider } from "@/services/sheetDataProvider";
import type { SheetSnapshotProvider as SheetSnapshotProviderService } from "../readOnly/sheetSnapshotProvider";

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
const spreadsheetId = "spreadsheet-1";
const settingsSheetId = 1;
const scheduleSheetId = 3;
const eventReferenceInstant = Date.UTC(2026, 8, 7, 3);
const chapterReferenceInstant = Date.UTC(2026, 8, 9, 3);
const scheduleTimeReferenceEquivalence = Schema.toEquivalence(ScheduleTimeReferenceMetadata);
const scheduleTimeReferenceForUnknownSource = (value: unknown) => {
  const source = Schema.decodeUnknownOption(SheetConfigurationSource)(value);
  return Option.isSome(source) ? scheduleTimeReferenceMetadataForSource(source.value) : undefined;
};

const tabs: ReadonlyArray<SheetSnapshotTab> = [
  {
    sheetId: settingsSheetId,
    title: "Thee's Sheet Settings",
    hidden: false,
    sheetType: "GRID",
    rowCount: 200,
    columnCount: 40,
  },
  {
    sheetId: 2,
    title: "Users",
    hidden: false,
    sheetType: "GRID",
    rowCount: 100,
    columnCount: 10,
  },
  {
    sheetId: scheduleSheetId,
    title: "Schedule",
    hidden: false,
    sheetType: "GRID",
    rowCount: 200,
    columnCount: 10,
  },
];

const settingsCell = (row: number, column: number, formattedValue: string) => ({
  row: 7 + row,
  column: 1 + column,
  formattedValue,
});

const legacySettingsCells = (eventStartEpochMs = chapterReferenceInstant, hourRange = "A1:A4") => [
  settingsCell(0, 0, "User IDs"),
  settingsCell(0, 1, "Users!A1:A4"),
  settingsCell(1, 0, "User Sheet Names"),
  settingsCell(1, 1, "Users!B1:B4"),
  settingsCell(0, 13, "Start Time"),
  settingsCell(0, 14, String(eventStartEpochMs / 1_000)),
  settingsCell(0, 16, "Miku"),
  settingsCell(0, 17, "2"),
  settingsCell(0, 18, "Schedule"),
  settingsCell(0, 19, hourRange),
  settingsCell(0, 20, "auto"),
  settingsCell(0, 22, "none"),
  settingsCell(0, 23, "B1:B4"),
  settingsCell(0, 24, "C1:C4"),
  settingsCell(0, 25, "D1:D4"),
  settingsCell(0, 28, "E1:E4"),
];

const scheduleCells = (hours: ReadonlyArray<number | null>) =>
  hours.flatMap((hour, row) =>
    hour === null ? [] : [{ row, column: 0, formattedValue: String(hour) }],
  );

const makeSnapshotProvider = (
  hours: ReadonlyArray<number | null> | (() => ReadonlyArray<number | null>) = [49, 50, 82, 193],
  onRead?: (sheetId: number, window: SheetSnapshotWindow) => void,
): SheetSnapshotProviderService["Service"] => {
  const currentHours = typeof hours === "function" ? hours : () => hours;
  return {
    describe: (requestedSpreadsheetId) =>
      Effect.succeed({
        spreadsheetId: Schema.decodeUnknownSync(SpreadsheetId)(requestedSpreadsheetId),
        tabs,
        metadataFetchedAtEpochMs: 0,
      }),
    readSnapshot: (requestedSpreadsheetId, sheetId, window, _readPolicy) => {
      const tab = tabs.find((candidate) => candidate.sheetId === sheetId);
      if (tab === undefined) return Effect.die(`Unknown test sheet ${sheetId}`);
      onRead?.(sheetId, window);
      return Effect.succeed({
        spreadsheetId: Schema.decodeUnknownSync(SpreadsheetId)(requestedSpreadsheetId),
        tab,
        window,
        cells:
          sheetId === settingsSheetId
            ? legacySettingsCells(
                chapterReferenceInstant,
                `A1:A${Math.max(4, currentHours().length)}`,
              )
            : scheduleCells(currentHours()).filter(
                ({ row }) => row >= window.startRow && row < window.startRow + window.rowCount,
              ),
        rowMetadata: [],
        columnMetadata: [],
        merges: [],
        metadataFetchedAtEpochMs: 0,
        windowFetchedAtEpochMs: 0,
      });
    },
  };
};

const makeDataProvider = (resolvedSpreadsheetId = spreadsheetId) =>
  SheetDataProvider.testLayer({
    generateCheckin: () => Effect.die("unused"),
    resolveCheckinMessageTarget: () => Effect.die("unused"),
    generateRoomOrder: () => Effect.die("unused"),
    loadWorkspaceSchedules: () => Effect.die("unused"),
    resolveSpreadsheetId: () =>
      Effect.succeed(Option.some(Schema.decodeUnknownSync(SpreadsheetId)(resolvedSpreadsheetId))),
  });

const legacySource = {
  kind: "legacy",
  binding: {
    status: "bound",
    expectedTitle: "Thee's Sheet Settings",
    spreadsheetId,
    sheetId: settingsSheetId,
    layoutVersion: "legacy-settings-layout-v1",
  },
} as const satisfies SheetConfigurationSourceValue;

const makeSheetRow = (
  source: SheetConfigurationSourceValue,
  draftVersion = 4,
): ConfigWorkspaceSheetRow => ({
  workspaceId,
  source,
  legacyBinding: source.kind === "legacy" ? source.binding : null,
  draftVersion,
  baseRevisionId: null,
  baselineDigest: null,
  draft: null,
  diagnostics: [],
  activeRevisionId: source.kind === "owned" ? source.revisionId : null,
  updatedBy: null,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
});

const attribution: Attribution = {
  invocationId: "timing-reference-operation",
  principal: { kind: "user", userId: Schema.decodeUnknownSync(UserId)("user-1") },
};

const makeOwnedConfiguration = (): WebSheetConfiguration => ({
  schemaVersion: 2,
  spreadsheetId,
  users: {
    userIds: { sheetId: 2, startRow: 0, endRow: 4, startColumn: 0, endColumn: 1 },
    userSheetNames: { sheetId: 2, startRow: 0, endRow: 4, startColumn: 1, endColumn: 2 },
  },
  teams: [],
  event: {
    startTimeEpochMs: eventReferenceInstant,
    scheduleTimeReference: {
      kind: "event-start",
      instantEpochMs: eventReferenceInstant,
      hour: 1,
    },
  },
  schedules: [],
  runners: [],
});

const makeOwnedLegacyConfiguration = (): WebSheetConfiguration => ({
  ...makeOwnedConfiguration(),
  schemaVersion: 1,
  event: { startTimeEpochMs: chapterReferenceInstant },
  schedules: [
    {
      entryId: "schedule-1",
      channel: "main",
      day: 1,
      sheetId: scheduleSheetId,
      hourRange: { startRow: 0, endRow: 4, startColumn: 0, endColumn: 1 },
      breakRange: "auto",
      encoding: "none",
      fillRange: { startRow: 0, endRow: 4, startColumn: 1, endColumn: 2 },
      overfillRange: { startRow: 0, endRow: 4, startColumn: 2, endColumn: 3 },
      standbyRange: { startRow: 0, endRow: 4, startColumn: 3, endColumn: 4 },
      visibleCell: { startRow: 0, endRow: 1, startColumn: 4, endColumn: 5 },
    },
  ],
});

type OptionValue<Value> = Value extends Option.Option<infer Element> ? Element : never;
type ConfigWorkspaceSheetRow = OptionValue<
  Effect.Success<
    ReturnType<TrustedSheetPersistenceShape["sheetConfiguration"]["getSheetConfiguration"]>
  >
>;
type ConfigWorkspaceSheetRevisionRow = OptionValue<
  Effect.Success<
    ReturnType<
      TrustedSheetPersistenceShape["sheetConfiguration"]["getSheetConfigurationRevisionById"]
    >
  >
>;

type ScheduleTimeReferenceTestStateShape = {
  readonly persistence: TrustedSheetPersistenceShape;
  readonly currentRow: () => ConfigWorkspaceSheetRow;
  readonly establishCalls: () => number;
  readonly bumpDraftVersion: () => void;
};

class ScheduleTimeReferenceTestState extends Context.Service<
  ScheduleTimeReferenceTestState,
  ScheduleTimeReferenceTestStateShape
>()("sheet-workflows/ScheduleTimeReferenceTestState") {}

const makePersistence = (options: {
  readonly row: ConfigWorkspaceSheetRow;
  readonly revision?: ConfigWorkspaceSheetRevisionRow;
}): Layer.Layer<TrustedSheetPersistence | ScheduleTimeReferenceTestState> => {
  const stateLayer = Layer.sync(ScheduleTimeReferenceTestState, () => {
    const base = makeTrustedSheetPersistenceMock();
    let row = options.row;
    let establishCalls = 0;
    const bumpDraftVersion = () => {
      row = { ...row, draftVersion: row.draftVersion + 1 };
    };
    const establish: TrustedSheetPersistenceShape["sheetConfiguration"]["establishSheetConfigurationScheduleTimeReference"] =
      (args) =>
        Effect.gen(function* () {
          const currentReference = scheduleTimeReferenceForUnknownSource(row.source);
          const requestedReference = scheduleTimeReferenceForUnknownSource(args.source);
          if (
            currentReference !== undefined &&
            requestedReference !== undefined &&
            scheduleTimeReferenceEquivalence(currentReference, requestedReference)
          ) {
            return;
          }
          if (args.expectedDraftVersion !== row.draftVersion) {
            return yield* Effect.die("draft version conflict");
          }
          row = { ...row, source: args.source, draftVersion: row.draftVersion + 1 };
          establishCalls += 1;
        });
    const persistence: TrustedSheetPersistenceShape = {
      ...base,
      sheetConfiguration: {
        ...base.sheetConfiguration,
        getSheetConfiguration: () => Effect.succeed(Option.some(row)),
        getSheetConfigurationRevisionById: () =>
          Effect.succeed(
            options.revision === undefined ? Option.none() : Option.some(options.revision),
          ),
        establishSheetConfigurationScheduleTimeReference: establish,
      },
    };
    return {
      persistence,
      currentRow: () => row,
      establishCalls: () => establishCalls,
      bumpDraftVersion,
    };
  });
  return Layer.effect(
    TrustedSheetPersistence,
    Effect.map(ScheduleTimeReferenceTestState, ({ persistence }) => persistence),
  ).pipe(Layer.provideMerge(stateLayer));
};

const runWith = <A>(
  effect: Effect.Effect<
    A,
    unknown,
    SheetConfigurationWorkflowOperations | ScheduleTimeReferenceTestState
  >,
  persistence: Layer.Layer<TrustedSheetPersistence | ScheduleTimeReferenceTestState>,
  snapshotProvider: SheetSnapshotProviderService["Service"],
) =>
  effect.pipe(
    Effect.provide(sheetConfigurationWorkflowOperationsLayer),
    Effect.provide(persistence),
    Effect.provide(makeDataProvider()),
    Effect.provide(SheetSnapshotProvider.testLayer(snapshotProvider)),
  );

describe("Sheet Configuration timing reference lifecycle", () => {
  it.effect("previews and applies the captured hour-49 legacy mapping", () => {
    const persistenceLayer = makePersistence({ row: makeSheetRow(legacySource) });
    const snapshot = makeSnapshotProvider();
    return runWith(
      Effect.gen(function* () {
        const state = yield* ScheduleTimeReferenceTestState;
        const operations = yield* SheetConfigurationWorkflowOperations;
        const preview = yield* operations.previewScheduleTimeReference(
          { workspaceId },
          attribution,
        );

        expect(preview.status).toBe("ready");
        expect(preview.draftVersion).toBe(4);
        expect(preview.proposedReference).toEqual({
          kind: "chapter-start",
          instantEpochMs: chapterReferenceInstant,
          hour: 49,
        });
        expect(preview.mappings.find(({ hour }) => hour === 49)).toEqual({
          hour: 49,
          legacyStartEpochMs: chapterReferenceInstant + 48 * 3_600_000,
          legacyEndEpochMs: chapterReferenceInstant + 49 * 3_600_000,
          proposedStartEpochMs: chapterReferenceInstant,
          proposedEndEpochMs: chapterReferenceInstant + 3_600_000,
        });
        const applied = yield* operations.applyScheduleTimeReference(
          {
            workspaceId,
            expectedDraftVersion: preview.draftVersion,
            expectedBaselineDigest: preview.baselineDigest,
            reference: preview.proposedReference!,
          },
          attribution,
        );

        expect(applied.status).toBe("applied");
        expect(applied.draftVersion).toBe(5);
        expect(state.currentRow().source).toMatchObject({
          kind: "legacy",
          binding: { scheduleTimeReference: preview.proposedReference },
        });
        expect(state.currentRow()).toMatchObject({
          draft: null,
          activeRevisionId: null,
          baselineDigest: null,
        });
        expect(state.establishCalls()).toBe(1);
      }),
      persistenceLayer,
      snapshot,
    );
  });

  it.effect("rejects stale evidence and makes a repeated apply idempotent", () => {
    const persistenceLayer = makePersistence({ row: makeSheetRow(legacySource) });
    let hours: ReadonlyArray<number | null> = [49, 50, 82, 193];
    const snapshotProvider = makeSnapshotProvider(() => hours);
    return runWith(
      Effect.gen(function* () {
        const state = yield* ScheduleTimeReferenceTestState;
        const operations = yield* SheetConfigurationWorkflowOperations;
        const preview = yield* operations.previewScheduleTimeReference(
          { workspaceId },
          attribution,
        );
        hours = [50, 51, 82, 193];
        const stale = yield* Effect.exit(
          operations.applyScheduleTimeReference(
            {
              workspaceId,
              expectedDraftVersion: preview.draftVersion,
              expectedBaselineDigest: preview.baselineDigest,
              reference: preview.proposedReference!,
            },
            attribution,
          ),
        );
        expect(Exit.isFailure(stale)).toBe(true);
        expect(state.establishCalls()).toBe(0);

        const fresh = yield* operations.previewScheduleTimeReference({ workspaceId }, attribution);
        const applied = yield* operations.applyScheduleTimeReference(
          {
            workspaceId,
            expectedDraftVersion: fresh.draftVersion,
            expectedBaselineDigest: fresh.baselineDigest,
            reference: fresh.proposedReference!,
          },
          attribution,
        );
        const repeated = yield* operations.applyScheduleTimeReference(
          {
            workspaceId,
            expectedDraftVersion: fresh.draftVersion,
            expectedBaselineDigest: fresh.baselineDigest,
            reference: fresh.proposedReference!,
          },
          attribution,
        );
        expect(applied.status).toBe("applied");
        expect(repeated.status).toBe("already-applied");
        expect(state.establishCalls()).toBe(1);
      }),
      persistenceLayer,
      snapshotProvider,
    );
  });

  it.effect("keeps competing applies idempotent for one captured reference", () => {
    const persistenceLayer = makePersistence({ row: makeSheetRow(legacySource) });
    return runWith(
      Effect.gen(function* () {
        const state = yield* ScheduleTimeReferenceTestState;
        const operations = yield* SheetConfigurationWorkflowOperations;
        const preview = yield* operations.previewScheduleTimeReference(
          { workspaceId },
          attribution,
        );
        const input = {
          workspaceId,
          expectedDraftVersion: preview.draftVersion,
          expectedBaselineDigest: preview.baselineDigest,
          reference: preview.proposedReference!,
        };
        const outcomes = yield* Effect.all(
          [
            Effect.exit(operations.applyScheduleTimeReference(input, attribution)),
            Effect.exit(operations.applyScheduleTimeReference(input, attribution)),
          ],
          { concurrency: 2 },
        );
        const statuses = outcomes.flatMap((outcome) =>
          Exit.isSuccess(outcome) ? [outcome.value.status] : [],
        );

        expect(outcomes.every(Exit.isSuccess)).toBe(true);
        expect(statuses).toHaveLength(2);
        expect(statuses).toContain("applied");
        expect(
          statuses.every((status) => status === "applied" || status === "already-applied"),
        ).toBe(true);
        expect(state.establishCalls()).toBe(1);
        expect(state.currentRow().source).toMatchObject({
          kind: "legacy",
          binding: { scheduleTimeReference: preview.proposedReference },
        });
      }),
      persistenceLayer,
      makeSnapshotProvider(),
    );
  });

  it.effect("rejects an A-B-A timing apply after an intervening generation", () => {
    const persistenceLayer = makePersistence({ row: makeSheetRow(legacySource) });
    return runWith(
      Effect.gen(function* () {
        const state = yield* ScheduleTimeReferenceTestState;
        const operations = yield* SheetConfigurationWorkflowOperations;
        const preview = yield* operations.previewScheduleTimeReference(
          { workspaceId },
          attribution,
        );
        const input = {
          workspaceId,
          expectedDraftVersion: preview.draftVersion,
          expectedBaselineDigest: preview.baselineDigest,
          reference: preview.proposedReference!,
        };

        yield* operations.applyScheduleTimeReference(input, attribution);
        state.bumpDraftVersion();
        const stale = yield* Effect.exit(operations.applyScheduleTimeReference(input, attribution));

        expect(Exit.isFailure(stale)).toBe(true);
        expect(state.establishCalls()).toBe(1);
        expect(state.currentRow().draftVersion).toBe(preview.draftVersion + 2);
      }),
      persistenceLayer,
      makeSnapshotProvider(),
    );
  });

  it.effect("keeps an ambiguous legacy schedule unresolved", () => {
    const persistenceLayer = makePersistence({ row: makeSheetRow(legacySource) });
    const snapshotProvider = makeSnapshotProvider([null, null, null]);
    return runWith(
      Effect.gen(function* () {
        const state = yield* ScheduleTimeReferenceTestState;
        const operations = yield* SheetConfigurationWorkflowOperations;
        const preview = yield* operations.previewScheduleTimeReference(
          { workspaceId },
          attribution,
        );
        expect(preview.status).toBe("unresolved");
        expect(preview.proposedReference).toBeNull();
        expect(preview.diagnostics).toEqual([
          expect.objectContaining({ code: "ScheduleTimeReferenceUnresolved" }),
        ]);
        const rejected = yield* Effect.exit(
          operations.applyScheduleTimeReference(
            {
              workspaceId,
              expectedDraftVersion: preview.draftVersion,
              expectedBaselineDigest: preview.baselineDigest,
              reference: {
                kind: "event-start",
                instantEpochMs: chapterReferenceInstant,
                hour: 1,
              },
            },
            attribution,
          ),
        );
        expect(Exit.isFailure(rejected)).toBe(true);
        expect(state.establishCalls()).toBe(0);
      }),
      persistenceLayer,
      snapshotProvider,
    );
  });

  it.effect(
    "reads the complete configured hour range when evidence is beyond the first page",
    () => {
      const hours = Array.from({ length: 104 }, () => null as number | null);
      hours[103] = 49;
      const persistenceLayer = makePersistence({ row: makeSheetRow(legacySource) });
      const scheduleWindows: Array<{ readonly startRow: number; readonly rowCount: number }> = [];
      return runWith(
        Effect.gen(function* () {
          const state = yield* ScheduleTimeReferenceTestState;
          const operations = yield* SheetConfigurationWorkflowOperations;
          const preview = yield* operations.previewScheduleTimeReference(
            { workspaceId },
            attribution,
          );
          expect(preview.proposedReference).toEqual({
            kind: "chapter-start",
            instantEpochMs: chapterReferenceInstant,
            hour: 49,
          });
          expect(scheduleWindows).toEqual(
            expect.arrayContaining([
              { startRow: 0, rowCount: 100 },
              { startRow: 100, rowCount: 4 },
            ]),
          );
          expect(scheduleWindows).toHaveLength(2);
          expect(state.establishCalls()).toBe(0);
        }),
        persistenceLayer,
        makeSnapshotProvider(hours, (sheetId, window) => {
          if (sheetId === scheduleSheetId) {
            scheduleWindows.push({ startRow: window.startRow, rowCount: window.rowCount });
          }
        }),
      );
    },
  );

  it.effect("does not inspect legacy sheets for an active owned revision", () => {
    const ownedSource = { kind: "owned" as const, revisionId: "revision-1" };
    const configuration = makeOwnedConfiguration();
    const revision: ConfigWorkspaceSheetRevisionRow = {
      workspaceId,
      revisionId: "revision-1",
      spreadsheetId,
      configuration,
      createdBy: "user-1",
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    };
    const persistenceLayer = makePersistence({ row: makeSheetRow(ownedSource), revision });
    const snapshotProvider: SheetSnapshotProviderService["Service"] = {
      describe: () => Effect.die("inactive legacy source must not be read"),
      readSnapshot: () => Effect.die("inactive legacy source must not be read"),
    };
    return runWith(
      Effect.gen(function* () {
        const operations = yield* SheetConfigurationWorkflowOperations;
        const preview = yield* operations.previewScheduleTimeReference(
          { workspaceId },
          attribution,
        );
        expect(preview.proposedReference).toEqual({
          kind: "event-start",
          instantEpochMs: eventReferenceInstant,
          hour: 1,
        });
        expect(preview.currentReference).toBeNull();
        expect(preview.status).toBe("ready");
        const applied = yield* operations.applyScheduleTimeReference(
          {
            workspaceId,
            expectedDraftVersion: preview.draftVersion,
            expectedBaselineDigest: preview.baselineDigest,
            reference: preview.proposedReference!,
          },
          attribution,
        );
        expect(applied.status).toBe("applied");
        expect(applied.source).toMatchObject({
          kind: "owned",
          revisionId: "revision-1",
          scheduleTimeReference: preview.proposedReference,
        });
        const repeated = yield* operations.applyScheduleTimeReference(
          {
            workspaceId,
            expectedDraftVersion: preview.draftVersion,
            expectedBaselineDigest: preview.baselineDigest,
            reference: preview.proposedReference!,
          },
          attribution,
        );
        expect(repeated.status).toBe("already-applied");
      }),
      persistenceLayer,
      snapshotProvider,
    );
  });

  it.effect("infers old owned timing from the active revision's full schedule evidence", () => {
    const configuration = makeOwnedLegacyConfiguration();
    const ownedSource = { kind: "owned" as const, revisionId: "revision-1" };
    const revision: ConfigWorkspaceSheetRevisionRow = {
      workspaceId,
      revisionId: "revision-1",
      spreadsheetId,
      configuration,
      createdBy: "user-1",
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    };
    const persistenceLayer = makePersistence({ row: makeSheetRow(ownedSource), revision });

    return runWith(
      Effect.gen(function* () {
        const state = yield* ScheduleTimeReferenceTestState;
        const operations = yield* SheetConfigurationWorkflowOperations;
        const preview = yield* operations.previewScheduleTimeReference(
          { workspaceId },
          attribution,
        );
        expect(preview.status).toBe("ready");
        expect(preview.proposedReference).toEqual({
          kind: "chapter-start",
          instantEpochMs: chapterReferenceInstant,
          hour: 49,
        });
        const applied = yield* operations.applyScheduleTimeReference(
          {
            workspaceId,
            expectedDraftVersion: preview.draftVersion,
            expectedBaselineDigest: preview.baselineDigest,
            reference: preview.proposedReference!,
          },
          attribution,
        );
        expect(applied.status).toBe("applied");
        expect(state.currentRow().source).toMatchObject({
          kind: "owned",
          revisionId: "revision-1",
          scheduleTimeReference: preview.proposedReference,
        });
      }),
      persistenceLayer,
      makeSnapshotProvider([49, 50, 82, 193]),
    );
  });
});
