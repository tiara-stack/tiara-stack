import { useAtomSuspense } from "@effect/atom-react";
import { Duration, Effect, Predicate, Schema } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";
import {
  SheetsDescribeInput,
  SheetsDescribeSuccess,
  SheetsReadSnapshotInput,
  SheetsReadSnapshotSuccess,
  SheetSnapshotWindow,
} from "sheet-workflow-contracts";
import type { SheetSnapshotReadPolicy } from "sheet-workflow-contracts";
import { runSheetWorkflow, sheetZeroClientAtom } from "#/lib/sheetZero";

const describeAsyncResultSchema = Schema.revealCodec(
  AsyncResult.Schema({
    success: SheetsDescribeSuccess,
    error: Schema.Unknown,
  }),
);

const snapshotAsyncResultSchema = Schema.revealCodec(
  AsyncResult.Schema({
    success: SheetsReadSnapshotSuccess,
    error: Schema.Unknown,
  }),
);

const normalizeSpreadsheetId = (spreadsheetId: string | undefined): string | undefined => {
  if (Predicate.isUndefined(spreadsheetId)) return undefined;
  const trimmed = spreadsheetId.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const spreadsheetIdField = (spreadsheetId: string | undefined) => {
  const normalized = normalizeSpreadsheetId(spreadsheetId);
  return normalized === undefined ? {} : { spreadsheetId: normalized };
};

const sheetDescriptionAtom = Atom.family(
  (input: {
    readonly workspaceId: string;
    readonly spreadsheetId?: string | undefined;
    readonly readPolicy: SheetSnapshotReadPolicy;
    readonly refreshKey: string | number;
  }) =>
    Atom.make<Schema.Schema.Type<typeof SheetsDescribeSuccess>, unknown>(
      Effect.fnUntraced(function* (get) {
        const runtime = yield* get.result(sheetZeroClientAtom);
        const decoded = yield* Schema.decodeUnknownEffect(SheetsDescribeInput)({
          workspaceId: input.workspaceId,
          ...spreadsheetIdField(input.spreadsheetId),
          readPolicy: input.readPolicy,
        });
        return yield* runSheetWorkflow(
          runtime.workflows.sheets.describe,
          decoded,
          SheetsDescribeSuccess,
        );
      }),
    ).pipe(
      Atom.setIdleTTL(Duration.seconds(30)),
      Atom.serializable({
        key: `sheetSnapshot.describe.${input.workspaceId}.${input.spreadsheetId ?? "persisted"}.${input.readPolicy}.${input.refreshKey}`,
        schema: describeAsyncResultSchema,
      }),
    ),
);

const sheetSnapshotAtom = Atom.family(
  (input: {
    readonly workspaceId: string;
    readonly sheetId: number;
    readonly spreadsheetId?: string | undefined;
    readonly window: SheetSnapshotWindow;
    readonly readPolicy: SheetSnapshotReadPolicy;
    readonly refreshKey: string | number;
  }) =>
    Atom.make<Schema.Schema.Type<typeof SheetsReadSnapshotSuccess>, unknown>(
      Effect.fnUntraced(function* (get) {
        const runtime = yield* get.result(sheetZeroClientAtom);
        const decoded = yield* Schema.decodeUnknownEffect(SheetsReadSnapshotInput)({
          workspaceId: input.workspaceId,
          sheetId: input.sheetId,
          window: input.window,
          ...spreadsheetIdField(input.spreadsheetId),
          readPolicy: input.readPolicy,
        });
        return yield* runSheetWorkflow(
          runtime.workflows.sheets.readSnapshot,
          decoded,
          SheetsReadSnapshotSuccess,
        );
      }),
    ).pipe(
      Atom.setIdleTTL(Duration.seconds(30)),
      Atom.serializable({
        key: `sheetSnapshot.window.${input.workspaceId}.${input.spreadsheetId ?? "persisted"}.${input.sheetId}.${input.window.startRow}.${input.window.startColumn}.${input.window.rowCount}.${input.window.columnCount}.${input.readPolicy}.${input.refreshKey}`,
        schema: snapshotAsyncResultSchema,
      }),
    ),
);

export const useSheetDescriptionResult = (input: {
  readonly workspaceId: string;
  readonly spreadsheetId?: string | undefined;
  readonly readPolicy?: SheetSnapshotReadPolicy;
  readonly refreshKey?: string | number;
}) => {
  const spreadsheetId = normalizeSpreadsheetId(input.spreadsheetId);
  const descriptionInput = useMemo(
    () => ({
      workspaceId: input.workspaceId,
      ...spreadsheetIdField(spreadsheetId),
      readPolicy: input.readPolicy ?? "cached",
      refreshKey: input.refreshKey ?? 0,
    }),
    [input.readPolicy, input.refreshKey, input.workspaceId, spreadsheetId],
  );
  return useAtomSuspense(sheetDescriptionAtom(descriptionInput), {
    suspendOnWaiting: false,
    includeFailure: true,
  });
};

export const useSheetSnapshotResult = (input: {
  readonly workspaceId: string;
  readonly sheetId: number;
  readonly spreadsheetId?: string | undefined;
  readonly window: SheetSnapshotWindow;
  readonly readPolicy?: SheetSnapshotReadPolicy;
  readonly refreshKey?: string | number;
}) => {
  const spreadsheetId = normalizeSpreadsheetId(input.spreadsheetId);
  const { columnCount, rowCount, startColumn, startRow } = input.window;
  const snapshotInput = useMemo(
    () => ({
      workspaceId: input.workspaceId,
      sheetId: input.sheetId,
      ...spreadsheetIdField(spreadsheetId),
      window: { startRow, startColumn, rowCount, columnCount },
      readPolicy: input.readPolicy ?? "cached",
      refreshKey: input.refreshKey ?? 0,
    }),
    [
      columnCount,
      input.readPolicy,
      input.refreshKey,
      input.sheetId,
      input.workspaceId,
      rowCount,
      startColumn,
      startRow,
      spreadsheetId,
    ],
  );
  return useAtomSuspense(sheetSnapshotAtom(snapshotInput), {
    suspendOnWaiting: false,
    includeFailure: true,
  });
};
