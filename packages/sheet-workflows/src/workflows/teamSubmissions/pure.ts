import { Option, Predicate, String } from "effect";
import type { MessageRef } from "sheet-bot-api";
import {
  appendRangeForCellsForWorkflow as appendSharedRangeForCells,
  appendRowValuesForWorkflow as appendSharedRowValues,
  appendedRowTargetForWorkflow as appendedSharedRowTarget,
  parseA1StartForWorkflow as parseSharedA1Start,
  rollbackValuesForRangeForWorkflow as rollbackSharedValuesForRange,
  type A1RangeOptions,
  type WorkflowSheetValueUpdate as SharedSheetValueUpdate,
  type WorkflowTeamSubmissionRowTarget as SharedTeamSubmissionRowTarget,
} from "./ranges";
import type {
  MessageTeamSubmission,
  ParsedTeamEntry,
  TeamConfig,
  TeamSubmissionRollbackSnapshot,
  TeamSubmissionRowMapping,
  TeamSubmissionSkippedEntry,
} from "./values";

// The workflow package keeps a source-compatible copy while the legacy dispatch path remains active.
export type SheetValueUpdate = SharedSheetValueUpdate;
export type TeamSubmissionRowTarget = SharedTeamSubmissionRowTarget;

export type ProcessedTeamSubmissionEntry = {
  readonly appended: boolean;
  readonly duplicateTargets: ReadonlyArray<TeamSubmissionRowTarget>;
  readonly entry: ParsedTeamEntry;
  readonly mapping: TeamSubmissionRowMapping;
  readonly updates: ReadonlyArray<SheetValueUpdate>;
};

export const pendingAppendRollbackRange = "";

export type TeamConfigLookup = {
  readonly config: TeamConfig;
  readonly tags: ReadonlyArray<string>;
  readonly oshis: ReadonlyArray<string>;
};

const workflowRangeOptions: A1RangeOptions = {
  allowMissingRow: true,
  allowOpenEndedEndRange: true,
  inferEndRowFromValues: true,
};

export const parseA1Start = (range: string) => parseSharedA1Start(range, workflowRangeOptions);

export const rollbackValuesForRange = (
  range: string,
  values: ReadonlyArray<ReadonlyArray<string>>,
) => rollbackSharedValuesForRange(range, values, workflowRangeOptions);

export const appendRangeForCells = (
  playerNameRange: string,
  teamNameRange: string,
  oshiRange: string | null,
) => appendSharedRangeForCells(playerNameRange, teamNameRange, oshiRange, workflowRangeOptions);

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

type WorkflowAppendRangeForCells = NonNullable<ReturnType<typeof appendRangeForCells>>;

export const appendRowValues = (
  appendRange: WorkflowAppendRangeForCells,
  entry: ParsedTeamEntry,
  oshi: ParsedTeamEntry["oshi"],
) => appendSharedRowValues(appendRange, entry, oshi);

export const appendedRowTarget = (
  input: TeamSubmissionRowTarget,
): TeamSubmissionRowTarget | null => {
  const target = appendedSharedRowTarget(input, workflowRangeOptions);
  return target === null ? null : target;
};

export const appendedRowIndex = (updatedRange: string | null | undefined) => {
  const start = updatedRange ? parseA1Start(updatedRange) : null;
  return start?.row ?? null;
};

/**
 * Actual values may omit trailing empty cells and rows; every expected cell must match the
 * corresponding actual cell, treating an omitted actual cell as an empty string.
 */
export const actualMatchesExpectedCells = (
  actual: ReadonlyArray<ReadonlyArray<string>>,
  expected: ReadonlyArray<ReadonlyArray<string>>,
) =>
  actual.length <= expected.length &&
  actual.every((actualRow, rowIndex) => actualRow.length <= (expected[rowIndex]?.length ?? 0)) &&
  expected.every((expectedRow, rowIndex) =>
    expectedRow.every((value, columnIndex) => value === (actual[rowIndex]?.[columnIndex] ?? "")),
  );

export const optionString = (value: Option.Option<string>) => Option.getOrUndefined(value);

// fallow-ignore-next-line code-duplication
export const flattenRangeValues = (range: {
  readonly values?: ReadonlyArray<ReadonlyArray<unknown>> | null;
}) =>
  range.values
    ?.flat()
    .filter(Predicate.isString)
    .map((value) => value.trim()) ?? [];

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

export const tagMatchesEntry = (tag: string, entry: ParsedTeamEntry) => {
  const normalizedTag = tag.toLowerCase().trim();
  const labels = teamTypeAliases[entry.teamType].map((label) => label.toLowerCase());
  const notes = entry.notes.map((note) => note.toLowerCase());
  return (
    labels.includes(normalizedTag) ||
    notes.includes(normalizedTag) ||
    (String.isNonEmpty(normalizedTag) && entry.teamName.toLowerCase().includes(normalizedTag))
  );
};

// fallow-ignore-next-line code-duplication
const normalizedOshiText = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/<a?:([A-Za-z0-9_]+):\d+>/g, " $1 ")
    .replace(/<@[!&]?\d+>/g, " ")
    .replace(/<#\d+>/g, " ")
    .replace(/[\s*_~|`>#]+/g, " ")
    .trim()
    .toLowerCase();

const matchingOshis = (candidate: string, validOshis: ReadonlyArray<string>) => {
  const normalizedCandidate = normalizedOshiText(candidate);
  const values = new Map<string, string>();
  for (const oshi of validOshis) {
    const normalized = normalizedOshiText(oshi);
    if (String.isNonEmpty(normalized) && !values.has(normalized)) values.set(normalized, oshi);
  }
  const exact = values.get(normalizedCandidate);
  if (exact !== undefined) return [exact];
  return [...values].flatMap(([normalized, canonical]) => {
    const isLetterOrNumber = (value: string | undefined) =>
      value !== undefined && /[\p{L}\p{N}]/u.test(value);
    let index = normalizedCandidate.indexOf(normalized);
    while (index >= 0) {
      const before = normalizedCandidate[index - 1];
      const after = normalizedCandidate[index + normalized.length];
      if (!isLetterOrNumber(before) && !isLetterOrNumber(after)) return [canonical];
      index = normalizedCandidate.indexOf(normalized, index + 1);
    }
    return [];
  });
};

export const matchOshi = (
  candidate: string | null,
  validOshis: ReadonlyArray<string>,
): ParsedTeamEntry["oshi"] => {
  if (candidate === null) return { candidate: null, value: null, status: "none" };
  if (validOshis.length === 0) return { candidate, value: null, status: "notConfigured" };
  const matches = matchingOshis(candidate, validOshis);
  if (matches.length === 1) return { candidate, value: matches[0] ?? null, status: "matched" };
  return {
    candidate,
    value: null,
    status: matches.length > 1 ? "ambiguous" : "invalid",
  };
};

export type TeamSubmissionDisposition = "accepted" | "notSubmission" | "oshiOnly";

const powerPairPattern = /\b\d{2,3}\s*\/\s*\d{3}\b/;
// These module-level literals are static, non-user-controlled grammar fragments for Discord
// custom emoji and normalized labels.
const customEmojiSource = "<a?:[A-Za-z0-9_]+:\\d+>";
const customEmojiPattern = new RegExp(customEmojiSource, "g");
const customEmojiTestPattern = new RegExp(customEmojiSource);
const unicodeEmojiPattern = /\p{Extended_Pictographic}/u;

const normalizeLine = (line: string) => line.trim().replace(/\s+/g, " ");

const normalizeSectionAlias = (value: string) =>
  value
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

const teamTypeAliases = {
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

type ParsedLine = {
  readonly type: ParsedTeamEntry["teamType"];
  readonly teamName: string;
  readonly notes: ReadonlyArray<string>;
};

type ExplicitTeamLabel = {
  readonly type: ParsedTeamEntry["teamType"];
  readonly value: string;
  readonly notes: ReadonlyArray<string>;
};

// fallow-ignore-next-line code-duplication
const sectionAliasLookup = new Map<string, ParsedTeamEntry["teamType"]>(
  Object.entries(teamTypeAliases).flatMap(([type, aliases]) =>
    aliases.map((alias) => [normalizeSectionAlias(alias), type as ParsedTeamEntry["teamType"]]),
  ),
);

const lineType = (label: string): ParsedTeamEntry["teamType"] | null =>
  sectionAliasLookup.get(normalizeSectionAlias(label)) ?? null;

const parentheticalNotes = (value: string): ReadonlyArray<string> =>
  [...value.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]?.trim()).filter(Predicate.isString);

const semanticNotes = (value: string) => {
  const notes: string[] = [];
  if (/\b(?:bd|bday|birthday)\b/i.test(value)) notes.push("birthday");
  if (/(?:^|[\s(])4\s*(?:\*|☆)(?=[\s)]|$)|\b4-star\b/i.test(value)) notes.push("4-star");
  if (/\buncapped\b/i.test(value)) notes.push("uncapped");
  return notes;
};

const splitTeamOptions = (value: string) =>
  value
    .split(/\s+(?:or|\/or)\s+|;\s*/i)
    .map(normalizeLine)
    .filter(String.isNonEmpty);

const parsedLinesForValue = (type: ParsedTeamEntry["teamType"], value: string) =>
  // fallow-ignore-next-line code-duplication
  (type === "fullFill" || type === "heal" || type === "alt"
    ? splitTeamOptions(value)
    : [normalizeLine(value)]
  )
    .filter(String.isNonEmpty)
    .map((teamName) => ({
      type,
      teamName,
      notes: [...new Set([...parentheticalNotes(teamName), ...semanticNotes(teamName)])],
    }));

const stripLineFormatting = (line: string) => {
  let value = line.trim();
  if (value.startsWith(">")) return null;
  if (value.startsWith("||") && value.endsWith("||") && value.length >= 4) {
    value = value.slice(2, -2).trim();
  }
  return normalizeLine(
    value
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(?:[-+*]|\d+[.)])\s+/, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      // fallow-ignore-next-line code-duplication
      .replace(/^`([^`]+)`$/, "$1"),
  );
};

// This static grammar fragment feeds the explicit, inline, and heading label regexes below.
const normalizedLabelPattern =
  "alt\\s*\\/\\s*enc|enc\\s*\\/\\s*alt|4(?:\\*|☆|-star)\\s+heal|birthday\\s+heal|bday\\s+heal|bd\\s+heal|full\\s+fill|fullfill|alternative|healer|encore|alts|main|fill|heal|ff|enc|alt|h";
const explicitLabelPattern = new RegExp(`^(${normalizedLabelPattern})\\s*:\\s*(.*)$`, "i");
const inlineLabelPattern = new RegExp(`^(${normalizedLabelPattern})\\s+(.+)$`, "i");
const headingLabelPattern = new RegExp(`^(${normalizedLabelPattern})\\s*:?$`, "i");

const labelType = (label: string): ExplicitTeamLabel["type"] | null => {
  const normalized = normalizeSectionAlias(label);
  if (/^(?:alt\s*\/\s*enc|enc\s*\/\s*alt)$/.test(normalized)) return "alt";
  return lineType(normalized);
};

const explicitTeamLabelFor = (label: string, value: string): ExplicitTeamLabel | null => {
  const type = labelType(label);
  return type === null
    ? null
    : {
        type,
        value: normalizeLine(value),
        notes: /\//.test(label) ? ["encore"] : semanticNotes(label),
      };
};

// fallow-ignore-next-line complexity
const explicitTeamLabel = (line: string): ExplicitTeamLabel | null => {
  const colon = explicitLabelPattern.exec(line);
  if (colon?.[1]) return explicitTeamLabelFor(colon[1], colon[2] ?? "");
  const inline = inlineLabelPattern.exec(line);
  if (inline?.[1] && inline[2] && powerPairPattern.test(inline[2])) {
    return explicitTeamLabelFor(inline[1], inline[2]);
  }
  const heading = headingLabelPattern.exec(line);
  // fallow-ignore-next-line code-duplication
  return heading?.[1] ? explicitTeamLabelFor(heading[1], "") : null;
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

// fallow-ignore-next-line code-duplication
const explicitOshiCandidate = (line: string) => {
  const prefix = /^oshi(?:\s+lead)?\s*:\s*(.+)$/i.exec(line);
  if (prefix?.[1]) return normalizeLine(prefix[1]);
  const suffix = /^(.+?)\s+oshi(?:\s+lead)?$/i.exec(line);
  return suffix?.[1] ? normalizeLine(suffix[1]) : null;
};

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
  if (
    /\b(?:heal|healer|birthday|bday|bd)\b/i.test(line) ||
    // fallow-ignore-next-line code-duplication
    /(?:^|[\s(])4\s*(?:\*|☆)(?=[\s)]|$)/i.test(line)
  ) {
    return { type: "heal", value: line, notes: semanticNotes(line) };
  }
  if (/\b(?:full\s*fill|fill|ff|main)\b/i.test(line)) {
    return { type: "fullFill", value: line, notes: semanticNotes(line) };
  }
  // fallow-ignore-next-line code-duplication
  return null;
};

// fallow-ignore-next-line code-duplication
const isTerminalNameOnly = (value: string) =>
  value.length <= 40 &&
  /^(?:[\p{L}\p{N}_-]+)(?:\s+[\p{L}\p{N}_-]+){0,3}$/u.test(value) &&
  !/\b(?:will|added|updated?|updates|thanks?|format|example)\b/i.test(value);

const isInstructionalValue = (value: string) =>
  !powerPairPattern.test(value) &&
  /\b(?:then|followed\s+by|format|example|template|instructions?)\b/i.test(value);

const inferredTypes = ["fullFill", "heal", "encore"] as const;
const cursorAfter = (cursor: number, type: ParsedTeamEntry["teamType"]) =>
  Math.max(
    cursor,
    ({ fullFill: 1, heal: 2, encore: 3 } as Partial<Record<ParsedTeamEntry["teamType"], number>>)[
      type
    ] ?? cursor,
  );

type TeamSubmissionScanner = {
  inferredIndex: number;
  readonly parsedLines: ParsedLine[];
  readonly oshiCandidates: string[];
  pendingType: ExplicitTeamLabel | null;
};

// fallow-ignore-next-line code-duplication
const parsedEntryFromLine = (
  line: ParsedLine,
  index: number,
  totalFullFill: number,
  basePlayerName: string,
  oshiCandidate: string | null,
  stableKey: string,
) => {
  const suffix =
    line.type === "alt"
      ? ` (alt ${index})`
      : line.type === "fullFill" && totalFullFill > 1
        ? ` (full fill ${index})`
        : "";
  return {
    stableKey,
    playerName: `${basePlayerName}${suffix}`,
    teamName: line.teamName,
    teamType: line.type,
    notes: [...line.notes],
    teamConfigName: null,
    oshi: { candidate: oshiCandidate, value: null, status: "notConfigured" },
  } satisfies ParsedTeamEntry;
};

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

// fallow-ignore-next-line complexity
const scanSubmissionLine = (
  scanner: TeamSubmissionScanner,
  line: string | null,
  isFinalMeaningfulLine: boolean,
) => {
  if (line === null) {
    scanner.pendingType = null;
    return;
  }
  if (!String.isNonEmpty(line)) return;
  const explicit = explicitTeamLabel(line);
  if (explicit !== null) {
    if (!String.isNonEmpty(explicit.value)) scanner.pendingType = explicit;
    else if (!isInstructionalValue(explicit.value)) {
      const lines = parsedLinesForValue(explicit.type, explicit.value);
      scanner.parsedLines.push(
        ...lines.map((value) => ({
          ...value,
          notes: [...new Set([...value.notes, ...explicit.notes])],
        })),
      );
      scanner.inferredIndex = cursorAfter(scanner.inferredIndex, explicit.type);
      scanner.pendingType = null;
    } else scanner.pendingType = null;
    return;
  }
  const explicitOshi = explicitOshiCandidate(line);
  const unlabeledOshi =
    scanner.parsedLines.length > 0 && !powerPairPattern.test(line) && line.length <= 80
      ? isEmojiOnly(line) || containsEmoji(line)
        ? line
        : null
      : null;
  if (explicitOshi !== null || unlabeledOshi !== null) {
    scanner.oshiCandidates.push(explicitOshi ?? unlabeledOshi!);
    scanner.pendingType = null;
    return;
  }
  if (scanner.pendingType !== null && powerPairPattern.test(line)) {
    const lines = parsedLinesForValue(scanner.pendingType.type, line);
    scanner.parsedLines.push(
      ...lines.map((value) => ({
        ...value,
        notes: [...new Set([...value.notes, ...scanner.pendingType!.notes])],
      })),
    );
    scanner.inferredIndex = cursorAfter(scanner.inferredIndex, scanner.pendingType.type);
    scanner.pendingType = null;
    return;
  }
  if (!powerPairPattern.test(line)) {
    if (scanner.parsedLines.length > 0 && isFinalMeaningfulLine && isTerminalNameOnly(line)) {
      scanner.oshiCandidates.push(line);
    }
    scanner.pendingType = null;
    return;
  }
  const inline = inlineTeamType(line);
  const type =
    inline?.type ?? inferredTypes[Math.min(scanner.inferredIndex, inferredTypes.length - 1)]!;
  const lines = parsedLinesForValue(type, inline?.value ?? line);
  scanner.parsedLines.push(
    ...lines.map((parsed) =>
      inline === null
        ? parsed
        : { ...parsed, notes: [...new Set([...parsed.notes, ...inline.notes])] },
    ),
  );
  scanner.inferredIndex =
    inline === null ? scanner.inferredIndex + 1 : cursorAfter(scanner.inferredIndex, type);
  scanner.pendingType = null;
};

export const parseTeamSubmissionMessage = (
  content: string,
  basePlayerName: string,
): {
  readonly entries: ReadonlyArray<ParsedTeamEntry>;
  readonly oshiCandidate: string | null;
  readonly disposition: TeamSubmissionDisposition;
} => {
  const normalizedLines: Array<string | null> = [];
  let inCodeFence = false;
  // fallow-ignore-next-line code-duplication
  for (const sourceLine of content.split(/\r?\n/)) {
    if (/^\s*```/.test(sourceLine)) {
      inCodeFence = !inCodeFence;
      normalizedLines.push(null);
    } else normalizedLines.push(inCodeFence ? null : stripLineFormatting(sourceLine));
  }
  let lastTruthyLineIndex = -1;
  for (let index = normalizedLines.length - 1; index >= 0; index -= 1) {
    if (normalizedLines[index]) {
      lastTruthyLineIndex = index;
      break;
    }
  }
  const scanner: TeamSubmissionScanner = {
    inferredIndex: 0,
    parsedLines: [],
    oshiCandidates: [],
    pendingType: null,
  };
  // fallow-ignore-next-line code-duplication
  for (const [index, line] of normalizedLines.entries()) {
    scanSubmissionLine(scanner, line, index === lastTruthyLineIndex);
  }
  const distinctOshiCandidates = [...new Set(scanner.oshiCandidates.map(normalizeLine))];
  const oshiCandidate =
    distinctOshiCandidates.length === 0 ? null : distinctOshiCandidates.join(" / ");
  const typeCounts = new Map<ParsedTeamEntry["teamType"], number>();
  const identityCounts = new Map<string, number>();
  const totalFullFill = scanner.parsedLines.filter((line) => line.type === "fullFill").length;
  // fallow-ignore-next-line code-duplication
  const entries = scanner.parsedLines.map((line) => {
    const index = (typeCounts.get(line.type) ?? 0) + 1;
    typeCounts.set(line.type, index);
    const identity = stableEntryIdentity(line.type, line.teamName, line.notes);
    const occurrence = (identityCounts.get(identity) ?? 0) + 1;
    identityCounts.set(identity, occurrence);
    return parsedEntryFromLine(
      line,
      index,
      totalFullFill,
      basePlayerName,
      oshiCandidate,
      occurrence === 1 ? identity : `${identity}:${occurrence}`,
    );
  });
  // fallow-ignore-next-line code-duplication
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
    // fallow-ignore-next-line code-duplication
    for (const mapping of existing.rowMappings) {
      const type = mapping.stableKey.split(":", 1)[0];
      if (type) availableKeys.set(type, [...(availableKeys.get(type) ?? []), mapping.stableKey]);
    }
  }
  return entries.map((entry) => {
    const identity = stableEntryIdentity(entry.teamType, entry.teamName, entry.notes);
    const keys = availableKeys.get(identity) ?? availableKeys.get(entry.teamType) ?? [];
    // Consume each stored key so duplicate entries cannot reuse the same stable identity.
    const stableKey = keys.shift();
    return stableKey === undefined ? entry : { ...entry, stableKey };
  });
};

export const existingMappingByKey = (submission: MessageTeamSubmission | null) =>
  new Map((submission?.rowMappings ?? []).map((mapping) => [mapping.stableKey, mapping] as const));

export const existingTeamKeys = (submission: MessageTeamSubmission | null) =>
  new Set((submission?.rowMappings ?? []).map((mapping) => mapping.stableKey));

// fallow-ignore-next-line code-duplication
export const blankRemovedRows = (
  previousKeys: ReadonlySet<string>,
  nextKeys: ReadonlySet<string>,
  previousMappings: ReadonlyMap<string, TeamSubmissionRowMapping>,
) =>
  [...previousKeys]
    .filter((key) => !nextKeys.has(key))
    .flatMap((key) => {
      const mapping = previousMappings.get(key);
      return mapping === undefined
        ? []
        : [
            // fallow-ignore-next-line code-duplication
            { range: mapping.playerNameRange, values: [[""]] },
            { range: mapping.teamNameRange, values: [[""]] },
            ...(mapping.oshiRange === null ? [] : [{ range: mapping.oshiRange, values: [[""]] }]),
          ];
    });

// fallow-ignore-next-line code-duplication
export const blankRollbackSnapshotForAppendedRows = (
  entries: ReadonlyArray<ProcessedTeamSubmissionEntry>,
): TeamSubmissionRollbackSnapshot =>
  entries
    .filter((entry) => entry.appended)
    .flatMap((entry) =>
      [
        {
          row: entry.mapping,
          stableKey: entry.mapping.stableKey,
        },
        ...entry.duplicateTargets.map((row) => ({ row, stableKey: entry.mapping.stableKey })),
      ].flatMap(({ row, stableKey }) => [
        { stableKey, range: row.playerNameRange, values: [] },
        { stableKey, range: row.teamNameRange, values: [] },
        ...(row.oshiRange === null ? [] : [{ stableKey, range: row.oshiRange, values: [] }]),
      ]),
    );

const confirmationLineForEntry = (entry: ParsedTeamEntry) => {
  const oshi =
    entry.oshi.status === "matched"
      ? ` | oshi: ${entry.oshi.value}`
      : entry.oshi.candidate
        ? ` | oshi: ${entry.oshi.candidate} (${entry.oshi.status}, not assigned)`
        : "";
  // fallow-ignore-next-line code-duplication
  return `- ${entry.playerName} | ${entry.teamType} | ${entry.teamName}${
    entry.notes.length > 0 ? ` | notes: ${entry.notes.join(", ")}` : ""
  }${oshi}`;
};

const confirmationLineForSkippedEntry = (entry: TeamSubmissionSkippedEntry) =>
  `- skipped ${entry.playerName} | ${entry.teamType} | ${entry.teamName} | reason: ${entry.reason}`;

export const renderConfirmation = (
  sourceMessage: MessageRef,
  entries: ReadonlyArray<ParsedTeamEntry>,
  skippedEntries: ReadonlyArray<TeamSubmissionSkippedEntry> = [],
) => {
  // TeamSubmissions authorization admits the configured Discord client before this renderer runs.
  const sourceUrl = `https://discord.com/channels/${sourceMessage.conversation.workspace.workspaceId}/${sourceMessage.conversation.conversationId}/${sourceMessage.messageId}`;
  if (entries.length === 0 && skippedEntries.length === 0)
    return `No teams could be parsed from ${sourceUrl}.`;
  const header =
    entries.length === 0
      ? `Skipped teams from ${sourceUrl}:`
      : `Registered teams from ${sourceUrl}:`;
  const lines = [
    ...entries.map(confirmationLineForEntry),
    ...skippedEntries.map(confirmationLineForSkippedEntry),
  ];
  const included: string[] = [];
  let renderedLength = header.length;
  for (const line of lines) {
    const omitted = lines.length - included.length;
    const summary = omitted > 0 ? `\n- … and ${omitted} more` : "";
    if (renderedLength + 1 + line.length + summary.length > 2_000) break;
    included.push(line);
    renderedLength += 1 + line.length;
  }
  const omitted = lines.length - included.length;
  return [header, ...included, ...(omitted > 0 ? [`- … and ${omitted} more`] : [])].join("\n");
};
