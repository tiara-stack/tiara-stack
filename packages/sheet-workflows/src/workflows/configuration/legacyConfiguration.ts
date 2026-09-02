import { createHash } from "node:crypto";
import { Predicate } from "effect";
import {
  normalizeRunnerIntervals,
  parseSheetRange,
  sheetRangeCoordinatesFrom,
  SheetConfigurationSource,
  SheetConfigurationDiagnostic,
  SheetRange,
  SheetRangeCoordinates,
  SheetRunnerConfiguration,
  SheetScheduleConfiguration,
  SheetTeamConfiguration,
  WebSheetConfiguration,
} from "sheet-domain";
import type { SheetSnapshotCell, SheetSnapshotTab } from "sheet-workflow-contracts";
import { cellText as text, parseLegacyNumber } from "../shared/runnerLocalSheets";

/** The bounded window used to observe every legacy configuration section in one read. */
export const legacySettingsSnapshotWindow = {
  startRow: 7,
  startColumn: 1,
  rowCount: 100,
  columnCount: 33,
} as const;

export const legacySettingsExpectedTitle = "Thee's Sheet Settings";
const legacySettingsLayoutVersion = "legacy-settings-layout-v1";

export type LegacyConfigurationRows = {
  readonly users: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly teams: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly event: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly schedules: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly runners: ReadonlyArray<ReadonlyArray<unknown>>;
};

export type LegacyConfigurationParseInput = {
  readonly spreadsheetId: string;
  readonly tabs: ReadonlyArray<SheetSnapshotTab>;
  readonly rows: LegacyConfigurationRows;
  readonly expectedTitle?: string;
  /** Existing bindings resolve by stable tab ID so a harmless rename remains valid. */
  readonly boundSheetId?: number;
};

export type LegacyConfigurationParseResult = {
  readonly source: SheetConfigurationSource;
  readonly configuration: WebSheetConfiguration | null;
  readonly diagnostics: ReadonlyArray<SheetConfigurationDiagnostic>;
  /** Digest of the observed legacy values used as the import baseline. */
  readonly baselineDigest: string;
};

const columnCount = legacySettingsSnapshotWindow.columnCount;

const rowsFromCells = (
  cells: ReadonlyArray<SheetSnapshotCell>,
): ReadonlyArray<ReadonlyArray<unknown>> => {
  const byPosition = new Map(
    cells.map((cell) => [`${cell.row}\u0000${cell.column}`, cell.formattedValue] as const),
  );
  return Array.from({ length: legacySettingsSnapshotWindow.rowCount }, (_, rowIndex) =>
    Array.from({ length: columnCount }, (_, columnIndex) =>
      byPosition.get(
        `${legacySettingsSnapshotWindow.startRow + rowIndex}\u0000${legacySettingsSnapshotWindow.startColumn + columnIndex}`,
      ),
    ),
  );
};

const section = (
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  startColumn: number,
  endColumn: number,
): ReadonlyArray<ReadonlyArray<unknown>> => rows.map((row) => row.slice(startColumn, endColumn));

/** Converts the bounded sparse snapshot into the five fixed legacy sections. */
export const legacyConfigurationRowsFromSnapshot = (
  cells: ReadonlyArray<SheetSnapshotCell>,
): LegacyConfigurationRows => {
  const rows = rowsFromCells(cells);
  return {
    users: section(rows, 0, 2),
    teams: section(rows, 3, 12),
    event: section(rows, 13, 15),
    schedules: section(rows, 16, 30),
    runners: section(rows, 31, 33),
  };
};

const first = (row: ReadonlyArray<unknown> | undefined): string | undefined => text(row?.[0]);

const keyValueEntries = (
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): ReadonlyMap<string, string | undefined> =>
  new Map(
    rows.flatMap((row) => {
      const key = text(row[0]);
      return Predicate.isUndefined(key) ? [] : [[key, text(row[1])] as const];
    }),
  );

const digestSectionOrder = ["users", "teams", "event", "schedules", "runners"] as const;

const legacyStructureDiagnostics = (
  rows: LegacyConfigurationRows,
): ReadonlyArray<SheetConfigurationDiagnostic> => {
  const diagnostics: Array<SheetConfigurationDiagnostic> = [];
  const expectedWidths = {
    users: 2,
    teams: 9,
    event: 2,
    schedules: 14,
    runners: 2,
  } as const;
  const severityBySection = {
    users: "error",
    teams: "warning",
    event: "error",
    schedules: "warning",
    runners: "warning",
  } as const;
  for (const sectionName of digestSectionOrder) {
    const sectionRows = rows[sectionName];
    const expectedWidth = expectedWidths[sectionName];
    sectionRows.forEach((row, rowIndex) => {
      if (!isEmptyRow(row) && row.length !== expectedWidth) {
        diagnostics.push(
          diagnostic(
            "LegacyHeadersChanged",
            `${sectionName}[${rowIndex}]`,
            `The legacy ${sectionName} section no longer has its expected ${expectedWidth}-column layout.`,
            severityBySection[sectionName],
          ),
        );
      }
    });
  }
  const keySections = [
    {
      name: "users",
      rows: rows.users,
      required: ["User IDs", "User Sheet Names"],
      allowed: ["User IDs", "User Sheet Names", "User Notes", "Moni IDs", "Moni Names", "Oshis"],
    },
    { name: "event", rows: rows.event, required: ["Start Time"], allowed: ["Start Time"] },
  ] as const;
  for (const section of keySections) {
    const labels = section.rows.flatMap((row) => {
      const key = text(row[0]);
      return Predicate.isUndefined(key) ? [] : [key];
    });
    for (const label of labels) {
      if (!section.allowed.some((allowed) => allowed === label)) {
        diagnostics.push(
          diagnostic(
            "LegacyHeadersChanged",
            `${section.name}.${label}`,
            `The legacy ${section.name} label ${label} is not part of the current layout.`,
          ),
        );
      }
    }
    for (const required of section.required) {
      if (!labels.includes(required)) {
        diagnostics.push(
          diagnostic(
            "LegacyHeadersChanged",
            `${section.name}.${required}`,
            `The legacy ${required} label is missing or moved.`,
          ),
        );
      }
    }
    if (new Set(labels).size !== labels.length) {
      diagnostics.push(
        diagnostic(
          "LegacyHeadersChanged",
          section.name,
          `The legacy ${section.name} labels are duplicated or moved.`,
        ),
      );
    }
  }
  return diagnostics;
};

const splitComma = (value: string | undefined): ReadonlyArray<string> =>
  Predicate.isUndefined(value)
    ? []
    : value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

const quotedTitle = (title: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]*$/u.test(title) ? title : `'${title.replaceAll("'", "''")}'`;

const rangeTitlePattern = /^(?:'((?:[^']|'')+)'|([^!]+))!/u;

const titleFromRange = (value: string): string | undefined => {
  const match = rangeTitlePattern.exec(value.trim());
  if (match === null) return undefined;
  if (match[2]?.startsWith("'") === true || match[2]?.endsWith("'") === true) {
    return undefined;
  }
  const title = (match[1] ?? match[2])?.replaceAll("''", "'");
  return title?.startsWith("'") && title.endsWith("'") ? title.slice(1, -1) : title;
};

const normalizedRows = (rows: LegacyConfigurationRows) =>
  digestSectionOrder.map((key) => rows[key].map((row) => row.map((value) => text(value) ?? null)));

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export const legacyConfigurationDigest = (rows: LegacyConfigurationRows): string =>
  `legacy-${digest(JSON.stringify(normalizedRows(rows)))}`;

const stableEntryId = (kind: string, identity: ReadonlyArray<string | number>): string =>
  `${kind}-${digest(identity.join("\u0000")).slice(0, 16)}`;

const diagnostic = (
  code: SheetConfigurationDiagnostic["code"],
  path: string,
  message: string,
  severity: SheetConfigurationDiagnostic["severity"] = "error",
): SheetConfigurationDiagnostic => ({
  code,
  path,
  message,
  severity,
});

const uniqueTabByTitle = (
  tabs: ReadonlyArray<SheetSnapshotTab>,
  title: string,
  path: string,
  diagnostics: Array<SheetConfigurationDiagnostic>,
  severity: SheetConfigurationDiagnostic["severity"] = "error",
): SheetSnapshotTab | undefined => {
  const matches = tabs.filter((tab) => tab.title === title);
  if (matches.length === 1) return matches[0];
  diagnostics.push(
    diagnostic(
      matches.length === 0 ? "SheetMissing" : "LegacyHeadersChanged",
      path,
      matches.length === 0
        ? `The referenced sheet tab is missing: ${title}.`
        : `The referenced sheet tab title is ambiguous: ${title}.`,
      severity,
    ),
  );
  return undefined;
};

const isEncoding = (value: string): value is SheetScheduleConfiguration["encoding"] =>
  value === "none" || value === "regex" || value === "bold" || value === "underline";

const isEmptyRow = (row: ReadonlyArray<unknown>): boolean =>
  row.every((value) => Predicate.isUndefined(text(value)));

const parseHourIntervals = (
  value: string | undefined,
  path: string,
  diagnostics: Array<SheetConfigurationDiagnostic>,
  severity: SheetConfigurationDiagnostic["severity"] = "error",
) => {
  // Legacy interval cells accept a compact human-authored grammar and report each bad segment.
  // fallow-ignore-next-line complexity
  const intervals = splitComma(value).flatMap((part) => {
    const match = /^(\d+)\s*-\s*(\d+)$/u.exec(part);
    const start = match?.[1] === undefined ? undefined : Number(match[1]);
    const end = match?.[2] === undefined ? undefined : Number(match[2]);
    if (
      Predicate.isUndefined(start) ||
      Predicate.isUndefined(end) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end
    ) {
      diagnostics.push(
        diagnostic(
          "InvalidRunnerInterval",
          path,
          `Invalid runner hour interval: ${part}`,
          severity,
        ),
      );
      return [];
    }
    return [{ start, end }];
  });
  return normalizeRunnerIntervals(intervals);
};

// Legacy ranges support both qualified and section-relative forms with explicit diagnostics.
// fallow-ignore-next-line complexity
const parseLegacyRange = (
  rawValue: string | undefined,
  path: string,
  tabs: ReadonlyArray<SheetSnapshotTab>,
  diagnostics: Array<SheetConfigurationDiagnostic>,
  relativeTitle?: string,
  localOnly = false,
  severity: SheetConfigurationDiagnostic["severity"] = "error",
): SheetRange | undefined => {
  if (Predicate.isUndefined(rawValue)) {
    diagnostics.push(diagnostic("InvalidSchema", path, "A sheet range is required.", severity));
    return undefined;
  }
  const raw = rawValue.trim();
  if (raw.length === 0 || /[\p{Cc}]/u.test(raw)) {
    diagnostics.push(
      diagnostic("InvalidRange", path, "The sheet range is empty or invalid.", severity),
    );
    return undefined;
  }
  const explicitTitle = titleFromRange(raw);
  if (localOnly && explicitTitle !== undefined) {
    diagnostics.push(
      diagnostic(
        "InvalidRange",
        path,
        "This legacy field must use a local range on its configured sheet tab.",
        severity,
      ),
    );
    return undefined;
  }
  const title = explicitTitle ?? relativeTitle;
  if (Predicate.isUndefined(title)) {
    diagnostics.push(
      diagnostic(
        "InvalidRange",
        path,
        "Legacy ranges must identify a sheet or belong to a configured team sheet.",
        severity,
      ),
    );
    return undefined;
  }
  const tab = uniqueTabByTitle(tabs, title, path, diagnostics, severity);
  if (tab === undefined) return undefined;
  const qualified = explicitTitle === undefined ? `${quotedTitle(title)}!${raw}` : raw;
  const range = parseSheetRange(qualified, tab.sheetId);
  if (range === undefined) {
    diagnostics.push(
      diagnostic(
        "InvalidRange",
        path,
        `The legacy range is not a valid contiguous range: ${raw}.`,
        severity,
      ),
    );
    return undefined;
  }
  return range;
};

const parseOptionalLegacyRange = (
  rawValue: string | undefined,
  path: string,
  tabs: ReadonlyArray<SheetSnapshotTab>,
  diagnostics: Array<SheetConfigurationDiagnostic>,
  relativeTitle?: string,
  localOnly = false,
  severity: SheetConfigurationDiagnostic["severity"] = "error",
): SheetRange | undefined =>
  Predicate.isUndefined(rawValue)
    ? undefined
    : parseLegacyRange(rawValue, path, tabs, diagnostics, relativeTitle, localOnly, severity);

const parseLocalLegacyRange = (
  rawValue: string | undefined,
  path: string,
  tabs: ReadonlyArray<SheetSnapshotTab>,
  diagnostics: Array<SheetConfigurationDiagnostic>,
  relativeTitle: string | undefined,
  severity: SheetConfigurationDiagnostic["severity"] = "error",
): typeof SheetRangeCoordinates.Type | undefined => {
  const range = parseLegacyRange(rawValue, path, tabs, diagnostics, relativeTitle, true, severity);
  return range === undefined ? undefined : sheetRangeCoordinatesFrom(range);
};

const parseOptionalLocalLegacyRange = (
  rawValue: string | undefined,
  path: string,
  tabs: ReadonlyArray<SheetSnapshotTab>,
  diagnostics: Array<SheetConfigurationDiagnostic>,
  relativeTitle: string | undefined,
  severity: SheetConfigurationDiagnostic["severity"] = "error",
): typeof SheetRangeCoordinates.Type | undefined =>
  rawValue === undefined
    ? undefined
    : parseLocalLegacyRange(rawValue, path, tabs, diagnostics, relativeTitle, severity);

const requiredText = (
  value: string | undefined,
  path: string,
  diagnostics: Array<SheetConfigurationDiagnostic>,
  severity: SheetConfigurationDiagnostic["severity"] = "error",
): string | undefined => {
  if (Predicate.isString(value) && value.length > 0) return value;
  diagnostics.push(diagnostic("InvalidSchema", path, "A non-empty value is required.", severity));
  return undefined;
};

const parseTeams = (
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  tabs: ReadonlyArray<SheetSnapshotTab>,
  diagnostics: Array<SheetConfigurationDiagnostic>,
): ReadonlyArray<SheetTeamConfiguration> => {
  const identities = new Set<string>();
  return (
    // Team rows combine shape validation, tab binding, and the split/combined ISV grammar.
    // fallow-ignore-next-line complexity
    rows.flatMap((row, index) => {
      if (isEmptyRow(row)) return [];
      const path = `teams[${index}]`;
      const name = requiredText(text(row[0]), `${path}.name`, diagnostics, "warning");
      const sheet = requiredText(text(row[1]), `${path}.sheet`, diagnostics, "warning");
      const sheetTab = Predicate.isString(sheet)
        ? uniqueTabByTitle(tabs, sheet, `${path}.sheet`, diagnostics, "warning")
        : undefined;
      if (name === undefined || sheet === undefined || sheetTab === undefined) return [];
      const playerNameRange = parseLocalLegacyRange(
        text(row[2]),
        `${path}.userNames`,
        tabs,
        diagnostics,
        sheet,
        "warning",
      );
      const teamNameText = text(row[3]);
      const teamName =
        teamNameText?.toLowerCase() === "auto"
          ? ("auto" as const)
          : parseLocalLegacyRange(
              teamNameText,
              `${path}.teamName`,
              tabs,
              diagnostics,
              sheet,
              "warning",
            );
      const isvKind = text(row[4]);
      const isvRanges = splitComma(text(row[5]));
      const isvGrammarValid =
        (isvKind === "combined" && isvRanges.length === 1) ||
        (isvKind === "split" && isvRanges.length === 3);
      const isv =
        isvKind === "combined" && isvRanges.length === 1
          ? (() => {
              const range = parseLocalLegacyRange(
                isvRanges[0],
                `${path}.isv.range`,
                tabs,
                diagnostics,
                sheet,
                "warning",
              );
              return range === undefined ? undefined : { kind: "combined" as const, range };
            })()
          : isvKind === "split" && isvRanges.length === 3
            ? (() => {
                const [lead, backline, talent] = isvRanges.map((range, rangeIndex) =>
                  parseLocalLegacyRange(
                    range,
                    `${path}.isv.${["lead", "backline", "talent"][rangeIndex]}`,
                    tabs,
                    diagnostics,
                    sheet,
                    "warning",
                  ),
                );
                return lead !== undefined && backline !== undefined && talent !== undefined
                  ? { kind: "split" as const, lead, backline, talent }
                  : undefined;
              })()
            : undefined;
      if (!isvGrammarValid) {
        diagnostics.push(
          diagnostic(
            "InvalidSchema",
            `${path}.isv`,
            "ISV configuration must be combined or three comma-separated split ranges.",
            "warning",
          ),
        );
      }
      const tagsKind = text(row[6]);
      const tagsText = text(row[7]);
      const tags =
        tagsKind === "constants"
          ? { kind: "constants" as const, values: splitComma(tagsText) }
          : tagsKind === "ranges"
            ? (() => {
                const range = parseLocalLegacyRange(
                  tagsText,
                  `${path}.tags.range`,
                  tabs,
                  diagnostics,
                  sheet,
                  "warning",
                );
                return range === undefined ? undefined : { kind: "ranges" as const, range };
              })()
            : undefined;
      if (tags === undefined) {
        diagnostics.push(
          diagnostic(
            "InvalidSchema",
            `${path}.tags`,
            "Tags configuration must be constants or a range.",
            "warning",
          ),
        );
      }
      const oshiRange = parseOptionalLocalLegacyRange(
        text(row[8]),
        `${path}.oshiRange`,
        tabs,
        diagnostics,
        sheet,
        "warning",
      );
      if (
        playerNameRange === undefined ||
        teamName === undefined ||
        isv === undefined ||
        tags === undefined
      ) {
        return [];
      }
      const identity = `${name}\u0000${sheetTab.sheetId}`;
      if (identities.has(identity)) {
        diagnostics.push(
          diagnostic("InvalidSchema", path, "Team name and sheet tab must be unique.", "warning"),
        );
        return [];
      }
      identities.add(identity);
      return [
        {
          entryId: stableEntryId("team", [name, sheetTab.sheetId]),
          name,
          sheetId: sheetTab.sheetId,
          teamName,
          userNames: playerNameRange,
          isv,
          tags,
          ...(oshiRange === undefined ? {} : { oshiRange }),
        },
      ];
    })
  );
};

const parseSchedules = (
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  tabs: ReadonlyArray<SheetSnapshotTab>,
  diagnostics: Array<SheetConfigurationDiagnostic>,
): ReadonlyArray<SheetScheduleConfiguration> => {
  const identities = new Set<string>();
  return (
    // Schedule rows preserve the legacy column order while validating every optional range.
    // fallow-ignore-next-line complexity
    rows.flatMap((row, index) => {
      if (isEmptyRow(row)) return [];
      const path = `schedules[${index}]`;
      const channel = requiredText(text(row[0]), `${path}.channel`, diagnostics, "warning");
      const dayText = text(row[1]);
      const dayValue =
        Predicate.isString(dayText) && /^\d+$/u.test(dayText)
          ? parseLegacyNumber(dayText)
          : undefined;
      const day =
        Predicate.isNumber(dayValue) && Number.isSafeInteger(dayValue) && dayValue >= 1
          ? dayValue
          : undefined;
      if (day === undefined) {
        diagnostics.push(
          diagnostic(
            "InvalidSchema",
            `${path}.day`,
            "Schedule day must be a positive integer.",
            "warning",
          ),
        );
      }
      const sheet = requiredText(text(row[2]), `${path}.sheet`, diagnostics, "warning");
      const sheetTab = Predicate.isString(sheet)
        ? uniqueTabByTitle(tabs, sheet, `${path}.sheet`, diagnostics, "warning")
        : undefined;
      if (
        channel === undefined ||
        day === undefined ||
        sheet === undefined ||
        sheetTab === undefined
      ) {
        return [];
      }
      const hourRange = parseLocalLegacyRange(
        text(row[3]),
        `${path}.hourRange`,
        tabs,
        diagnostics,
        sheet,
        "warning",
      );
      const breakText = text(row[4]);
      const breakRange =
        breakText?.toLowerCase() === "auto"
          ? ("auto" as const)
          : parseLocalLegacyRange(
              breakText,
              `${path}.breakRange`,
              tabs,
              diagnostics,
              sheet,
              "warning",
            );
      const monitorRange = parseOptionalLocalLegacyRange(
        text(row[5]),
        `${path}.monitorRange`,
        tabs,
        diagnostics,
        sheet,
        "warning",
      );
      const encodingText = text(row[6]);
      const encoding =
        Predicate.isString(encodingText) && isEncoding(encodingText) ? encodingText : undefined;
      if (encoding === undefined) {
        diagnostics.push(
          diagnostic(
            "InvalidSchema",
            `${path}.encoding`,
            "Schedule encoding must be none, regex, bold, or underline.",
            "warning",
          ),
        );
      }
      const fillRange = parseLocalLegacyRange(
        text(row[7]),
        `${path}.fillRange`,
        tabs,
        diagnostics,
        sheet,
        "warning",
      );
      const overfillRange = parseLocalLegacyRange(
        text(row[8]),
        `${path}.overfillRange`,
        tabs,
        diagnostics,
        sheet,
        "warning",
      );
      const standbyRange = parseLocalLegacyRange(
        text(row[9]),
        `${path}.standbyRange`,
        tabs,
        diagnostics,
        sheet,
        "warning",
      );
      const screenshotRange = parseOptionalLocalLegacyRange(
        text(row[10]),
        `${path}.screenshotRange`,
        tabs,
        diagnostics,
        sheet,
        "warning",
      );
      const noteRange = parseOptionalLocalLegacyRange(
        text(row[11]),
        `${path}.noteRange`,
        tabs,
        diagnostics,
        sheet,
        "warning",
      );
      const visibleCell = parseLocalLegacyRange(
        text(row[12]),
        `${path}.visibleCell`,
        tabs,
        diagnostics,
        sheet,
        "warning",
      );
      if (
        hourRange === undefined ||
        breakRange === undefined ||
        encoding === undefined ||
        fillRange === undefined ||
        overfillRange === undefined ||
        standbyRange === undefined ||
        visibleCell === undefined
      ) {
        return [];
      }
      const identity = `${channel}\u0000${day}\u0000${sheetTab.sheetId}`;
      if (identities.has(identity)) {
        diagnostics.push(
          diagnostic(
            "DuplicateScheduleIdentity",
            path,
            "Schedule channel, day, and sheet tab must be unique.",
            "warning",
          ),
        );
        return [];
      }
      identities.add(identity);
      return [
        {
          entryId: stableEntryId("schedule", [channel, day, sheetTab.sheetId]),
          channel,
          day,
          sheetId: sheetTab.sheetId,
          hourRange,
          breakRange,
          ...(monitorRange === undefined ? {} : { monitorRange }),
          encoding,
          fillRange,
          overfillRange,
          standbyRange,
          ...(screenshotRange === undefined ? {} : { screenshotRange }),
          ...(noteRange === undefined ? {} : { noteRange }),
          visibleCell,
        },
      ];
    })
  );
};

const parseRunners = (
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  diagnostics: Array<SheetConfigurationDiagnostic>,
): ReadonlyArray<SheetRunnerConfiguration> => {
  const runners = new Map<
    string,
    {
      readonly name: string;
      readonly hours: ReadonlyArray<{ readonly start: number; readonly end: number }>;
    }
  >();
  for (const [index, row] of rows.entries()) {
    if (isEmptyRow(row)) continue;
    const path = `runners[${index}]`;
    const name = requiredText(first(row), `${path}.name`, diagnostics, "warning");
    const hours = parseHourIntervals(text(row[1]), `${path}.hours`, diagnostics, "warning");
    if (name === undefined) continue;
    if (hours.length === 0) {
      diagnostics.push(
        diagnostic(
          "InvalidRunnerInterval",
          `${path}.hours`,
          "A runner needs at least one hour interval.",
          "warning",
        ),
      );
      continue;
    }
    const previous = runners.get(name);
    runners.set(name, {
      name,
      hours: normalizeRunnerIntervals([...(previous?.hours ?? []), ...hours]),
    });
  }
  return [...runners.values()].map(({ hours, name }) => ({
    entryId: stableEntryId("runner", [name]),
    name,
    hours,
  }));
};

const parseUsers = (
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  tabs: ReadonlyArray<SheetSnapshotTab>,
  diagnostics: Array<SheetConfigurationDiagnostic>,
) => {
  const entries = keyValueEntries(rows);
  const userIds = parseLegacyRange(entries.get("User IDs"), "users.userIds", tabs, diagnostics);
  const userSheetNames = parseLegacyRange(
    entries.get("User Sheet Names"),
    "users.userSheetNames",
    tabs,
    diagnostics,
  );
  const notes = parseOptionalLegacyRange(
    entries.get("User Notes"),
    "users.userNotes",
    tabs,
    diagnostics,
  );
  const oshis = parseOptionalLegacyRange(entries.get("Oshis"), "users.oshis", tabs, diagnostics);
  const monitorIdsValue = entries.get("Moni IDs");
  const monitorNamesValue = entries.get("Moni Names");
  const monitorIds = parseOptionalLegacyRange(
    monitorIdsValue,
    "users.monitors.ids",
    tabs,
    diagnostics,
  );
  const monitorNames = parseOptionalLegacyRange(
    monitorNamesValue,
    "users.monitors.names",
    tabs,
    diagnostics,
  );
  if (Predicate.isUndefined(monitorIdsValue) !== Predicate.isUndefined(monitorNamesValue)) {
    diagnostics.push(
      diagnostic(
        "MissingPairedRange",
        "users.monitors",
        "Monitor ID and monitor name ranges must be configured together.",
      ),
    );
  }
  if (userIds === undefined || userSheetNames === undefined) return undefined;
  return {
    userIds,
    userSheetNames,
    ...(notes === undefined ? {} : { userNotes: notes }),
    ...(monitorIds !== undefined && monitorNames !== undefined
      ? { monitors: { ids: monitorIds, names: monitorNames } }
      : {}),
    ...(oshis === undefined ? {} : { oshis }),
  };
};

/** Parses a legacy settings observation into a reviewable draft and a source baseline. */
// Legacy migration intentionally keeps source binding, diagnostics, and baseline derivation in
// one deterministic pass.
// fallow-ignore-next-line complexity
export const parseLegacyConfiguration = (
  input: LegacyConfigurationParseInput,
): LegacyConfigurationParseResult => {
  const diagnostics: Array<SheetConfigurationDiagnostic> = [];
  diagnostics.push(...legacyStructureDiagnostics(input.rows));
  const expectedTitle = input.expectedTitle ?? legacySettingsExpectedTitle;
  const matchingSettingsTabs = input.tabs.filter((tab) => tab.title === expectedTitle);
  const settingsTab =
    input.boundSheetId === undefined
      ? matchingSettingsTabs.length === 1
        ? matchingSettingsTabs[0]
        : undefined
      : input.tabs.find((tab) => tab.sheetId === input.boundSheetId);
  const source: SheetConfigurationSource =
    settingsTab === undefined
      ? input.boundSheetId === undefined
        ? { kind: "legacy", binding: { status: "unresolved", expectedTitle } }
        : {
            kind: "legacy",
            binding: {
              status: "bound",
              expectedTitle,
              spreadsheetId: input.spreadsheetId,
              sheetId: input.boundSheetId,
              layoutVersion: legacySettingsLayoutVersion,
            },
          }
      : {
          kind: "legacy",
          binding: {
            status: "bound",
            expectedTitle,
            spreadsheetId: input.spreadsheetId,
            sheetId: settingsTab.sheetId,
            layoutVersion: legacySettingsLayoutVersion,
          },
        };
  if (settingsTab === undefined) {
    diagnostics.push(
      diagnostic(
        input.boundSheetId === undefined ? "LegacySourceUnresolved" : "LegacySourceChanged",
        "source.binding",
        input.boundSheetId === undefined
          ? matchingSettingsTabs.length > 1
            ? `The legacy settings tab title is ambiguous: ${expectedTitle}.`
            : `The legacy settings tab could not be found: ${expectedTitle}.`
          : "The bound legacy settings tab no longer exists.",
      ),
    );
  }

  const users = parseUsers(input.rows.users, input.tabs, diagnostics);
  const eventEntries = keyValueEntries(input.rows.event);
  const startSeconds = parseLegacyNumber(eventEntries.get("Start Time"));
  const event =
    Predicate.isNumber(startSeconds) && Number.isFinite(startSeconds)
      ? { startTimeEpochMs: Math.round(startSeconds * 1_000) }
      : undefined;
  if (event === undefined) {
    diagnostics.push(
      diagnostic(
        "LegacyHeadersChanged",
        "event.startTimeEpochMs",
        "The legacy Start Time setting is missing or invalid.",
      ),
    );
  }

  const teams = parseTeams(input.rows.teams, input.tabs, diagnostics);
  const schedules = parseSchedules(input.rows.schedules, input.tabs, diagnostics);
  const runners = parseRunners(input.rows.runners, diagnostics);
  const configurationCandidate =
    settingsTab !== undefined && users !== undefined && event !== undefined
      ? {
          schemaVersion: 1 as const,
          spreadsheetId: input.spreadsheetId,
          users,
          teams,
          event,
          schedules,
          runners,
        }
      : null;
  const configuration = diagnostics.some(({ severity }) => severity === "error")
    ? null
    : configurationCandidate;
  const baselineDigest = legacyConfigurationDigest(input.rows);
  return { source, configuration, diagnostics, baselineDigest };
};
