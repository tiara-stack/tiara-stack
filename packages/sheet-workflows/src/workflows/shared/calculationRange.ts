import { Predicate, Schema } from "effect";
import { sheetColumnLabel } from "sheet-domain";

export interface CanonicalCalculationRange {
  readonly sheetTitle: string;
  readonly sheetRef: string;
}

// Keep the provider's zero-based grid rectangle beside the canonical A1 range so reads and
// writes cannot drift when the calculation projection moves.
export const calculationProjectionStartRowIndex = 29;
export const calculationProjectionStartColumnIndex = 49;
export const calculationProjectionWidth = 32;

const calculationProjectionStartColumn = sheetColumnLabel(calculationProjectionStartColumnIndex);
const calculationProjectionEndColumn = sheetColumnLabel(
  calculationProjectionStartColumnIndex + calculationProjectionWidth - 1,
);
const calculationProjectionStartRow = calculationProjectionStartRowIndex + 1;
const calculationProjectionResultStartRow = calculationProjectionStartRow + 1;
const calculationProjectionRange = `${calculationProjectionStartColumn}${calculationProjectionStartRow}:${calculationProjectionEndColumn}`;
const unquotedSheetTitle = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const calculationProjection = new RegExp(
  `^(?:'((?:[^']|'')+)'|([^!']+))!${calculationProjectionRange}$`,
  "iu",
);
const maximumCalculationSheetRow = 10_000_000;
const maximumCalculationRoomCount = maximumCalculationSheetRow - calculationProjectionStartRow;
const calculationSheetTitle = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 && !/[\p{Cc}]/u.test(value)
      ? undefined
      : "sheet title must be non-empty and contain no control characters",
  ),
);
const calculationRoomCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maximumCalculationRoomCount }),
);
const isCalculationRoomCount = Schema.is(calculationRoomCount);
const isCalculationSheetTitle = Schema.is(calculationSheetTitle);

const quoteSheetTitle = (sheetTitle: string): string =>
  unquotedSheetTitle.test(sheetTitle) ? sheetTitle : `'${sheetTitle.replaceAll("'", "''")}'`;

export const canonicalCalculationSheetRef = (
  rawSheetRef: string,
): CanonicalCalculationRange | undefined => {
  if (!Schema.is(Schema.String)(rawSheetRef)) return undefined;
  const match = calculationProjection.exec(rawSheetRef.trim());
  if (Predicate.isNull(match)) return undefined;
  const sheetTitle = match[1] !== undefined ? match[1].replaceAll("''", "'") : (match[2] ?? "");
  if (!isCalculationSheetTitle(sheetTitle)) return undefined;
  return {
    sheetTitle,
    sheetRef: `${quoteSheetTitle(sheetTitle)}!${calculationProjectionRange}`,
  };
};

export const calculationResultRange = (roomCount: number): string => {
  if (!isCalculationRoomCount(roomCount)) {
    throw new RangeError(
      `roomCount must be an integer between 0 and ${maximumCalculationRoomCount}`,
    );
  }
  return `${calculationProjectionStartColumn}${calculationProjectionResultStartRow}:${calculationProjectionEndColumn}${Math.max(calculationProjectionResultStartRow, calculationProjectionResultStartRow + roomCount - 1)}`;
};
