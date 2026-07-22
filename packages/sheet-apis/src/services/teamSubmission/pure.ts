import { Effect, Option, Predicate, Semaphore, String, pipe } from "effect";
import type { TeamConfig } from "sheet-ingress-api/schemas/sheetConfig";
import {
  type MessageTeamSubmission,
  type ParsedOshi,
  type ParsedTeamEntry,
  type TeamSubmissionRowMapping,
  TeamSubmissionSkippedEntry,
  type TeamSubmissionUpsertFromDiscordPayload,
} from "sheet-ingress-api/schemas/teamSubmission";
import { makeArgumentError } from "typhoon-core/error";

export type A1Cell = {
  readonly sheet: string;
  readonly column: string;
  readonly row: number;
};

export type SheetValueUpdate = {
  readonly range: string;
  readonly values: string[][];
};

export type TeamSubmissionRowTarget = {
  readonly rowIndex: number;
  readonly playerNameRange: string;
  readonly teamNameRange: string;
  readonly oshiRange: string | null;
};

export type ProcessedTeamSubmissionEntry = {
  readonly appended: boolean;
  readonly entry: ParsedTeamEntry;
  readonly mapping: TeamSubmissionRowMapping;
  readonly updates: ReadonlyArray<SheetValueUpdate>;
};

export type SkippedTeamSubmissionEntry = typeof TeamSubmissionSkippedEntry.Type;

export type ProcessedTeamSubmissionResult =
  | { readonly _tag: "registered"; readonly entry: ProcessedTeamSubmissionEntry }
  | { readonly _tag: "skipped"; readonly entry: SkippedTeamSubmissionEntry };

export const pendingAppendRollbackRange = "";

export const isProcessedResult =
  <Tag extends ProcessedTeamSubmissionResult["_tag"]>(tag: Tag) =>
  (
    entry: ProcessedTeamSubmissionResult,
  ): entry is Extract<ProcessedTeamSubmissionResult, { readonly _tag: Tag }> =>
    Predicate.isTagged(tag)(entry);

export type TeamConfigLookup = {
  readonly config: TeamConfig;
  readonly tags: ReadonlyArray<string>;
  readonly oshis: ReadonlyArray<string>;
};

export type SubmissionLockEntry = {
  readonly semaphore: Semaphore.Semaphore;
  active: number;
};

export const actionableSubmissionStatuses = new Set<MessageTeamSubmission["status"]>([
  "registered",
  "updated",
]);
export const editableSubmissionStatuses = new Set<MessageTeamSubmission["status"]>([
  "registered",
  "updated",
  "empty",
  "applying",
]);

export const requireSubmissionStatus = (
  submission: MessageTeamSubmission,
  allowedStatuses: ReadonlySet<MessageTeamSubmission["status"]>,
) =>
  allowedStatuses.has(submission.status)
    ? Effect.void
    : Effect.fail(
        makeArgumentError(`Team submission is already ${submission.status} and cannot be changed`),
      );

export const requireActionableSubmission = (submission: MessageTeamSubmission) =>
  requireSubmissionStatus(submission, actionableSubmissionStatuses);

export const requireEditableSubmission = (submission: MessageTeamSubmission) =>
  requireSubmissionStatus(submission, editableSubmissionStatuses);

export const a1RangeRegex =
  /^(?:'(?<quotedSheet>(?:[^']|'')*)'|(?<sheet>[^!]+))!\s*(?<column>[A-Z]+)(?<row>\d+)/i;

export const parseA1Start = (range: string): A1Cell | null => {
  const match = a1RangeRegex.exec(range.trim());
  const groups = match?.groups;
  const sheet = groups?.quotedSheet?.replaceAll("''", "'") ?? groups?.sheet?.trim();
  if (!sheet || !groups?.column || !groups.row) {
    return null;
  }

  return { sheet, column: groups.column.toUpperCase(), row: Number(groups.row) };
};

export const cellForRow = (range: string, row: number) => {
  const start = parseA1Start(range);
  return start === null ? null : `'${start.sheet.replaceAll("'", "''")}'!${start.column}${row}`;
};

export const columnToNumber = (column: string) =>
  column
    .toUpperCase()
    .split("")
    .reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);

export const numberToColumn = (value: number) => {
  let remaining = value;
  let column = "";
  while (remaining > 0) {
    const mod = (remaining - 1) % 26;
    column = globalThis.String.fromCharCode(65 + mod) + column;
    remaining = Math.floor((remaining - mod) / 26);
  }
  return column;
};

export const rollbackValuesForRange = (
  range: string,
  values: ReadonlyArray<ReadonlyArray<string>>,
) => {
  const start = parseA1Start(range);
  const endMatch = /:([A-Z]+)(\d+)$/i.exec(range.trim());
  if (start === null) {
    return values.length === 0 ? [[""]] : values.map((row) => [...row]);
  }

  const endColumn = endMatch?.[1] ?? start.column;
  const endRow = endMatch?.[2] ? Number(endMatch[2]) : start.row;
  const width = Math.max(1, columnToNumber(endColumn) - columnToNumber(start.column) + 1);
  const height = Math.max(1, endRow - start.row + 1);
  return globalThis.Array.from({ length: height }, (_, rowIndex) =>
    globalThis.Array.from(
      { length: width },
      (_, columnIndex) => values[rowIndex]?.[columnIndex] ?? "",
    ),
  );
};

export const appendRangeForCells = (
  playerNameRange: string,
  teamNameRange: string,
  oshiRange: string | null,
) => {
  const cells = [
    ["playerColumn", parseA1Start(playerNameRange)],
    ["teamColumn", parseA1Start(teamNameRange)],
    ...(oshiRange === null ? [] : ([["oshiColumn", parseA1Start(oshiRange)]] as const)),
  ] as const;
  if (cells.some(([, cell]) => cell === null)) {
    return null;
  }
  const parsedCells = cells as ReadonlyArray<
    readonly ["playerColumn" | "teamColumn" | "oshiColumn", A1Cell]
  >;
  const sheet = parsedCells[0]?.[1].sheet;
  if (!sheet || parsedCells.some(([, cell]) => cell.sheet !== sheet)) {
    return null;
  }

  const columns = parsedCells.map(([key, cell]) => [key, columnToNumber(cell.column)] as const);
  const uniqueColumns = new Set(columns.map(([, column]) => column));
  if (uniqueColumns.size !== columns.length) {
    return null;
  }
  const startColumn = Math.min(...columns.map(([, column]) => column));
  const endColumn = Math.max(...columns.map(([, column]) => column));
  const columnMap = Object.fromEntries(columns) as {
    readonly playerColumn: number;
    readonly teamColumn: number;
    readonly oshiColumn?: number;
  };

  return {
    range: `'${sheet.replaceAll("'", "''")}'!${numberToColumn(startColumn)}:${numberToColumn(endColumn)}`,
    startColumn,
    endColumn,
    playerColumn: columnMap.playerColumn,
    teamColumn: columnMap.teamColumn,
    oshiColumn: columnMap.oshiColumn ?? null,
  };
};

export type AppendRangeForCells = NonNullable<ReturnType<typeof appendRangeForCells>>;

export const appendRowValues = (
  appendRange: AppendRangeForCells,
  entry: ParsedTeamEntry,
  oshi: ParsedOshi,
) => {
  const row = new globalThis.Array<string>(
    appendRange.endColumn - appendRange.startColumn + 1,
  ).fill("");
  row[appendRange.playerColumn - appendRange.startColumn] = entry.playerName;
  row[appendRange.teamColumn - appendRange.startColumn] = entry.teamName;
  if (appendRange.oshiColumn !== null) {
    row[appendRange.oshiColumn - appendRange.startColumn] = oshi.value ?? "";
  }
  return row;
};

export const appendedRowTarget = ({
  rowIndex,
  playerNameRange,
  teamNameRange,
  oshiRange,
}: {
  readonly rowIndex: number;
  readonly playerNameRange: string;
  readonly teamNameRange: string;
  readonly oshiRange: string | null;
}): TeamSubmissionRowTarget | null => {
  const appendedPlayerNameRange = cellForRow(playerNameRange, rowIndex);
  const appendedTeamNameRange = cellForRow(teamNameRange, rowIndex);
  const appendedOshiRange = oshiRange === null ? null : cellForRow(oshiRange, rowIndex);
  if (
    appendedPlayerNameRange === null ||
    appendedTeamNameRange === null ||
    (oshiRange !== null && appendedOshiRange === null)
  ) {
    return null;
  }

  return {
    rowIndex,
    playerNameRange: appendedPlayerNameRange,
    teamNameRange: appendedTeamNameRange,
    oshiRange: appendedOshiRange,
  };
};

export const appendedRowIndex = (updatedRange: string | null | undefined) => {
  const start = updatedRange ? parseA1Start(updatedRange) : null;
  return start?.row ?? null;
};

export const optionString = (value: Option.Option<string>) => Option.getOrUndefined(value);

export const optionArray = <A>(value: Option.Option<ReadonlyArray<A>>) =>
  Option.getOrElse(value, () => [] as ReadonlyArray<A>);

export const sourceMessageRef = (
  payload: Pick<
    TeamSubmissionUpsertFromDiscordPayload,
    "client" | "workspaceId" | "conversationId" | "messageId"
  >,
) => ({
  conversation: {
    workspace: {
      client: payload.client,
      workspaceId: payload.workspaceId,
    },
    conversationId: payload.conversationId,
  },
  messageId: payload.messageId,
});

export const sourceMessageUrl = (
  payload: Pick<
    TeamSubmissionUpsertFromDiscordPayload,
    "workspaceId" | "conversationId" | "messageId"
  >,
) =>
  `https://discord.com/channels/${payload.workspaceId}/${payload.conversationId}/${payload.messageId}`;

export type SubmissionLockPayload = {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly messageId: string;
};

export const submissionLockKey = (payload: SubmissionLockPayload) =>
  [payload.workspaceId, payload.conversationId, payload.messageId].join(":");

export const normalizeLine = (line: string) => line.trim().replace(/\s+/g, " ");

const powerPairPattern = /\b\d{2,3}\s*\/\s*\d{3}\b/;
const customEmojiSource = "<a?:[A-Za-z0-9_]+:\\d+>";
const customEmojiPattern = new RegExp(customEmojiSource, "g");
const customEmojiTestPattern = new RegExp(customEmojiSource);
const unicodeEmojiPattern = /\p{Extended_Pictographic}/u;

export type TeamSubmissionDisposition = "accepted" | "notSubmission" | "oshiOnly";

export const normalizeSectionAlias = (value: string) =>
  value
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

export const teamTypeAliases = {
  fullFill: ["fullFill", "full fill", "fullfill", "fill", "ff", "main"],
  heal: [
    "heal",
    "healer",
    "h",
    "4* heal",
    "4☆ heal",
    "4-star heal",
    "birthday heal",
    "bday heal",
    "bd heal",
  ],
  encore: ["encore", "enc"],
  alt: ["alt", "alts", "alternative"],
} as const;

export type ParsedLine = {
  readonly type: ParsedTeamEntry["teamType"];
  readonly teamName: string;
  readonly notes: ReadonlyArray<string>;
};

type ExplicitTeamLabel = {
  readonly type: ParsedTeamEntry["teamType"];
  readonly value: string;
  readonly notes: ReadonlyArray<string>;
};

export const sectionAliasLookup = new Map<string, ParsedTeamEntry["teamType"]>(
  Object.entries(teamTypeAliases).flatMap(([type, aliases]) =>
    aliases.map((alias) => [normalizeSectionAlias(alias), type as ParsedTeamEntry["teamType"]]),
  ),
);

export const lineType = (label: string): ParsedTeamEntry["teamType"] | null =>
  sectionAliasLookup.get(normalizeSectionAlias(label)) ?? null;

export const parentheticalNotes = (value: string) =>
  [...value.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]?.trim()).filter(Predicate.isString);

export const splitFullFillOptions = (value: string) =>
  value
    .split(/\s+(?:or|\/or)\s+|;\s*/i)
    .map(normalizeLine)
    .filter(String.isNonEmpty);

export const splitTeamOptions = splitFullFillOptions;

export const teamTypeLabels: Record<
  ParsedTeamEntry["teamType"],
  ReadonlyArray<string>
> = teamTypeAliases;

export const inferredTypes = ["fullFill", "heal", "encore"] as const;

export type ParsedSubmissionLine =
  | {
      readonly _tag: "oshi";
      readonly value: string;
      readonly inferredIndex: number;
    }
  | {
      readonly _tag: "teams";
      readonly lines: ReadonlyArray<ParsedLine>;
      readonly inferredIndex: number;
    };

export const parsedLinesForValue = (type: ParsedTeamEntry["teamType"], value: string) =>
  (["fullFill", "heal", "alt"].includes(type) ? splitTeamOptions(value) : [normalizeLine(value)])
    .filter(String.isNonEmpty)
    .map((teamName) => ({
      type,
      teamName,
      notes: [...new Set([...parentheticalNotes(teamName), ...semanticNotes(teamName)])],
    }));

const stripLineFormatting = (line: string) => {
  let value = line.trim();
  if (value.startsWith(">")) {
    return null;
  }
  if (value.startsWith("||") && value.endsWith("||") && value.length >= 4) {
    value = value.slice(2, -2).trim();
  }
  value = value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-+*]|\d+[.)])\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^`([^`]+)`$/, "$1");
  return normalizeLine(value);
};

const normalizedLabelPattern =
  "alt\\s*\\/\\s*enc|enc\\s*\\/\\s*alt|4(?:\\*|☆|-star)\\s+heal|birthday\\s+heal|bday\\s+heal|bd\\s+heal|full\\s+fill|fullfill|alternative|healer|encore|alts|main|fill|heal|ff|enc|alt|h";
const explicitLabelPattern = new RegExp(`^(${normalizedLabelPattern})\\s*:\\s*(.*)$`, "i");
const inlineLabelPattern = new RegExp(`^(${normalizedLabelPattern})\\s+(.+)$`, "i");
const headingLabelPattern = new RegExp(`^(${normalizedLabelPattern})\\s*:?$`, "i");

const labelType = (label: string): ExplicitTeamLabel["type"] | null => {
  const normalized = normalizeSectionAlias(label);
  if (/^(?:alt\s*\/\s*enc|enc\s*\/\s*alt)$/.test(normalized)) {
    return "alt";
  }
  return lineType(normalized);
};

const explicitTeamLabelFor = (label: string, value: string): ExplicitTeamLabel | null => {
  const type = labelType(label);
  if (type === null) {
    return null;
  }
  return {
    type,
    value: normalizeLine(value),
    notes: /\//.test(label) ? ["encore"] : semanticNotes(label),
  };
};

const colonTeamLabel = (line: string) => {
  const match = explicitLabelPattern.exec(line);
  return match?.[1] ? explicitTeamLabelFor(match[1], match[2] ?? "") : null;
};

const inlineTeamLabel = (line: string) => {
  const inline = inlineLabelPattern.exec(line);
  return inline?.[1] && inline[2] && powerPairPattern.test(inline[2])
    ? explicitTeamLabelFor(inline[1], inline[2])
    : null;
};

const headingTeamLabel = (line: string) => {
  const heading = headingLabelPattern.exec(line);
  return heading?.[1] ? explicitTeamLabelFor(heading[1], "") : null;
};

const explicitTeamLabel = (line: string): ExplicitTeamLabel | null =>
  colonTeamLabel(line) ?? inlineTeamLabel(line) ?? headingTeamLabel(line);

const fourStarPattern = /(?:^|[\s(])4\s*(?:\*|☆)(?=[\s)]|$)|\b4-star\b/i;

const semanticNotes = (value: string) => {
  const notes: string[] = [];
  if (/\b(?:bd|bday|birthday)\b/i.test(value)) {
    notes.push("birthday");
  }
  if (fourStarPattern.test(value)) {
    notes.push("4-star");
  }
  if (/\buncapped\b/i.test(value)) {
    notes.push("uncapped");
  }
  return notes;
};

const mergeNotes = (line: ParsedLine, notes: ReadonlyArray<string>): ParsedLine => ({
  ...line,
  notes: [...new Set([...line.notes, ...notes])],
});

const inlineTeamType = (line: string): ExplicitTeamLabel | null => {
  const suffixAlt = /^(.*?)\s+\b(?:alt|alts|alternative)\b(?:\s+(.*))?$/i.exec(line);
  if (suffixAlt?.[1] && powerPairPattern.test(suffixAlt[1])) {
    return {
      type: "alt",
      value: normalizeLine([suffixAlt[1], suffixAlt[2]].filter(Boolean).join(" ")),
      notes: semanticNotes(line),
    };
  }
  if (/\b(?:alt|alts|alternative)\b/i.test(line)) {
    return { type: "alt", value: line, notes: semanticNotes(line) };
  }
  if (/\b(?:enc|encore)\b/i.test(line)) {
    return { type: "encore", value: line, notes: semanticNotes(line) };
  }
  if (/\b(?:heal|healer|birthday|bday|bd)\b/i.test(line) || fourStarPattern.test(line)) {
    return { type: "heal", value: line, notes: semanticNotes(line) };
  }
  if (/\b(?:full\s*fill|fill|ff|main)\b/i.test(line)) {
    return { type: "fullFill", value: line, notes: semanticNotes(line) };
  }
  return null;
};

const containsEmoji = (value: string) =>
  customEmojiTestPattern.test(value) || unicodeEmojiPattern.test(value);

const isEmojiOnly = (value: string) => {
  const withoutCustomEmoji = value.replace(customEmojiPattern, "");
  const withoutUnicodeEmoji = withoutCustomEmoji.replace(
    /[\p{Extended_Pictographic}\uFE0F\u200D\s,./|_-]/gu,
    "",
  );
  return containsEmoji(value) && withoutUnicodeEmoji.length === 0;
};

const explicitOshiCandidate = (line: string) => {
  const prefix = /^oshi(?:\s+lead)?\s*:\s*(.+)$/i.exec(line);
  if (prefix?.[1]) {
    return normalizeLine(prefix[1]);
  }
  const suffix = /^(.+?)\s+oshi(?:\s+lead)?$/i.exec(line);
  return suffix?.[1] ? normalizeLine(suffix[1]) : null;
};

const isTerminalNameOnly = (value: string) =>
  value.length <= 40 &&
  /^(?:[\p{L}\p{N}_-]+)(?:\s+[\p{L}\p{N}_-]+){0,3}$/u.test(value) &&
  !/\b(?:will|added|updated?|updates|thanks?|format|example)\b/i.test(value);

const isInstructionalValue = (value: string) =>
  !powerPairPattern.test(value) &&
  /\b(?:then|followed\s+by|format|example|template|instructions?)\b/i.test(value);

const cursorAfter = (cursor: number, type: ParsedTeamEntry["teamType"]) => {
  const nextByType: Partial<Record<ParsedTeamEntry["teamType"], number>> = {
    fullFill: 1,
    heal: 2,
    encore: 3,
  };
  return Math.max(cursor, nextByType[type] ?? cursor);
};

type TeamSubmissionScanner = {
  inferredIndex: number;
  readonly parsedLines: ParsedLine[];
  readonly oshiCandidates: string[];
  pendingType: ExplicitTeamLabel | null;
};

const normalizedSubmissionLines = (content: string) => {
  const normalizedLines: Array<string | null> = [];
  let inCodeFence = false;
  for (const sourceLine of content.split(/\r?\n/)) {
    if (/^\s*```/.test(sourceLine)) {
      inCodeFence = !inCodeFence;
      normalizedLines.push(null);
    } else {
      normalizedLines.push(inCodeFence ? null : stripLineFormatting(sourceLine));
    }
  }
  return normalizedLines;
};

const appendParsedValue = (
  scanner: TeamSubmissionScanner,
  classification: ExplicitTeamLabel,
  value = classification.value,
) => {
  scanner.parsedLines.push(
    ...parsedLinesForValue(classification.type, value).map((parsed) =>
      mergeNotes(parsed, classification.notes),
    ),
  );
  scanner.inferredIndex = cursorAfter(scanner.inferredIndex, classification.type);
  scanner.pendingType = null;
};

const scanExplicitTeamLabel = (scanner: TeamSubmissionScanner, explicit: ExplicitTeamLabel) => {
  if (!String.isNonEmpty(explicit.value)) {
    scanner.pendingType = explicit;
  } else if (isInstructionalValue(explicit.value)) {
    scanner.pendingType = null;
  } else {
    appendParsedValue(scanner, explicit);
  }
};

const unlabeledOshiCandidate = (line: string, hasTeams: boolean) => {
  if (!hasTeams || powerPairPattern.test(line) || line.length > 80) {
    return null;
  }
  return isEmojiOnly(line) || containsEmoji(line) ? line : null;
};

const appendInferredTeam = (scanner: TeamSubmissionScanner, line: string) => {
  const inline = inlineTeamType(line);
  const type =
    inline?.type ?? inferredTypes[Math.min(scanner.inferredIndex, inferredTypes.length - 1)]!;
  if (inline === null) {
    scanner.parsedLines.push(...parsedLinesForValue(type, line));
    scanner.inferredIndex += 1;
    scanner.pendingType = null;
  } else {
    appendParsedValue(scanner, inline);
  }
};

const scanOshiLine = (scanner: TeamSubmissionScanner, line: string) => {
  const explicitOshi = explicitOshiCandidate(line);
  const candidate = explicitOshi ?? unlabeledOshiCandidate(line, scanner.parsedLines.length > 0);
  if (candidate === null) {
    return false;
  }
  scanner.oshiCandidates.push(candidate);
  scanner.pendingType = null;
  return true;
};

const scanNonTeamLine = (
  scanner: TeamSubmissionScanner,
  line: string,
  isFinalMeaningfulLine: boolean,
) => {
  if (scanner.parsedLines.length > 0 && isFinalMeaningfulLine && isTerminalNameOnly(line)) {
    scanner.oshiCandidates.push(line);
  }
  scanner.pendingType = null;
};

const scanSubmissionLine = (
  scanner: TeamSubmissionScanner,
  line: string | null,
  isFinalMeaningfulLine: boolean,
) => {
  if (line === null) {
    scanner.pendingType = null;
    return;
  }
  if (!String.isNonEmpty(line)) {
    return;
  }
  const explicitTeam = explicitTeamLabel(line);
  if (explicitTeam !== null) {
    scanExplicitTeamLabel(scanner, explicitTeam);
    return;
  }
  if (scanOshiLine(scanner, line)) {
    return;
  }
  if (scanner.pendingType !== null && powerPairPattern.test(line)) {
    appendParsedValue(scanner, scanner.pendingType, line);
    return;
  }
  if (!powerPairPattern.test(line)) {
    scanNonTeamLine(scanner, line, isFinalMeaningfulLine);
    return;
  }
  appendInferredTeam(scanner, line);
};

const entriesFromParsedLines = (
  parsedLines: ReadonlyArray<ParsedLine>,
  basePlayerName: string,
  oshiCandidate: string | null,
) => {
  const typeCounts = new Map<ParsedTeamEntry["teamType"], number>();
  const identityCounts = new Map<string, number>();
  const totalFullFill = parsedLines.filter((line) => line.type === "fullFill").length;
  return parsedLines.map((line) => {
    const index = (typeCounts.get(line.type) ?? 0) + 1;
    typeCounts.set(line.type, index);
    const identity = stableEntryIdentity(line.type, line.teamName, line.notes);
    const occurrence = (identityCounts.get(identity) ?? 0) + 1;
    identityCounts.set(identity, occurrence);
    const stableKey = occurrence === 1 ? identity : `${identity}:${occurrence}`;
    return parsedEntryFromLine(
      line,
      index,
      totalFullFill,
      basePlayerName,
      oshiCandidate,
      stableKey,
    );
  });
};

export const parseSubmissionLine = (line: string, inferredIndex: number): ParsedSubmissionLine => {
  const colonIndex = line.indexOf(":");
  const label = colonIndex >= 0 ? line.slice(0, colonIndex).trim() : "";
  const labeledValue = colonIndex >= 0 ? line.slice(colonIndex + 1).trim() : line;
  if (label.toLowerCase() === "oshi") {
    return { _tag: "oshi", value: labeledValue, inferredIndex };
  }

  const explicitType = colonIndex >= 0 ? lineType(label) : null;
  const type = explicitType ?? inferredTypes[Math.min(inferredIndex, inferredTypes.length - 1)]!;
  const value = explicitType === null ? line : labeledValue;
  return {
    _tag: "teams",
    lines: parsedLinesForValue(type, value),
    inferredIndex: explicitType === null ? inferredIndex + 1 : inferredIndex,
  };
};

export const entrySuffix = (line: ParsedLine, index: number, totalFullFill: number) => {
  if (line.type === "alt") {
    return ` (alt ${index})`;
  }
  if (line.type === "fullFill" && totalFullFill > 1) {
    return ` (full fill ${index})`;
  }
  return "";
};

export const parsedEntryFromLine = (
  line: ParsedLine,
  index: number,
  totalFullFill: number,
  basePlayerName: string,
  oshiCandidate: string | null,
  stableKey: string,
) =>
  ({
    stableKey,
    playerName: `${basePlayerName}${entrySuffix(line, index, totalFullFill)}`,
    teamName: line.teamName,
    teamType: line.type,
    notes: [...line.notes],
    teamConfigName: null,
    oshi: { candidate: oshiCandidate, value: null, status: "notConfigured" },
  }) satisfies ParsedTeamEntry;

const stableEntryIdentity = (
  teamType: ParsedTeamEntry["teamType"],
  teamName: string,
  notes: ReadonlyArray<string>,
) => {
  let normalizedTeamName = normalizeLine(teamName);
  for (const note of [...notes].reverse()) {
    const suffix = `(${note})`;
    if (normalizedTeamName.endsWith(suffix)) {
      normalizedTeamName = normalizeLine(normalizedTeamName.slice(0, -suffix.length));
    }
  }
  return `${teamType}:${encodeURIComponent(normalizedTeamName.toLowerCase())}`;
};

export const parseTeamSubmissionMessage = (
  content: string,
  basePlayerName: string,
): {
  readonly entries: ReadonlyArray<ParsedTeamEntry>;
  readonly oshiCandidate: string | null;
  readonly disposition: TeamSubmissionDisposition;
} => {
  const normalizedLines = normalizedSubmissionLines(content);
  const scanner: TeamSubmissionScanner = {
    inferredIndex: 0,
    parsedLines: [],
    oshiCandidates: [],
    pendingType: null,
  };
  let lastTruthyLineIndex = -1;
  for (let index = normalizedLines.length - 1; index >= 0; index -= 1) {
    if (normalizedLines[index]) {
      lastTruthyLineIndex = index;
      break;
    }
  }

  for (const [index, line] of normalizedLines.entries()) {
    scanSubmissionLine(scanner, line, index === lastTruthyLineIndex);
  }

  const distinctOshiCandidates = [...new Set(scanner.oshiCandidates.map(normalizeLine))];
  const oshiCandidate =
    distinctOshiCandidates.length === 0 ? null : distinctOshiCandidates.join(" / ");
  const entries = entriesFromParsedLines(scanner.parsedLines, basePlayerName, oshiCandidate);

  return {
    entries,
    oshiCandidate,
    disposition:
      entries.length > 0 ? "accepted" : oshiCandidate === null ? "notSubmission" : "oshiOnly",
  };
};

export const preserveExistingStableKeys = (
  existing: MessageTeamSubmission,
  entries: ReadonlyArray<ParsedTeamEntry>,
) => {
  const availableKeys = new Map<string, string[]>();
  for (const entry of existing.parsedSubmission) {
    const identity = stableEntryIdentity(entry.teamType, entry.teamName, entry.notes);
    availableKeys.set(identity, [...(availableKeys.get(identity) ?? []), entry.stableKey]);
  }
  if (availableKeys.size === 0) {
    for (const mapping of existing.rowMappings) {
      const type = mapping.stableKey.split(":", 1)[0];
      if (type) {
        availableKeys.set(type, [...(availableKeys.get(type) ?? []), mapping.stableKey]);
      }
    }
  }

  return entries.map((entry) => {
    const identity = stableEntryIdentity(entry.teamType, entry.teamName, entry.notes);
    const keys = availableKeys.get(identity) ?? availableKeys.get(entry.teamType) ?? [];
    const stableKey = keys.shift();
    return stableKey === undefined ? entry : { ...entry, stableKey };
  });
};

export const flattenRangeValues = (range: { readonly values?: unknown[][] | null }) =>
  range.values
    ?.flat()
    .filter(Predicate.isString)
    .map((value) => value.trim()) ?? [];

export const tagMatchesEntry = (tag: string, entry: ParsedTeamEntry) => {
  const normalizedTag = tag.toLowerCase().trim();
  const labels = teamTypeLabels[entry.teamType].map((label) => label.toLowerCase());
  const notes = entry.notes.map((note) => note.toLowerCase());
  const teamName = entry.teamName.toLowerCase();

  return (
    labels.includes(normalizedTag) ||
    notes.includes(normalizedTag) ||
    (String.isNonEmpty(normalizedTag) && teamName.includes(normalizedTag))
  );
};

export const isUsableTeamConfig = (config: TeamConfig) =>
  Option.isSome(config.name) &&
  Option.isSome(config.sheet) &&
  Option.isSome(config.playerNameRange);

export const chooseNamedTeamConfig = (
  teamConfigs: ReadonlyArray<TeamConfigLookup>,
  destinationTeamConfigName: Option.Option<string>,
) => {
  const named = Option.getOrUndefined(destinationTeamConfigName);
  const configs = teamConfigs.filter(({ config }) => isUsableTeamConfig(config));
  return named ? (configs.find(({ config }) => Option.contains(config.name, named)) ?? null) : null;
};

const existingRowMappings = (submission: Option.Option<MessageTeamSubmission>) =>
  optionArray(
    pipe(
      submission,
      Option.map((value) => value.rowMappings),
    ),
  );

export const existingMappingByKey = (submission: Option.Option<MessageTeamSubmission>) =>
  new Map(existingRowMappings(submission).map((mapping) => [mapping.stableKey, mapping] as const));

export const existingTeamKeys = (submission: Option.Option<MessageTeamSubmission>) =>
  new Set(existingRowMappings(submission).map((mapping) => mapping.stableKey));

const confirmationLineForEntry = (entry: ParsedTeamEntry) => {
  const oshi =
    entry.oshi.status === "matched"
      ? ` | oshi: ${entry.oshi.value}`
      : entry.oshi.candidate
        ? ` | oshi: ${entry.oshi.candidate} (${entry.oshi.status}, not assigned)`
        : "";
  return `- ${entry.playerName} | ${entry.teamType} | ${entry.teamName}${
    entry.notes.length > 0 ? ` | notes: ${entry.notes.join(", ")}` : ""
  }${oshi}`;
};

const confirmationLineForSkippedEntry = (entry: SkippedTeamSubmissionEntry) =>
  `- skipped ${entry.playerName} | ${entry.teamType} | ${entry.teamName} | reason: ${entry.reason}`;

const boundedConfirmation = (header: string, detailLines: ReadonlyArray<string>) => {
  const maxConfirmationLength = 2_000;
  const includedLines: string[] = [];
  for (const detailLine of detailLines) {
    const remaining = detailLines.length - includedLines.length - 1;
    const omittedSummary = remaining > 0 ? `\n- … and ${remaining} more` : "";
    const candidate = [header, ...includedLines, detailLine].join("\n") + omittedSummary;
    if (candidate.length > maxConfirmationLength) {
      break;
    }
    includedLines.push(detailLine);
  }

  const omitted = detailLines.length - includedLines.length;
  return [header, ...includedLines, ...(omitted > 0 ? [`- … and ${omitted} more`] : [])].join("\n");
};

export const renderConfirmation = (
  payload: Pick<
    TeamSubmissionUpsertFromDiscordPayload,
    "workspaceId" | "conversationId" | "messageId"
  >,
  entries: ReadonlyArray<ParsedTeamEntry>,
  skippedEntries: ReadonlyArray<SkippedTeamSubmissionEntry> = [],
) => {
  const sourceUrl = sourceMessageUrl(payload);
  if (entries.length === 0 && skippedEntries.length === 0) {
    return `No teams could be parsed from ${sourceUrl}.`;
  }

  const header =
    entries.length === 0
      ? `Skipped teams from ${sourceUrl}:`
      : `Registered teams from ${sourceUrl}:`;
  return boundedConfirmation(header, [
    ...entries.map(confirmationLineForEntry),
    ...skippedEntries.map(confirmationLineForSkippedEntry),
  ]);
};
