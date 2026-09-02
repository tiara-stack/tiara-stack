import { Effect, Match, Schema } from "effect";

/** The first persisted representation of the web-native Sheet Configuration. */
export const sheetConfigurationSchemaVersion = 1 as const;

export const SheetConfigurationImportAttemptStatus = Schema.Literals([
  "running",
  "succeeded",
  "needs-review",
  "failed",
]);
export type SheetConfigurationImportAttemptStatus =
  typeof SheetConfigurationImportAttemptStatus.Type;

export const SheetConfigurationAuditOutcome = Schema.Literals([
  "succeeded",
  "invalid",
  "conflict",
  "denied",
  "failed",
]);
export type SheetConfigurationAuditOutcome = typeof SheetConfigurationAuditOutcome.Type;

const Identifier = Schema.Trimmed.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonEmptyText = Schema.Trimmed.check(Schema.isNonEmpty());
const maximumSheetColumnStart = 18_277;
const maximumSheetColumnEnd = 18_278;
const SheetColumnStart = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maximumSheetColumnStart }),
);
const SheetColumnEnd = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maximumSheetColumnEnd }),
);
const RowEnd = Schema.Union([NonNegativeInt, Schema.Literal("sheet-end")]);

/** A stable, zero-based, half-open rectangle in a Google Sheets GRID tab. */
export const SheetRange = Schema.Struct({
  sheetId: NonNegativeInt,
  startRow: NonNegativeInt,
  endRow: RowEnd,
  startColumn: SheetColumnStart,
  endColumn: SheetColumnEnd,
});
export type SheetRange = Schema.Schema.Type<typeof SheetRange>;

export const SheetRangeEnd = RowEnd;
export type SheetRangeEnd = Schema.Schema.Type<typeof SheetRangeEnd>;

export const SheetRangeCoordinates = Schema.Struct({
  startRow: NonNegativeInt,
  endRow: RowEnd,
  startColumn: SheetColumnStart,
  endColumn: SheetColumnEnd,
});
export type SheetRangeCoordinates = Schema.Schema.Type<typeof SheetRangeCoordinates>;

export const SheetRangeOrAuto = Schema.Union([SheetRangeCoordinates, Schema.Literal("auto")]);
export type SheetRangeOrAuto = Schema.Schema.Type<typeof SheetRangeOrAuto>;

/** Attaches a stable tab identity to coordinates at a provider boundary. */
export const sheetRangeFromCoordinates = (
  sheetId: number,
  coordinates: SheetRangeCoordinates,
): SheetRange => ({ sheetId, ...coordinates });

/** Removes the inherited tab identity from an entry-local range. */
export const sheetRangeCoordinatesFrom = ({
  sheetId: _sheetId,
  ...coordinates
}: SheetRange): SheetRangeCoordinates => coordinates;

export const LegacySourceBinding = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unresolved"),
    expectedTitle: NonEmptyText,
  }),
  Schema.Struct({
    status: Schema.Literal("bound"),
    expectedTitle: NonEmptyText,
    spreadsheetId: Identifier,
    sheetId: NonNegativeInt,
    layoutDigest: Schema.optional(Identifier),
  }),
]);
export type LegacySourceBinding = Schema.Schema.Type<typeof LegacySourceBinding>;

export const SheetConfigurationSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("legacy"),
    binding: LegacySourceBinding,
  }),
  Schema.Struct({
    kind: Schema.Literal("owned"),
    revisionId: Schema.NullOr(Identifier),
  }),
]);
export type SheetConfigurationSource = Schema.Schema.Type<typeof SheetConfigurationSource>;

const MonitorRange = Schema.Struct({
  ids: Schema.optional(SheetRange),
  names: Schema.optional(SheetRange),
});

export const SheetUsersConfiguration = Schema.Struct({
  userIds: SheetRange,
  userSheetNames: SheetRange,
  userNotes: Schema.optional(SheetRange),
  monitors: Schema.optional(MonitorRange),
  oshis: Schema.optional(SheetRange),
});
export type SheetUsersConfiguration = Schema.Schema.Type<typeof SheetUsersConfiguration>;

const TeamIsvConfiguration = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("combined"),
    range: SheetRangeCoordinates,
  }),
  Schema.Struct({
    kind: Schema.Literal("split"),
    lead: SheetRangeCoordinates,
    backline: SheetRangeCoordinates,
    talent: SheetRangeCoordinates,
  }),
]);
export type TeamIsvConfiguration = Schema.Schema.Type<typeof TeamIsvConfiguration>;

const TeamTagsConfiguration = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("constants"),
    values: Schema.Array(NonEmptyText),
  }),
  Schema.Struct({
    kind: Schema.Literal("ranges"),
    range: SheetRangeCoordinates,
  }),
]);
export type TeamTagsConfiguration = Schema.Schema.Type<typeof TeamTagsConfiguration>;

export const SheetTeamConfiguration = Schema.Struct({
  entryId: Identifier,
  /** The legacy team configuration name retained for team-submission routing. */
  name: Schema.optional(Identifier),
  sheetId: NonNegativeInt,
  teamName: Schema.Union([SheetRangeCoordinates, Schema.Literal("auto")]),
  userNames: SheetRangeCoordinates,
  isv: TeamIsvConfiguration,
  tags: TeamTagsConfiguration,
  oshiRange: Schema.optional(SheetRangeCoordinates),
});
export type SheetTeamConfiguration = Schema.Schema.Type<typeof SheetTeamConfiguration>;

export const SheetEventConfiguration = Schema.Struct({
  /** UTC milliseconds since Unix epoch. This is the JSON-safe instant representation. */
  startTimeEpochMs: Schema.Int,
});
export type SheetEventConfiguration = Schema.Schema.Type<typeof SheetEventConfiguration>;

export const ScheduleEncoding = Schema.Literals(["none", "regex", "bold", "underline"]);
export type ScheduleEncoding = Schema.Schema.Type<typeof ScheduleEncoding>;

export const SheetScheduleConfiguration = Schema.Struct({
  entryId: Identifier,
  channel: NonEmptyText,
  day: PositiveInt,
  sheetId: NonNegativeInt,
  hourRange: SheetRangeCoordinates,
  breakRange: SheetRangeOrAuto,
  monitorRange: Schema.optional(SheetRangeCoordinates),
  encoding: ScheduleEncoding,
  fillRange: SheetRangeCoordinates,
  overfillRange: SheetRangeCoordinates,
  standbyRange: SheetRangeCoordinates,
  screenshotRange: Schema.optional(SheetRangeCoordinates),
  noteRange: Schema.optional(SheetRangeCoordinates),
  visibleCell: SheetRangeCoordinates,
});
export type SheetScheduleConfiguration = Schema.Schema.Type<typeof SheetScheduleConfiguration>;

export const SheetRunnerInterval = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type SheetRunnerInterval = Schema.Schema.Type<typeof SheetRunnerInterval>;

export const SheetRunnerConfiguration = Schema.Struct({
  entryId: Identifier,
  name: NonEmptyText,
  hours: Schema.Array(SheetRunnerInterval),
});
export type SheetRunnerConfiguration = Schema.Schema.Type<typeof SheetRunnerConfiguration>;

export const WebSheetConfiguration = Schema.Struct({
  schemaVersion: Schema.Literal(sheetConfigurationSchemaVersion),
  spreadsheetId: Identifier,
  users: SheetUsersConfiguration,
  teams: Schema.Array(SheetTeamConfiguration),
  event: SheetEventConfiguration,
  schedules: Schema.Array(SheetScheduleConfiguration),
  runners: Schema.Array(SheetRunnerConfiguration),
});
export type WebSheetConfiguration = Schema.Schema.Type<typeof WebSheetConfiguration>;

export const SheetConfigurationRevision = Schema.Struct({
  revisionId: Identifier,
  workspaceId: Identifier,
  createdAtEpochMs: Schema.Int,
  createdBy: Identifier,
  configuration: WebSheetConfiguration,
});
export type SheetConfigurationRevision = Schema.Schema.Type<typeof SheetConfigurationRevision>;

export const SheetConfigurationDiagnosticCode = Schema.Literals([
  "InvalidSchema",
  "InvalidRange",
  "MissingPairedRange",
  "DuplicateScheduleIdentity",
  "TooManyTeams",
  "InvalidRunnerInterval",
  "LegacySourceUnresolved",
  "LegacyHeadersChanged",
  "LegacySourceChanged",
  "SheetMissing",
  "SheetOutOfBounds",
  "UnsupportedSheetType",
  "Conflict",
  "ProviderRejected",
]);
export type SheetConfigurationDiagnosticCode = Schema.Schema.Type<
  typeof SheetConfigurationDiagnosticCode
>;

export const SheetConfigurationDiagnostic = Schema.Struct({
  code: SheetConfigurationDiagnosticCode,
  path: Schema.String,
  message: Schema.String,
  severity: Schema.Literals(["error", "warning"]),
});
export type SheetConfigurationDiagnostic = Schema.Schema.Type<typeof SheetConfigurationDiagnostic>;

export const SheetConfigurationDraft = Schema.Struct({
  workspaceId: Identifier,
  draftVersion: NonNegativeInt,
  baseRevisionId: Schema.NullOr(Identifier),
  baselineDigest: Schema.NullOr(Identifier),
  source: SheetConfigurationSource,
  configuration: Schema.NullOr(WebSheetConfiguration),
  diagnostics: Schema.Array(SheetConfigurationDiagnostic),
  updatedAtEpochMs: Schema.Int,
});
export type SheetConfigurationDraft = Schema.Schema.Type<typeof SheetConfigurationDraft>;

const isValidRange = (range: SheetRange): boolean =>
  range.endColumn > range.startColumn &&
  (range.endRow === "sheet-end" || range.endRow > range.startRow);

// Keep parsed provider ranges inside the same practical row bound used by calculation reads.
const maximumSheetRow = 10_000_000;

const isWithinSheetRowBounds = (range: Pick<SheetRange, "startRow" | "endRow">): boolean =>
  Number.isInteger(range.startRow) &&
  range.startRow >= 0 &&
  range.startRow < maximumSheetRow &&
  Number.isInteger(range.endRow === "sheet-end" ? range.startRow : range.endRow) &&
  (range.endRow === "sheet-end" || range.endRow <= maximumSheetRow);

const diagnostic = (
  code: SheetConfigurationDiagnosticCode,
  path: string,
  message: string,
): SheetConfigurationDiagnostic => ({ code, path, message, severity: "error" });

const rangeDiagnostics = (
  path: string,
  range: SheetRange,
): ReadonlyArray<SheetConfigurationDiagnostic> =>
  isValidRange(range) && isWithinSheetRowBounds(range)
    ? []
    : [
        diagnostic(
          "InvalidRange",
          path,
          "The range must be a non-empty half-open rectangle within the supported sheet bounds.",
        ),
      ];

/** Returns every persisted range as a tab-qualified range for provider validation. */
export const sheetConfigurationRanges = (configuration: WebSheetConfiguration) => {
  const ranges: Array<readonly [string, SheetRange]> = [
    ["users.userIds", configuration.users.userIds],
    ["users.userSheetNames", configuration.users.userSheetNames],
  ];
  const add = (path: string, range: SheetRange | undefined) => {
    if (range !== undefined) ranges.push([path, range]);
  };
  const addLocal = (path: string, sheetId: number, range: SheetRangeCoordinates | undefined) => {
    if (range !== undefined) add(path, sheetRangeFromCoordinates(sheetId, range));
  };
  add("users.userNotes", configuration.users.userNotes);
  add("users.monitors.ids", configuration.users.monitors?.ids);
  add("users.monitors.names", configuration.users.monitors?.names);
  add("users.oshis", configuration.users.oshis);
  configuration.teams.forEach((team, index) => {
    addLocal(
      `teams[${index}].teamName`,
      team.sheetId,
      team.teamName === "auto" ? undefined : team.teamName,
    );
    addLocal(`teams[${index}].userNames`, team.sheetId, team.userNames);
    Match.value(team.isv).pipe(
      Match.discriminator("kind")("split", ({ lead, backline, talent }) => {
        addLocal(`teams[${index}].isv.lead`, team.sheetId, lead);
        addLocal(`teams[${index}].isv.backline`, team.sheetId, backline);
        addLocal(`teams[${index}].isv.talent`, team.sheetId, talent);
      }),
      Match.discriminator("kind")("combined", ({ range }) => {
        addLocal(`teams[${index}].isv.range`, team.sheetId, range);
      }),
      Match.exhaustive,
    );
    addLocal(
      `teams[${index}].tags`,
      team.sheetId,
      Match.value(team.tags).pipe(
        Match.discriminator("kind")("ranges", ({ range }) => range),
        Match.orElse(() => undefined),
      ),
    );
    addLocal(`teams[${index}].oshiRange`, team.sheetId, team.oshiRange);
  });
  configuration.schedules.forEach((schedule, index) => {
    addLocal(`schedules[${index}].hourRange`, schedule.sheetId, schedule.hourRange);
    if (schedule.breakRange !== "auto") {
      addLocal(`schedules[${index}].breakRange`, schedule.sheetId, schedule.breakRange);
    }
    addLocal(`schedules[${index}].monitorRange`, schedule.sheetId, schedule.monitorRange);
    addLocal(`schedules[${index}].fillRange`, schedule.sheetId, schedule.fillRange);
    addLocal(`schedules[${index}].overfillRange`, schedule.sheetId, schedule.overfillRange);
    addLocal(`schedules[${index}].standbyRange`, schedule.sheetId, schedule.standbyRange);
    addLocal(`schedules[${index}].screenshotRange`, schedule.sheetId, schedule.screenshotRange);
    addLocal(`schedules[${index}].noteRange`, schedule.sheetId, schedule.noteRange);
    addLocal(`schedules[${index}].visibleCell`, schedule.sheetId, schedule.visibleCell);
  });
  return ranges;
};

/** Returns structured diagnostics without throwing on untrusted draft or import data. */
export const validateWebSheetConfiguration = (
  input: unknown,
): Effect.Effect<ReadonlyArray<SheetConfigurationDiagnostic>> =>
  Schema.decodeUnknownEffect(WebSheetConfiguration)(input, { onExcessProperty: "error" }).pipe(
    Effect.map((configuration) => {
      const diagnostics = sheetConfigurationRanges(configuration).flatMap(([path, range]) =>
        rangeDiagnostics(path, range),
      );
      configuration.runners.forEach((runner, runnerIndex) => {
        runner.hours.forEach((interval, intervalIndex) => {
          if (interval.start > interval.end) {
            diagnostics.push(
              diagnostic(
                "InvalidRunnerInterval",
                `runners[${runnerIndex}].hours[${intervalIndex}]`,
                "Runner hour intervals must end at or after their start.",
              ),
            );
          }
        });
      });
      if (configuration.teams.length > 32) {
        diagnostics.push(
          diagnostic("TooManyTeams", "teams", "A configuration can contain at most 32 teams."),
        );
      }
      const entryIds = new Set<string>();
      for (const [collection, entries] of [
        ["teams", configuration.teams],
        ["schedules", configuration.schedules],
        ["runners", configuration.runners],
      ] as const) {
        entries.forEach(({ entryId }, index) => {
          if (entryIds.has(entryId)) {
            diagnostics.push(
              diagnostic(
                "InvalidSchema",
                `${collection}[${index}].entryId`,
                "Entry IDs must be unique across teams, schedules, and runners.",
              ),
            );
          }
          entryIds.add(entryId);
        });
      }
      if (
        (configuration.users.monitors?.ids === undefined) !==
        (configuration.users.monitors?.names === undefined)
      ) {
        diagnostics.push(
          diagnostic(
            "MissingPairedRange",
            "users.monitors",
            "Monitor ID and monitor name ranges must be configured together.",
          ),
        );
      }
      const scheduleIdentities = new Set<string>();
      configuration.schedules.forEach((schedule, index) => {
        const identity = `${schedule.channel}\u0000${schedule.day}`;
        if (scheduleIdentities.has(identity)) {
          diagnostics.push(
            diagnostic(
              "DuplicateScheduleIdentity",
              `schedules[${index}]`,
              "Schedule channel and day must be unique.",
            ),
          );
        }
        scheduleIdentities.add(identity);
      });
      return diagnostics;
    }),
    Effect.catch((error) =>
      Effect.succeed([
        diagnostic(
          "InvalidSchema",
          "configuration",
          Schema.isSchemaError(error)
            ? `The configuration does not match the current schema version: ${error.message}`
            : "The configuration does not match the current schema version.",
        ),
      ]),
    ),
  );

/** Merges overlapping or adjacent inclusive runner intervals deterministically. */
export const normalizeRunnerIntervals = (
  intervals: ReadonlyArray<SheetRunnerInterval>,
): ReadonlyArray<SheetRunnerInterval> => {
  const sorted = [...intervals]
    .filter(({ start, end }) => start <= end)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const normalized: Array<SheetRunnerInterval> = [];
  for (const interval of sorted) {
    const previous = normalized.at(-1);
    if (previous !== undefined && interval.start <= previous.end + 1) {
      normalized[normalized.length - 1] = {
        ...previous,
        end: Math.max(previous.end, interval.end),
      };
    } else {
      normalized.push({ ...interval });
    }
  }
  return normalized;
};

export const normalizeConfiguration = (
  configuration: WebSheetConfiguration,
): WebSheetConfiguration => ({
  ...configuration,
  users: {
    ...configuration.users,
  },
  teams: configuration.teams.map((team) =>
    team.tags.kind === "constants"
      ? {
          ...team,
          tags: {
            kind: "constants",
            values: [...new Set(team.tags.values.map((value) => value.trim()).filter(Boolean))],
          },
        }
      : { ...team },
  ),
  schedules: configuration.schedules.map((schedule) => ({ ...schedule })),
  runners: configuration.runners.map((runner) => ({
    ...runner,
    hours: normalizeRunnerIntervals(runner.hours),
  })),
});

const unquotedSheetTitle = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const cellReferenceSheetTitle = /^[A-Za-z]{1,3}[1-9]\d*$/u;

export const sheetColumnLabel = (zeroBasedIndex: number): string => {
  let value = zeroBasedIndex + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = `${String.fromCharCode(65 + remainder)}${label}`;
    value = Math.floor((value - 1) / 26);
  }
  return label;
};

const columnIndex = (label: string): number => {
  let value = 0;
  for (const character of label.toUpperCase()) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value - 1;
};

const quoteSheetTitle = (title: string): string =>
  unquotedSheetTitle.test(title) && !cellReferenceSheetTitle.test(title)
    ? title
    : `'${title.replaceAll("'", "''")}'`;

/** Formats a stable range as a tab-qualified A1 reference for provider calls and UI labels. */
export const formatSheetRange = (sheetTitle: string, range: SheetRange): string => {
  if (!isValidRange(range)) {
    throw new RangeError("The range must have a non-empty half-open rectangle.");
  }
  const start = `${sheetColumnLabel(range.startColumn)}${range.startRow + 1}`;
  const endRow = range.endRow === "sheet-end" ? "" : String(range.endRow);
  const end = `${sheetColumnLabel(range.endColumn - 1)}${endRow}`;
  return `${quoteSheetTitle(sheetTitle)}!${start}:${end}`;
};

/** Formats a range when valid, returning undefined for an invalid persisted value. */
export const formatSheetRangeOption = (sheetTitle: string, range: SheetRange): string | undefined =>
  isValidRange(range) ? formatSheetRange(sheetTitle, range) : undefined;

const a1Pattern =
  /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]+)(?:\$?(\d+))?(?::\$?([A-Z]+)(?:\$?(\d+))?)?$/iu;

const parseSheetRangeInput = (input: string) => {
  const match = a1Pattern.exec(input.trim());
  if (match === null) return undefined;
  const title = (match[1] ?? match[2])?.replaceAll("''", "'");
  if (title === undefined || /[\p{Cc}]/u.test(title)) return undefined;
  return { match, title };
};

/** Returns the tab title from a tab-qualified A1 range without resolving its sheet identity. */
export const sheetTitleFromRange = (input: string): string | undefined =>
  parseSheetRangeInput(input)?.title;

/** Parses exactly one contiguous tab-qualified A1 range into the canonical coordinates. */
export const parseSheetRange = (input: string, sheetId: number): SheetRange | undefined => {
  const parsed = parseSheetRangeInput(input);
  if (parsed === undefined) return undefined;
  const { match } = parsed;
  const startColumnText = match[3];
  const startRowText = match[4];
  if (startColumnText === undefined || startRowText === undefined) {
    return undefined;
  }
  const startColumn = columnIndex(startColumnText);
  const startRow = Number(startRowText) - 1;
  const endColumn = columnIndex(match[5] ?? startColumnText) + 1;
  const endRow: number | "sheet-end" =
    match[5] === undefined
      ? startRow + 1
      : match[6] === undefined || match[6] === ""
        ? "sheet-end"
        : Number(match[6]);
  const range = { sheetId, startRow, endRow, startColumn, endColumn };
  if (
    startColumn < 0 ||
    startColumn > maximumSheetColumnStart ||
    endColumn > maximumSheetColumnEnd ||
    !isValidRange(range) ||
    !isWithinSheetRowBounds(range)
  ) {
    return undefined;
  }
  return range;
};

export const sourceForLegacySettings = (
  expectedTitle = "Thee's Sheet Settings",
): SheetConfigurationSource => ({
  kind: "legacy",
  binding: { status: "unresolved", expectedTitle },
});
