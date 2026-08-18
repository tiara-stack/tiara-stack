import { Predicate, Schema } from "effect";
import { CalculationsRecalculateSheet } from "sheet-workflow-contracts";
import { workflowContractExecutionSchema } from "../shared/execution";
import {
  calculationProjectionStartRowIndex,
  calculationProjectionWidth,
  canonicalCalculationSheetRef,
} from "../shared/calculationRange";

const CalculationCell = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);
const CalculationRows = Schema.Array(Schema.Array(CalculationCell));
const maximumPersistedCalculationRowWidth = calculationProjectionWidth;
export const maximumPersistedCalculationCells = 1_000_000;
// Each persisted projection row is written across the full range width. Keep the schema bound
// in sync with the provider so sparse rows cannot pass persistence validation and fail later.
export const maximumPersistedCalculationRows = Math.min(
  10_000_000 - calculationProjectionStartRowIndex,
  Math.floor(maximumPersistedCalculationCells / maximumPersistedCalculationRowWidth),
);
export const maximumPersistedCalculationPayloadBytes = 16 * 1024 * 1024;
const persistedCalculationTextEncoder = new TextEncoder();
// This is a conservative upper-bound estimate for the serialized payload size.
const persistedCalculationCellByteLength = (cell: CalculationCell): number =>
  Predicate.isNull(cell)
    ? 4
    : Predicate.isBoolean(cell)
      ? cell
        ? 4
        : 5
      : Predicate.isNumber(cell)
        ? (Number.isFinite(cell) ? String(cell) : "null").length
        : cell.length * 6 + 2;

// Keep action payloads within the maximum Google Sheets grid height and bound both the
// rectangular width and serialized size so a populated open-ended range cannot create an
// unbounded durable action payload.
const PersistedCalculationRows = CalculationRows.check(
  Schema.isLengthBetween(0, maximumPersistedCalculationRows),
).check(
  Schema.makeFilter((rows) => {
    let totalCells = 0;
    let totalBytes = 2;
    for (const row of rows) {
      if (row.length > maximumPersistedCalculationRowWidth) {
        return `calculation projection rows may not exceed ${maximumPersistedCalculationRowWidth} cells`;
      }
      totalCells += row.length;
      totalBytes += 2;
      for (const cell of row) {
        totalBytes += persistedCalculationCellByteLength(cell) + 1;
      }
      if (
        totalCells > maximumPersistedCalculationCells ||
        totalBytes > maximumPersistedCalculationPayloadBytes
      ) {
        return "calculation projection payload exceeds its persisted size limit";
      }
    }
    return undefined;
  }),
);

const CalculationSourceTeam = Schema.Struct({
  type: Schema.String,
  playerId: Schema.NullOr(Schema.String),
  playerName: Schema.NullOr(Schema.String),
  teamName: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  lead: Schema.Number,
  backline: Schema.Number,
  talent: Schema.NullOr(Schema.Number),
});

const CalculationSourcePlayer = Schema.Struct({
  name: Schema.String,
  teams: Schema.Array(CalculationSourceTeam),
});

const CalculationRangeSnapshot = Schema.Struct({
  range: Schema.String,
  rows: CalculationRows,
});

// The provider/source boundary uses this raw snapshot internally before action persistence is reduced.
// fallow-ignore-next-line unused-export
export const CalculationSourceSnapshot = Schema.Struct({
  sheetId: Schema.Int,
  sheetTitle: Schema.String,
  canonicalSheetRef: Schema.String,
  preWriteProjection: CalculationRows,
  settingsRows: CalculationRows,
  teamConfigurationRows: CalculationRows,
  sourceRanges: Schema.Array(CalculationRangeSnapshot),
});

export const CalculationSource = Schema.Struct({
  sheetId: Schema.Int,
  sheetTitle: Schema.String,
  canonicalSheetRef: Schema.String,
  preWriteProjection: PersistedCalculationRows,
  players: Schema.Array(CalculationSourcePlayer),
  failure: Schema.NullOr(CalculationsRecalculateSheet.declaredFailure),
});

const CalculationProjection = Schema.Struct({
  rows: PersistedCalculationRows,
  outputRange: Schema.String,
  roomCount: Schema.Int,
  failure: Schema.NullOr(CalculationsRecalculateSheet.declaredFailure),
});

export const CalculationWriteReceipt = Schema.Struct({
  disposition: Schema.Literals(["confirmed", "reconciled"]),
  outputRange: Schema.String,
  roomCount: Schema.Int,
});

// The shared helper is intentionally contract-generic and exposes its input as an opaque
// WorkflowContractSchema. Re-state this field at the application boundary so action callbacks
// receive the decoded calculation input type rather than forcing a second decode for identity.
export const CalculationExecution = Schema.Struct({
  ...workflowContractExecutionSchema(CalculationsRecalculateSheet).fields,
  input: CalculationsRecalculateSheet.input,
});

const CanonicalCalculationExecutionFields = Schema.Struct({
  ...CalculationExecution.fields,
  sheetTitle: Schema.String,
  canonicalSheetRef: Schema.String,
});

type CanonicalCalculationExecutionValue = Schema.Schema.Type<
  typeof CanonicalCalculationExecutionFields
>;

const canonicalCalculationExecutionCheck = Schema.makeFilter(
  ({ input, sheetTitle, canonicalSheetRef }: CanonicalCalculationExecutionValue) => {
    const canonical = canonicalCalculationSheetRef(input.sheetRef);
    return canonical?.sheetTitle === sheetTitle && canonical.sheetRef === canonicalSheetRef
      ? undefined
      : "canonical calculation sheet identity must match input.sheetRef";
  },
);

export const CanonicalCalculationExecution = CanonicalCalculationExecutionFields.check(
  canonicalCalculationExecutionCheck,
);

const persistedCalculationPayloadByteLength = (value: unknown): number => {
  const serialized = JSON.stringify(value);
  return Predicate.isString(serialized)
    ? persistedCalculationTextEncoder.encode(serialized).byteLength
    : Number.POSITIVE_INFINITY;
};

export const CalculationWriteExecution = Schema.Struct({
  ...CanonicalCalculationExecution.fields,
  source: CalculationSource,
  projection: CalculationProjection,
}).check(canonicalCalculationExecutionCheck);

const CalculationWriteExecutionShape = Schema.Struct({
  ...CalculationWriteExecution.fields,
  source: Schema.Struct({
    ...CalculationSource.fields,
    preWriteProjection: CalculationRows,
  }),
  projection: Schema.Struct({
    ...CalculationProjection.fields,
    rows: CalculationRows,
  }),
}).check(canonicalCalculationExecutionCheck);

export const isCalculationWriteExecutionShape = Schema.is(CalculationWriteExecutionShape);

export const isCalculationWriteExecutionWithinPersistedPayloadLimit = (
  execution: typeof CalculationWriteExecution.Type,
): boolean =>
  persistedCalculationPayloadByteLength(execution) <= maximumPersistedCalculationPayloadBytes;

export type CalculationCell = typeof CalculationCell.Type;
export type CalculationRows = typeof CalculationRows.Type;
export const isPersistedCalculationRows = Schema.is(PersistedCalculationRows);
export type CalculationSourceSnapshot = typeof CalculationSourceSnapshot.Type;
export type CalculationSource = typeof CalculationSource.Type;
export type CalculationSourceTeam = typeof CalculationSourceTeam.Type;
export type CalculationProjection = typeof CalculationProjection.Type;
export type CalculationWriteReceipt = typeof CalculationWriteReceipt.Type;
