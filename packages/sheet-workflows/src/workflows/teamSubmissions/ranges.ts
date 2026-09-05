import { Predicate } from "effect";
import type { ParsedTeamEntry } from "./values";

export type A1Cell = {
  readonly sheet: string;
  readonly column: string;
  readonly row: number;
};

export type WorkflowSheetValueUpdate = {
  readonly range: string;
  readonly values: string[][];
};

export type A1RangeOptions = {
  readonly allowMissingRow?: boolean;
  readonly allowOpenEndedEndRange?: boolean;
  readonly inferEndRowFromValues?: boolean;
};

const a1RangeRegex =
  /^(?:'(?<quotedSheet>(?:[^']|'')*)'|(?<sheet>[^!]+))!\s*(?<column>[A-Z]+)(?<row>\d+)?(?::[A-Z]+\d*)?$/i;

export const parseA1StartForWorkflow = (
  range: string,
  options: A1RangeOptions = {},
): A1Cell | null => {
  const match = a1RangeRegex.exec(range.trim());
  const groups = match?.groups;
  const sheet = groups?.quotedSheet?.replaceAll("''", "'") ?? groups?.sheet?.trim();
  if (!sheet || !groups?.column || (!groups.row && !options.allowMissingRow)) return null;

  return {
    sheet,
    column: groups.column.toUpperCase(),
    row: groups.row === undefined ? 1 : Number(groups.row),
  };
};

const cellForRow = (range: string, row: number, options: A1RangeOptions = {}) => {
  const start = parseA1StartForWorkflow(range, options);
  return start === null ? null : `'${start.sheet.replaceAll("'", "''")}'!${start.column}${row}`;
};

export const canonicalCellRangeForWorkflow = (
  range: string,
  row: number,
  options: A1RangeOptions = {},
) => cellForRow(range, row, options);

const columnToNumber = (column: string) =>
  column
    .toUpperCase()
    .split("")
    .reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);

const numberToColumn = (value: number) => {
  let remaining = value;
  let column = "";
  while (remaining > 0) {
    const mod = (remaining - 1) % 26;
    column = globalThis.String.fromCharCode(65 + mod) + column;
    remaining = Math.floor((remaining - mod) / 26);
  }
  return column;
};

export const rollbackValuesForRangeForWorkflow = (
  range: string,
  values: ReadonlyArray<ReadonlyArray<string>>,
  options: A1RangeOptions = {},
) => {
  const start = parseA1StartForWorkflow(range, options);
  const endPattern = options.allowOpenEndedEndRange ? /:([A-Z]+)(\d+)?$/i : /:([A-Z]+)(\d+)$/i;
  const endMatch = endPattern.exec(range.trim());
  if (start === null) {
    return values.length === 0 ? [[""]] : values.map((row) => [...row]);
  }

  const endColumn = endMatch?.[1] ?? start.column;
  const endRow = endMatch?.[2]
    ? Number(endMatch[2])
    : options.inferEndRowFromValues
      ? start.row + Math.max(0, values.length - 1)
      : start.row;
  const width = Math.max(1, columnToNumber(endColumn) - columnToNumber(start.column) + 1);
  const height = Math.max(1, endRow - start.row + 1);
  return globalThis.Array.from({ length: height }, (_, rowIndex) =>
    globalThis.Array.from(
      { length: width },
      (_, columnIndex) => values[rowIndex]?.[columnIndex] ?? "",
    ),
  );
};

export const appendRangeForCellsForWorkflow = (
  playerNameRange: string,
  teamNameRange: string | null,
  oshiRange: string | null,
  options: A1RangeOptions = {},
) => {
  const cells = [
    ["playerColumn", parseA1StartForWorkflow(playerNameRange, options)],
    ...(teamNameRange === null
      ? []
      : ([["teamColumn", parseA1StartForWorkflow(teamNameRange, options)]] as const)),
    ...(oshiRange === null
      ? []
      : ([["oshiColumn", parseA1StartForWorkflow(oshiRange, options)]] as const)),
  ] as const;
  const parsedCells = cells.flatMap(([key, cell]) =>
    Predicate.isNotNull(cell) ? [[key, cell] as const] : [],
  );
  if (parsedCells.length !== cells.length) return null;

  const sheet = parsedCells[0]?.[1].sheet;
  if (!sheet || parsedCells.some(([, cell]) => cell.sheet !== sheet)) return null;

  const configuredColumns = parsedCells.map(
    ([key, cell]) => [key, columnToNumber(cell.column)] as const,
  );
  const uniqueColumns = new Set(configuredColumns.map(([, column]) => column));
  if (uniqueColumns.size !== configuredColumns.length) return null;
  const columns = configuredColumns.filter(
    ([key]) => teamNameRange !== null || key !== "oshiColumn",
  );
  const startColumn = Math.min(...columns.map(([, column]) => column));
  const endColumn = Math.max(...columns.map(([, column]) => column));
  const columnMap = Object.fromEntries(columns) as {
    readonly playerColumn: number;
    readonly teamColumn?: number;
    readonly oshiColumn?: number;
  };

  return {
    range: `'${sheet.replaceAll("'", "''")}'!${numberToColumn(startColumn)}:${numberToColumn(endColumn)}`,
    startColumn,
    endColumn,
    playerColumn: columnMap.playerColumn,
    teamColumn: columnMap.teamColumn,
    oshiColumn: teamNameRange === null ? null : (columnMap.oshiColumn ?? null),
  };
};

/**
 * Limits an append's logical table to the rows that can contain player values. Google Sheets can
 * otherwise append after formula-only columns elsewhere on the tab.
 */
export const boundedAppendRangeForWorkflow = (range: string, startRow: number, endRow: number) => {
  const start = parseA1StartForWorkflow(range, { allowMissingRow: true });
  if (start === null) return null;
  const endMatch = /:([A-Z]+)(?:\d+)?$/i.exec(range.trim());
  const endColumn = endMatch?.[1]?.toUpperCase() ?? start.column;
  const boundedStartRow = Math.max(1, startRow);
  const boundedEndRow = Math.max(boundedStartRow, endRow);
  return `'${start.sheet.replaceAll("'", "''")}'!${start.column}${boundedStartRow}:${endColumn}${boundedEndRow}`;
};

export const lastPopulatedRowForWorkflow = (
  range: string,
  values: ReadonlyArray<ReadonlyArray<string>>,
) => {
  const start = parseA1StartForWorkflow(range, { allowMissingRow: true });
  if (start === null) return null;
  let lastRow = start.row - 1;
  values.forEach((row, index) => {
    if (row.some((value) => value.trim().length > 0)) lastRow = start.row + index;
  });
  return lastRow;
};

type AppendRangeForCells = NonNullable<ReturnType<typeof appendRangeForCellsForWorkflow>>;

export type WorkflowTeamSubmissionRowTarget = {
  readonly rowIndex: number;
  readonly playerNameRange: string;
  readonly teamNameRange: string | null;
  readonly isvRanges: ReadonlyArray<string>;
  readonly oshiRange: string | null;
};

export const appendRowValuesForWorkflow = (
  appendRange: AppendRangeForCells,
  entry: ParsedTeamEntry,
  oshi: ParsedTeamEntry["oshi"],
) => {
  const row = new globalThis.Array<string>(
    appendRange.endColumn - appendRange.startColumn + 1,
  ).fill("");
  row[appendRange.playerColumn - appendRange.startColumn] = entry.playerName;
  if (appendRange.teamColumn !== undefined) {
    row[appendRange.teamColumn - appendRange.startColumn] = entry.teamName;
  }
  if (appendRange.oshiColumn !== null) {
    row[appendRange.oshiColumn - appendRange.startColumn] = oshi.value ?? "";
  }
  return row;
};

export const appendedRowTargetForWorkflow = (
  {
    rowIndex,
    playerNameRange,
    teamNameRange,
    isvRanges,
    oshiRange,
  }: WorkflowTeamSubmissionRowTarget,
  options: A1RangeOptions = {},
): WorkflowTeamSubmissionRowTarget | null => {
  const appendedPlayerNameRange = cellForRow(playerNameRange, rowIndex, options);
  const appendedTeamNameRange =
    teamNameRange === null ? null : cellForRow(teamNameRange, rowIndex, options);
  const appendedIsvRanges = isvRanges.flatMap((range) => {
    const appendedRange = cellForRow(range, rowIndex, options);
    return Predicate.isNull(appendedRange) ? [] : [appendedRange];
  });
  const appendedOshiRange = oshiRange === null ? null : cellForRow(oshiRange, rowIndex, options);
  if (
    appendedPlayerNameRange === null ||
    (teamNameRange !== null && appendedTeamNameRange === null) ||
    appendedIsvRanges.length !== isvRanges.length ||
    (oshiRange !== null && appendedOshiRange === null)
  ) {
    return null;
  }

  const targetRanges = [
    appendedPlayerNameRange,
    ...(appendedTeamNameRange === null ? [] : [appendedTeamNameRange]),
    ...appendedIsvRanges,
    ...(appendedOshiRange === null ? [] : [appendedOshiRange]),
  ];
  if (new Set(targetRanges).size !== targetRanges.length) return null;

  return {
    rowIndex,
    playerNameRange: appendedPlayerNameRange,
    teamNameRange: appendedTeamNameRange,
    isvRanges: appendedIsvRanges,
    oshiRange: appendedOshiRange,
  };
};
