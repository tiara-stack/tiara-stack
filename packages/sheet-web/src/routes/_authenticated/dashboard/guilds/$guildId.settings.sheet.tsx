import { Dialog } from "@base-ui/react/dialog";
import { useAtomRefresh } from "@effect/atom-react";
import { createFileRoute, Link, type RegisteredRouter, useBlocker } from "@tanstack/react-router";
import { Effect, Equal, Option, Predicate, Schema, pipe } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CloudDownload,
  Database,
  Eye,
  FileClock,
  Layers3,
  LoaderCircle,
  MoreHorizontal,
  RotateCcw,
  Save,
  Sparkles,
  Table2,
  Trash2,
  Undo2,
  Users,
} from "lucide-react";
import { ensureResultAtomData, isBrowserRuntime } from "#/lib/atomRegistry";
import { resultValue } from "#/lib/asyncResult";
import {
  guildCapabilities,
  guildPermissionsAtom,
  permissionsFromResult,
  useGuildPermissionsResult,
} from "#/lib/guildConfig";
import {
  newSheetConfigurationRevisionId,
  useActivateSheetConfiguration,
  useDiscardSheetConfigurationDraft,
  useImportLegacyConfiguration,
  useRollbackSheetConfiguration,
  useSaveSheetConfigurationDraft,
  useSaveSheetConfigurationRevision,
  useRefreshSheetConfiguration,
  useRefreshSheetConfigurationRevisions,
  useSheetConfigurationRevisionsResult,
  useSheetConfigurationResult,
  type SheetConfigurationState,
} from "#/lib/sheetConfiguration";
import { useSheetDescriptionResult, useSheetSnapshotResult } from "#/lib/sheetSnapshot";
import { formatRunnerHours, parseRunnerHoursInput } from "#/lib/sheetConfigurationInput";
import {
  LegacySourceBinding,
  SheetRange,
  SheetRangeCoordinates,
  WebSheetConfiguration,
  formatSheetRangeOption,
  parseSheetRange,
  sheetColumnLabel as columnLabel,
  sheetRangeCoordinatesFrom,
  sheetRangeFromCoordinates,
  sheetTitleFromRange,
  validateWebSheetConfiguration,
} from "sheet-domain";
import type { SheetConfigurationRevision } from "sheet-domain";
import { WorkspaceId } from "sheet-workflow-contracts";
import type {
  SheetSnapshotTab,
  SheetSnapshotWindow,
  SheetsReadSnapshotSuccess,
} from "sheet-workflow-contracts";

const SheetConfigurationSearch = Schema.Struct({
  sheetSection: Schema.optional(
    Schema.Literals(["overview", "users", "teams", "schedules", "runners"]),
  ),
  sheetField: Schema.optional(Schema.String),
});

export const Route = createFileRoute("/_authenticated/dashboard/guilds/$guildId/settings/sheet")({
  component: SheetConfigurationRoute,
  validateSearch: pipe(SheetConfigurationSearch, Schema.toStandardSchemaV1),
  loader: async ({ abortController, context, params }) => {
    if (!isBrowserRuntime()) return;
    await Effect.runPromise(
      ensureResultAtomData(context.atomRegistry, guildPermissionsAtom(params.guildId)).pipe(
        Effect.catch(() => Effect.void),
      ),
      { signal: abortController.signal },
    );
  },
});

type Configuration = Schema.Schema.Type<typeof WebSheetConfiguration>;
type Range = Schema.Schema.Type<typeof SheetRange>;
type LocalRange = Schema.Schema.Type<typeof SheetRangeCoordinates>;
type ConfigurationRevision = Schema.Schema.Type<typeof SheetConfigurationRevision>;
type LegacyBinding = Schema.Schema.Type<typeof LegacySourceBinding>;
type Team = Configuration["teams"][number];
type Schedule = Configuration["schedules"][number];
type Runner = Configuration["runners"][number];
type StudioSection = "overview" | "users" | "teams" | "schedules" | "runners";
type FocusRequest = { readonly path: string; readonly nonce: number };
type ConfigurationDiagnostic = {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning";
};
type RangeGroupId = "identity" | "participants" | "output" | "visibility" | "optional";

const defaultStudioSection: StudioSection = "overview";
const defaultStudioField = "users.userIds";

type ConfigurationChange = {
  readonly path: string;
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly kind: "added" | "removed" | "changed";
};

type RangeUndoEntry = {
  readonly path: string;
  readonly label: string;
  readonly before: Range;
  readonly after: Range;
};

type ConfirmationRequest = {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly tone: "warning" | "danger";
  readonly onConfirm: () => void;
};

type ActivationReceipt = {
  readonly revisionId: string;
  readonly activatedAtEpochMs: number;
  readonly changedCount: number;
  readonly changedGroups: string;
};

type PendingActivation = {
  readonly revisionId: string;
  readonly previousActiveRevisionId: string | null;
};

const activationReceiptStorageKey = (workspaceId: string): string =>
  `sheet-configuration-activation:${workspaceId}`;

// fallow-ignore-next-line complexity
const isActivationReceipt = (value: unknown): value is ActivationReceipt =>
  Predicate.isObject(value) &&
  Predicate.hasProperty(value, "revisionId") &&
  Predicate.isString(value.revisionId) &&
  Predicate.hasProperty(value, "activatedAtEpochMs") &&
  Predicate.isNumber(value.activatedAtEpochMs) &&
  Predicate.hasProperty(value, "changedCount") &&
  Predicate.isNumber(value.changedCount) &&
  Predicate.hasProperty(value, "changedGroups") &&
  Predicate.isString(value.changedGroups);

// fallow-ignore-next-line complexity
const readActivationReceipt = (workspaceId: string): ActivationReceipt | undefined => {
  if (typeof window === "undefined") return undefined;
  try {
    const stored = window.sessionStorage.getItem(activationReceiptStorageKey(workspaceId));
    if (stored === null) return undefined;
    const value: unknown = JSON.parse(stored);
    return isActivationReceipt(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const errorText = (error: unknown) =>
  Predicate.isError(error)
    ? error.message
    : "We couldn't complete that request. Check your connection and try again.";

const makeRange = (
  sheetId: number,
  startRow: number,
  startColumn: number,
  endRow: number | "sheet-end" = startRow + 1,
  endColumn = startColumn + 1,
): Range => ({ sheetId, startRow, endRow, startColumn, endColumn });

const makeLocalRange = (
  startRow: number,
  startColumn: number,
  endRow: number | "sheet-end" = startRow + 1,
  endColumn = startColumn + 1,
): LocalRange => ({ startRow, endRow, startColumn, endColumn });

const makeStarterConfiguration = (spreadsheetId: string): Configuration => ({
  schemaVersion: 1,
  spreadsheetId: spreadsheetId.trim(),
  users: {
    userIds: makeRange(0, 7, 1, "sheet-end", 2),
    userSheetNames: makeRange(0, 7, 2, "sheet-end", 3),
  },
  teams: [],
  event: { startTimeEpochMs: Date.now() },
  schedules: [],
  runners: [],
});

const makeTeamConfiguration = (sheetId: number, index: number): Team => {
  const range = () => makeLocalRange(0, 0, 1, 1);
  return {
    entryId: newSheetConfigurationRevisionId(),
    name: `New team ${index + 1}`,
    sheetId,
    teamName: "auto",
    userNames: range(),
    isv: { kind: "combined", range: range() },
    tags: { kind: "constants", values: [] },
  };
};

const makeScheduleConfiguration = (sheetId: number, index: number): Schedule => {
  const range = () => makeLocalRange(0, 0, 1, 1);
  return {
    entryId: newSheetConfigurationRevisionId(),
    channel: `channel-${index + 1}`,
    day: index + 1,
    sheetId,
    hourRange: range(),
    breakRange: "auto",
    encoding: "none",
    fillRange: range(),
    overfillRange: range(),
    standbyRange: range(),
    visibleCell: range(),
  };
};

const makeRunnerConfiguration = (index: number): Runner => ({
  entryId: newSheetConfigurationRevisionId(),
  name: `Runner ${index + 1}`,
  hours: [{ start: 0, end: 0 }],
});

const rebindTeamSheet = (team: Team, sheetId: number): Team => ({
  ...team,
  sheetId,
});

const rebindScheduleSheet = (schedule: Schedule, sheetId: number): Schedule => ({
  ...schedule,
  sheetId,
});

type RangeGuidance = {
  readonly description: string;
  readonly expected: string;
  readonly example: string;
};

type RangeTarget = {
  readonly path: string;
  readonly label: string;
  readonly range: Range;
  readonly description: string;
  readonly expected: string;
  readonly example: string;
  readonly group: RangeGroupId;
  readonly required: boolean;
};

const rangeTargetMetadataRules: ReadonlyArray<{
  readonly matches: RegExp;
  readonly group: RangeGroupId;
  readonly required: boolean;
}> = [
  {
    matches: /^users\.(?:userIds|userSheetNames)$/u,
    group: "identity",
    required: true,
  },
  { matches: /\.(?:teamName)$/u, group: "identity", required: true },
  {
    matches: /\.(?:userNames|isv(?:\.(?:lead|backline|talent))?)$/u,
    group: "participants",
    required: true,
  },
  {
    matches: /\.(?:hourRange|fillRange|overfillRange|standbyRange|monitorRange)$/u,
    group: "output",
    required: true,
  },
  { matches: /\.(?:visibleCell)$/u, group: "visibility", required: true },
];

const rangeTargetMetadataFor = (
  path: string,
): {
  readonly group: RangeGroupId;
  readonly required: boolean;
} =>
  rangeTargetMetadataRules.find(({ matches }) => matches.test(path)) ?? {
    group: "optional",
    required: false,
  };

const rangeTargetsForSection = (
  targets: ReadonlyArray<RangeTarget>,
  section: Exclude<StudioSection, "overview">,
): ReadonlyArray<RangeTarget> =>
  targets.filter(
    (target) => target.path.startsWith(`${section}.`) || target.path.startsWith(`${section}[`),
  );

const rangeGroupDefinitions: ReadonlyArray<{
  readonly id: RangeGroupId;
  readonly label: string;
  readonly description: string;
}> = [
  {
    id: "identity",
    label: "Identity",
    description: "The rows that identify people, teams, or schedule entries.",
  },
  {
    id: "participants",
    label: "Participants",
    description: "The rows that connect people to teams and schedules.",
  },
  {
    id: "output",
    label: "Output",
    description: "The cells the runtime reads or writes for this workspace.",
  },
  {
    id: "visibility",
    label: "Visibility",
    description: "The cells that control whether a schedule is shown.",
  },
  {
    id: "optional",
    label: "Optional",
    description: "Additional values you can enable when your sheet provides them.",
  },
];

const configurationDiagnosticFor = (
  target: RangeTarget,
  diagnostics: ReadonlyArray<ConfigurationDiagnostic>,
): ConfigurationDiagnostic | undefined =>
  diagnostics.find(
    (diagnostic) =>
      diagnostic.severity === "error" &&
      (diagnostic.path === target.path || diagnostic.path.startsWith(`${target.path}.`)),
  );

const groupedRangeTargets = (targets: ReadonlyArray<RangeTarget>) =>
  rangeGroupDefinitions
    .map((group) => ({
      ...group,
      targets: targets.filter((target) => target.group === group.id),
    }))
    .filter(({ targets: groupTargets }) => groupTargets.length > 0);

// fallow-ignore-next-line complexity
const selectedPathForSection = (
  targets: ReadonlyArray<RangeTarget>,
  section: StudioSection,
  selectedPath: string,
): string => {
  const sectionTargets = section === "overview" ? [] : rangeTargetsForSection(targets, section);
  return (
    sectionTargets.find((target) => target.path === selectedPath)?.path ??
    sectionTargets[0]?.path ??
    selectedPath
  );
};

// Field guidance keeps the schema path available while teaching the operator what the cells do.
const rangeGuidanceRules: ReadonlyArray<{
  readonly matches: RegExp;
  readonly guidance: RangeGuidance;
}> = [
  {
    matches: /^users\.userIds$/u,
    guidance: {
      description: "The people whose rows the bot can match to Discord members.",
      expected: "One Discord user ID per row",
      example: "Users!B8:B",
    },
  },
  {
    matches: /^users\.userSheetNames$/u,
    guidance: {
      description: "Display names paired with the user IDs in the same row.",
      expected: "One name per row",
      example: "Users!C8:C",
    },
  },
  {
    matches: /^users\.userNotes$/u,
    guidance: {
      description: "Optional notes the bot carries alongside each user.",
      expected: "One note per row",
      example: "Users!D8:D",
    },
  },
  {
    matches: /^users\.monitors\.ids$/u,
    guidance: {
      description: "Monitor Discord IDs paired with the monitor names below.",
      expected: "One Discord ID per row",
      example: "Monitors!B8:B",
    },
  },
  {
    matches: /^users\.monitors\.names$/u,
    guidance: {
      description: "Monitor display names paired with the monitor IDs above.",
      expected: "One name per row",
      example: "Monitors!C8:C",
    },
  },
  {
    matches: /^users\.oshis$/u,
    guidance: {
      description: "Preference values read for each user row.",
      expected: "One value per row",
      example: "Users!E8:E",
    },
  },
  {
    matches: /\.teamName$/u,
    guidance: {
      description: "The sheet column that names this team.",
      expected: "One team name per row",
      example: "Teams!A2:A",
    },
  },
  {
    matches: /\.userNames$/u,
    guidance: {
      description: "The rows of users assigned to this team.",
      expected: "One user name per row",
      example: "Teams!B2:B",
    },
  },
  {
    matches: /\.isv(?:\.(?:lead|backline|talent))?$/u,
    guidance: {
      description: "Roster values used to build this team’s roster.",
      expected: "One value per row",
      example: "Teams!C2:C",
    },
  },
  {
    matches: /\.tags$/u,
    guidance: {
      description: "Tags read for this team when tags come from the sheet.",
      expected: "One tag value per row",
      example: "Teams!D2:D",
    },
  },
  {
    matches: /\.oshiRange$/u,
    guidance: {
      description: "Preference values associated with this team.",
      expected: "One value per row",
      example: "Teams!E2:E",
    },
  },
  {
    matches: /\.hourRange$/u,
    guidance: {
      description: "The cells that define this schedule’s playable hours.",
      expected: "Start/end values for each interval",
      example: "Schedule!D3:E3",
    },
  },
  {
    matches: /\.breakRange$/u,
    guidance: {
      description: "Optional cells the schedule uses to identify its break.",
      expected: "One break interval",
      example: "Schedule!F3:F3",
    },
  },
  {
    matches: /\.monitorRange$/u,
    guidance: {
      description: "The cells used to read monitor assignments for this schedule.",
      expected: "One monitor value per row",
      example: "Schedule!G3:G",
    },
  },
  {
    matches: /\.(?:fillRange|overfillRange|standbyRange)$/u,
    guidance: {
      description: "Cells used to write the schedule’s participant state.",
      expected: "A contiguous output range",
      example: "Schedule!H3:H",
    },
  },
  {
    matches: /\.visibleCell$/u,
    guidance: {
      description: "The cell that indicates whether this schedule is visible.",
      expected: "One cell",
      example: "Schedule!A3:A3",
    },
  },
  {
    matches: /\.screenshotRange$/u,
    guidance: {
      description: "Cells used to capture screenshot content for this schedule.",
      expected: "A contiguous output range",
      example: "Schedule!J3:K12",
    },
  },
  {
    matches: /\.noteRange$/u,
    guidance: {
      description: "Cells used to read notes associated with this schedule.",
      expected: "One note value per row",
      example: "Schedule!L3:L",
    },
  },
];

const rangeGuidanceFor = (path: string, label: string): RangeGuidance =>
  rangeGuidanceRules.find(({ matches }) => matches.test(path))?.guidance ?? {
    description: `${label} provides values for this workspace.`,
    expected: "A contiguous range",
    example: "Roster!B8:C",
  };

const rangeTarget = (path: string, label: string, range: Range): RangeTarget => ({
  path,
  label,
  range,
  ...rangeGuidanceFor(path, label),
  ...rangeTargetMetadataFor(path),
});

// Range diffs need one guard for both tab-qualified and entry-local coordinates.
// fallow-ignore-next-line complexity
const isRangeLike = (value: unknown): value is Range | LocalRange =>
  Predicate.isObject(value) &&
  Predicate.hasProperty(value, "startRow") &&
  Predicate.isNumber(value.startRow) &&
  Predicate.hasProperty(value, "endRow") &&
  (Predicate.isNumber(value.endRow) || value.endRow === "sheet-end") &&
  Predicate.hasProperty(value, "startColumn") &&
  Predicate.isNumber(value.startColumn) &&
  Predicate.hasProperty(value, "endColumn") &&
  Predicate.isNumber(value.endColumn);

const formatDiffRange = (range: Range | LocalRange): string => {
  const sheet =
    Predicate.hasProperty(range, "sheetId") && Predicate.isNumber(range.sheetId)
      ? `Sheet ID ${range.sheetId} · `
      : "";
  const endRow = range.endRow === "sheet-end" ? "" : String(range.endRow);
  return `${sheet}${columnLabel(range.startColumn)}${range.startRow + 1}:${columnLabel(range.endColumn - 1)}${endRow}`;
};

// Diff display intentionally handles persisted scalars, ranges, arrays, and timestamps together.
// fallow-ignore-next-line complexity
const formatDiffValue = (path: string, value: unknown): string => {
  if (value === undefined) return "Not configured";
  if (value === null) return "None";
  if (isRangeLike(value)) return formatDiffRange(value);
  if (path.endsWith("startTimeEpochMs") && Predicate.isNumber(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  if (Array.isArray(value)) return value.length === 0 ? "None" : `${value.length} entries`;
  if (Predicate.isString(value)) return value.length === 0 ? "Empty" : value;
  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) return String(value);
  return JSON.stringify(value);
};

// Flattening preserves field-level review rows while treating ranges as one meaningful value.
// fallow-ignore-next-line complexity
const flattenDiffValues = (value: unknown, path: string, values: Map<string, unknown>): void => {
  if (isRangeLike(value) || (!Predicate.isObject(value) && !Array.isArray(value))) {
    if (path.length > 0) values.set(path, value);
    return;
  }
  if (Array.isArray(value)) {
    if (path.length > 0) values.set(`${path}.__count`, value.length);
    value.forEach((entry, index) => flattenDiffValues(entry, `${path}[${index}]`, values));
    return;
  }
  Object.entries(value).forEach(([key, child]) => {
    if (key === "entryId" || key === "schemaVersion") return;
    flattenDiffValues(child, path.length > 0 ? `${path}.${key}` : key, values);
  });
};

const diffSegmentLabels: Readonly<Record<string, string>> = {
  spreadsheetId: "Spreadsheet ID",
  users: "Users",
  userIds: "User IDs",
  userSheetNames: "User names",
  userNotes: "User notes",
  monitors: "Monitors",
  oshis: "User preferences",
  event: "Event",
  startTimeEpochMs: "Event start (UTC)",
  teams: "Teams",
  name: "Name",
  sheetId: "Sheet ID",
  teamName: "Team-name range",
  userNames: "User-name range",
  isv: "Roster values",
  kind: "Field layout",
  range: "Range",
  lead: "Lead range",
  backline: "Backline range",
  talent: "Talent range",
  tags: "Tags",
  values: "Values",
  oshiRange: "Preference range",
  schedules: "Schedules",
  channel: "Channel",
  day: "Day",
  hourRange: "Hour range",
  breakRange: "Break range",
  monitorRange: "Monitor range",
  encoding: "Encoding",
  fillRange: "Fill range",
  overfillRange: "Overfill range",
  standbyRange: "Standby range",
  screenshotRange: "Screenshot range",
  noteRange: "Note range",
  visibleCell: "Visible cell",
  runners: "Runners",
  hours: "Hours",
  start: "Start",
  end: "End",
  __count: "Count",
};

// Review labels balance stable schema paths with readable administrator-facing names.
// fallow-ignore-next-line complexity
const humanizeDiffSegment = (segment: string): string => {
  const indexed = /^(.+?) ([0-9]+)$/u.exec(segment);
  if (indexed !== null) {
    const label = diffSegmentLabels[indexed[1] ?? ""] ?? indexed[1] ?? "Entry";
    return `${label} ${indexed[2]}`;
  }
  if (diffSegmentLabels[segment] !== undefined) return diffSegmentLabels[segment];
  const spaced = segment.replace(/([a-z])([A-Z])/gu, "$1 $2").replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

// Entry paths retain their stable index while presenting a readable diff label.
// fallow-ignore-next-line complexity
const formatDiffLabel = (path: string): string => {
  const entry = /^(teams|schedules|runners)\[([0-9]+)\](.*)$/u.exec(path);
  const withEntryLabel =
    entry === null
      ? path
      : `${diffSegmentLabels[entry[1] ?? ""] ?? "Entry"} ${Number(entry[2]) + 1}${entry[3] ?? ""}`;
  return withEntryLabel
    .replace(/\[([0-9]+)\]/gu, (_match, index: string) => ` ${Number(index) + 1}`)
    .split(".")
    .map(humanizeDiffSegment)
    .join(" · ");
};

// Field-level diffing is intentionally centralized so review and future audit views share it.
// fallow-ignore-next-line complexity
const configurationDiffs = (
  before: Configuration | null | undefined,
  after: Configuration | null | undefined,
): ReadonlyArray<ConfigurationChange> => {
  const beforeValues = new Map<string, unknown>();
  const afterValues = new Map<string, unknown>();
  if (before !== null && before !== undefined) flattenDiffValues(before, "", beforeValues);
  if (after !== null && after !== undefined) flattenDiffValues(after, "", afterValues);
  const paths = [...new Set([...beforeValues.keys(), ...afterValues.keys()])];
  return paths.flatMap((path) => {
    const beforeValue = beforeValues.get(path);
    const afterValue = afterValues.get(path);
    if (Equal.equals(beforeValue, afterValue)) return [];
    return [
      {
        path,
        label: formatDiffLabel(path.replace(/\.__count$/u, "")),
        before: formatDiffValue(path, beforeValue),
        after: formatDiffValue(path, afterValue),
        kind:
          beforeValue === undefined
            ? ("added" as const)
            : afterValue === undefined
              ? ("removed" as const)
              : ("changed" as const),
      },
    ];
  });
};

type ConfigurationChangeGroupId = "workspace" | "users" | "teams" | "schedules" | "runners";

const configurationChangeGroupRules: ReadonlyArray<{
  readonly matches: RegExp;
  readonly id: ConfigurationChangeGroupId;
}> = [
  { matches: /^users(?:\.|\[)/u, id: "users" },
  { matches: /^teams(?:\.|\[)/u, id: "teams" },
  { matches: /^schedules(?:\.|\[)/u, id: "schedules" },
  { matches: /^runners(?:\.|\[)/u, id: "runners" },
];

const configurationChangeGroupFor = (path: string): ConfigurationChangeGroupId =>
  configurationChangeGroupRules.find(({ matches }) => matches.test(path))?.id ?? "workspace";

const configurationChangeGroupDefinitions: ReadonlyArray<{
  readonly id: ConfigurationChangeGroupId;
  readonly label: string;
}> = [
  { id: "workspace", label: "Workspace" },
  { id: "users", label: "Users" },
  { id: "teams", label: "Teams" },
  { id: "schedules", label: "Schedules" },
  { id: "runners", label: "Runners" },
];

const groupedConfigurationChanges = (changes: ReadonlyArray<ConfigurationChange>) =>
  configurationChangeGroupDefinitions
    .map((group) => ({
      ...group,
      changes: changes.filter((change) => configurationChangeGroupFor(change.path) === group.id),
    }))
    .filter(({ changes: groupChanges }) => groupChanges.length > 0);

const configurationChangeGroupLabelFor = (id: ConfigurationChangeGroupId): string =>
  configurationChangeGroupDefinitions.find((group) => group.id === id)?.label ?? "Workspace";

const changedMappingGroupIdsFor = (
  changes: ReadonlyArray<ConfigurationChange>,
): ReadonlyArray<Exclude<ConfigurationChangeGroupId, "workspace">> => {
  const ids = changes
    .map((change) => configurationChangeGroupFor(change.path))
    .filter((id): id is Exclude<ConfigurationChangeGroupId, "workspace"> => id !== "workspace");
  return [...new Set(ids)];
};

const studioSectionRules: ReadonlyArray<{
  readonly matches: RegExp;
  readonly section: StudioSection;
}> = [
  { matches: /^users(?:\.|\[)/u, section: "users" },
  { matches: /^teams(?:\.|\[)/u, section: "teams" },
  { matches: /^schedules(?:\.|\[)/u, section: "schedules" },
  { matches: /^runners(?:\.|\[)/u, section: "runners" },
];

const studioSectionForPath = (path: string): StudioSection =>
  studioSectionRules.find(({ matches }) => matches.test(path))?.section ?? "overview";

const configurationRanges = (configuration: Configuration): ReadonlyArray<RangeTarget> => {
  const targets: Array<RangeTarget> = [
    rangeTarget("users.userIds", "User IDs", configuration.users.userIds),
    rangeTarget("users.userSheetNames", "User names", configuration.users.userSheetNames),
  ];
  const add = (path: string, label: string, range: Range | undefined) => {
    if (range !== undefined) targets.push(rangeTarget(path, label, range));
  };
  const addLocal = (
    path: string,
    label: string,
    sheetId: number,
    range: LocalRange | undefined,
  ) => {
    if (range !== undefined) {
      targets.push(rangeTarget(path, label, sheetRangeFromCoordinates(sheetId, range)));
    }
  };
  add("users.userNotes", "User notes", configuration.users.userNotes);
  add("users.monitors.ids", "Monitor IDs", configuration.users.monitors?.ids);
  add("users.monitors.names", "Monitor names", configuration.users.monitors?.names);
  add("users.oshis", "Preference values", configuration.users.oshis);
  // The range rail must expose every typed field, including conditional ISV and tag shapes.
  // fallow-ignore-next-line complexity
  configuration.teams.forEach((team, index) => {
    const teamLabel = team.name ?? `Team ${index + 1}`;
    if (team.teamName !== "auto")
      addLocal(`teams[${index}].teamName`, `${teamLabel} name`, team.sheetId, team.teamName);
    addLocal(`teams[${index}].userNames`, `${teamLabel} users`, team.sheetId, team.userNames);
    if (team.isv.kind === "combined") {
      addLocal(`teams[${index}].isv`, `${teamLabel} roster`, team.sheetId, team.isv.range);
    } else {
      addLocal(`teams[${index}].isv.lead`, `${teamLabel} lead`, team.sheetId, team.isv.lead);
      addLocal(
        `teams[${index}].isv.backline`,
        `${teamLabel} backline`,
        team.sheetId,
        team.isv.backline,
      );
      addLocal(`teams[${index}].isv.talent`, `${teamLabel} talent`, team.sheetId, team.isv.talent);
    }
    if (team.tags.kind === "ranges")
      addLocal(`teams[${index}].tags`, `${teamLabel} tags`, team.sheetId, team.tags.range);
    addLocal(`teams[${index}].oshiRange`, `${teamLabel} preferences`, team.sheetId, team.oshiRange);
  });
  configuration.schedules.forEach((schedule, index) => {
    addLocal(
      `schedules[${index}].hourRange`,
      `${schedule.channel} · hour`,
      schedule.sheetId,
      schedule.hourRange,
    );
    if (schedule.breakRange !== "auto") {
      addLocal(
        `schedules[${index}].breakRange`,
        `${schedule.channel} · break`,
        schedule.sheetId,
        schedule.breakRange,
      );
    }
    addLocal(
      `schedules[${index}].monitorRange`,
      `${schedule.channel} · monitor`,
      schedule.sheetId,
      schedule.monitorRange,
    );
    addLocal(
      `schedules[${index}].fillRange`,
      `${schedule.channel} · fill`,
      schedule.sheetId,
      schedule.fillRange,
    );
    addLocal(
      `schedules[${index}].overfillRange`,
      `${schedule.channel} · overfill`,
      schedule.sheetId,
      schedule.overfillRange,
    );
    addLocal(
      `schedules[${index}].standbyRange`,
      `${schedule.channel} · standby`,
      schedule.sheetId,
      schedule.standbyRange,
    );
    addLocal(
      `schedules[${index}].screenshotRange`,
      `${schedule.channel} · screenshot`,
      schedule.sheetId,
      schedule.screenshotRange,
    );
    addLocal(
      `schedules[${index}].noteRange`,
      `${schedule.channel} · notes`,
      schedule.sheetId,
      schedule.noteRange,
    );
    addLocal(
      `schedules[${index}].visibleCell`,
      `${schedule.channel} · visible`,
      schedule.sheetId,
      schedule.visibleCell,
    );
  });
  return targets;
};

// fallow-ignore-next-line complexity
const configurationPathsRelated = (requestedPath: string, candidatePath: string): boolean =>
  requestedPath === candidatePath ||
  requestedPath.startsWith(`${candidatePath}.`) ||
  requestedPath.startsWith(`${candidatePath}[`) ||
  candidatePath.startsWith(`${requestedPath}.`) ||
  candidatePath.startsWith(`${requestedPath}[`);

const rangeTargetForPath = (
  targets: ReadonlyArray<RangeTarget>,
  path: string,
): RangeTarget | undefined =>
  targets.find((target) => configurationPathsRelated(path, target.path));

// Range edits fan out through the nested configuration shape while preserving stable entry IDs.
// fallow-ignore-next-line complexity
const updateConfigurationRange = (
  configuration: Configuration,
  path: string,
  range: Range,
): Configuration => {
  if (path === "users.userIds")
    return { ...configuration, users: { ...configuration.users, userIds: range } };
  if (path === "users.userSheetNames") {
    return { ...configuration, users: { ...configuration.users, userSheetNames: range } };
  }
  if (path === "users.userNotes")
    return { ...configuration, users: { ...configuration.users, userNotes: range } };
  if (path === "users.oshis")
    return { ...configuration, users: { ...configuration.users, oshis: range } };
  if (path === "users.monitors.ids" || path === "users.monitors.names") {
    const monitors = configuration.users.monitors ?? { ids: range, names: range };
    return {
      ...configuration,
      users: {
        ...configuration.users,
        monitors: { ...monitors, [path.endsWith(".ids") ? "ids" : "names"]: range },
      },
    };
  }
  const teamMatch = /^teams\[([0-9]+)\]\.(.+)$/u.exec(path);
  if (teamMatch !== null) {
    const index = Number(teamMatch[1]);
    const field = teamMatch[2] ?? "";
    const team = configuration.teams[index];
    if (team === undefined) return configuration;
    const teams = [...configuration.teams];
    const localRange = sheetRangeCoordinatesFrom(range);
    if (field === "teamName" || field === "userNames" || field === "oshiRange") {
      teams[index] = { ...team, sheetId: range.sheetId, [field]: localRange };
    } else if (field === "isv" && team.isv.kind === "combined") {
      teams[index] = {
        ...team,
        sheetId: range.sheetId,
        isv: { kind: "combined", range: localRange },
      };
    } else if (field.startsWith("isv.") && team.isv.kind === "split") {
      const key = field.slice("isv.".length) as "lead" | "backline" | "talent";
      teams[index] = {
        ...team,
        sheetId: range.sheetId,
        isv: { ...team.isv, [key]: localRange },
      };
    } else if (field === "tags" && team.tags.kind === "ranges") {
      teams[index] = {
        ...team,
        sheetId: range.sheetId,
        tags: { kind: "ranges", range: localRange },
      };
    }
    return { ...configuration, teams };
  }
  const scheduleMatch = /^schedules\[([0-9]+)\]\.(.+)$/u.exec(path);
  if (scheduleMatch !== null) {
    const index = Number(scheduleMatch[1]);
    const field = (scheduleMatch[2] ?? "") as keyof Configuration["schedules"][number];
    const schedule = configuration.schedules[index];
    if (
      schedule === undefined ||
      field === "entryId" ||
      field === "channel" ||
      field === "day" ||
      field === "sheetId" ||
      field === "encoding" ||
      (field === "breakRange" && schedule.breakRange === "auto")
    ) {
      return configuration;
    }
    const schedules = [...configuration.schedules];
    schedules[index] = {
      ...schedule,
      sheetId: range.sheetId,
      [field]: sheetRangeCoordinatesFrom(range),
    };
    return { ...configuration, schedules };
  }
  return configuration;
};

// fallow-ignore-next-line complexity
function SheetConfigurationRoute() {
  const { guildId } = Route.useParams();
  const workspaceId = Schema.decodeUnknownOption(WorkspaceId)(guildId);
  const permissionResult = useGuildPermissionsResult(guildId);
  const refreshPermissions = useAtomRefresh(guildPermissionsAtom(guildId));

  if (Option.isNone(workspaceId)) {
    return (
      <FullState label="This workspace identifier is invalid. Return to the guild dashboard." />
    );
  }

  const capabilities = guildCapabilities(
    permissionsFromResult(permissionResult),
    workspaceId.value,
  );

  if (AsyncResult.isFailure(permissionResult) && !AsyncResult.isSuccess(permissionResult)) {
    return (
      <FullState
        label="Could not check Manage Server access. Retry to load the sheet editor."
        retryLabel="RETRY ACCESS CHECK"
        onRetry={refreshPermissions}
      />
    );
  }
  if (!capabilities.canManage && !AsyncResult.isSuccess(permissionResult)) {
    return <FullState label="Checking manage access" />;
  }
  if (!capabilities.canManage) {
    return (
      <FullState
        label="Manage Server permission is required to edit the web-native sheet mappings."
        denied
      />
    );
  }
  return <ConfigurationStudio workspaceId={workspaceId.value} />;
}

// This component coordinates the atom-backed loading state before mounting the editable studio.
// fallow-ignore-next-line complexity
function ConfigurationStudio({ workspaceId }: { readonly workspaceId: typeof WorkspaceId.Type }) {
  const configurationResult = useSheetConfigurationResult(workspaceId);
  const revisionsResult = useSheetConfigurationRevisionsResult(workspaceId);
  const refreshConfiguration = useRefreshSheetConfiguration(workspaceId);
  const refreshRevisions = useRefreshSheetConfigurationRevisions(workspaceId);
  const configurationState = resultValue(configurationResult);
  const revisions = resultValue(revisionsResult) ?? [];

  if (configurationState === undefined) {
    return (
      <FullState
        label={
          AsyncResult.isFailure(configurationResult)
            ? "Could not load these sheet mappings. Retry to try again."
            : "Loading Sheet Mappings"
        }
        busy={
          !AsyncResult.isSuccess(configurationResult) && !AsyncResult.isFailure(configurationResult)
        }
        retryLabel={AsyncResult.isFailure(configurationResult) ? "RETRY CONFIGURATION" : undefined}
        onRetry={AsyncResult.isFailure(configurationResult) ? refreshConfiguration : undefined}
      />
    );
  }

  const activeConfiguration =
    configurationState.activeRevisionId === null
      ? undefined
      : revisions.find(({ revisionId }) => revisionId === configurationState.activeRevisionId)
          ?.configuration;

  return (
    <StudioLoaded
      key={`${workspaceId}:${configurationState.draftVersion}:${configurationState.activeRevisionId ?? "none"}`}
      workspaceId={workspaceId}
      state={configurationState}
      activeConfiguration={activeConfiguration}
      revisions={revisions}
      configurationUnavailable={AsyncResult.isFailure(configurationResult)}
      revisionsLoading={revisionsResult.waiting && !AsyncResult.isFailure(revisionsResult)}
      revisionsUnavailable={AsyncResult.isFailure(revisionsResult)}
      refreshConfiguration={refreshConfiguration}
      refreshRevisions={refreshRevisions}
    />
  );
}

// The loaded studio intentionally owns the draft lifecycle and its optimistic action statuses.
// fallow-ignore-next-line complexity
function StudioLoaded({
  workspaceId,
  state,
  activeConfiguration,
  revisions,
  configurationUnavailable,
  revisionsLoading,
  revisionsUnavailable,
  refreshConfiguration,
  refreshRevisions,
}: {
  readonly workspaceId: typeof WorkspaceId.Type;
  readonly state: SheetConfigurationState;
  readonly activeConfiguration: Configuration | undefined;
  readonly revisions: ReadonlyArray<ConfigurationRevision>;
  readonly configurationUnavailable: boolean;
  readonly revisionsLoading: boolean;
  readonly revisionsUnavailable: boolean;
  readonly refreshConfiguration: () => void;
  readonly refreshRevisions: () => void;
}) {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const initialConfiguration = state.configuration ?? activeConfiguration ?? null;
  // A needs-review import can persist its baseline before it has a usable parsed configuration.
  // Keep the discard path visible so that state can be recovered without database intervention.
  const hasDraft = state.configuration !== null || state.baselineDigest !== null;
  const [section, setSection] = useState<StudioSection>(
    search.sheetSection ?? defaultStudioSection,
  );
  const [editing, setEditing] = useState<Configuration | null>(initialConfiguration);
  const [saved, setSaved] = useState<Configuration | null>(initialConfiguration);
  const [selectedPath, setSelectedPath] = useState(search.sheetField ?? defaultStudioField);
  const [pendingRangeState, setPendingRangeState] =
    useState<PendingRangeState>(cleanPendingRangeState);
  const [pendingInputErrors, setPendingInputErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [busy, setBusy] = useState<string>();
  const [activationReviewOpen, setActivationReviewOpen] = useState(false);
  const [activationReceipt, setActivationReceipt] = useState<ActivationReceipt>();
  const [rangeUndoStack, setRangeUndoStack] = useState<ReadonlyArray<RangeUndoEntry>>([]);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest>();
  const [pendingSectionNavigation, setPendingSectionNavigation] = useState<StudioSection>();
  const statusRef = useRef<HTMLDivElement>(null);
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreReviewFocusRef = useRef(false);
  const focusNonceRef = useRef(0);
  const pendingActivationRef = useRef<PendingActivation | undefined>(undefined);
  const activationPreviousRevisionRef = useRef<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest>();
  const [starterSpreadsheetId, setStarterSpreadsheetId] = useState("");
  const importLegacy = useImportLegacyConfiguration();
  const saveDraft = useSaveSheetConfigurationDraft();
  const saveRevision = useSaveSheetConfigurationRevision();
  const activate = useActivateSheetConfiguration();
  const rollback = useRollbackSheetConfiguration();
  const discard = useDiscardSheetConfigurationDraft();
  const dirty = !Equal.equals(editing, saved);
  const targets = useMemo(() => (editing === null ? [] : configurationRanges(editing)), [editing]);
  const sectionTargets = section === "overview" ? [] : rangeTargetsForSection(targets, section);
  const currentTarget =
    sectionTargets.find((target) => target.path === selectedPath) ?? sectionTargets[0];
  const isLegacy = state.source.kind === "legacy";
  const legacySourceChanged =
    isLegacy && state.diagnostics.some(({ code }) => code === "LegacySourceChanged");
  const diagnostics = useMemo(() => {
    if (editing === null) return state.diagnostics;
    return dirty ? Effect.runSync(validateWebSheetConfiguration(editing)) : state.diagnostics;
  }, [dirty, editing, state.diagnostics]);
  const hasErrors = diagnostics.some(({ severity }) => severity === "error");
  const displayConfiguration = editing ?? state.configuration ?? activeConfiguration ?? null;
  const displayState =
    displayConfiguration === state.configuration
      ? state
      : { ...state, configuration: displayConfiguration };
  const activationChanges = useMemo(
    () => configurationDiffs(activeConfiguration ?? saved, editing),
    [activeConfiguration, editing, saved],
  );
  const draftIsActive =
    state.source.kind === "owned" &&
    state.activeRevisionId !== null &&
    activationChanges.length === 0;
  const errorCount = diagnostics.filter(({ severity }) => severity === "error").length;
  const hasPendingRangeEdit = pendingRangeState.dirty || pendingRangeState.invalid;
  const pendingInputError = Object.keys(pendingInputErrors)
    .sort()
    .map((key) => pendingInputErrors[key])
    .find((message) => message !== undefined);
  const hasPendingInputError = pendingInputError !== undefined;
  const hasPendingEditorState = hasPendingRangeEdit || hasPendingInputError;
  const hasUnsavedEditorState = dirty || hasPendingEditorState;
  const showSaveDraftAction = dirty && !hasPendingEditorState;
  const showReviewActivationAction =
    !dirty && !hasPendingEditorState && hasDraft && editing !== null && !draftIsActive;
  const showUndoAction = rangeUndoStack.length > 0 && !hasPendingEditorState;
  const blocker = useBlocker<RegisteredRouter, true>({
    shouldBlockFn: ({ current, next }) =>
      busy === undefined &&
      hasUnsavedEditorState &&
      (current.pathname !== next.pathname || current.fullPath !== next.fullPath),
    enableBeforeUnload: false,
    withResolver: true,
  });

  const requestFocus = useCallback((path: string) => {
    focusNonceRef.current += 1;
    setFocusRequest({ path, nonce: focusNonceRef.current });
  }, []);

  const updatePendingInputError = useCallback((key: string, message: string | undefined) => {
    setPendingInputErrors((current) => {
      if (message === undefined) {
        if (current[key] === undefined) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      return current[key] === message ? current : { ...current, [key]: message };
    });
  }, []);

  useEffect(() => {
    setActivationReceipt(readActivationReceipt(workspaceId));
  }, [workspaceId]);

  useEffect(() => {
    if (status.kind !== "idle") statusRef.current?.focus();
  }, [status]);

  useEffect(() => {
    if (activationReceipt === undefined || typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(
        activationReceiptStorageKey(workspaceId),
        JSON.stringify(activationReceipt),
      );
    } catch {
      // A receipt is helpful context, but activation must not depend on browser storage.
    }
  }, [activationReceipt, workspaceId]);

  // Receipt reconciliation must distinguish a stale persisted receipt from an activation
  // that has succeeded but whose reactive state has not arrived yet.
  // fallow-ignore-next-line complexity
  useEffect(() => {
    if (
      activationReceipt === undefined ||
      activationReceipt.revisionId === state.activeRevisionId
    ) {
      if (activationReceipt?.revisionId === state.activeRevisionId) {
        pendingActivationRef.current = undefined;
      }
      return;
    }
    const pendingActivation = pendingActivationRef.current;
    if (
      pendingActivation?.revisionId === activationReceipt.revisionId &&
      (state.activeRevisionId === null ||
        state.activeRevisionId === pendingActivation.previousActiveRevisionId)
    ) {
      return;
    }
    setActivationReceipt(undefined);
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.removeItem(activationReceiptStorageKey(workspaceId));
    } catch {
      // Stale receipt cleanup is best effort and must not affect the editor.
    }
  }, [activationReceipt, state.activeRevisionId, workspaceId]);

  useEffect(() => {
    if (!hasUnsavedEditorState || typeof window === "undefined") return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedEditorState]);

  // fallow-ignore-next-line complexity
  useEffect(() => {
    if (activationReviewOpen || focusRequest === undefined) return;
    if (section !== "overview" && rangeTargetForPath(targets, focusRequest.path) !== undefined) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const candidate = Array.from(
        document.querySelectorAll<HTMLElement>("[data-configuration-path]"),
      ).find((element) => {
        const candidatePath = element.dataset.configurationPath;
        return (
          candidatePath !== undefined && configurationPathsRelated(focusRequest.path, candidatePath)
        );
      });
      if (candidate === undefined) return;
      candidate.focus({ preventScroll: true });
      candidate.scrollIntoView({ block: "nearest" });
      setFocusRequest(undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activationReviewOpen, focusRequest, section, targets]);

  useEffect(() => {
    if (activationReviewOpen || !restoreReviewFocusRef.current) return;
    restoreReviewFocusRef.current = false;
    const frame = window.requestAnimationFrame(() => reviewTriggerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [activationReviewOpen]);

  const closeActivationReview = () => {
    restoreReviewFocusRef.current = true;
    setActivationReviewOpen(false);
  };

  const openActivationReview = () => {
    restoreReviewFocusRef.current = false;
    setActivationReviewOpen(true);
  };

  const updateStudioLocation = (
    nextSection: StudioSection,
    nextPath = nextSection === "overview" ? undefined : selectedPath,
  ) => {
    setSection(nextSection);
    setSelectedPath(nextPath ?? defaultStudioField);
    void navigate({
      search: { sheetSection: nextSection, sheetField: nextPath },
      replace: true,
    });
  };

  const clearPendingEditorState = () => {
    setPendingRangeState(cleanPendingRangeState);
    setPendingInputErrors({});
  };

  const navigateToSection = (next: StudioSection) => {
    if (next === section) return;
    if (hasPendingEditorState) {
      setPendingSectionNavigation(next);
      return;
    }
    updateStudioLocation(next, selectedPathForSection(targets, next, selectedPath));
  };

  useEffect(() => {
    const nextSection = search.sheetSection ?? defaultStudioSection;
    const nextPath = search.sheetField ?? defaultStudioField;
    setSection((current) => (current === nextSection ? current : nextSection));
    setSelectedPath((current) => (current === nextPath ? current : nextPath));
  }, [search.sheetField, search.sheetSection]);

  useEffect(() => {
    if (
      section === "overview" ||
      currentTarget === undefined ||
      currentTarget.path === selectedPath
    ) {
      return;
    }
    setSelectedPath(currentTarget.path);
    void navigate({
      search: { sheetSection: section, sheetField: currentTarget.path },
      replace: true,
    });
  }, [currentTarget?.path, navigate, section, selectedPath]);

  useEffect(() => {
    if (
      !hasPendingRangeEdit &&
      status.kind === "error" &&
      status.message === pendingRangeErrorMessage
    ) {
      setStatus({ kind: "idle" });
    }
  }, [hasPendingRangeEdit, status]);

  useEffect(() => {
    if (!dirty && !Equal.equals(saved, initialConfiguration)) {
      setSaved(initialConfiguration);
      setEditing(initialConfiguration);
      setPendingRangeState(cleanPendingRangeState);
    }
  }, [dirty, initialConfiguration, saved]);

  const runAction = async (
    label: string,
    action: () => Promise<unknown>,
    successMessage: string | ((result: unknown) => string) = `${label} complete.`,
  ): Promise<unknown> => {
    setBusy(label);
    setStatus({ kind: "idle" });
    try {
      const result = await action();
      setStatus({
        kind: "success",
        message: typeof successMessage === "function" ? successMessage(result) : successMessage,
      });
      return result;
    } catch (error) {
      setStatus({ kind: "error", message: errorText(error) });
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  const handleConfigurationChange = (next: Configuration) => {
    setRangeUndoStack([]);
    setEditing(next);
  };

  // fallow-ignore-next-line complexity
  const handleRangeChange = (path: string, range: Range) => {
    if (editing === null) return;
    const currentTargets = configurationRanges(editing);
    const existing = rangeTargetForPath(currentTargets, path);
    const previous = existing?.range;
    if (previous === undefined || Equal.equals(previous, range)) return;
    const label = existing?.label ?? formatDiffLabel(path);
    setRangeUndoStack((current) =>
      [...current, { path, label, before: previous, after: range }].slice(-20),
    );
    setEditing(updateConfigurationRange(editing, path, range));
  };

  const undoLastRange = () => {
    const entry = rangeUndoStack[rangeUndoStack.length - 1];
    if (entry === undefined || editing === null) return;
    setEditing(updateConfigurationRange(editing, entry.path, entry.before));
    setRangeUndoStack((current) => current.slice(0, -1));
    setPendingRangeState(cleanPendingRangeState);
    setStatus({ kind: "success", message: `Undid the range change for ${entry.label}.` });
  };

  useEffect(() => {
    if (activationReviewOpen || rangeUndoStack.length === 0 || hasPendingEditorState) return;
    // fallow-ignore-next-line complexity
    const handleUndo = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== "z") {
        return;
      }
      const activeElement = document.activeElement;
      if (activeElement?.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      undoLastRange();
    };
    window.addEventListener("keydown", handleUndo);
    return () => window.removeEventListener("keydown", handleUndo);
  }, [activationReviewOpen, hasPendingEditorState, rangeUndoStack, editing]);

  const validateDraft = async (configuration: Configuration | null) =>
    configuration === null
      ? state.diagnostics
      : await Effect.runPromise(validateWebSheetConfiguration(configuration));

  const persistDraft = async () => {
    if (editing === null) throw new Error("Create or import a configuration before saving.");
    const diagnostics = await validateDraft(editing);
    const result = await saveDraft({
      workspaceId,
      expectedDraftVersion: state.draftVersion,
      source: state.source,
      legacyBinding: state.legacyBinding,
      baseRevisionId: state.baseRevisionId ?? state.activeRevisionId,
      baselineDigest: state.baselineDigest,
      configuration: editing,
      diagnostics,
    });
    const persistedConfiguration = result.configuration;
    setEditing(persistedConfiguration);
    setSaved(persistedConfiguration);
    setRangeUndoStack([]);
    return {
      result,
      draftVersion: result.draftVersion,
      configuration: persistedConfiguration,
      diagnostics: result.diagnostics,
    };
  };

  const saveDraftAction = () =>
    void runAction(
      "Save draft",
      async () => (await persistDraft()).draftVersion,
      (result) => `Draft v${String(result)} saved.`,
    );

  const importAction = () =>
    void runAction("Import legacy settings", async () => {
      const result = await importLegacy(workspaceId);
      if (result.configuration !== null) {
        const configuration = Schema.decodeUnknownSync(WebSheetConfiguration)(result.configuration);
        setEditing(configuration);
        setSaved(configuration);
      }
      setPendingRangeState(cleanPendingRangeState);
      setPendingInputErrors({});
      updateStudioLocation("overview");
    });

  // Activation validates, persists, versions, and activates one candidate configuration.
  // fallow-ignore-next-line complexity
  // The activation callback keeps validation, persistence, versioning, and activation atomic.
  // fallow-ignore-next-line complexity
  const activateConfiguration = async () => {
    if (editing === null) throw new Error("Create or import a configuration before activating.");
    const previousActiveRevisionId = state.activeRevisionId;
    activationPreviousRevisionRef.current = previousActiveRevisionId;
    const diagnostics = await validateDraft(editing);
    if (diagnostics.some(({ severity }) => severity === "error")) {
      throw new Error("Resolve configuration errors before activating.");
    }
    const draft = dirty ? await persistDraft() : undefined;
    if (draft?.diagnostics.some(({ severity }) => severity === "error") === true) {
      throw new Error("Resolve configuration errors before activating.");
    }
    const draftVersion = draft?.draftVersion ?? state.draftVersion;
    const candidateConfiguration = draft?.configuration ?? editing;
    if (candidateConfiguration === null) {
      throw new Error("Create or import a configuration before activating.");
    }
    const revision = await saveRevision({
      workspaceId,
      expectedDraftVersion: draftVersion,
      revisionId: newSheetConfigurationRevisionId(),
      configuration: candidateConfiguration,
    });
    await activate({
      workspaceId,
      expectedDraftVersion: draftVersion,
      revisionId: revision.revision.revisionId,
      expectedBaselineDigest: state.baselineDigest,
    });
    return revision.revision.revisionId;
  };

  const reviewAndActivate = () =>
    void runAction(
      "Activate configuration",
      activateConfiguration,
      (result) => `Revision ${String(result).slice(0, 8)} is live.`,
    ).then((revisionId) => {
      if (typeof revisionId !== "string") return;
      pendingActivationRef.current = {
        revisionId,
        previousActiveRevisionId: activationPreviousRevisionRef.current,
      };
      setActivationReceipt({
        revisionId,
        activatedAtEpochMs: Date.now(),
        changedCount: activationChanges.length,
        changedGroups: groupedConfigurationChanges(activationChanges)
          .map(({ label }) => label)
          .join(" · "),
      });
      setActivationReviewOpen(false);
    });

  // fallow-ignore-next-line complexity
  const editConfigurationPath = (path: string) => {
    const nextSection = studioSectionForPath(path);
    const nextTargets =
      nextSection === "overview" ? [] : rangeTargetsForSection(targets, nextSection);
    const nextPath = rangeTargetForPath(nextTargets, path)?.path;
    restoreReviewFocusRef.current = false;
    setActivationReviewOpen(false);
    updateStudioLocation(
      nextSection,
      nextPath ?? selectedPathForSection(targets, nextSection, selectedPath),
    );
    requestFocus(nextPath ?? path);
  };

  const rollbackAction = (revision: ConfigurationRevision) =>
    setConfirmation({
      title: `Roll back to revision ${revision.revisionId.slice(0, 8)}?`,
      description:
        "This draft will become the active sheet mapping revision. The current active revision will remain in history.",
      confirmLabel: "ROLL BACK REVISION",
      tone: "warning",
      onConfirm: () => {
        setConfirmation(undefined);
        void runAction(`Rollback to ${revision.revisionId.slice(0, 8)}`, async () => {
          await rollback({
            workspaceId,
            expectedDraftVersion: state.draftVersion,
            revisionId: revision.revisionId,
          });
        });
      },
    });

  const restoreLegacyAction = () =>
    setConfirmation({
      title: "Restore the legacy source?",
      description:
        "The retained legacy Settings tab will become the live source again. Your web revisions will remain available for rollback.",
      confirmLabel: "RESTORE LEGACY SOURCE",
      tone: "warning",
      onConfirm: () => {
        setConfirmation(undefined);
        void runAction("Restore the legacy source", async () => {
          await rollback({
            workspaceId,
            expectedDraftVersion: state.draftVersion,
            revisionId: null,
          });
        });
      },
    });

  const discardAction = () =>
    setConfirmation({
      title: "Discard this draft?",
      description:
        "Unsaved changes and the current draft configuration will be removed. The active source will not change.",
      confirmLabel: "DISCARD DRAFT",
      tone: "danger",
      onConfirm: () => {
        setConfirmation(undefined);
        void runAction("Discard draft", async () => {
          await discard({
            workspaceId,
            expectedDraftVersion: state.draftVersion,
          });
          setEditing(initialConfiguration);
          setSaved(initialConfiguration);
          clearPendingEditorState();
          setRangeUndoStack([]);
        });
      },
    });

  const createStarter = () => {
    const spreadsheetId = starterSpreadsheetId.trim();
    if (spreadsheetId.length === 0) {
      setStatus({ kind: "error", message: "Enter a Google Sheets spreadsheet ID first." });
      return;
    }
    const starter = makeStarterConfiguration(spreadsheetId);
    setEditing(starter);
    setRangeUndoStack([]);
    setPendingRangeState(cleanPendingRangeState);
    setPendingInputErrors({});
    updateStudioLocation("overview");
    setStatus({ kind: "success", message: "Draft created. Map its ranges, then save." });
  };

  return (
    <div className="min-h-[calc(100vh-11rem)] min-w-0 max-w-full border border-[#33ccbb]/25 bg-[#080d0c] pb-[calc(5rem+env(safe-area-inset-bottom))] text-white sm:pb-24">
      <header className="sticky top-12 z-30 min-w-0 border-b border-[#33ccbb]/20 bg-[#080d0c]/95 px-3 py-2.5 backdrop-blur sm:top-24 sm:px-6 sm:py-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Link
            to="/dashboard/guilds/$guildId/settings"
            params={{ guildId: workspaceId }}
            className="flex h-11 w-11 shrink-0 items-center justify-center border border-white/15 text-white/55 transition hover:border-[#33ccbb] hover:text-[#33ccbb] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc] sm:h-9 sm:w-9"
            aria-label="Back to server settings"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-black tracking-tight sm:text-2xl">
              Sheet mappings
            </h1>
            <p className="mt-1 hidden max-w-2xl text-xs leading-relaxed text-white/55 sm:block">
              The current source stays live while you edit a draft. Save the draft, then activate it
              when it is ready.
            </p>
          </div>
        </div>
        <div className="mt-2 flex min-w-0 items-center justify-between gap-3 sm:mt-3">
          <EditorLifecycle
            isLegacy={isLegacy}
            legacySourceChanged={legacySourceChanged}
            hasDraft={hasDraft}
            dirty={dirty}
            hasPendingEditorState={hasPendingEditorState}
            draftIsActive={draftIsActive}
          />
          <SourceBadge
            isLegacy={isLegacy}
            legacySourceChanged={legacySourceChanged}
            revisionId={state.activeRevisionId}
          />
        </div>
      </header>

      {configurationUnavailable ? (
        <DataStatusNotice
          kind="warning"
          message="The latest configuration could not be refreshed. You are viewing the last available draft."
          actionLabel="RETRY"
          onAction={refreshConfiguration}
        />
      ) : null}

      {activationReceipt ? (
        <ActivationReceiptBanner
          receipt={activationReceipt}
          onViewHistory={() => updateStudioLocation("overview")}
        />
      ) : null}

      {activationReviewOpen ? (
        <ActivationReview
          workspaceId={workspaceId}
          configuration={editing}
          isLegacy={isLegacy}
          activeRevisionId={state.activeRevisionId}
          changes={activationChanges}
          errorCount={errorCount}
          busy={busy}
          status={status}
          statusRef={statusRef}
          onCancel={closeActivationReview}
          onEdit={editConfigurationPath}
          onConfirm={reviewAndActivate}
        />
      ) : (
        <div className="grid min-h-[calc(100vh-18rem)] min-w-0 grid-cols-1 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside
            className="border-b border-[#33ccbb]/15 bg-[#0a1210] p-3 lg:border-b-0 lg:border-r sm:p-4"
            aria-label="Sheet mapping sections"
          >
            <p className="hidden px-2 pb-3 font-mono text-[9px] font-black tracking-[0.2em] text-white/35 lg:block">
              MAPPINGS
            </p>
            <label className="block lg:hidden" htmlFor="sheet-configuration-section">
              <span className="mb-2 block font-mono text-[9px] font-black tracking-[0.16em] text-[#8fbab4]">
                MAPPING SECTION
              </span>
              <select
                id="sheet-configuration-section"
                className="studioInput w-full"
                value={section}
                onChange={(event) => navigateToSection(event.target.value as StudioSection)}
              >
                <option value="overview">Overview</option>
                <option value="users">Users</option>
                <option value="teams">Teams</option>
                <option value="schedules">Schedules</option>
                <option value="runners">Runners</option>
              </select>
            </label>
            <nav className="hidden lg:block lg:space-y-1">
              <StudioNavButton
                active={section === "overview"}
                icon={<Sparkles />}
                onClick={() => navigateToSection("overview")}
              >
                Overview
              </StudioNavButton>
              <StudioNavButton
                active={section === "users"}
                icon={<Users />}
                onClick={() => navigateToSection("users")}
              >
                Users
              </StudioNavButton>
              <StudioNavButton
                active={section === "teams"}
                icon={<Layers3 />}
                onClick={() => navigateToSection("teams")}
              >
                Teams
              </StudioNavButton>
              <StudioNavButton
                active={section === "schedules"}
                icon={<Table2 />}
                onClick={() => navigateToSection("schedules")}
              >
                Schedules
              </StudioNavButton>
              <StudioNavButton
                active={section === "runners"}
                icon={<Database />}
                onClick={() => navigateToSection("runners")}
              >
                Runners
              </StudioNavButton>
            </nav>
            <div className="mt-3 border-t border-white/10 px-2 pt-3 lg:mt-8 lg:px-0 lg:pt-4">
              <p className="font-mono text-[9px] font-black tracking-[0.16em] text-white/35">
                DRAFT VERSION
              </p>
              <p className="font-mono text-lg font-bold text-[#33ccbb]">v{state.draftVersion}</p>
            </div>
          </aside>

          <div className="min-w-0 bg-[#0b1210]">
            {section === "overview" ? (
              <OverviewSection
                state={displayState}
                hasDraft={hasDraft}
                isLegacy={isLegacy}
                legacySourceChanged={legacySourceChanged}
                starterSpreadsheetId={starterSpreadsheetId}
                setStarterSpreadsheetId={setStarterSpreadsheetId}
                createStarter={createStarter}
                importAction={importAction}
                busy={busy}
                revisions={revisions}
                rollbackAction={rollbackAction}
                restoreLegacyAction={restoreLegacyAction}
                discardAction={discardAction}
                diagnostics={diagnostics}
                dirty={dirty}
                hasErrors={hasErrors}
                revisionsLoading={revisionsLoading}
                revisionsUnavailable={revisionsUnavailable}
                refreshRevisions={refreshRevisions}
                onConfigurationChange={handleConfigurationChange}
                onPendingInputStateChange={updatePendingInputError}
                onDiagnosticNavigate={editConfigurationPath}
                onEditMappings={() => navigateToSection("users")}
              />
            ) : editing === null ? (
              <EmptyConfigurationSection onOverview={() => navigateToSection("overview")} />
            ) : (
              <RangeSection
                workspaceId={workspaceId}
                section={section}
                configuration={editing}
                draftDirty={dirty}
                targets={targets}
                selectedPath={currentTarget?.path ?? selectedPath}
                onSelect={(path) => updateStudioLocation(section, path)}
                diagnostics={diagnostics}
                focusRequest={focusRequest}
                pendingRangeState={pendingRangeState}
                onPendingRangeStateChange={setPendingRangeState}
                onPendingInputStateChange={updatePendingInputError}
                pendingInputError={pendingInputError}
                onClearPendingEditorState={clearPendingEditorState}
                onChange={handleRangeChange}
                onConfigurationChange={handleConfigurationChange}
              />
            )}
          </div>
        </div>
      )}

      {!activationReviewOpen ? (
        <footer
          className="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 border-t border-[#33ccbb]/25 bg-[#07100e]/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur sm:flex-row sm:justify-between sm:gap-3 sm:px-6 sm:py-3"
          aria-label="Draft actions"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-xs sm:flex-1">
            {status.kind !== "idle" ? (
              <ActionStatus status={status} statusRef={statusRef} />
            ) : (
              <>
                <span
                  className={`h-2 w-2 shrink-0 ${dirty || hasPendingEditorState ? "bg-[#ffb86c]" : "bg-[#33ccbb]"}`}
                />
                <span className="truncate text-white/65">
                  {pendingInputError ??
                    (pendingRangeState.invalid
                      ? "Pending range edit is invalid · fix or revert it"
                      : pendingRangeState.dirty
                        ? "Pending range edit · apply it in the editor"
                        : dirty
                          ? "Draft in progress · save draft"
                          : draftIsActive
                            ? "Active · no changes to publish"
                            : hasDraft
                              ? "Saved draft · review activation"
                              : "Current source · import or create a draft")}
                </span>
              </>
            )}
          </div>
          {showUndoAction || showSaveDraftAction || showReviewActivationAction ? (
            <div className="flex w-full shrink-0 justify-end gap-2 sm:w-auto">
              {showUndoAction ? (
                <details className="relative">
                  <summary
                    className={`${smallButton} cursor-pointer list-none px-2 text-[9px] sm:px-3 sm:text-[10px] marker:hidden`}
                    aria-label="More draft actions"
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                    MORE
                  </summary>
                  <div className="absolute bottom-full right-0 z-10 mb-2 min-w-52 border border-[#33ccbb]/30 bg-[#0a1512] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
                    <button
                      type="button"
                      className={`${smallButton} w-full justify-start border-transparent px-3 text-[10px] hover:bg-[#33ccbb]/10`}
                      aria-label={`Undo last range change for ${rangeUndoStack[rangeUndoStack.length - 1]?.label ?? "active mapping"}`}
                      disabled={busy !== undefined}
                      onClick={(event) => {
                        undoLastRange();
                        event.currentTarget.closest("details")?.removeAttribute("open");
                      }}
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                      UNDO LAST RANGE
                    </button>
                  </div>
                </details>
              ) : null}
              {showSaveDraftAction ? (
                <button
                  type="button"
                  className={`${primaryButton} min-h-11 min-w-0 flex-1 px-3 text-[10px] sm:min-h-0 sm:flex-none sm:px-4 sm:text-xs`}
                  aria-label="Save draft"
                  disabled={busy !== undefined}
                  onClick={saveDraftAction}
                >
                  {busy === "Save draft" ? (
                    <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  SAVE DRAFT
                </button>
              ) : null}
              {showReviewActivationAction ? (
                <button
                  type="button"
                  className={`${primaryButton} min-h-11 min-w-0 flex-1 px-3 text-[10px] sm:min-h-0 sm:flex-none sm:px-4 sm:text-xs`}
                  aria-label="Review activation before making the draft live"
                  disabled={busy !== undefined || hasErrors}
                  ref={reviewTriggerRef}
                  onClick={openActivationReview}
                >
                  {busy === "Activate configuration" ? (
                    <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                  REVIEW ACTIVATION
                </button>
              ) : null}
            </div>
          ) : null}
        </footer>
      ) : null}
      <ActionConfirmationDialog
        request={
          pendingSectionNavigation === undefined
            ? undefined
            : {
                title: "Discard staged editor changes?",
                description:
                  "The pending A1 selection or incomplete field value will be cleared before changing sections. Saved and applied draft changes will stay intact.",
                confirmLabel: "DISCARD & CHANGE SECTION",
                tone: "warning",
                onConfirm: () => {
                  const next = pendingSectionNavigation;
                  setPendingSectionNavigation(undefined);
                  clearPendingEditorState();
                  updateStudioLocation(next, selectedPathForSection(targets, next, selectedPath));
                },
              }
        }
        onCancel={() => setPendingSectionNavigation(undefined)}
      />
      <ActionConfirmationDialog
        request={confirmation}
        onCancel={() => setConfirmation(undefined)}
      />
      <DraftNavigationConfirmation blocker={blocker} />
    </div>
  );
}

// The inline review keeps activation in the editor's flow without an interruptive modal.
// fallow-ignore-next-line complexity
function ActivationReview({
  workspaceId,
  configuration,
  isLegacy,
  activeRevisionId,
  changes,
  errorCount,
  busy,
  status,
  statusRef,
  onCancel,
  onEdit,
  onConfirm,
}: {
  readonly workspaceId: string;
  readonly configuration: Configuration | null;
  readonly isLegacy: boolean;
  readonly activeRevisionId: string | null;
  readonly changes: ReadonlyArray<ConfigurationChange>;
  readonly errorCount: number;
  readonly busy: string | undefined;
  readonly status: Status;
  readonly statusRef: { readonly current: HTMLDivElement | null };
  readonly onCancel: () => void;
  readonly onEdit: (path: string) => void;
  readonly onConfirm: () => void;
}) {
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => reviewHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const sourceMessage = isLegacy
    ? "The legacy Settings tab stays current until you activate this draft."
    : activeRevisionId === null
      ? "No active web revision exists yet. This draft will be the first one."
      : "This draft will replace the active web revision.";
  const groups = groupedConfigurationChanges(changes);
  const mappingCount = configuration === null ? 0 : configurationRanges(configuration).length;
  const sampleTargetCount =
    configuration === null ? 0 : activationSampleTargetsFor(configuration, changes).length;
  const initialSampleTargetCount = Math.min(sampleTargetCount, activationSampleInitialTargetLimit);
  const summary =
    groups.length === 0
      ? "No mapping values will change. Activating still creates a new audit checkpoint."
      : `This draft updates ${groups.map(({ label, changes: groupChanges }) => `${groupChanges.length} ${label.toLowerCase()} ${groupChanges.length === 1 ? "mapping" : "mappings"}`).join(", ")}.`;
  return (
    <section
      className="space-y-5 bg-[#0b1210] p-5 sm:p-8"
      aria-labelledby="activation-review-title"
    >
      <div className="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2
            ref={reviewHeadingRef}
            id="activation-review-title"
            className="text-2xl font-black tracking-tight outline-none"
            tabIndex={-1}
          >
            Review what will go live
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55">{sourceMessage}</p>
        </div>
        <div className="shrink-0 border border-[#33ccbb]/30 bg-[#33ccbb]/10 px-3 py-2 font-mono text-[10px] font-black tracking-[0.12em] text-[#73e9dc]">
          {changes.length} {changes.length === 1 ? "CHANGE" : "CHANGES"} TO REVIEW
        </div>
      </div>

      {status.kind !== "idle" ? <ActionStatus status={status} statusRef={statusRef} /> : null}

      <div className="border border-[#33ccbb]/35 bg-[#0e1a17] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[9px] font-black tracking-[0.16em] text-[#73e9dc]">
              ACTIVATION CHECKPOINT
            </p>
            <h3 className="mt-1 text-lg font-black">
              {errorCount > 0 ? "Resolve mapping errors first" : "Ready to activate this draft"}
            </h3>
          </div>
          <span className="shrink-0 border border-[#33ccbb]/30 bg-[#33ccbb]/10 px-2 py-1 font-mono text-[10px] font-black tracking-[0.1em] text-[#73e9dc]">
            {changes.length} {changes.length === 1 ? "CHANGE" : "CHANGES"}
          </span>
        </div>
        <dl className="mt-4 grid gap-px bg-white/10 sm:grid-cols-2 xl:grid-cols-4">
          <div className="min-w-0 bg-[#0a1210] p-3">
            <dt className="font-mono text-[9px] font-black tracking-[0.12em] text-white/40">
              CURRENT SOURCE
            </dt>
            <dd className="mt-1 break-words text-xs font-bold text-white/75">
              {isLegacy
                ? "Legacy Settings tab"
                : activeRevisionId === null
                  ? "No active web revision"
                  : `Web revision ${activeRevisionId.slice(0, 8)}`}
            </dd>
          </div>
          <div className="min-w-0 bg-[#0a1210] p-3">
            <dt className="font-mono text-[9px] font-black tracking-[0.12em] text-white/40">
              DRAFT MAPPINGS
            </dt>
            <dd className="mt-1 break-words text-xs font-bold text-white/75">
              {configuration === null ? "Unavailable" : `${mappingCount} configured ranges`}
            </dd>
          </div>
          <div className="min-w-0 bg-[#0a1210] p-3">
            <dt className="font-mono text-[9px] font-black tracking-[0.12em] text-white/40">
              SAMPLE CHECK
            </dt>
            <dd className="mt-1 break-words text-xs font-bold text-white/75">
              {changes.length === 0
                ? "No changed mappings"
                : sampleTargetCount === 0
                  ? "No changed mapping has a current range"
                  : sampleTargetCount > activationSampleInitialTargetLimit
                    ? `${initialSampleTargetCount} of ${sampleTargetCount} changed mappings sampled initially`
                    : `${sampleTargetCount} changed ${sampleTargetCount === 1 ? "mapping" : "mappings"} sampled below`}
            </dd>
          </div>
          <div className="min-w-0 bg-[#0a1210] p-3">
            <dt className="font-mono text-[9px] font-black tracking-[0.12em] text-white/40">
              EXPECTED OUTCOME
            </dt>
            <dd className="mt-1 break-words text-xs font-bold text-white/75">
              {isLegacy ? "Web revision becomes active" : "Draft becomes active"}
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-sm leading-relaxed text-white/75">{summary}</p>
        <p className="mt-2 text-xs leading-relaxed text-[#8fbab4]">
          Changed mappings are sampled below when available. The first{" "}
          {activationSampleInitialTargetLimit} load automatically; remaining mappings can be read on
          demand. A sample checks that mapping only; it does not prove the rest of its group.
        </p>
      </div>

      {configuration !== null ? (
        <ActivationSampleData
          workspaceId={workspaceId}
          configuration={configuration}
          changes={changes}
        />
      ) : null}

      {changes.length === 0 ? (
        <div className="border border-white/10 bg-[#0a1210] p-4 text-sm leading-relaxed text-white/60">
          No values differ from the current configuration. Activating this draft will still create a
          new audit checkpoint.
        </div>
      ) : (
        <details className="border border-white/10 bg-[#0a1210]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-black text-white/80 marker:hidden">
            <span>Technical details</span>
            <span className="flex items-center gap-2 font-mono text-[10px] text-white/45">
              {changes.length} {changes.length === 1 ? "change" : "changes"}
              <ChevronDown className="h-4 w-4" />
            </span>
          </summary>
          <div className="space-y-2 border-t border-white/10 p-3">
            {groups.map((group) => (
              <details key={group.id} className="border border-white/10 bg-[#0a1210]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-black text-white/80 marker:hidden">
                  <span>{group.label}</span>
                  <span className="flex items-center gap-2 font-mono text-[10px] text-white/45">
                    {group.changes.length} {group.changes.length === 1 ? "mapping" : "mappings"}
                    <ChevronDown className="h-4 w-4" />
                  </span>
                </summary>
                <div className="divide-y divide-white/10 border-t border-white/10">
                  {group.changes.map((change) => (
                    <details key={change.path} className="group/change p-4">
                      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 marker:hidden">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-black text-white/80">
                            {change.label}
                          </span>
                          <span className="mt-1 block text-[10px] text-white/40">
                            {change.kind === "added"
                              ? "New value"
                              : change.kind === "removed"
                                ? "Removed value"
                                : "Updated value"}
                          </span>
                        </span>
                        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-white/35 transition group-open/change:rotate-180" />
                      </summary>
                      <div className="mt-3 space-y-3 border-t border-white/10 pt-3">
                        <p className="break-all font-mono text-[10px] text-white/35">
                          Technical path: {change.path}
                        </p>
                        <div className="grid items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
                          <DiffValue
                            label="Before"
                            value={change.before}
                            muted={change.kind === "added"}
                          />
                          <ArrowRight className="mx-auto h-4 w-4 rotate-90 text-white/30 sm:rotate-0" />
                          <DiffValue
                            label="After"
                            value={change.after}
                            muted={change.kind === "removed"}
                          />
                        </div>
                        <button
                          type="button"
                          className={smallButton}
                          onClick={() => onEdit(change.path)}
                        >
                          EDIT MAPPING
                        </button>
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </details>
      )}

      {errorCount > 0 ? (
        <p className="border border-[#ff7b72]/25 bg-[#251412] px-4 py-3 text-xs font-bold leading-relaxed text-[#ffb5ae]">
          Resolve {errorCount} mapping {errorCount === 1 ? "error" : "errors"} in the editor before
          activating this revision.
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 border-t border-white/10 pt-4 sm:flex-row sm:justify-end">
        <button
          type="button"
          className={secondaryButton}
          onClick={onCancel}
          disabled={busy !== undefined}
        >
          BACK TO EDITOR
        </button>
        <button
          type="button"
          className={primaryButton}
          disabled={busy !== undefined || errorCount > 0}
          onClick={onConfirm}
        >
          {busy === "Activate configuration" ? (
            <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          ACTIVATE DRAFT
        </button>
      </div>
    </section>
  );
}

const activationSampleWindowFor = (range: Range | undefined): SheetSnapshotWindow => {
  if (range === undefined) {
    return { startRow: 0, startColumn: 0, rowCount: 4, columnCount: 4 };
  }
  const rowCount =
    range.endRow === "sheet-end" ? 4 : Math.max(1, Math.min(4, range.endRow - range.startRow));
  const columnCount = Math.max(1, Math.min(8, range.endColumn - range.startColumn));
  return {
    startRow: range.startRow,
    startColumn: range.startColumn,
    rowCount,
    columnCount,
  };
};

const activationSampleInitialTargetLimit = 8;

const activationSampleRowsFor = (cells: ReadonlyMap<string, string>, window: SheetSnapshotWindow) =>
  Array.from({ length: window.rowCount }, (_, rowOffset) => {
    const values = Array.from({ length: window.columnCount }, (_, columnOffset) => {
      const key =
        String(window.startRow + rowOffset) + ":" + String(window.startColumn + columnOffset);
      return cells.get(key) ?? "";
    });
    return { rowNumber: window.startRow + rowOffset + 1, cells: values };
  })
    .filter(({ cells: row }) => row.some((cell) => cell.trim().length > 0))
    .slice(0, 3);

function activationSampleTargetsFor(
  configuration: Configuration,
  changes: ReadonlyArray<ConfigurationChange>,
): ReadonlyArray<RangeTarget> {
  const targets = configurationRanges(configuration);
  return targets.filter((target) =>
    // fallow-ignore-next-line complexity
    changes.some((change) => {
      if (configurationPathsRelated(change.path, target.path)) return true;
      const entryMatch = /^(teams|schedules)\[([0-9]+)\]/u.exec(change.path);
      const targetEntry = entryMatch === null ? undefined : `${entryMatch[1]}[${entryMatch[2]}]`;
      if (targetEntry !== undefined && target.path.startsWith(`${targetEntry}.`)) {
        return change.path.endsWith(".sheetId");
      }
      if (!change.path.endsWith(".kind")) return false;
      return configurationPathsRelated(change.path.slice(0, -".kind".length), target.path);
    }),
  );
}

const formatFetchedAt = (epochMs: number | undefined): string => {
  if (epochMs === undefined) return "";
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? "" : `As of ${date.toISOString().slice(11, 19)} UTC`;
};

const activationSampleCellsFor = (
  cells:
    | ReadonlyArray<{
        readonly row: number;
        readonly column: number;
        readonly formattedValue: string;
      }>
    | undefined,
): ReadonlyMap<string, string> =>
  new Map(
    (cells ?? []).map((cell) => [
      String(cell.row) + ":" + String(cell.column),
      cell.formattedValue,
    ]),
  );

const activationSampleTabFor = (
  tabs: ReadonlyArray<SheetSnapshotTab>,
  sheetId: number,
  snapshotTab: SheetSnapshotTab | undefined,
): SheetSnapshotTab | undefined =>
  tabs.find((candidate) => candidate.sheetId === sheetId) ?? snapshotTab;

const activationSampleFailureFor = (tabsFailed: boolean, snapshotFailed: boolean): boolean =>
  tabsFailed || snapshotFailed;

const activationSampleRangeLabelFor = (tab: SheetSnapshotTab | undefined, range: Range): string =>
  tab === undefined
    ? `Sheet ID ${range.sheetId} · ${columnLabel(range.startColumn)}${range.startRow + 1}:${columnLabel(range.endColumn - 1)}${range.endRow === "sheet-end" ? "" : range.endRow}`
    : (formatSheetRangeOption(tab.title, range) ?? formatDiffRange(range));

const activationSampleStatusTextFor = (
  previewFailure: boolean,
  previewLoading: boolean,
  hasSnapshot: boolean,
): string =>
  previewFailure
    ? hasSnapshot
      ? "LAST AVAILABLE"
      : "UNAVAILABLE"
    : previewLoading
      ? "READING SAMPLE"
      : "LIVE SAMPLE";

const activationSampleLoadingFor = (
  previewFailure: boolean,
  tabsWaiting: boolean,
  snapshotWaiting: boolean,
  hasSnapshot: boolean,
): boolean => !previewFailure && (tabsWaiting || snapshotWaiting || !hasSnapshot);

const activationSampleCoverageLabelFor = (sampleTargets: ReadonlyArray<RangeTarget>): string =>
  sampleTargets.length === 0
    ? "No changed mapping has a current candidate range."
    : sampleTargets.length <= activationSampleInitialTargetLimit
      ? `${sampleTargets.length} changed ${sampleTargets.length === 1 ? "mapping is" : "mappings are"} sampled below.`
      : `The first ${activationSampleInitialTargetLimit} of ${sampleTargets.length} changed mappings are sampled initially.`;

type ActivationSampleCoverage = {
  readonly id: Exclude<ConfigurationChangeGroupId, "workspace">;
  readonly label: string;
  readonly rangeLabels: ReadonlyArray<string>;
  readonly configuredRangeCount: number;
};

const activationSampleCoverageFor = (
  configuration: Configuration,
  affectedGroupIds: ReadonlyArray<Exclude<ConfigurationChangeGroupId, "workspace">>,
  sampleTargets: ReadonlyArray<RangeTarget>,
): ReadonlyArray<ActivationSampleCoverage> => {
  const targets = configurationRanges(configuration);
  return affectedGroupIds.map((id) => ({
    id,
    label: configurationChangeGroupLabelFor(id),
    rangeLabels: targets
      .filter(
        (target) =>
          configurationChangeGroupFor(target.path) === id &&
          sampleTargets.some((sampleTarget) => sampleTarget.path === target.path),
      )
      .map((target) => target.label),
    configuredRangeCount: targets.filter(
      (target) => configurationChangeGroupFor(target.path) === id,
    ).length,
  }));
};

const activationSampleSelectionFor = (
  configuration: Configuration,
  changes: ReadonlyArray<ConfigurationChange>,
):
  | {
      readonly sampleTargets: ReadonlyArray<RangeTarget>;
      readonly coverageLabel: string;
    }
  | undefined => {
  const sampleTargets = activationSampleTargetsFor(configuration, changes);
  if (sampleTargets.length === 0) return undefined;
  return {
    sampleTargets,
    coverageLabel: activationSampleCoverageLabelFor(sampleTargets),
  };
};

const activationSampleFetchedAtFor = (
  snapshot: SheetsReadSnapshotSuccess | undefined,
  tabsResult: ReturnType<typeof useSheetDescriptionResult>,
): number | undefined =>
  snapshot?.windowFetchedAtEpochMs ?? resultValue(tabsResult)?.metadataFetchedAtEpochMs;

function ActivationSampleData({
  workspaceId,
  configuration,
  changes,
}: {
  readonly workspaceId: string;
  readonly configuration: Configuration;
  readonly changes: ReadonlyArray<ConfigurationChange>;
}) {
  const selection = activationSampleSelectionFor(configuration, changes);
  if (selection === undefined) {
    return (
      <section className="border border-white/10 bg-[#0a1210] p-4" aria-label="Sample check">
        <p className="font-mono text-[9px] font-black tracking-[0.16em] text-[#73e9dc]">
          SAMPLE CHECK
        </p>
        <p className="mt-2 text-sm font-bold text-white/80">
          No changed sheet mapping is available to sample.
        </p>
        <p className="mt-1 text-xs leading-relaxed text-[#8fbab4]">
          The changed values are structural or remove a mapping. Review them below; activation will
          use the complete candidate configuration.
        </p>
      </section>
    );
  }
  const coverage = activationSampleCoverageFor(
    configuration,
    changedMappingGroupIdsFor(changes),
    selection.sampleTargets,
  );
  return (
    <ActivationSamplePreview
      workspaceId={workspaceId}
      spreadsheetId={configuration.spreadsheetId}
      sampleTargets={selection.sampleTargets}
      coverageLabel={selection.coverageLabel}
      coverage={coverage}
    />
  );
}

function ActivationSamplePreview({
  workspaceId,
  spreadsheetId,
  sampleTargets,
  coverageLabel,
  coverage,
}: {
  readonly workspaceId: string;
  readonly spreadsheetId: string;
  readonly sampleTargets: ReadonlyArray<RangeTarget>;
  readonly coverageLabel: string;
  readonly coverage: ReadonlyArray<ActivationSampleCoverage>;
}) {
  return (
    <ActivationSampleTabs
      workspaceId={workspaceId}
      spreadsheetId={spreadsheetId}
      sampleTargets={sampleTargets}
      coverageLabel={coverageLabel}
      coverage={coverage}
    />
  );
}

function ActivationSampleTabs({
  workspaceId,
  spreadsheetId,
  sampleTargets,
  coverageLabel,
  coverage,
}: {
  readonly workspaceId: string;
  readonly spreadsheetId: string;
  readonly sampleTargets: ReadonlyArray<RangeTarget>;
  readonly coverageLabel: string;
  readonly coverage: ReadonlyArray<ActivationSampleCoverage>;
}) {
  const tabsResult = useSheetDescriptionResult({
    workspaceId,
    spreadsheetId,
    readPolicy: "fresh",
    refreshKey: "activation-review",
  });
  const tabs = resultValue(tabsResult)?.tabs ?? [];
  return (
    <ActivationSampleSnapshotList
      workspaceId={workspaceId}
      spreadsheetId={spreadsheetId}
      sampleTargets={sampleTargets}
      coverageLabel={coverageLabel}
      coverage={coverage}
      tabs={tabs}
      tabsResult={tabsResult}
    />
  );
}

function ActivationSampleStatus({
  previewFailure,
  statusText,
  fetchedAt,
}: {
  readonly previewFailure: boolean;
  readonly statusText: string;
  readonly fetchedAt: string;
}) {
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <span
        className={
          previewFailure
            ? "border border-[#ffb86c]/30 bg-[#1a1710] px-2 py-1 font-mono text-[9px] font-black tracking-[0.12em] text-[#ffcf91]"
            : "border border-[#33ccbb]/30 bg-[#33ccbb]/10 px-2 py-1 font-mono text-[9px] font-black tracking-[0.12em] text-[#73e9dc]"
        }
        role={previewFailure ? "status" : undefined}
        aria-live="polite"
      >
        {statusText}
      </span>
      {fetchedAt ? <span className="font-mono text-[9px] text-[#8fbab4]">{fetchedAt}</span> : null}
    </div>
  );
}

// fallow-ignore-next-line complexity
function ActivationSampleSnapshotList({
  workspaceId,
  spreadsheetId,
  sampleTargets,
  coverageLabel,
  coverage,
  tabs,
  tabsResult,
}: {
  readonly workspaceId: string;
  readonly spreadsheetId: string;
  readonly sampleTargets: ReadonlyArray<RangeTarget>;
  readonly coverageLabel: string;
  readonly coverage: ReadonlyArray<ActivationSampleCoverage>;
  readonly tabs: ReadonlyArray<SheetSnapshotTab>;
  readonly tabsResult: ReturnType<typeof useSheetDescriptionResult>;
}) {
  const sampleTargetKey = sampleTargets.map((target) => target.path).join("\u0000");
  const [showAllTargets, setShowAllTargets] = useState(false);
  useEffect(() => setShowAllTargets(false), [sampleTargetKey]);
  const visibleSampleTargets = showAllTargets
    ? sampleTargets
    : sampleTargets.slice(0, activationSampleInitialTargetLimit);
  const remainingTargetCount = sampleTargets.length - visibleSampleTargets.length;
  const previewFailure = AsyncResult.isFailure(tabsResult);
  const previewLoading = tabsResult.waiting || !resultValue(tabsResult);
  const statusText = previewFailure
    ? "UNAVAILABLE"
    : previewLoading
      ? "READING MAPPINGS"
      : `${visibleSampleTargets.length} of ${sampleTargets.length} MAPPINGS TO REVIEW`;
  const fetchedAt = formatFetchedAt(resultValue(tabsResult)?.metadataFetchedAtEpochMs);
  return (
    <section
      className="border border-[#33ccbb]/25 bg-[#0e1a17] p-4"
      aria-labelledby="activation-sample-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[9px] font-black tracking-[0.16em] text-[#73e9dc]">
            SAMPLE CHECK
          </p>
          <h3 id="activation-sample-title" className="mt-1 text-lg font-black">
            Preflight every changed mapping
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-white/55">
            Read fresh samples for changed mappings before activation. The first{" "}
            {activationSampleInitialTargetLimit} load automatically; remaining mappings can be read
            on demand. A sample checks that mapping only; it does not prove the rest of its group.
          </p>
        </div>
        <ActivationSampleStatus
          previewFailure={previewFailure}
          statusText={statusText}
          fetchedAt={fetchedAt}
        />
      </div>
      <ActivationSampleCoverageList coverage={coverage} />
      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        {visibleSampleTargets.map((sampleTarget) => (
          <ActivationSampleSnapshot
            key={sampleTarget.path}
            workspaceId={workspaceId}
            spreadsheetId={spreadsheetId}
            sampleTarget={sampleTarget}
            tabs={tabs}
            tabsResult={tabsResult}
          />
        ))}
      </div>
      {remainingTargetCount > 0 ? (
        <button
          type="button"
          className={`${smallButton} mt-3 w-full justify-center sm:w-auto`}
          onClick={() => setShowAllTargets(true)}
        >
          READ REMAINING {remainingTargetCount} MAPPINGS
        </button>
      ) : null}
      <p className="mt-3 text-[10px] leading-relaxed text-white/50">
        {coverageLabel} Activation still uses the full candidate configuration. Samples are
        read-only and limited to the visible window.
      </p>
    </section>
  );
}

function ActivationSampleSnapshot({
  workspaceId,
  spreadsheetId,
  sampleTarget,
  tabs,
  tabsResult,
}: {
  readonly workspaceId: string;
  readonly spreadsheetId: string;
  readonly sampleTarget: RangeTarget;
  readonly tabs: ReadonlyArray<SheetSnapshotTab>;
  readonly tabsResult: ReturnType<typeof useSheetDescriptionResult>;
}) {
  const sampleRange = sampleTarget.range;
  const sampleWindow = useMemo(
    () => activationSampleWindowFor(sampleRange),
    [sampleRange.endColumn, sampleRange.endRow, sampleRange.startColumn, sampleRange.startRow],
  );
  const selectedSheetId = sampleTarget.range.sheetId;
  const snapshotResult = useSheetSnapshotResult({
    workspaceId,
    spreadsheetId,
    sheetId: selectedSheetId,
    window: sampleWindow,
    readPolicy: "fresh",
    refreshKey: "activation-review",
  });
  return (
    <ActivationSampleSnapshotResult
      sampleTarget={sampleTarget}
      sampleWindow={sampleWindow}
      tabs={tabs}
      tabsResult={tabsResult}
      snapshotResult={snapshotResult}
    />
  );
}

function ActivationSampleSnapshotResult({
  sampleTarget,
  sampleWindow,
  tabs,
  tabsResult,
  snapshotResult,
}: {
  readonly sampleTarget: RangeTarget;
  readonly sampleWindow: SheetSnapshotWindow;
  readonly tabs: ReadonlyArray<SheetSnapshotTab>;
  readonly tabsResult: ReturnType<typeof useSheetDescriptionResult>;
  readonly snapshotResult: ReturnType<typeof useSheetSnapshotResult>;
}) {
  const snapshot = resultValue(snapshotResult);
  const sampleTab = activationSampleTabFor(tabs, sampleTarget.range.sheetId, snapshot?.tab);
  const sampleCells = activationSampleCellsFor(snapshot?.cells);
  const sampleRows = activationSampleRowsFor(sampleCells, sampleWindow);
  const previewFailure = activationSampleFailureFor(
    AsyncResult.isFailure(tabsResult),
    AsyncResult.isFailure(snapshotResult),
  );
  const previewLoading = activationSampleLoadingFor(
    previewFailure,
    tabsResult.waiting,
    snapshotResult.waiting,
    snapshot !== undefined,
  );
  const fetchedAtEpochMs = activationSampleFetchedAtFor(snapshot, tabsResult);
  return (
    <ActivationSampleCard
      rangeLabel={activationSampleRangeLabelFor(sampleTab, sampleTarget.range)}
      sampleTarget={sampleTarget}
      sampleRows={sampleRows}
      sampleWindow={sampleWindow}
      previewFailure={previewFailure}
      previewLoading={previewLoading}
      fetchedAtEpochMs={fetchedAtEpochMs}
      statusText={activationSampleStatusTextFor(
        previewFailure,
        previewLoading,
        snapshot !== undefined,
      )}
    />
  );
}

function ActivationSampleCard({
  rangeLabel,
  sampleTarget,
  sampleRows,
  sampleWindow,
  previewFailure,
  previewLoading,
  fetchedAtEpochMs,
  statusText,
}: {
  readonly rangeLabel: string;
  readonly sampleTarget: RangeTarget;
  readonly sampleRows: ReadonlyArray<{
    readonly rowNumber: number;
    readonly cells: ReadonlyArray<string>;
  }>;
  readonly sampleWindow: SheetSnapshotWindow;
  readonly previewFailure: boolean;
  readonly previewLoading: boolean;
  readonly fetchedAtEpochMs: number | undefined;
  readonly statusText: string;
}) {
  const fetchedAt = formatFetchedAt(fetchedAtEpochMs);
  return (
    <article className="border border-white/10 bg-[#0a1210] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[9px] font-black tracking-[0.16em] text-[#73e9dc]">
            CHANGED MAPPING
          </p>
          <h4 className="mt-1 text-base font-black">{sampleTarget.label}</h4>
          <p className="mt-1 text-xs leading-relaxed text-white/55">
            Fresh read-only data for this changed mapping. Other mappings are not covered by this
            sample.
          </p>
        </div>
        <ActivationSampleStatus
          previewFailure={previewFailure}
          statusText={statusText}
          fetchedAt={fetchedAt}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border border-white/10 bg-[#08100e] px-3 py-2">
        <span className="text-xs font-bold text-white/75">{sampleTarget.label}</span>
        <span className="text-white/25">·</span>
        <code className="min-w-0 truncate text-[11px] text-[#9ef4e8]">{rangeLabel}</code>
        <span className="ml-auto text-right text-[10px] text-[#8fbab4]">
          {sampleTarget.expected}
        </span>
      </div>
      <ActivationSampleContent
        sampleTarget={sampleTarget}
        sampleRows={sampleRows}
        sampleWindow={sampleWindow}
        previewFailure={previewFailure}
        previewLoading={previewLoading}
      />
    </article>
  );
}

function ActivationSampleCoverageList({
  coverage,
}: {
  readonly coverage: ReadonlyArray<ActivationSampleCoverage>;
}) {
  return (
    <div
      className="mt-3 border border-white/10 bg-[#08100e] p-3"
      aria-label="Changed mapping coverage"
    >
      <p className="font-mono text-[9px] font-black tracking-[0.14em] text-[#8fbab4]">
        CHANGED MAPPING COVERAGE
      </p>
      <p className="mt-1 text-[10px] leading-relaxed text-[#8fbab4]">
        Every changed mapping with a current candidate range is listed below.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {/* fallow-ignore-next-line complexity */}
        {coverage.map((group) => {
          const status = group.rangeLabels.length > 0 ? "SAMPLE INCLUDED" : "NO CURRENT RANGE";
          const statusClass =
            group.rangeLabels.length > 0
              ? "border-[#33ccbb]/25 bg-[#33ccbb]/10 text-[#73e9dc]"
              : "border-[#ffb86c]/25 bg-[#1a1710] text-[#ffcf91]";
          return (
            <div key={group.id} className="border border-white/10 bg-[#0a1210] p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-black text-white/80">{group.label}</p>
                <span
                  className={`shrink-0 border px-1.5 py-0.5 font-mono text-[8px] font-black tracking-[0.1em] ${statusClass}`}
                >
                  {status}
                </span>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-[#8fbab4]">
                {group.rangeLabels.length} changed{" "}
                {group.rangeLabels.length === 1 ? "mapping" : "mappings"} included ·{" "}
                {group.configuredRangeCount} configured total
              </p>
              <p className="mt-1 truncate font-mono text-[10px] text-white/70">
                {group.rangeLabels.length > 0
                  ? group.rangeLabels.join(" · ")
                  : "No current range to sample; review the structural change below"}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActivationSampleContent({
  sampleTarget,
  sampleRows,
  sampleWindow,
  previewFailure,
  previewLoading,
}: {
  readonly sampleTarget: RangeTarget;
  readonly sampleRows: ReadonlyArray<{
    readonly rowNumber: number;
    readonly cells: ReadonlyArray<string>;
  }>;
  readonly sampleWindow: SheetSnapshotWindow;
  readonly previewFailure: boolean;
  readonly previewLoading: boolean;
}) {
  if (previewLoading) {
    return (
      <p className="mt-3 text-xs text-[#8fbab4]" role="status" aria-live="polite">
        Reading a small, read-only sample…
      </p>
    );
  }
  if (sampleRows.length > 0) {
    return (
      <ActivationSampleTable
        sampleTarget={sampleTarget}
        sampleRows={sampleRows}
        sampleWindow={sampleWindow}
      />
    );
  }
  if (previewFailure) {
    return (
      <p className="mt-3 border border-[#ffb86c]/25 bg-[#1a1710] px-3 py-2 text-xs leading-relaxed text-[#ffcf91]">
        The sample is unavailable. Check sheet sharing and tab access before activating, then return
        to the editor to retry the preview.
      </p>
    );
  }
  return (
    <p className="mt-3 border border-white/10 bg-[#08100e] px-3 py-2 text-xs leading-relaxed text-white/55">
      The sheet responded, but this sample window has no populated values yet.
    </p>
  );
}

function ActivationSampleTable({
  sampleTarget,
  sampleRows,
  sampleWindow,
}: {
  readonly sampleTarget: RangeTarget;
  readonly sampleRows: ReadonlyArray<{
    readonly rowNumber: number;
    readonly cells: ReadonlyArray<string>;
  }>;
  readonly sampleWindow: SheetSnapshotWindow;
}) {
  return (
    <div className="mt-3 overflow-x-auto border border-white/10">
      <table className="w-full min-w-[28rem] border-collapse text-left text-[11px]">
        <caption className="sr-only">Sample values from {sampleTarget.label}</caption>
        <thead className="bg-[#101b18] font-mono text-[9px] font-black tracking-[0.12em] text-[#8fbab4]">
          <tr>
            <th scope="col" className="border-b border-r border-white/10 px-3 py-2">
              ROW
            </th>
            {Array.from({ length: sampleWindow.columnCount }, (_, column) => (
              <th key={column} scope="col" className="border-b border-r border-white/10 px-3 py-2">
                {columnLabel(sampleWindow.startColumn + column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sampleRows.map((row) => (
            <tr key={row.rowNumber} className="bg-[#0a1210]">
              <th
                scope="row"
                className="border-b border-r border-white/10 px-3 py-2 font-mono font-normal text-[#8fbab4]"
              >
                {row.rowNumber}
              </th>
              {row.cells.map((value, column) => (
                <td
                  key={column}
                  className="max-w-[16rem] border-b border-r border-white/10 px-3 py-2 text-white/75"
                >
                  {value || "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-white/10 bg-[#08100e] px-3 py-2 text-[10px] text-[#8fbab4]">
        Showing up to 3 non-empty rows from the read window. Blank rows are omitted.
      </p>
    </div>
  );
}

function DiffValue({
  label,
  value,
  muted,
}: {
  readonly label: string;
  readonly value: string;
  readonly muted: boolean;
}) {
  return (
    <div
      className={`min-w-0 border px-3 py-2 ${muted ? "border-white/10 bg-[#08100e]" : "border-[#33ccbb]/20 bg-[#0e1a17]"}`}
    >
      <p className="font-mono text-[9px] font-black tracking-[0.14em] text-white/35">{label}</p>
      <p
        className={`mt-1 break-words font-mono text-xs ${muted ? "text-white/35" : "text-[#9ef4e8]"}`}
      >
        {value}
      </p>
    </div>
  );
}

type RangeMobileStep = "fields" | "grid";
type SheetTabsStatus = "loading" | "error" | "ready";
type PendingRangeState = { readonly dirty: boolean; readonly invalid: boolean };
type GridSelection = {
  readonly startRow: number;
  readonly startColumn: number;
  readonly endRow: number;
  readonly endColumn: number;
};
type Status =
  | { readonly kind: "idle" }
  | { readonly kind: "success" | "error"; readonly message: string };

const cleanPendingRangeState: PendingRangeState = { dirty: false, invalid: false };
const pendingRangeErrorMessage = "Apply or clear the staged range before choosing another field.";

function ActionStatus({
  status,
  statusRef,
}: {
  readonly status: Exclude<Status, { readonly kind: "idle" }>;
  readonly statusRef: { readonly current: HTMLDivElement | null };
}) {
  return (
    <div
      ref={statusRef}
      tabIndex={-1}
      role={status.kind === "error" ? "alert" : "status"}
      aria-live="polite"
      className={`min-w-0 max-w-full break-words border px-3 py-2 text-xs ${status.kind === "error" ? "border-[#ff7b72]/30 bg-[#ff7b72]/10 text-[#ffb5ae]" : "border-[#33ccbb]/25 bg-[#33ccbb]/10 text-[#9ef4e8]"}`}
    >
      {status.message}
    </div>
  );
}

type EditorLifecycleStage = "current" | "draft" | "saved" | "active";

type EditorLifecycleStageDefinition = {
  readonly id: EditorLifecycleStage;
  readonly label: string;
  readonly shortLabel: string;
};

const editorLifecycleStages: ReadonlyArray<EditorLifecycleStageDefinition> = [
  { id: "current", label: "Current source", shortLabel: "Current" },
  { id: "draft", label: "Draft in progress", shortLabel: "Draft" },
  { id: "saved", label: "Saved draft", shortLabel: "Saved" },
  { id: "active", label: "Active", shortLabel: "Active" },
];

const editorLifecycleStageIndexFor = (stage: EditorLifecycleStage): number =>
  editorLifecycleStages.findIndex(({ id }) => id === stage);

const editorLifecycleStageFor = ({
  hasDraft,
  dirty,
  draftIsActive,
}: {
  readonly hasDraft: boolean;
  readonly dirty: boolean;
  readonly draftIsActive: boolean;
}): EditorLifecycleStage =>
  (
    [
      [dirty, "draft"],
      [draftIsActive, "active"],
      [hasDraft, "saved"],
    ] as const
  ).find(([condition]) => condition)?.[1] ?? "current";

const editorLifecycleMessageFor = ({
  isLegacy,
  legacySourceChanged,
  hasDraft,
  dirty,
  hasPendingEditorState,
  draftIsActive,
}: {
  readonly isLegacy: boolean;
  readonly legacySourceChanged: boolean;
  readonly hasDraft: boolean;
  readonly dirty: boolean;
  readonly hasPendingEditorState: boolean;
  readonly draftIsActive: boolean;
}): string => {
  const stage = editorLifecycleStageFor({
    hasDraft,
    dirty,
    draftIsActive,
  });
  if (legacySourceChanged) {
    return "Legacy source needs re-binding · import is paused until the source is restored.";
  }
  if (hasPendingEditorState) return "Pending edit · finish or clear it before saving.";
  const messages: Record<EditorLifecycleStage, string> = {
    current: "Current source · import or create a draft to begin.",
    draft: "Draft in progress · save it to persist your changes.",
    saved: isLegacy
      ? "Saved draft · the legacy source remains active until activation."
      : "Saved draft · review changes before activation.",
    active: "Active · this saved draft is live.",
  };
  return messages[stage];
};

type EditorLifecycleStepState = "complete" | "current" | "upcoming";

const editorLifecycleStepStateFor = (
  index: number,
  currentStageIndex: number,
): EditorLifecycleStepState => {
  if (index < currentStageIndex) return "complete";
  if (index === currentStageIndex) return "current";
  return "upcoming";
};

const editorLifecycleStepStyles: Record<
  EditorLifecycleStepState,
  { readonly progressClass: string; readonly labelClass: string }
> = {
  complete: {
    progressClass: "bg-[#33ccbb]/45",
    labelClass: "text-white/50",
  },
  current: {
    progressClass: "bg-[#33ccbb]",
    labelClass: "text-[#9ef4e8]",
  },
  upcoming: {
    progressClass: "bg-white/15",
    labelClass: "text-white/30",
  },
};

function EditorLifecycleStep({
  stage,
  index,
  currentStageIndex,
}: {
  readonly stage: EditorLifecycleStageDefinition;
  readonly index: number;
  readonly currentStageIndex: number;
}) {
  const state = editorLifecycleStepStateFor(index, currentStageIndex);
  const styles = editorLifecycleStepStyles[state];
  return (
    <div className="min-w-0" aria-current={state === "current" ? "step" : undefined}>
      <div className={`h-1 ${styles.progressClass}`} />
      <p
        className={`mt-1 truncate font-mono text-[9px] font-black tracking-[0.08em] sm:text-[10px] sm:tracking-[0.12em] ${styles.labelClass}`}
      >
        <span className="sm:hidden">{stage.shortLabel}</span>
        <span className="hidden sm:inline">{stage.label}</span>
      </p>
    </div>
  );
}

function EditorLifecycle({
  isLegacy,
  legacySourceChanged,
  hasDraft,
  dirty,
  hasPendingEditorState,
  draftIsActive,
}: {
  readonly isLegacy: boolean;
  readonly legacySourceChanged: boolean;
  readonly hasDraft: boolean;
  readonly dirty: boolean;
  readonly hasPendingEditorState: boolean;
  readonly draftIsActive: boolean;
}) {
  const currentStage = editorLifecycleStageFor({
    hasDraft,
    dirty,
    draftIsActive,
  });
  const currentStageIndex = editorLifecycleStageIndexFor(currentStage);

  return (
    <div
      className="min-w-0 flex-1"
      aria-label={`Configuration lifecycle: ${editorLifecycleStages[currentStageIndex]?.label ?? "Current source"}`}
    >
      <div className="grid grid-cols-4 gap-1">
        {editorLifecycleStages.map((stage, index) => (
          <EditorLifecycleStep
            key={stage.id}
            stage={stage}
            index={index}
            currentStageIndex={currentStageIndex}
          />
        ))}
      </div>
      <p className="mt-1 truncate text-[10px] leading-relaxed text-[#8fbab4] sm:text-[11px]">
        {editorLifecycleMessageFor({
          isLegacy,
          legacySourceChanged,
          hasDraft,
          dirty,
          hasPendingEditorState,
          draftIsActive,
        })}
      </p>
    </div>
  );
}

// Source state is deliberately rendered as a compact, high-signal status badge.
// fallow-ignore-next-line complexity
function SourceBadge({
  isLegacy,
  legacySourceChanged,
  revisionId,
}: {
  readonly isLegacy: boolean;
  readonly legacySourceChanged: boolean;
  readonly revisionId: string | null;
}) {
  const sourceNeedsRebind = isLegacy && legacySourceChanged;
  return (
    <div
      className={`flex items-center gap-2 border px-3 py-2 font-mono text-[10px] font-black tracking-[0.12em] ${sourceNeedsRebind ? "border-[#ff7b72]/40 bg-[#ff7b72]/10 text-[#ffb5ae]" : isLegacy ? "border-[#ffb86c]/30 bg-[#ffb86c]/10 text-[#ffcf91]" : "border-[#33ccbb]/30 bg-[#33ccbb]/10 text-[#73e9dc]"}`}
    >
      <span
        className={`h-2 w-2 ${sourceNeedsRebind ? "bg-[#ff7b72]" : isLegacy ? "bg-[#ffb86c]" : "bg-[#33ccbb]"}`}
      />
      <span className="sm:hidden">
        {sourceNeedsRebind
          ? "LEGACY · REBIND"
          : isLegacy
            ? "CURRENT · LEGACY"
            : revisionId
              ? "ACTIVE"
              : "SAVED DRAFT"}
      </span>
      <span className="hidden sm:inline">
        {sourceNeedsRebind
          ? "LEGACY SOURCE · REBIND REQUIRED"
          : isLegacy
            ? "CURRENT SOURCE · LEGACY SETTINGS"
            : revisionId
              ? `ACTIVE · ${revisionId.slice(0, 8)}`
              : "SAVED DRAFT · NOT ACTIVE"}
      </span>
    </div>
  );
}

function StudioNavButton({
  active,
  icon,
  children,
  onClick,
}: {
  readonly active: boolean;
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-2 py-2.5 text-left text-xs font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc] ${active ? "bg-[#33ccbb] text-[#07100e]" : "text-white/55 hover:bg-[#33ccbb]/10 hover:text-white"}`}
    >
      <span className="shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      <span className="truncate">{children}</span>
      {active ? <ChevronRight className="ml-auto h-3 w-3" /> : null}
    </button>
  );
}

function OnboardingStepper({
  isLegacy,
  legacySourceChanged,
  hasDraft,
  dirty,
}: {
  readonly isLegacy: boolean;
  readonly legacySourceChanged: boolean;
  readonly hasDraft: boolean;
  readonly dirty: boolean;
}) {
  const currentStage = editorLifecycleStageFor({ hasDraft, dirty, draftIsActive: false });
  const currentStageIndex = editorLifecycleStageIndexFor(currentStage);
  const nextAction = {
    current: isLegacy
      ? legacySourceChanged
        ? "Rebind the missing legacy Settings tab, then refresh and import the current source."
        : "Import the current Settings tab to create an editable draft."
      : "Enter a spreadsheet ID to create an editable draft.",
    draft: "Edit and apply each mapping, then save the draft.",
    saved: "Review the saved draft before activating it.",
    active: "This draft is active.",
  }[currentStage];

  return (
    <div
      className="border border-[#33ccbb]/20 bg-[#0a1512] p-3 sm:p-4"
      aria-label="Configuration lifecycle"
    >
      <p className="mb-3 font-mono text-[9px] font-black tracking-[0.2em] text-[#8fbab4]">
        CONFIGURATION LIFECYCLE
      </p>
      <div className="grid grid-cols-4 gap-1">
        {editorLifecycleStages.map((stage, index) => (
          <EditorLifecycleStep
            key={stage.id}
            stage={stage}
            index={index}
            currentStageIndex={currentStageIndex}
          />
        ))}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-white/55">
        <span className="font-bold text-white/70">Next:</span> {nextAction}
      </p>
    </div>
  );
}

// Overview keeps source provenance, diagnostics, and destructive actions visible together.
// fallow-ignore-next-line complexity
function OverviewSection({
  state,
  hasDraft,
  isLegacy,
  legacySourceChanged,
  starterSpreadsheetId,
  setStarterSpreadsheetId,
  createStarter,
  importAction,
  busy,
  revisions,
  rollbackAction,
  restoreLegacyAction,
  discardAction,
  diagnostics,
  dirty,
  hasErrors,
  revisionsLoading,
  revisionsUnavailable,
  refreshRevisions,
  onConfigurationChange,
  onPendingInputStateChange,
  onDiagnosticNavigate,
  onEditMappings,
}: {
  readonly state: {
    readonly source: { readonly kind: "legacy" | "owned" };
    readonly configuration: Configuration | null;
    readonly diagnostics: ReadonlyArray<{
      readonly code: string;
      readonly path: string;
      readonly message: string;
      readonly severity: "error" | "warning";
    }>;
    readonly activeRevisionId: string | null;
    readonly draftVersion: number;
    readonly baselineDigest: string | null;
    readonly legacyBinding: LegacyBinding | null;
  };
  readonly hasDraft: boolean;
  readonly isLegacy: boolean;
  readonly legacySourceChanged: boolean;
  readonly starterSpreadsheetId: string;
  readonly setStarterSpreadsheetId: (value: string) => void;
  readonly createStarter: () => void;
  readonly importAction: () => void;
  readonly busy: string | undefined;
  readonly revisions: ReadonlyArray<ConfigurationRevision>;
  readonly rollbackAction: (revision: ConfigurationRevision) => void;
  readonly restoreLegacyAction: () => void;
  readonly discardAction: () => void;
  readonly diagnostics: ReadonlyArray<{
    readonly code: string;
    readonly path: string;
    readonly message: string;
    readonly severity: "error" | "warning";
  }>;
  readonly dirty: boolean;
  readonly hasErrors: boolean;
  readonly revisionsLoading: boolean;
  readonly revisionsUnavailable: boolean;
  readonly refreshRevisions: () => void;
  readonly onConfigurationChange: (configuration: Configuration) => void;
  readonly onPendingInputStateChange: (key: string, message: string | undefined) => void;
  readonly onDiagnosticNavigate: (path: string) => void;
  readonly onEditMappings: () => void;
}) {
  const configuration = state.configuration;
  return (
    <section className="space-y-6 p-5 sm:p-8">
      {state.activeRevisionId === null ? (
        <OnboardingStepper
          isLegacy={isLegacy}
          legacySourceChanged={legacySourceChanged}
          hasDraft={hasDraft}
          dirty={dirty}
        />
      ) : null}

      {isLegacy && legacySourceChanged ? (
        <div className="border border-[#ff7b72]/40 bg-[#1a1110] p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#ff9d94]" />
            <div className="min-w-0">
              <h2 className="text-xl font-black text-[#ffb5ae]">Legacy source needs re-binding</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/60">
                The Settings tab bound to this workspace is no longer available. Import is paused so
                a missing tab cannot be mistaken for the current source.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-white/45">
                Restore or rebind that tab, then refresh this page and import the current source.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {isLegacy && !hasDraft && !legacySourceChanged ? (
        <div className="border border-[#ffb86c]/40 bg-[#1a1710] p-5 sm:p-6">
          <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
            <div className="flex min-w-0 items-start gap-3">
              <CloudDownload className="mt-0.5 h-5 w-5 shrink-0 text-[#ffb86c]" />
              <div className="min-w-0">
                <h2 className="text-xl font-black text-[#ffcf91]">
                  Start by importing the current Settings tab
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/60">
                  Import the legacy Settings tab into an editable draft. This read-only import
                  leaves the current source live and untouched until you activate a revision.
                </p>
                <p className="mt-2 text-xs text-white/40">
                  Next, map ranges, save the draft, and review the activation diff.
                </p>
              </div>
            </div>
            <button
              type="button"
              className={`${primaryButton} shrink-0`}
              disabled={busy !== undefined}
              onClick={importAction}
            >
              <CloudDownload className="h-4 w-4" />
              {busy === "Import legacy settings" ? "IMPORTING" : "IMPORT TO DRAFT"}
            </button>
          </div>
        </div>
      ) : null}

      {configuration === null && !isLegacy ? (
        <div className="border border-dashed border-[#33ccbb]/35 bg-[#0a1512] p-5 sm:p-7">
          <div className="flex items-start gap-4">
            <Sparkles className="mt-1 h-5 w-5 shrink-0 text-[#33ccbb]" />
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-black">Create your first draft</h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/55">
                New workspaces start without a configuration. Enter the spreadsheet ID, then map its
                tabs and ranges. You can inspect the read-only grid before activation.
              </p>
              <div className="mt-5 flex max-w-xl flex-col gap-2 sm:flex-row sm:items-end">
                <label
                  className="min-w-0 flex-1 text-xs font-bold text-white/65"
                  htmlFor="starter-spreadsheet-id"
                >
                  Spreadsheet ID
                  <input
                    id="starter-spreadsheet-id"
                    value={starterSpreadsheetId}
                    onChange={(event) => setStarterSpreadsheetId(event.target.value)}
                    placeholder="Paste a Google Sheets ID"
                    className="studioInput mt-2 w-full"
                  />
                </label>
                <button type="button" className={primaryButton} onClick={createStarter}>
                  <Sparkles className="h-4 w-4" />
                  CREATE DRAFT
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
        <div className="border border-[#33ccbb]/20 bg-[#0e1815] p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2
                className="text-xl font-black outline-none"
                data-configuration-path="configuration"
                tabIndex={-1}
              >
                Draft workspace
              </h2>
              <p className="mt-1 text-xs text-[#8fbab4]">
                Source, spreadsheet, and draft metadata.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <Eye className="h-5 w-5 text-[#33ccbb]" />
              {configuration !== null ? (
                <button type="button" className={smallButton} onClick={onEditMappings}>
                  EDIT MAPPINGS
                </button>
              ) : null}
            </div>
          </div>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/55">
            {isLegacy
              ? legacySourceChanged
                ? "The bound legacy Settings tab is unavailable. Rebind it before importing the current source."
                : hasDraft
                  ? "This draft was imported from the legacy Settings tab. Update its ranges, save the draft, then review it before it becomes the live configuration."
                  : "This workspace currently uses the legacy Settings tab. Import it to create an editable draft; the legacy source stays live until you activate a revision."
              : "This sheet mapping draft controls the runtime reads from Google Sheets."}
          </p>
          {configuration !== null ? (
            <ConfigurationOverviewFields
              configuration={configuration}
              onChange={onConfigurationChange}
              onPendingInputStateChange={onPendingInputStateChange}
            />
          ) : null}
          <div className="mt-5 grid gap-px bg-white/10 sm:grid-cols-3">
            <Metric label="DRAFT VERSION" value={`v${state.draftVersion}`} />
            <Metric
              label="ACTIVE REVISION"
              value={state.activeRevisionId ? state.activeRevisionId.slice(0, 8) : "—"}
            />
            <Metric
              label="MAPPED RANGES"
              value={configuration ? String(configurationRanges(configuration).length) : "—"}
            />
          </div>
          {state.baselineDigest ? (
            <details className="mt-3 border-t border-white/10 pt-3">
              <summary className="cursor-pointer font-mono text-[10px] font-bold tracking-[0.12em] text-white/35 marker:text-[#33ccbb]">
                ADVANCED DETAILS
              </summary>
              <p className="mt-2 break-all font-mono text-[10px] text-white/35">
                Legacy snapshot check: {state.baselineDigest}
              </p>
            </details>
          ) : null}
        </div>
        <details className="border border-white/10 bg-[#0a1210] p-5">
          <summary className="cursor-pointer list-none font-mono text-[10px] font-black tracking-[0.2em] text-[#8fbab4] marker:text-[#33ccbb]">
            SAFETY &amp; PERSISTENCE
          </summary>
          <ul className="mt-4 space-y-3 text-xs leading-relaxed text-[#8fbab4]">
            <li>Sheet reads are limited to 100 × 40 cells and 2 MiB.</li>
            <li>Draft saves detect conflicting versions before they overwrite changes.</li>
            <li>Activations and rollbacks are recorded without storing cell values.</li>
          </ul>
        </details>
      </div>

      {!isLegacy && state.activeRevisionId !== null && state.legacyBinding !== null ? (
        <div className="flex flex-col justify-between gap-4 border border-[#c792ea]/25 bg-[#15121a] p-5 sm:flex-row sm:items-center">
          <div className="flex items-start gap-3">
            <RotateCcw className="mt-0.5 h-5 w-5 shrink-0 text-[#c792ea]" />
            <div>
              <h3 className="font-bold text-[#dbc4f5]">Restore the legacy source</h3>
              <p className="mt-1 text-xs leading-relaxed text-white/55">
                Select the retained {state.legacyBinding.expectedTitle} binding after confirming
                access and sheet structure. Existing web revisions remain available for rollback.
              </p>
            </div>
          </div>
          <button
            type="button"
            className={`${secondaryButton} shrink-0 border-[#c792ea]/35 text-[#dbc4f5] hover:bg-[#c792ea]/10`}
            disabled={busy !== undefined || dirty}
            onClick={restoreLegacyAction}
          >
            <RotateCcw className="h-4 w-4" />
            RESTORE LEGACY
          </button>
        </div>
      ) : null}

      {diagnostics.length > 0 ? (
        <Diagnostics diagnostics={diagnostics} onNavigate={onDiagnosticNavigate} />
      ) : null}
      {hasErrors ? (
        <p className="text-xs font-bold text-[#ff9d94]">
          Activation is disabled until every error is resolved.
        </p>
      ) : null}

      <section className="border border-white/10 bg-[#0a1210]">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="text-lg font-black">Activation history</h2>
          <FileClock className="h-5 w-5 text-white/35" />
        </div>
        {revisionsUnavailable ? (
          <DataStatusNotice
            kind="warning"
            message="Activation history could not be loaded. Retry before relying on rollback details."
            actionLabel="RETRY HISTORY"
            onAction={refreshRevisions}
          />
        ) : revisionsLoading ? (
          <p className="flex items-center gap-2 px-5 py-6 text-sm text-white/45" role="status">
            <LoaderCircle className="h-4 w-4 animate-spin text-[#33ccbb] motion-reduce:animate-none" />
            Loading activation history…
          </p>
        ) : revisions.length === 0 ? (
          <p className="px-5 py-6 text-sm text-white/45">No activated revisions yet.</p>
        ) : (
          <div className="divide-y divide-white/10">
            {revisions.map((revision) => (
              <RevisionRow
                key={revision.revisionId}
                revision={revision}
                active={revision.revisionId === state.activeRevisionId}
                disabled={busy !== undefined || isLegacy || dirty}
                onRollback={() => rollbackAction(revision)}
              />
            ))}
          </div>
        )}
      </section>
      {hasDraft ? (
        <button
          type="button"
          className="text-xs font-bold text-white/45 underline decoration-white/20 underline-offset-4 hover:text-[#ff9d94] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc]"
          disabled={busy !== undefined}
          onClick={discardAction}
        >
          <RotateCcw className="mr-1 inline h-3.5 w-3.5" />
          Discard this draft
        </button>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="bg-[#08100e] px-4 py-3">
      <p className="font-mono text-[9px] font-black tracking-[0.16em] text-white/30">{label}</p>
      <p className="mt-1 truncate font-mono text-sm font-bold text-white/80">{value}</p>
    </div>
  );
}

// fallow-ignore-next-line complexity
function RevisionRow({
  revision,
  active,
  disabled,
  onRollback,
}: {
  readonly revision: ConfigurationRevision;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly onRollback: () => void;
}) {
  const createdAt = new Date(revision.createdAtEpochMs);
  const createdAtLabel = Number.isNaN(createdAt.getTime())
    ? "Unknown time"
    : `${new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(createdAt)} UTC`;
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <span className={`h-2 w-2 ${active ? "bg-[#33ccbb]" : "bg-white/20"}`} />
        <div>
          <p className="font-mono text-xs font-bold text-white/75">{revision.revisionId}</p>
          <p className="mt-1 text-[11px] text-white/40">
            {createdAtLabel} · {revision.createdBy}
          </p>
        </div>
      </div>
      <button
        type="button"
        className={`${secondaryButton} self-start sm:self-auto`}
        disabled={disabled || active}
        onClick={onRollback}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {active ? "ACTIVE" : "ROLL BACK"}
      </button>
    </div>
  );
}

function Diagnostics({
  diagnostics,
  onNavigate,
}: {
  readonly diagnostics: ReadonlyArray<{
    readonly code: string;
    readonly path: string;
    readonly message: string;
    readonly severity: "error" | "warning";
  }>;
  readonly onNavigate: (path: string) => void;
}) {
  return (
    <div className="border border-[#ff7b72]/25 bg-[#251412] p-4">
      <div className="flex items-center gap-2 font-mono text-[10px] font-black tracking-[0.15em] text-[#ffaaa2]">
        <CircleAlert className="h-4 w-4" />
        NEEDS REVIEW
      </div>
      <div className="mt-3 space-y-2">
        {diagnostics.map((diagnostic, index) => (
          <div
            key={`${diagnostic.path}:${index}`}
            className="border border-[#ff7b72]/15 bg-[#1b100f] p-3"
          >
            <button
              type="button"
              className="text-left text-xs font-bold text-[#ffaaa2] underline decoration-[#ffaaa2]/35 underline-offset-4 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc]"
              onClick={() => onNavigate(diagnostic.path)}
              aria-label={`Go to ${formatDiffLabel(diagnostic.path)}`}
            >
              {formatDiffLabel(diagnostic.path)}
            </button>
            <span className="ml-2 break-all font-mono text-[10px] text-white/35">
              {diagnostic.path}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-white/65">
              {diagnostic.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyConfigurationSection({ onOverview }: { readonly onOverview: () => void }) {
  return (
    <div className="flex min-h-[32rem] items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <Sparkles className="mx-auto h-8 w-8 text-[#33ccbb]" />
        <h2 className="mt-4 text-xl font-black">Create or import a draft first</h2>
        <p className="mt-2 text-sm leading-relaxed text-white/50">
          Create a draft from a spreadsheet ID, or import the legacy Settings tab from Overview.
        </p>
        <button type="button" className={`${secondaryButton} mt-5`} onClick={onOverview}>
          BACK TO OVERVIEW
        </button>
      </div>
    </div>
  );
}

const utcDateTimeInputValue = (epochMs: number): string => {
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 16);
};

const utcDateTimeInputEpochMs = (value: string): number | undefined => {
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  const epochMs = Date.parse(`${withSeconds}Z`);
  return Number.isFinite(epochMs) ? epochMs : undefined;
};

function ConfigurationOverviewFields({
  configuration,
  onChange,
  onPendingInputStateChange,
}: {
  readonly configuration: Configuration;
  readonly onChange: (configuration: Configuration) => void;
  readonly onPendingInputStateChange: (key: string, message: string | undefined) => void;
}) {
  const formattedEventValue = utcDateTimeInputValue(configuration.event.startTimeEpochMs);
  const [eventValue, setEventValue] = useState(formattedEventValue);
  const [eventError, setEventError] = useState<string | undefined>();
  useEffect(() => {
    setEventValue(formattedEventValue);
    setEventError(undefined);
    onPendingInputStateChange("configuration:event-start", undefined);
  }, [formattedEventValue, onPendingInputStateChange]);

  const updateEventValue = (value: string) => {
    setEventValue(value);
    const epochMs = utcDateTimeInputEpochMs(value);
    if (epochMs === undefined) {
      const message =
        value.length === 0 ? "Enter an event start time in UTC." : "Use a valid UTC date and time.";
      setEventError(message);
      onPendingInputStateChange("configuration:event-start", message);
      return;
    }
    setEventError(undefined);
    onPendingInputStateChange("configuration:event-start", undefined);
    onChange({ ...configuration, event: { startTimeEpochMs: epochMs } });
  };

  return (
    <div className="mt-5 grid gap-3 border border-white/10 bg-[#08100e] p-3 sm:grid-cols-2">
      <label className="block text-xs font-bold text-white/65" htmlFor="configuration-spreadsheet">
        Spreadsheet ID
        <input
          id="configuration-spreadsheet"
          data-configuration-path="spreadsheetId"
          className="studioInput mt-2 w-full font-mono"
          value={configuration.spreadsheetId}
          onChange={(event) => onChange({ ...configuration, spreadsheetId: event.target.value })}
        />
      </label>
      <label className="block text-xs font-bold text-white/65" htmlFor="configuration-event-start">
        Event start (UTC)
        <input
          id="configuration-event-start"
          data-configuration-path="event.startTimeEpochMs"
          className="studioInput mt-2 w-full font-mono"
          type="datetime-local"
          step={60}
          value={eventValue}
          aria-invalid={eventError !== undefined}
          aria-describedby="configuration-event-start-hint"
          onChange={(event) => updateEventValue(event.target.value)}
        />
        <p
          id="configuration-event-start-hint"
          className={`mt-1 text-[11px] ${eventError === undefined ? "text-white/40" : "font-bold text-[#ff9d94]"}`}
          role={eventError === undefined ? undefined : "alert"}
        >
          {eventError ?? "Enter this time in UTC. The editor stores the exact UTC value."}
        </p>
      </label>
    </div>
  );
}

// Field sections share one editor surface while preserving the configuration's tagged shapes.
// fallow-ignore-next-line complexity
function ConfigurationFields({
  workspaceId,
  section,
  configuration,
  focusRequest,
  onChange,
  onPendingInputStateChange,
}: {
  readonly workspaceId: string;
  readonly section: Exclude<StudioSection, "overview">;
  readonly configuration: Configuration;
  readonly focusRequest: FocusRequest | undefined;
  readonly onChange: (configuration: Configuration) => void;
  readonly onPendingInputStateChange: (key: string, message: string | undefined) => void;
}) {
  // fallow-ignore-next-line code-duplication
  const [tabsRefreshKey, setTabsRefreshKey] = useState(0);
  const tabsResult = useSheetDescriptionResult({
    workspaceId,
    spreadsheetId: configuration.spreadsheetId,
    readPolicy: "fresh",
    refreshKey: tabsRefreshKey,
  });
  const tabs = resultValue(tabsResult)?.tabs ?? [];
  const tabsStatus: SheetTabsStatus = AsyncResult.isFailure(tabsResult)
    ? "error"
    : tabsResult.waiting && tabs.length === 0
      ? "loading"
      : "ready";
  const tabsStatusNotice = (
    <SheetTabsStatusNotice
      status={tabsStatus}
      onRetry={() => setTabsRefreshKey((current) => current + 1)}
    />
  );
  const defaultSheetId = configuration.users.userIds.sheetId;

  if (section === "users") {
    return (
      <div className="mt-6 space-y-2">
        {tabsStatusNotice}
        <p className="font-mono text-[9px] font-black tracking-[0.16em] text-white/35">
          OPTIONAL MAPPINGS
        </p>
        <OptionalRangeToggle
          label="User notes"
          present={configuration.users.userNotes !== undefined}
          onAdd={() =>
            onChange({
              ...configuration,
              users: {
                ...configuration.users,
                userNotes: makeRange(defaultSheetId, 0, 0, 1, 1),
              },
            })
          }
          onRemove={() => {
            const { userNotes: _userNotes, ...users } = configuration.users;
            onChange({ ...configuration, users });
          }}
        />
        <OptionalRangeToggle
          label="Monitor IDs + names"
          present={configuration.users.monitors !== undefined}
          onAdd={() =>
            onChange({
              ...configuration,
              users: {
                ...configuration.users,
                monitors: {
                  ids: makeRange(defaultSheetId, 0, 0, 1, 1),
                  names: makeRange(defaultSheetId, 0, 0, 1, 1),
                },
              },
            })
          }
          onRemove={() => {
            const { monitors: _monitors, ...users } = configuration.users;
            onChange({ ...configuration, users });
          }}
        />
        <OptionalRangeToggle
          label="Preference values"
          present={configuration.users.oshis !== undefined}
          onAdd={() =>
            onChange({
              ...configuration,
              users: { ...configuration.users, oshis: makeRange(defaultSheetId, 0, 0, 1, 1) },
            })
          }
          onRemove={() => {
            const { oshis: _oshis, ...users } = configuration.users;
            onChange({ ...configuration, users });
          }}
        />
      </div>
    );
  }

  if (section === "teams") {
    return (
      <div className="mt-6 space-y-3">
        {tabsStatusNotice}
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[9px] font-black tracking-[0.16em] text-white/35">
            TEAM ENTRIES
          </p>
          <button
            type="button"
            className={smallButton}
            onClick={() =>
              onChange({
                ...configuration,
                teams: [
                  ...configuration.teams,
                  makeTeamConfiguration(
                    tabs[0]?.sheetId ?? defaultSheetId,
                    configuration.teams.length,
                  ),
                ],
              })
            }
          >
            ADD TEAM
          </button>
        </div>
        {configuration.teams.map((team, index) => (
          <TeamFields
            key={team.entryId}
            team={team}
            index={index}
            count={configuration.teams.length}
            tabs={tabs}
            tabsStatus={tabsStatus}
            onChange={(next) =>
              onChange({
                ...configuration,
                teams: configuration.teams.map((candidate, candidateIndex) =>
                  candidateIndex === index ? next : candidate,
                ),
              })
            }
            onMove={(direction) =>
              onChange({
                ...configuration,
                teams: moveEntry(configuration.teams, index, direction),
              })
            }
            onRemove={() =>
              onChange({
                ...configuration,
                teams: removeEntry(configuration.teams, index),
              })
            }
          />
        ))}
        {configuration.teams.length === 0 ? (
          <p className="border border-dashed border-white/10 p-3 text-[11px] text-white/40">
            No teams yet. Add one to define its ranges.
          </p>
        ) : null}
      </div>
    );
  }

  if (section === "schedules") {
    return (
      <div className="mt-6 space-y-3">
        {tabsStatusNotice}
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[9px] font-black tracking-[0.16em] text-white/35">
            SCHEDULE ENTRIES
          </p>
          <button
            type="button"
            className={smallButton}
            onClick={() =>
              onChange({
                ...configuration,
                schedules: [
                  ...configuration.schedules,
                  makeScheduleConfiguration(
                    tabs[0]?.sheetId ?? defaultSheetId,
                    configuration.schedules.length,
                  ),
                ],
              })
            }
          >
            ADD SCHEDULE
          </button>
        </div>
        {configuration.schedules.map((schedule, index) => (
          <ScheduleFields
            key={schedule.entryId}
            schedule={schedule}
            index={index}
            count={configuration.schedules.length}
            tabs={tabs}
            tabsStatus={tabsStatus}
            onChange={(next) =>
              onChange({
                ...configuration,
                schedules: configuration.schedules.map((candidate, candidateIndex) =>
                  candidateIndex === index ? next : candidate,
                ),
              })
            }
            onMove={(direction) =>
              onChange({
                ...configuration,
                schedules: moveEntry(configuration.schedules, index, direction),
              })
            }
            onRemove={() =>
              onChange({
                ...configuration,
                schedules: removeEntry(configuration.schedules, index),
              })
            }
          />
        ))}
        {configuration.schedules.length === 0 ? (
          <p className="border border-dashed border-white/10 p-3 text-[11px] text-white/40">
            No schedules yet. Add one to define a channel/day mapping.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-3">
      {tabsStatusNotice}
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[9px] font-black tracking-[0.16em] text-white/35">
          RUNNER ENTRIES
        </p>
        <button
          type="button"
          className={smallButton}
          onClick={() =>
            onChange({
              ...configuration,
              runners: [
                ...configuration.runners,
                makeRunnerConfiguration(configuration.runners.length),
              ],
            })
          }
        >
          ADD RUNNER
        </button>
      </div>
      {configuration.runners.map((runner, index) => (
        <RunnerFields
          key={runner.entryId}
          runner={runner}
          index={index}
          count={configuration.runners.length}
          focusRequest={focusRequest}
          onChange={(next) =>
            onChange({
              ...configuration,
              runners: configuration.runners.map((candidate, candidateIndex) =>
                candidateIndex === index ? next : candidate,
              ),
            })
          }
          onPendingInputStateChange={onPendingInputStateChange}
          onMove={(direction) =>
            onChange({
              ...configuration,
              runners: moveEntry(configuration.runners, index, direction),
            })
          }
          onRemove={() => {
            onPendingInputStateChange(`runner:${runner.entryId}`, undefined);
            onChange({
              ...configuration,
              runners: removeEntry(configuration.runners, index),
            });
          }}
        />
      ))}
      {configuration.runners.length === 0 ? (
        <p className="border border-dashed border-white/10 p-3 text-[11px] text-white/40">
          No runners yet. Add one to define its start and end times.
        </p>
      ) : null}
    </div>
  );
}

function OptionalRangeToggle({
  label,
  present,
  onAdd,
  onRemove,
}: {
  readonly label: string;
  readonly present: boolean;
  readonly onAdd: () => void;
  readonly onRemove: () => void;
}) {
  const actionLabel = present ? `Remove ${label} range` : `Add ${label} range`;
  const [removeOpen, setRemoveOpen] = useState(false);
  return (
    <>
      <div className="flex items-center justify-between gap-2 border border-white/10 bg-[#0a1210] px-3 py-2">
        <span className="text-xs text-white/60">{label}</span>
        {present ? (
          <button
            type="button"
            className={smallButton}
            aria-label={actionLabel}
            onClick={() => setRemoveOpen(true)}
          >
            REMOVE
          </button>
        ) : (
          <button type="button" className={smallButton} aria-label={actionLabel} onClick={onAdd}>
            ADD RANGE
          </button>
        )}
      </div>
      <ActionConfirmationDialog
        request={
          removeOpen
            ? {
                title: `Remove ${label} range?`,
                description:
                  "The optional mapping and its current range will be removed from this draft.",
                confirmLabel: "REMOVE RANGE",
                tone: "danger",
                onConfirm: onRemove,
              }
            : undefined
        }
        onCancel={() => setRemoveOpen(false)}
      />
    </>
  );
}

// fallow-ignore-next-line complexity
function SheetTabsStatusNotice({
  status,
  onRetry,
}: {
  readonly status: SheetTabsStatus;
  readonly onRetry: () => void;
}) {
  if (status === "ready") return null;
  const loading = status === "loading";
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 border px-3 py-2 text-[11px] leading-relaxed ${loading ? "border-[#33ccbb]/20 bg-[#0a1512] text-[#8fbab4]" : "border-[#ffb86c]/25 bg-[#1a1710] text-[#ffcf91]"}`}
      role={loading ? "status" : "alert"}
      aria-live="polite"
    >
      <span className="flex min-w-0 items-start gap-2">
        {loading ? (
          <LoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : (
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        )}
        <span>
          {loading
            ? "Loading sheet tab names. Existing range values remain available while metadata loads."
            : "Sheet tab names are unavailable. Retry before choosing a different tab."}
        </span>
      </span>
      {!loading ? (
        <button type="button" className={smallButton} onClick={onRetry}>
          RETRY TABS
        </button>
      ) : null}
    </div>
  );
}

function SheetSelect({
  id,
  value,
  tabs,
  status,
  path,
  onChange,
}: {
  readonly id: string;
  readonly value: number;
  readonly tabs: ReadonlyArray<SheetSnapshotTab>;
  readonly status: SheetTabsStatus;
  readonly path?: string;
  readonly onChange: (sheetId: number) => void;
}) {
  return tabs.length > 0 ? (
    <select
      id={id}
      data-configuration-path={path}
      className="studioInput w-full"
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {tabs.map((tab) => (
        <option key={tab.sheetId} value={tab.sheetId}>
          {tab.title}
        </option>
      ))}
    </select>
  ) : (
    <select
      id={id}
      className="studioInput w-full font-mono"
      data-configuration-path={path}
      value={value}
      disabled
    >
      <option value={value}>
        {status === "loading"
          ? "Loading sheet tabs…"
          : status === "error"
            ? "Sheet tabs unavailable"
            : "No sheet tabs found"}
      </option>
    </select>
  );
}

function EntryToolbar({
  label,
  index,
  count,
  onMove,
  onRemove,
}: {
  readonly label: string;
  readonly index: number;
  readonly count: number;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const [removeOpen, setRemoveOpen] = useState(false);
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
        <p className="text-xs font-black text-white/70">{label}</p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={iconButton}
            aria-label={`Move ${label} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={iconButton}
            aria-label={`Move ${label} down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={iconButton}
            aria-label={`Remove ${label}`}
            onClick={() => setRemoveOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <ActionConfirmationDialog
        request={
          removeOpen
            ? {
                title: `Remove ${label}?`,
                description:
                  "This entry and its mappings will be removed from the draft. The change is not saved until you save the draft.",
                confirmLabel: "REMOVE ENTRY",
                tone: "danger",
                onConfirm: onRemove,
              }
            : undefined
        }
        onCancel={() => setRemoveOpen(false)}
      />
    </>
  );
}

const nextTeamIsv = (current: Team["isv"], kind: string): Team["isv"] => {
  const range = current.kind === "combined" ? current.range : current.lead;
  const split =
    current.kind === "combined"
      ? { backline: range, talent: range }
      : { backline: current.backline, talent: current.talent };
  return kind === "combined"
    ? { kind: "combined", range }
    : { kind: "split", lead: range, ...split };
};

const nextTeamTags = (current: Team["tags"], kind: string): Team["tags"] =>
  kind === "constants"
    ? { kind: "constants", values: current.kind === "constants" ? current.values : [] }
    : {
        kind: "ranges",
        range: current.kind === "ranges" ? current.range : makeLocalRange(0, 0, 1, 1),
      };

// Team editing keeps all conditional range selectors adjacent to the team identity controls.
// fallow-ignore-next-line complexity
function TeamFields({
  team,
  index,
  count,
  tabs,
  tabsStatus,
  onChange,
  onMove,
  onRemove,
}: {
  readonly team: Team;
  readonly index: number;
  readonly count: number;
  readonly tabs: ReadonlyArray<SheetSnapshotTab>;
  readonly tabsStatus: SheetTabsStatus;
  readonly onChange: (team: Team) => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const update = (next: Partial<Team>) => onChange({ ...team, ...next });
  const setSheet = (sheetId: number) => onChange(rebindTeamSheet(team, sheetId));
  const currentName = team.name ?? "";
  return (
    <div className="space-y-3 border border-white/10 bg-[#0a1210] p-3">
      <EntryToolbar
        label={`${currentName || `Team ${index + 1}`} · ${team.entryId.slice(0, 8)}`}
        index={index}
        count={count}
        onMove={onMove}
        onRemove={onRemove}
      />
      <label className="block text-[11px] font-bold text-white/55" htmlFor={`team-name-${index}`}>
        Team name
        <input
          id={`team-name-${index}`}
          className="studioInput mt-1 w-full"
          value={currentName}
          data-configuration-path={`teams[${index}].name`}
          onChange={(event) => {
            const value = event.target.value;
            if (value.trim().length === 0) {
              const { name: _name, ...withoutName } = team;
              onChange(withoutName);
            } else update({ name: value });
          }}
        />
      </label>
      <label className="block text-[11px] font-bold text-white/55" htmlFor={`team-sheet-${index}`}>
        Sheet tab
        <SheetSelect
          id={`team-sheet-${index}`}
          value={team.sheetId}
          tabs={tabs}
          status={tabsStatus}
          path={`teams[${index}].sheetId`}
          onChange={setSheet}
        />
      </label>
      <label
        className="block text-[11px] font-bold text-white/55"
        htmlFor={`team-name-mode-${index}`}
      >
        Team-name range
        <select
          id={`team-name-mode-${index}`}
          className="studioInput mt-1 w-full"
          value={team.teamName === "auto" ? "auto" : "range"}
          data-configuration-path={`teams[${index}].teamName`}
          onChange={(event) =>
            update({
              teamName:
                event.target.value === "auto"
                  ? "auto"
                  : team.teamName === "auto"
                    ? makeLocalRange(0, 0, 1, 1)
                    : team.teamName,
            })
          }
        >
          <option value="auto">Auto</option>
          <option value="range">Explicit range</option>
        </select>
        <span className="mt-1 block text-[10px] font-normal leading-relaxed text-[#8fbab4]">
          Auto team names are synthesized when read; submissions do not write a team-name cell.
        </span>
      </label>
      <label className="block text-[11px] font-bold text-white/55" htmlFor={`team-isv-${index}`}>
        Roster columns
        <select
          id={`team-isv-${index}`}
          data-configuration-path={`teams[${index}].isv.kind`}
          className="studioInput mt-1 w-full"
          value={team.isv.kind}
          onChange={(event) => update({ isv: nextTeamIsv(team.isv, event.target.value) })}
        >
          <option value="combined">Combined</option>
          <option value="split">Lead / backline / talent</option>
        </select>
        <span className="mt-1 block text-[10px] font-normal leading-relaxed text-[#8fbab4]">
          Combined reads one roster value per row. Split reads separate lead, backline, and talent
          columns.
        </span>
      </label>
      <label className="block text-[11px] font-bold text-white/55" htmlFor={`team-tags-${index}`}>
        Tags source
        <select
          id={`team-tags-${index}`}
          data-configuration-path={`teams[${index}].tags.kind`}
          className="studioInput mt-1 w-full"
          value={team.tags.kind}
          onChange={(event) => update({ tags: nextTeamTags(team.tags, event.target.value) })}
        >
          <option value="constants">Constants</option>
          <option value="ranges">Range</option>
        </select>
        <span className="mt-1 block text-[10px] font-normal leading-relaxed text-[#8fbab4]">
          Constants stay in this draft. Range reads tag values from sheet cells.
        </span>
      </label>
      {team.tags.kind === "constants" ? (
        <label
          className="block text-[11px] font-bold text-white/55"
          htmlFor={`team-tag-values-${index}`}
        >
          Tag constants
          <input
            id={`team-tag-values-${index}`}
            data-configuration-path={`teams[${index}].tags.values`}
            className="studioInput mt-1 w-full"
            value={team.tags.values.join(", ")}
            onChange={(event) =>
              update({
                tags: {
                  kind: "constants",
                  values: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter((value) => value.length > 0),
                },
              })
            }
          />
        </label>
      ) : null}
      <OptionalRangeToggle
        label="Preference range"
        present={team.oshiRange !== undefined}
        onAdd={() => update({ oshiRange: makeLocalRange(0, 0, 1, 1) })}
        onRemove={() => {
          const { oshiRange: _oshiRange, ...withoutOshiRange } = team;
          onChange(withoutOshiRange);
        }}
      />
    </div>
  );
}

function ScheduleFields({
  schedule,
  index,
  count,
  tabs,
  tabsStatus,
  onChange,
  onMove,
  onRemove,
}: {
  readonly schedule: Schedule;
  readonly index: number;
  readonly count: number;
  readonly tabs: ReadonlyArray<SheetSnapshotTab>;
  readonly tabsStatus: SheetTabsStatus;
  readonly onChange: (schedule: Schedule) => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const update = (next: Partial<Schedule>) => onChange({ ...schedule, ...next });
  const currentLabel = schedule.channel || `Schedule ${index + 1}`;
  const optionalRange = (key: "monitorRange" | "screenshotRange" | "noteRange") => schedule[key];
  const rangeForOptional = () => makeLocalRange(0, 0, 1, 1);
  return (
    <div className="space-y-3 border border-white/10 bg-[#0a1210] p-3">
      <EntryToolbar
        label={`${currentLabel} · day ${schedule.day}`}
        index={index}
        count={count}
        onMove={onMove}
        onRemove={onRemove}
      />
      <label
        className="block text-[11px] font-bold text-white/55"
        htmlFor={`schedule-channel-${index}`}
      >
        Channel
        <input
          id={`schedule-channel-${index}`}
          data-configuration-path={`schedules[${index}].channel`}
          className="studioInput mt-1 w-full"
          value={schedule.channel}
          onChange={(event) => update({ channel: event.target.value })}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label
          className="block text-[11px] font-bold text-white/55"
          htmlFor={`schedule-day-${index}`}
        >
          Day
          <input
            id={`schedule-day-${index}`}
            data-configuration-path={`schedules[${index}].day`}
            className="studioInput mt-1 w-full"
            type="number"
            min={1}
            value={schedule.day}
            onChange={(event) => update({ day: Math.max(1, Number(event.target.value) || 1) })}
          />
        </label>
        <label
          className="block text-[11px] font-bold text-white/55"
          htmlFor={`schedule-sheet-${index}`}
        >
          Sheet tab
          <SheetSelect
            id={`schedule-sheet-${index}`}
            value={schedule.sheetId}
            tabs={tabs}
            status={tabsStatus}
            path={`schedules[${index}].sheetId`}
            onChange={(sheetId) => onChange(rebindScheduleSheet(schedule, sheetId))}
          />
        </label>
      </div>
      <label
        className="block text-[11px] font-bold text-white/55"
        htmlFor={`schedule-encoding-${index}`}
      >
        Encoding
        <select
          id={`schedule-encoding-${index}`}
          data-configuration-path={`schedules[${index}].encoding`}
          className="studioInput mt-1 w-full"
          value={schedule.encoding}
          onChange={(event) => update({ encoding: event.target.value as Schedule["encoding"] })}
        >
          <option value="none">None</option>
          <option value="regex">Regex</option>
          <option value="bold">Bold</option>
          <option value="underline">Underline</option>
        </select>
        <span className="mt-1 block text-[10px] font-normal leading-relaxed text-[#8fbab4]">
          Controls how schedule text is marked when it is rendered.
        </span>
      </label>
      <label
        className="block text-[11px] font-bold text-white/55"
        htmlFor={`schedule-break-${index}`}
      >
        Break range
        <select
          id={`schedule-break-${index}`}
          data-configuration-path={`schedules[${index}].breakRange`}
          className="studioInput mt-1 w-full"
          value={schedule.breakRange === "auto" ? "auto" : "range"}
          onChange={(event) =>
            update({
              breakRange:
                event.target.value === "auto"
                  ? "auto"
                  : schedule.breakRange === "auto"
                    ? rangeForOptional()
                    : schedule.breakRange,
            })
          }
        >
          <option value="auto">Auto</option>
          <option value="range">Explicit range</option>
        </select>
      </label>
      {(["monitorRange", "screenshotRange", "noteRange"] as const).map((key) => (
        <OptionalRangeToggle
          key={key}
          label={
            key === "monitorRange"
              ? "Monitor range"
              : key === "screenshotRange"
                ? "Screenshot range"
                : "Note range"
          }
          present={optionalRange(key) !== undefined}
          onAdd={() => update({ [key]: rangeForOptional() })}
          onRemove={() => {
            const next = { ...schedule };
            delete next[key];
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

function RunnerFields({
  runner,
  index,
  count,
  focusRequest,
  onChange,
  onPendingInputStateChange,
  onMove,
  onRemove,
}: {
  readonly runner: Runner;
  readonly index: number;
  readonly count: number;
  readonly focusRequest: FocusRequest | undefined;
  readonly onChange: (runner: Runner) => void;
  readonly onPendingInputStateChange: (key: string, message: string | undefined) => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  return (
    <div className="space-y-3 border border-white/10 bg-[#0a1210] p-3">
      <EntryToolbar
        label={`${runner.name || `Runner ${index + 1}`} · ${runner.entryId.slice(0, 8)}`}
        index={index}
        count={count}
        onMove={onMove}
        onRemove={onRemove}
      />
      <label className="block text-[11px] font-bold text-white/55" htmlFor={`runner-name-${index}`}>
        Runner name
        <input
          id={`runner-name-${index}`}
          data-configuration-path={`runners[${index}].name`}
          className="studioInput mt-1 w-full"
          value={runner.name}
          onChange={(event) => onChange({ ...runner, name: event.target.value })}
        />
      </label>
      <RunnerHoursField
        runner={runner}
        index={index}
        focusRequest={focusRequest}
        onChange={onChange}
        onPendingInputStateChange={onPendingInputStateChange}
      />
    </div>
  );
}

// fallow-ignore-next-line complexity
function RunnerHoursField({
  runner,
  index,
  focusRequest,
  onChange,
  onPendingInputStateChange,
}: {
  readonly runner: Runner;
  readonly index: number;
  readonly focusRequest: FocusRequest | undefined;
  readonly onChange: (runner: Runner) => void;
  readonly onPendingInputStateChange: (key: string, message: string | undefined) => void;
}) {
  const inputKey = `runner:${runner.entryId}`;
  const formattedHours = formatRunnerHours(runner.hours);
  const [hoursValue, setHoursValue] = useState(formattedHours);
  const [hoursError, setHoursError] = useState<string | undefined>(
    parseRunnerHoursInput(formattedHours).error,
  );

  useEffect(() => {
    const parsed = parseRunnerHoursInput(formattedHours);
    setHoursValue(formattedHours);
    setHoursError(parsed.error);
    onPendingInputStateChange(inputKey, parsed.error);
  }, [formattedHours, inputKey, onPendingInputStateChange]);

  const updateHours = (value: string) => {
    const parsed = parseRunnerHoursInput(value);
    setHoursValue(value);
    setHoursError(parsed.error);
    onPendingInputStateChange(inputKey, parsed.error);
    if (parsed.error === undefined) onChange({ ...runner, hours: parsed.hours });
  };

  const hintId =
    hoursError === undefined ? `runner-hours-hint-${index}` : `runner-hours-error-${index}`;
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (
      focusRequest === undefined ||
      !configurationPathsRelated(focusRequest.path, `runners[${index}].hours`)
    ) {
      return;
    }
    // fallow-ignore-next-line code-duplication
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest?.nonce, focusRequest?.path, index]);
  return (
    <label className="block text-[11px] font-bold text-white/55" htmlFor={`runner-hours-${index}`}>
      Hours
      <input
        id={`runner-hours-${index}`}
        ref={inputRef}
        data-configuration-path={`runners[${index}].hours`}
        className="studioInput mt-1 w-full font-mono"
        value={hoursValue}
        onChange={(event) => updateHours(event.target.value)}
        onBlur={() => updateHours(hoursValue)}
        placeholder="8-10, 12-14"
        aria-invalid={hoursError !== undefined}
        aria-describedby={hintId}
      />
      <span
        id={hintId}
        className={`mt-1 block text-[10px] leading-relaxed ${hoursError === undefined ? "text-white/40" : "font-bold text-[#ff9d94]"}`}
      >
        {hoursError ?? "Use comma-separated inclusive intervals; overlaps merge on save."}
      </span>
    </label>
  );
}

const moveEntry = <A,>(entries: ReadonlyArray<A>, index: number, direction: -1 | 1): Array<A> => {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= entries.length) return [...entries];
  const next = [...entries];
  const [entry] = next.splice(index, 1);
  if (entry !== undefined) next.splice(nextIndex, 0, entry);
  return next;
};

const removeEntry = <A,>(entries: ReadonlyArray<A>, index: number): Array<A> =>
  entries.filter((_entry, entryIndex) => entryIndex !== index);

// The desktop master-detail editor and mobile stepper intentionally share one stateful surface.
// fallow-ignore-next-line complexity
function RangeSection({
  workspaceId,
  section,
  configuration,
  draftDirty,
  targets,
  selectedPath,
  onSelect,
  diagnostics,
  focusRequest,
  pendingRangeState,
  pendingInputError,
  onPendingRangeStateChange,
  onPendingInputStateChange,
  onClearPendingEditorState,
  onChange,
  onConfigurationChange,
}: {
  readonly workspaceId: string;
  readonly section: Exclude<StudioSection, "overview">;
  readonly configuration: Configuration;
  readonly draftDirty: boolean;
  readonly targets: ReadonlyArray<RangeTarget>;
  readonly selectedPath: string;
  readonly onSelect: (path: string) => void;
  readonly diagnostics: ReadonlyArray<ConfigurationDiagnostic>;
  readonly focusRequest: FocusRequest | undefined;
  readonly pendingRangeState: PendingRangeState;
  readonly pendingInputError: string | undefined;
  readonly onPendingRangeStateChange: (state: PendingRangeState) => void;
  readonly onPendingInputStateChange: (key: string, message: string | undefined) => void;
  readonly onClearPendingEditorState: () => void;
  readonly onChange: (path: string, range: Range) => void;
  readonly onConfigurationChange: (configuration: Configuration) => void;
}) {
  // fallow-ignore-next-line code-duplication
  const [tabsRefreshKey, setTabsRefreshKey] = useState(0);
  const tabsResult = useSheetDescriptionResult({
    workspaceId,
    spreadsheetId: configuration.spreadsheetId,
    readPolicy: "fresh",
    refreshKey: tabsRefreshKey,
  });
  const tabs = resultValue(tabsResult)?.tabs ?? [];
  const tabsStatus: SheetTabsStatus = AsyncResult.isFailure(tabsResult)
    ? "error"
    : tabsResult.waiting && tabs.length === 0
      ? "loading"
      : "ready";
  const sectionTargets = rangeTargetsForSection(targets, section);
  const active = sectionTargets.find((target) => target.path === selectedPath) ?? sectionTargets[0];
  const groupedTargets = groupedRangeTargets(sectionTargets);
  const targetsNeedingReview = sectionTargets.filter(
    (target) => configurationDiagnosticFor(target, diagnostics) !== undefined,
  );
  const readyTargetCount = sectionTargets.length - targetsNeedingReview.length;
  const requiredTargetCount = sectionTargets.filter((target) => target.required).length;
  const optionalTargetCount = sectionTargets.length - requiredTargetCount;
  const [mobileStep, setMobileStep] = useState<RangeMobileStep>(() =>
    active === undefined ? "fields" : "grid",
  );
  const [selectionFocusNonce, setSelectionFocusNonce] = useState(0);
  const [pendingTargetPath, setPendingTargetPath] = useState<string>();
  useEffect(() => {
    setMobileStep(active === undefined ? "fields" : "grid");
  }, [active?.path, section]);
  const commitTargetSelection = (path: string) => {
    onClearPendingEditorState();
    onSelect(path);
    setMobileStep("grid");
    setSelectionFocusNonce((current) => current + 1);
  };
  // fallow-ignore-next-line complexity
  const selectTarget = (path: string) => {
    if (path === active?.path) {
      setMobileStep("grid");
      setSelectionFocusNonce((current) => current + 1);
      return;
    }
    if (pendingRangeState.dirty || pendingRangeState.invalid || pendingInputError !== undefined) {
      setPendingTargetPath(path);
      return;
    }
    commitTargetSelection(path);
  };
  const focusMatchesActive =
    focusRequest !== undefined &&
    active !== undefined &&
    configurationPathsRelated(focusRequest.path, active.path);
  useEffect(() => {
    if (focusMatchesActive) setMobileStep("grid");
  }, [focusMatchesActive, focusRequest?.nonce]);
  const activeIndex = active === undefined ? -1 : sectionTargets.indexOf(active);
  const activeGroup = groupedTargets.find(({ targets: groupTargets }) =>
    groupTargets.some((target) => target.path === active?.path),
  );
  const nextNeedsReview = targetsNeedingReview.find((target) => target.path !== active?.path);
  const nextTarget =
    nextNeedsReview ??
    (sectionTargets.length === 0
      ? undefined
      : sectionTargets[(activeIndex + 1) % sectionTargets.length]);
  const configurationEntryCount = {
    users: 0,
    teams: configuration.teams.length,
    schedules: configuration.schedules.length,
    runners: configuration.runners.length,
  }[section];
  const configurationEditorLabel = {
    users: "Optional user settings",
    teams: "Team entries and options",
    schedules: "Schedule entries and options",
    runners: "Runner entries and hours",
  }[section];
  const focusEntryEditor =
    focusRequest !== undefined &&
    (focusRequest.path === section ||
      focusRequest.path.startsWith(`${section}.`) ||
      focusRequest.path.startsWith(`${section}[`));
  return (
    <section className="min-h-[32rem] min-w-0 max-w-full">
      <div className="relative z-10 flex flex-col items-stretch gap-2 border-b border-[#33ccbb]/20 bg-[#0b1210] p-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-4 sm:p-6">
        <div className="min-w-0 sm:flex-1">
          <p className="hidden font-mono text-[9px] font-black tracking-[0.16em] text-[#73e9dc] xl:block">
            SELECTED MAPPING
          </p>
          <h2 className="truncate text-xl font-black text-white sm:mt-1 sm:text-2xl">
            {active?.label ?? "No sheet ranges yet"}
          </h2>
          <p className="mt-1 hidden max-w-2xl text-xs leading-relaxed text-white/55 sm:block">
            {active?.description ??
              "Runners use hour intervals rather than sheet ranges. Add a runner below."}
          </p>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
          <div className="text-left font-mono text-[10px] text-white/45 sm:text-right">
            {sectionTargets.length === 0
              ? "NO RANGE MAPPINGS"
              : `${readyTargetCount} OF ${sectionTargets.length} READY`}
            {sectionTargets.length > 0 ? (
              <span className="ml-2 hidden text-[#8fbab4] sm:inline">
                · {requiredTargetCount} required · {optionalTargetCount} optional
              </span>
            ) : null}
          </div>
          {nextTarget ? (
            <button
              type="button"
              className={smallButton}
              onClick={() => selectTarget(nextTarget.path)}
            >
              {nextNeedsReview ? "NEXT TO REVIEW" : "NEXT MAPPING"}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        {sectionTargets.length > 0 ? (
          <div className="basis-full">
            <div className="h-1 bg-white/10" aria-hidden="true">
              <div
                className="h-full bg-[#33ccbb] transition-[width] motion-reduce:transition-none"
                style={{ width: `${(readyTargetCount / sectionTargets.length) * 100}%` }}
              />
            </div>
            <p className="mt-2 hidden text-[11px] text-[#8fbab4] xl:block">
              Required ranges come first. Optional mappings appear when enabled for this workspace.
            </p>
          </div>
        ) : null}
      </div>
      <div className="border-b border-white/10 p-2 xl:hidden">
        <div
          className="grid grid-cols-2 gap-1 border border-white/10 bg-[#08100e] p-1"
          role="tablist"
          aria-label="Range setup steps"
        >
          <button
            type="button"
            role="tab"
            id={`configuration-fields-tab-${section}`}
            aria-selected={mobileStep === "fields"}
            aria-controls={`configuration-fields-${section}`}
            className={`min-h-11 px-3 py-2 text-left text-xs font-black transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc] ${mobileStep === "fields" ? "bg-[#33ccbb] text-[#07100e]" : "text-white/55 hover:bg-[#33ccbb]/10 hover:text-white"}`}
            onClick={() => setMobileStep("fields")}
          >
            <span className="block font-mono text-[9px] tracking-[0.14em] opacity-70">STEP 1</span>
            Choose a mapping
          </button>
          <button
            type="button"
            role="tab"
            id={`configuration-grid-tab-${section}`}
            aria-selected={mobileStep === "grid"}
            aria-controls={`configuration-grid-${section}`}
            disabled={sectionTargets.length === 0}
            className={`min-h-11 px-3 py-2 text-left text-xs font-black transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc] ${mobileStep === "grid" ? "bg-[#33ccbb] text-[#07100e]" : "text-white/55 hover:bg-[#33ccbb]/10 hover:text-white"} disabled:cursor-not-allowed disabled:opacity-30`}
            onClick={() => setMobileStep("grid")}
          >
            <span className="block font-mono text-[9px] tracking-[0.14em] opacity-70">STEP 2</span>
            <span className="block">Set the range</span>
          </button>
        </div>
        <p className="px-1 pt-2 text-[11px] leading-relaxed text-[#8fbab4]">
          {active === undefined
            ? "Choose a mapping to inspect, or open the section settings below."
            : mobileStep === "fields"
              ? "Choose a mapping to inspect. Step 2 opens its A1 and grid controls."
              : "Type an A1 range or click and drag across the grid. Apply it to the draft, then save the draft."}
        </p>
      </div>
      {tabsStatus !== "ready" ? (
        <div className="px-4 pt-4 xl:px-7">
          <SheetTabsStatusNotice
            status={tabsStatus}
            onRetry={() => setTabsRefreshKey((current) => current + 1)}
          />
        </div>
      ) : null}
      <div className="grid min-w-0 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
        <div
          id={`configuration-fields-${section}`}
          role="tabpanel"
          aria-labelledby={`configuration-fields-tab-${section}`}
          className={`${mobileStep === "fields" ? "block" : "hidden"} min-w-0 border-b border-white/10 p-5 xl:order-2 xl:block xl:border-b-0 xl:border-l sm:p-7`}
        >
          <h2 className="text-2xl font-black">Mapping list</h2>
          <p className="mt-2 hidden text-sm leading-relaxed text-white/65 xl:block">
            Select a mapping to inspect its current A1 address and expected cell shape.
          </p>
          <div className="mt-5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-[9px] font-black tracking-[0.16em] text-white/35">
                MAPPINGS
              </p>
              <span className="font-mono text-[9px] text-white/30">
                {sectionTargets.length} {sectionTargets.length === 1 ? "mapping" : "mappings"}
              </span>
            </div>
            {sectionTargets.length === 0 ? (
              <p className="border border-dashed border-white/10 p-4 text-xs text-white/40">
                This section has no sheet ranges. Use the{" "}
                {section === "runners" ? "runner editor" : "section settings"} below.
              </p>
            ) : (
              groupedTargets.map((group) => (
                <div key={group.id} className="border border-white/10 bg-[#0a1210]">
                  <div className="flex items-start justify-between gap-3 border-b border-white/10 px-3 py-2">
                    <div>
                      <p className="font-mono text-[10px] font-black tracking-[0.14em] text-white/70">
                        {group.label}
                      </p>
                      <p className="mt-1 text-[10px] leading-relaxed text-[#8fbab4]">
                        {group.description}
                      </p>
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-[#8fbab4]">
                      {group.targets.length}
                    </span>
                  </div>
                  <div className="space-y-1 p-1">
                    {group.targets.map((target) => (
                      <RangeListItem
                        key={target.path}
                        target={target}
                        tabs={tabs}
                        active={target.path === active?.path}
                        hasIssue={configurationDiagnosticFor(target, diagnostics) !== undefined}
                        onClick={() => selectTarget(target.path)}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
          {section === "users" ? null : (
            <details
              className="mt-5 border border-white/10 bg-[#0a1210]"
              open={configurationEntryCount === 0 || focusEntryEditor}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-xs font-bold text-white/70 marker:hidden">
                <span>{configurationEditorLabel}</span>
                <span className="flex items-center gap-2 font-mono text-[10px] text-[#8fbab4]">
                  {configurationEntryCount} {configurationEntryCount === 1 ? "entry" : "entries"}
                  <ChevronDown className="h-4 w-4" />
                </span>
              </summary>
              <div className="border-t border-white/10 px-3 pb-3">
                <ConfigurationFields
                  workspaceId={workspaceId}
                  section={section}
                  configuration={configuration}
                  focusRequest={focusRequest}
                  onChange={onConfigurationChange}
                  onPendingInputStateChange={onPendingInputStateChange}
                />
              </div>
            </details>
          )}
          {section === "users" ? (
            <details
              className="mt-5 border border-white/10 bg-[#0a1210] px-3 py-2"
              open={focusEntryEditor ? true : undefined}
            >
              <summary className="cursor-pointer text-xs font-bold text-white/65 marker:text-[#33ccbb]">
                Optional mapping settings
              </summary>
              <ConfigurationFields
                workspaceId={workspaceId}
                section={section}
                configuration={configuration}
                focusRequest={focusRequest}
                onChange={onConfigurationChange}
                onPendingInputStateChange={onPendingInputStateChange}
              />
            </details>
          ) : null}
        </div>
        <div
          id={`configuration-grid-${section}`}
          role="tabpanel"
          aria-labelledby={`configuration-grid-tab-${section}`}
          className={`${mobileStep === "grid" ? "block" : "hidden"} min-w-0 p-4 xl:order-1 xl:block sm:p-7`}
        >
          {active ? (
            <RangeCanvas
              workspaceId={workspaceId}
              spreadsheetId={configuration.spreadsheetId}
              targets={targets}
              target={active}
              mappingIndex={activeIndex + 1}
              mappingCount={sectionTargets.length}
              mappingGroupLabel={activeGroup?.label ?? "Mapping"}
              draftDirty={draftDirty}
              pendingRangeState={pendingRangeState}
              focusRequest={focusRequest}
              focusSelectionNonce={selectionFocusNonce}
              onPendingRangeStateChange={onPendingRangeStateChange}
              onChange={onChange}
            />
          ) : (
            <div className="border border-dashed border-white/10 bg-[#0a1210] p-5 text-sm leading-relaxed text-white/50">
              Runners use hour intervals instead of a sheet grid. Open the runner editor on the left
              to set their hours.
            </div>
          )}
        </div>
      </div>
      <ActionConfirmationDialog
        request={
          pendingTargetPath === undefined
            ? undefined
            : {
                title: "Discard the staged range?",
                description:
                  "The pending A1 edit or grid selection will be cleared before opening another mapping. Applied draft changes will stay intact.",
                confirmLabel: "DISCARD & OPEN MAPPING",
                tone: "warning",
                onConfirm: () => {
                  const nextPath = pendingTargetPath;
                  setPendingTargetPath(undefined);
                  onClearPendingEditorState();
                  commitTargetSelection(nextPath);
                },
              }
        }
        onCancel={() => setPendingTargetPath(undefined)}
      />
    </section>
  );
}

// Each mapping row keeps its tab-qualified A1 reference visible for quick inspection.
const rangeSummaryFor = (target: RangeTarget, tabs: ReadonlyArray<SheetSnapshotTab>): string => {
  const tab = tabs.find((candidate) => candidate.sheetId === target.range.sheetId);
  if (tab !== undefined)
    return formatSheetRangeOption(tab.title, target.range) ?? formatDiffRange(target.range);
  const start = `${columnLabel(target.range.startColumn)}${target.range.startRow + 1}`;
  const endRow = target.range.endRow === "sheet-end" ? "" : String(target.range.endRow);
  const end = `${columnLabel(target.range.endColumn - 1)}${endRow}`;
  return `Sheet ID ${target.range.sheetId} · ${start}:${end}`;
};

// Range targets are rendered as an indexed navigation list for keyboard and pointer workflows.
// fallow-ignore-next-line complexity
function RangeListItem({
  target,
  tabs,
  active,
  hasIssue,
  onClick,
}: {
  readonly target: RangeTarget;
  readonly tabs: ReadonlyArray<SheetSnapshotTab>;
  readonly active: boolean;
  readonly hasIssue: boolean;
  readonly onClick: () => void;
}) {
  const rangeSummary = rangeSummaryFor(target, tabs);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${target.label}, ${rangeSummary}${target.required ? ", required" : ", optional"}${hasIssue ? ", needs review" : ""}`}
      className={`group flex w-full items-start gap-3 border px-3 py-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc] ${active ? "border-[#33ccbb]/50 bg-[#33ccbb]/10" : "border-white/10 bg-[#0a1210] hover:border-[#33ccbb]/30"}`}
    >
      <span
        className={`mt-1 h-2.5 w-2.5 shrink-0 ${active ? "bg-[#33ccbb]" : "bg-[#33ccbb]/35"}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span
            className={`truncate text-xs font-bold ${active ? "text-[#9ef4e8]" : "text-white/65"}`}
          >
            {target.label}
          </span>
          <span className="font-mono text-[9px] font-black tracking-[0.1em] text-[#8fbab4]">
            {target.required ? "REQUIRED" : "OPTIONAL"}
          </span>
        </span>
        <span className="mt-1 block text-[10px] leading-relaxed text-[#8fbab4]">
          {target.expected}
        </span>
        <code
          className="mt-1 block truncate text-[11px] text-[#9ef4e8]"
          title={`Current range: ${rangeSummary}`}
        >
          {rangeSummary}
        </code>
        <span
          className={`mt-1 block font-mono text-[9px] font-black tracking-[0.1em] ${hasIssue ? "text-[#ff9d94]" : "text-[#73e9dc]"}`}
        >
          {hasIssue ? "NEEDS ATTENTION" : "READY"}
        </span>
      </span>
      <ChevronRight
        className={`ml-auto mt-1 h-3 w-3 shrink-0 ${active ? "text-[#33ccbb]" : "text-white/20 group-hover:text-white/60"}`}
      />
    </button>
  );
}

function RangeFieldGuide({ target }: { readonly target: RangeTarget }) {
  return (
    <details className="mt-5 border border-[#33ccbb]/20 bg-[#0e1a17] p-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-bold text-white/70 marker:text-[#33ccbb]">
        <span>Mapping help</span>
        <span className="font-mono text-[10px] text-[#8fbab4]">Expected content &amp; example</span>
      </summary>
      <div className="mt-3 border-t border-white/10 pt-3">
        <p className="text-xs leading-relaxed text-white/70">{target.description}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="border border-white/10 bg-[#08100e] px-3 py-2">
            <p className="font-mono text-[9px] font-black tracking-[0.14em] text-[#8fbab4]">
              EXPECTED CONTENT
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-[#b6e9e2]">{target.expected}</p>
          </div>
          <div className="border border-white/10 bg-[#08100e] px-3 py-2">
            <p className="font-mono text-[9px] font-black tracking-[0.14em] text-[#8fbab4]">
              EXAMPLE ONLY
            </p>
            <code className="mt-1 block truncate text-[11px] text-[#9ef4e8]">{target.example}</code>
          </div>
        </div>
        <details className="mt-3 border-t border-white/10 pt-3">
          <summary className="cursor-pointer font-mono text-[10px] font-bold tracking-[0.12em] text-[#8fbab4] marker:text-[#33ccbb]">
            ADVANCED FIELD PATH
          </summary>
          <code className="mt-2 block break-all text-[11px] text-[#9ef4e8]">{target.path}</code>
        </details>
      </div>
    </details>
  );
}

// The range canvas owns selection state, keyboard navigation, provider refresh, and grid rendering.
// fallow-ignore-next-line complexity
function RangeCanvas({
  workspaceId,
  spreadsheetId,
  targets,
  target,
  mappingIndex,
  mappingCount,
  mappingGroupLabel,
  draftDirty,
  pendingRangeState,
  focusRequest,
  focusSelectionNonce,
  onPendingRangeStateChange,
  onChange,
}: {
  readonly workspaceId: string;
  readonly spreadsheetId: string;
  readonly targets: ReadonlyArray<RangeTarget>;
  readonly target: RangeTarget | undefined;
  readonly mappingIndex: number;
  readonly mappingCount: number;
  readonly mappingGroupLabel: string;
  readonly draftDirty: boolean;
  readonly pendingRangeState: PendingRangeState;
  readonly focusRequest: FocusRequest | undefined;
  readonly focusSelectionNonce: number;
  readonly onPendingRangeStateChange: (state: PendingRangeState) => void;
  readonly onChange: (path: string, range: Range) => void;
}) {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const tabsResult = useSheetDescriptionResult({
    workspaceId,
    spreadsheetId,
    readPolicy: "fresh",
    refreshKey: refreshNonce,
  });
  const tabs = resultValue(tabsResult)?.tabs ?? [];
  const targetTabId = target?.range.sheetId ?? tabs[0]?.sheetId ?? 0;
  const [startRow, setStartRow] = useState(target?.range.startRow ?? 0);
  const [startColumn, setStartColumn] = useState(target?.range.startColumn ?? 0);
  const [rowCount, setRowCount] = useState(16);
  const columnCount = 12;
  const [selection, setSelection] = useState<GridSelection>();
  const selectionRef = useRef<GridSelection | undefined>(undefined);
  const [lastAppliedRange, setLastAppliedRange] = useState<string>();
  const [focusedCell, setFocusedCell] = useState<{
    readonly row: number;
    readonly column: number;
  }>();
  const dragAnchorRef = useRef<{ readonly row: number; readonly column: number } | undefined>(
    undefined,
  );
  const dragPointerIdRef = useRef<number | undefined>(undefined);
  const dragStartPointRef = useRef<{ readonly x: number; readonly y: number } | undefined>(
    undefined,
  );
  const didDragRef = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const [selectedSheetId, setSelectedSheetId] = useState(targetTabId);
  const setTransientSelection = useCallback(
    (next: GridSelection | undefined) => {
      selectionRef.current = next;
      setSelection(next);
      onPendingRangeStateChange(
        next === undefined ? cleanPendingRangeState : { dirty: true, invalid: false },
      );
    },
    [onPendingRangeStateChange],
  );
  useEffect(() => {
    if (target === undefined) return;
    setSelectedSheetId(target.range.sheetId);
    setStartRow(target.range.startRow);
    setStartColumn(target.range.startColumn);
    setTransientSelection(undefined);
    setLastAppliedRange(undefined);
    setFocusedCell({ row: target.range.startRow, column: target.range.startColumn });
  }, [
    setTransientSelection,
    target?.path,
    target?.range.sheetId,
    target?.range.startRow,
    target?.range.startColumn,
  ]);
  const snapshotWindow = useMemo<SheetSnapshotWindow>(
    () => ({ startRow, startColumn, rowCount, columnCount }),
    [startRow, startColumn, rowCount, columnCount],
  );
  const snapshotResult = useSheetSnapshotResult({
    workspaceId,
    spreadsheetId,
    sheetId: selectedSheetId,
    window: snapshotWindow,
    readPolicy: "fresh",
    refreshKey: refreshNonce,
  });
  const snapshot = resultValue(snapshotResult);
  const cells = useMemo(
    () => new Map((snapshot?.cells ?? []).map((cell) => [`${cell.row}:${cell.column}`, cell])),
    [snapshot?.cells],
  );
  const tab = tabs.find((candidate) => candidate.sheetId === selectedSheetId) ?? snapshot?.tab;
  const targetTab =
    target === undefined
      ? undefined
      : tabs.find((candidate) => candidate.sheetId === target.range.sheetId);
  const selectedRectangle =
    selection ??
    (target === undefined || target.range.sheetId !== selectedSheetId
      ? undefined
      : {
          startRow: target.range.startRow,
          startColumn: target.range.startColumn,
          endRow:
            target.range.endRow === "sheet-end"
              ? target.range.startRow + rowCount - 1
              : target.range.endRow - 1,
          endColumn: target.range.endColumn - 1,
        });
  // fallow-ignore-next-line complexity
  const applySelection = (selectionToApply?: GridSelection) => {
    const nextSelection = selectionToApply ?? selectionRef.current ?? selection;
    if (nextSelection === undefined || target === undefined) return;
    onChange(target.path, {
      sheetId: selectedSheetId,
      startRow: nextSelection.startRow,
      endRow: nextSelection.endRow + 1,
      startColumn: nextSelection.startColumn,
      endColumn: nextSelection.endColumn + 1,
    });
    setLastAppliedRange(
      `${columnLabel(nextSelection.startColumn)}${nextSelection.startRow + 1}:${columnLabel(nextSelection.endColumn)}${nextSelection.endRow + 1}`,
    );
    setTransientSelection(undefined);
  };
  // Selection updates preserve the anchor while supporting shift-extension in either direction.
  // fallow-ignore-next-line complexity
  const selectCell = (row: number, column: number, extend: boolean) => {
    const currentSelection = selectionRef.current ?? selection;
    if (pendingRangeState.dirty && currentSelection === undefined) return undefined;
    const anchor =
      extend && currentSelection !== undefined
        ? { row: currentSelection.startRow, column: currentSelection.startColumn }
        : { row, column };
    setFocusedCell({ row, column });
    // fallow-ignore-next-line code-duplication
    const nextSelection =
      extend && currentSelection !== undefined
        ? {
            startRow: Math.min(anchor.row, row),
            startColumn: Math.min(anchor.column, column),
            endRow: Math.max(anchor.row, row),
            endColumn: Math.max(anchor.column, column),
          }
        : { startRow: row, startColumn: column, endRow: row, endColumn: column };
    setTransientSelection(nextSelection);
    return nextSelection;
  };
  const selectDraggedCell = (row: number, column: number) => {
    const anchor = dragAnchorRef.current;
    if (anchor === undefined) return;
    didDragRef.current = didDragRef.current || anchor.row !== row || anchor.column !== column;
    setFocusedCell({ row, column });
    // fallow-ignore-next-line code-duplication
    const nextSelection = {
      startRow: Math.min(anchor.row, row),
      startColumn: Math.min(anchor.column, column),
      endRow: Math.max(anchor.row, row),
      endColumn: Math.max(anchor.column, column),
    };
    setTransientSelection(nextSelection);
    return nextSelection;
  };
  // fallow-ignore-next-line complexity
  const beginCellPointer = (
    event: PointerEvent<HTMLButtonElement>,
    row: number,
    column: number,
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (pendingRangeState.dirty && selectionRef.current === undefined) return;
    if (event.pointerType === "mouse") event.preventDefault();
    dragAnchorRef.current = { row, column };
    dragPointerIdRef.current = event.pointerId;
    dragStartPointRef.current = { x: event.clientX, y: event.clientY };
    didDragRef.current = false;
  };
  // fallow-ignore-next-line complexity
  const moveCellPointer = (event: PointerEvent<HTMLButtonElement>, row: number, column: number) => {
    if (
      dragAnchorRef.current === undefined ||
      dragPointerIdRef.current !== event.pointerId ||
      dragStartPointRef.current === undefined
    ) {
      return;
    }
    const moved =
      Math.abs(event.clientX - dragStartPointRef.current.x) > 6 ||
      Math.abs(event.clientY - dragStartPointRef.current.y) > 6;
    if (!didDragRef.current && !moved) return;
    didDragRef.current = true;
    event.preventDefault();
    if (event.pointerType !== "mouse" && !event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const pointedCell = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-sheet-cell]");
    const pointedRow = Number(pointedCell?.dataset.sheetRow);
    const pointedColumn = Number(pointedCell?.dataset.sheetColumn);
    selectDraggedCell(
      Number.isFinite(pointedRow) ? pointedRow : row,
      Number.isFinite(pointedColumn) ? pointedColumn : column,
    );
  };
  // fallow-ignore-next-line complexity
  const finishCellPointer = (event: PointerEvent<HTMLElement>, canceled = false) => {
    if (dragPointerIdRef.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragAnchorRef.current = undefined;
    dragPointerIdRef.current = undefined;
    dragStartPointRef.current = undefined;
    if (canceled) {
      didDragRef.current = false;
      setTransientSelection(undefined);
    }
  };
  // Keyboard navigation clamps the transient selection to the currently displayed grid window.
  // fallow-ignore-next-line complexity
  const moveFocusedCell = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = focusedCell ?? { row: startRow, column: startColumn };
    let row = current.row;
    let column = current.column;
    const firstRow = startRow;
    const lastRow = startRow + rowCount - 1;
    const firstColumn = startColumn;
    const lastColumn = startColumn + columnCount - 1;
    if (event.ctrlKey && event.key === "Home") {
      row = firstRow;
      column = firstColumn;
    } else if (event.ctrlKey && event.key === "End") {
      row = lastRow;
      column = lastColumn;
    } else if (event.key === "Home") {
      column = firstColumn;
    } else if (event.key === "End") {
      column = lastColumn;
    } else if (event.key === "ArrowUp") {
      row = Math.max(firstRow, row - 1);
    } else if (event.key === "ArrowDown") {
      row = Math.min(lastRow, row + 1);
    } else if (event.key === "ArrowLeft") {
      column = Math.max(firstColumn, column - 1);
    } else if (event.key === "ArrowRight") {
      column = Math.min(lastColumn, column + 1);
    } else {
      return false;
    }
    event.preventDefault();
    selectCell(row, column, event.shiftKey);
    return true;
  };
  const hasPreviewFailure =
    AsyncResult.isFailure(tabsResult) || AsyncResult.isFailure(snapshotResult);
  const tabsStatus: SheetTabsStatus = AsyncResult.isFailure(tabsResult)
    ? "error"
    : tabsResult.waiting && tabs.length === 0
      ? "loading"
      : "ready";
  const hasPreviewData = tabs.length > 0 && snapshot !== undefined;
  const previewStatus = hasPreviewFailure
    ? "error"
    : tabsResult.waiting || snapshotResult.waiting || !hasPreviewData
      ? "loading"
      : "ready";
  const previewMessage =
    AsyncResult.isFailure(tabsResult) && tabs.length === 0
      ? "Could not load the sheet tabs. Confirm the spreadsheet is accessible, then retry."
      : AsyncResult.isFailure(snapshotResult) && snapshot === undefined
        ? "Could not load cells for this tab. Choose another tab or retry."
        : hasPreviewFailure
          ? "Showing the last available preview. Retry to fetch current cells."
          : previewStatus === "loading"
            ? "Loading the read-only sheet preview…"
            : "READ-ONLY SHEET PREVIEW";
  const previewFetchedAt =
    snapshot?.windowFetchedAtEpochMs ?? resultValue(tabsResult)?.metadataFetchedAtEpochMs;
  return (
    <div className="space-y-4" data-sheet-range-editor="true">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-black">
            <span className="mr-2 font-mono text-[10px] font-black tracking-[0.16em] text-[#8fbab4]">
              MAPPING {mappingIndex} OF {mappingCount}
            </span>
            <span>Set the range</span>
          </h3>
          <p className="mt-1 text-xs text-[#8fbab4]">
            {mappingGroupLabel} · {target?.label ?? "No mapping selected"}
          </p>
        </div>
        <div className="flex min-w-0 max-w-full shrink-0 flex-wrap items-center justify-end gap-2 text-right">
          {previewStatus === "ready" ? (
            <Eye className="h-4 w-4 text-[#33ccbb]" />
          ) : previewStatus === "error" ? (
            <CircleAlert className="h-4 w-4 text-[#ffb86c]" />
          ) : (
            <LoaderCircle className="h-4 w-4 animate-spin text-[#33ccbb] motion-reduce:animate-none" />
          )}
          <span
            className={`min-w-0 max-w-full text-[11px] ${previewStatus === "error" ? "text-[#ffcf91]" : previewStatus === "ready" ? "text-[#9ef4e8]" : "text-[#8fbab4]"}`}
            role={previewStatus === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {previewMessage}
          </span>
          {previewFetchedAt !== undefined ? (
            <span className="font-mono text-[9px] text-[#8fbab4]">
              {formatFetchedAt(previewFetchedAt)}
            </span>
          ) : null}
          <button
            type="button"
            className={smallButton}
            onClick={() => setRefreshNonce((current) => current + 1)}
            aria-label={previewStatus === "error" ? "Retry sheet preview" : "Refresh sheet preview"}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {previewStatus === "error" ? "RETRY" : "REFRESH"}
          </button>
        </div>
      </div>
      {previewStatus === "error" ? (
        <p className="border border-[#ffb86c]/25 bg-[#1a1710] px-3 py-2 text-[11px] leading-relaxed text-[#ffcf91]">
          You can still edit the range while the preview recovers. Confirm the spreadsheet is shared
          with the configured reader, then retry.
        </p>
      ) : null}
      {target ? <RangeFieldGuide target={target} /> : null}
      <RangeTextInput
        target={target}
        tab={targetTab ?? tab}
        tabs={tabs}
        draftDirty={draftDirty}
        focusRequest={focusRequest}
        focusSelectionNonce={focusSelectionNonce}
        onPendingRangeStateChange={onPendingRangeStateChange}
        onChange={onChange}
      />
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_7rem]">
        <label className="block text-xs font-bold text-white/70" htmlFor="range-tab">
          Sheet tab
          <SheetSelect
            id="range-tab"
            value={selectedSheetId}
            tabs={tabs}
            status={tabsStatus}
            onChange={(sheetId) => {
              setSelectedSheetId(sheetId);
              setTransientSelection(undefined);
              setLastAppliedRange(undefined);
              setFocusedCell(undefined);
            }}
          />
        </label>
        <details className="border border-white/10 bg-[#0a1210] px-3 py-2 sm:col-span-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-bold text-white/70 marker:text-[#33ccbb]">
            <span>View options</span>
            <span className="font-mono text-[10px] text-[#8fbab4]">
              {columnLabel(startColumn)}
              {startRow + 1} · {rowCount} rows
            </span>
          </summary>
          <div className="mt-3 grid gap-2 border-t border-white/10 pt-3 sm:grid-cols-3">
            <label className="block text-xs font-bold text-white/70" htmlFor="range-start-row">
              First row
              <input
                id="range-start-row"
                type="number"
                min={1}
                max={1000000}
                value={startRow + 1}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isInteger(next) && next >= 1) setStartRow(Math.min(1000000, next) - 1);
                }}
                className="studioInput mt-2 w-full"
              />
            </label>
            <label className="block text-xs font-bold text-white/70" htmlFor="range-start-column">
              First column
              <input
                id="range-start-column"
                type="number"
                min={1}
                max={18278}
                value={startColumn + 1}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isInteger(next) && next >= 1)
                    setStartColumn(Math.min(18278, next) - 1);
                }}
                className="studioInput mt-2 w-full"
                aria-describedby="range-window-hint"
              />
            </label>
            <label className="block text-xs font-bold text-white/70" htmlFor="range-row-count">
              Preview rows
              <input
                id="range-row-count"
                type="number"
                min={1}
                max={100}
                value={rowCount}
                onChange={(event) =>
                  setRowCount(Math.max(1, Math.min(100, Number(event.target.value) || 1)))
                }
                className="studioInput mt-2 w-full"
              />
            </label>
          </div>
          <p id="range-window-hint" className="mt-3 text-[10px] leading-relaxed text-[#8fbab4]">
            Inspecting from{" "}
            <code className="text-[#9ef4e8]">
              {columnLabel(startColumn)}
              {startRow + 1}
            </code>{" "}
            · move the preview window to inspect nearby cells without changing the mapping.
          </p>
        </details>
      </div>
      {pendingRangeState.dirty && selection === undefined ? (
        <p className="border border-[#ffb86c]/25 bg-[#1a1710] px-3 py-2 text-[11px] leading-relaxed text-[#ffcf91]">
          An A1 edit is pending. Apply or revert it before selecting cells in the grid.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-x border-t border-white/10 bg-[#0a1210] px-3 py-2">
        <p className="font-mono text-[9px] font-black tracking-[0.14em] text-[#8fbab4]">
          PREVIEW CELLS
        </p>
        <p className="text-right text-[10px] text-[#8fbab4]">
          Click or drag to stage a range. Apply to draft commits it.
          {lastAppliedRange ? (
            <span className="ml-2 text-[#9ef4e8]">· DRAFT RANGE APPLIED {lastAppliedRange}</span>
          ) : null}
          <span className="mt-1 block text-[10px] text-[#8fbab4]">
            Keyboard: arrows move · Shift+Arrow selects · Enter applies · Escape clears · Ctrl/Cmd+Z
            undoes the last applied range
          </span>
        </p>
      </div>
      <p className="-mt-2 text-[11px] leading-relaxed text-[#8fbab4]">
        Swipe or scroll horizontally to inspect all columns. The preview is read-only; your
        selection stays pending until you apply it to the draft.
      </p>
      <div
        ref={gridRef}
        className="max-h-[min(60vh,42rem)] touch-pan-x touch-pan-y overflow-auto overscroll-contain border border-[#33ccbb]/25 bg-[#070d0b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc]"
        role="grid"
        aria-label={`${target?.label ?? "Sheet"} range preview`}
        aria-readonly="true"
        aria-multiselectable="true"
        aria-rowcount={-1}
        aria-colcount={-1}
        aria-describedby="range-grid-instructions"
        aria-activedescendant={
          focusedCell === undefined
            ? undefined
            : `sheet-cell-${focusedCell.row}-${focusedCell.column}`
        }
        tabIndex={0}
        onPointerUp={(event) => finishCellPointer(event)}
        onPointerCancel={(event) => finishCellPointer(event, true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            applySelection();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setTransientSelection(undefined);
          } else {
            moveFocusedCell(event);
          }
        }}
      >
        <div className="min-w-[32.5rem] sm:min-w-[42rem]">
          <div
            className="grid"
            style={{ gridTemplateColumns: `2.5rem repeat(${columnCount}, minmax(2.5rem, 1fr))` }}
          >
            <div role="row" aria-rowindex={1} className="contents">
              <div
                role="presentation"
                className="sticky left-0 top-0 z-20 border-b border-r border-white/10 bg-[#101b18]"
              />
              {Array.from({ length: columnCount }, (_, column) => (
                <div
                  key={column}
                  role="columnheader"
                  aria-colindex={startColumn + column + 1}
                  className="sticky top-0 z-10 border-b border-r border-white/10 bg-[#101b18] px-2 py-2 text-center font-mono text-[10px] text-[#8fbab4]"
                >
                  {columnLabel(startColumn + column)}
                </div>
              ))}
            </div>
            {Array.from({ length: rowCount }, (_, row) => (
              <div key={row} role="row" aria-rowindex={startRow + row + 1} className="contents">
                <div
                  role="rowheader"
                  aria-rowindex={startRow + row + 1}
                  className="sticky left-0 z-10 border-b border-r border-white/10 bg-[#101b18] px-2 py-2 text-right font-mono text-[10px] text-[#8fbab4]"
                >
                  {startRow + row + 1}
                </div>
                {/* Grid cells combine selection, mapped targets, and pointer/keyboard actions. */}
                {/* fallow-ignore-next-line complexity */}
                {Array.from({ length: columnCount }, (_, column) => {
                  const absoluteRow = startRow + row;
                  const absoluteColumn = startColumn + column;
                  const cell = cells.get(`${absoluteRow}:${absoluteColumn}`);
                  const inSelection =
                    selectedRectangle !== undefined &&
                    absoluteRow >= selectedRectangle.startRow &&
                    absoluteRow <= selectedRectangle.endRow &&
                    absoluteColumn >= selectedRectangle.startColumn &&
                    absoluteColumn <= selectedRectangle.endColumn;
                  const mapped = targets.find(
                    // fallow-ignore-next-line complexity
                    (candidate) =>
                      candidate.range.sheetId === selectedSheetId &&
                      absoluteRow >= candidate.range.startRow &&
                      (candidate.range.endRow === "sheet-end" ||
                        absoluteRow < candidate.range.endRow) &&
                      absoluteColumn >= candidate.range.startColumn &&
                      absoluteColumn < candidate.range.endColumn,
                  );
                  return (
                    <button
                      key={`${absoluteRow}:${absoluteColumn}`}
                      id={`sheet-cell-${absoluteRow}-${absoluteColumn}`}
                      type="button"
                      role="gridcell"
                      tabIndex={-1}
                      aria-rowindex={absoluteRow + 1}
                      aria-colindex={absoluteColumn + 1}
                      aria-selected={inSelection}
                      data-sheet-cell="true"
                      data-sheet-row={absoluteRow}
                      data-sheet-column={absoluteColumn}
                      aria-label={`${tab?.title ?? "Sheet"} row ${absoluteRow + 1}, column ${columnLabel(absoluteColumn)}${cell?.formattedValue ? `: ${cell.formattedValue}` : ""}`}
                      onPointerDown={(event) =>
                        beginCellPointer(event, absoluteRow, absoluteColumn)
                      }
                      onPointerMove={(event) => moveCellPointer(event, absoluteRow, absoluteColumn)}
                      onPointerEnter={() => {
                        if (dragPointerIdRef.current !== undefined) {
                          selectDraggedCell(absoluteRow, absoluteColumn);
                        }
                      }}
                      onPointerUp={(event) => finishCellPointer(event)}
                      onPointerCancel={(event) => finishCellPointer(event, true)}
                      onClick={(event) => {
                        if (didDragRef.current) {
                          didDragRef.current = false;
                          return;
                        }
                        selectCell(absoluteRow, absoluteColumn, event.shiftKey);
                        gridRef.current?.focus({ preventScroll: true });
                      }}
                      className={`min-h-11 touch-pan-x touch-pan-y overflow-hidden border-b border-r border-white/10 px-2 py-2 text-left text-[11px] transition motion-reduce:transition-none hover:bg-[#33ccbb]/15 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#73e9dc] ${inSelection ? "bg-[#33ccbb]/30 ring-1 ring-inset ring-[#33ccbb]" : mapped ? rangeTint(mapped.path) : "bg-transparent"}`}
                      style={
                        focusedCell?.row === absoluteRow && focusedCell.column === absoluteColumn
                          ? { outline: "2px solid #73e9dc", outlineOffset: "-2px" }
                          : undefined
                      }
                      title={cell?.formattedValue ?? "Empty cell"}
                    >
                      {cell?.formattedValue ?? ""}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      {selection ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-[#33ccbb]/20 bg-[#0e1a17] px-3 py-3">
          <div>
            <p className="font-mono text-[11px] text-[#9ef4e8]">
              SELECTED {columnLabel(selection.startColumn)}
              {selection.startRow + 1}:{columnLabel(selection.endColumn)}
              {selection.endRow + 1}
            </p>
            <p className="mt-1 text-[10px] text-[#8fbab4]">
              This selection is pending. Apply it to update the draft.
            </p>
          </div>
          <button
            type="button"
            className={`${smallButton} border-[#33ccbb]/45 text-[#9ef4e8]`}
            data-sheet-editor-apply="true"
            onClick={() => applySelection()}
          >
            APPLY TO DRAFT
          </button>
        </div>
      ) : null}
      <div id="range-grid-instructions" className="sr-only" role="status" aria-live="polite">
        {selection === undefined
          ? "No pending grid selection. Click or drag to stage a range, then apply it to the draft."
          : `Selected ${columnLabel(selection.startColumn)}${selection.startRow + 1} through ${columnLabel(selection.endColumn)}${selection.endRow + 1}. Apply the selection to update the draft.`}
      </div>
    </div>
  );
}

// Range text input accepts a tab-qualified A1 reference and resolves it against the live tabs.
// fallow-ignore-next-line complexity
const parseRangeInput = (
  value: string,
  target: RangeTarget,
  tab: SheetSnapshotTab | undefined,
  tabs: ReadonlyArray<SheetSnapshotTab>,
): Range | undefined => {
  const title = sheetTitleFromRange(value);
  const matchingTabs =
    title === undefined ? [] : tabs.filter((candidate) => candidate.title === title);
  const matchingTab =
    title === undefined
      ? undefined
      : tabs.length === 0
        ? tab?.title === title
          ? tab
          : { sheetId: target.range.sheetId, title }
        : matchingTabs.length === 1
          ? matchingTabs[0]
          : undefined;
  return matchingTab === undefined ? undefined : parseSheetRange(value, matchingTab.sheetId);
};

// A1 input resolves a title to the current tab set before committing an explicit range edit.
// fallow-ignore-next-line complexity
function RangeTextInput({
  target,
  tab,
  tabs,
  draftDirty,
  focusRequest,
  focusSelectionNonce,
  onPendingRangeStateChange,
  onChange,
}: {
  readonly target: RangeTarget | undefined;
  readonly tab: SheetSnapshotTab | undefined;
  readonly tabs: ReadonlyArray<SheetSnapshotTab>;
  readonly draftDirty: boolean;
  readonly focusRequest: FocusRequest | undefined;
  readonly focusSelectionNonce: number;
  readonly onPendingRangeStateChange: (state: PendingRangeState) => void;
  readonly onChange: (path: string, range: Range) => void;
}) {
  const formatted =
    target === undefined
      ? ""
      : tab === undefined
        ? formatDiffRange(target.range)
        : (formatSheetRangeOption(tab.title, target.range) ?? formatDiffRange(target.range));
  const [value, setValue] = useState(formatted);
  const [showError, setShowError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const metadataUnavailable = target !== undefined && tab === undefined;
  const parsed =
    target === undefined || metadataUnavailable
      ? undefined
      : parseRangeInput(value, target, tab, tabs);
  const dirty = target !== undefined && value !== formatted;
  const invalid = dirty && parsed === undefined;
  const focusRequested =
    focusRequest !== undefined &&
    target !== undefined &&
    configurationPathsRelated(focusRequest.path, target.path);
  const shouldFocus = target !== undefined && (focusRequested || focusSelectionNonce > 0);

  useEffect(() => {
    setValue(formatted);
    setShowError(false);
  }, [formatted, target?.path]);
  useEffect(() => {
    onPendingRangeStateChange({ dirty, invalid });
  }, [dirty, invalid, onPendingRangeStateChange]);
  useEffect(() => {
    if (!shouldFocus) return;
    // fallow-ignore-next-line code-duplication
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest?.nonce, focusRequest?.path, shouldFocus, target?.path]);

  if (target === undefined) return null;

  const apply = () => {
    if (metadataUnavailable || parsed === undefined) {
      setShowError(true);
      return;
    }
    if (!dirty) {
      setShowError(false);
      return;
    }
    setShowError(false);
    onPendingRangeStateChange(cleanPendingRangeState);
    onChange(target.path, parsed);
  };
  const revert = () => {
    setValue(formatted);
    setShowError(false);
    onPendingRangeStateChange(cleanPendingRangeState);
  };
  const error = showError && (invalid || metadataUnavailable);

  return (
    <div
      className="border border-[#33ccbb]/35 bg-[#0e1a17] p-3"
      role="group"
      aria-labelledby="range-formula-bar-label"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <p
            id="range-formula-bar-label"
            className="shrink-0 font-mono text-[9px] font-black tracking-[0.16em] text-[#73e9dc]"
          >
            FORMULA BAR
          </p>
          <span className="truncate border-l border-white/15 pl-2 text-xs font-bold text-white/70">
            {target.label}
          </span>
        </div>
        <span className="font-mono text-[9px] font-black tracking-[0.14em] text-[#8fbab4]">
          {metadataUnavailable
            ? "UNAVAILABLE"
            : invalid
              ? "INVALID"
              : dirty
                ? "STAGED EDIT"
                : draftDirty
                  ? "DRAFT CHANGES"
                  : "CURRENT"}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-white/65">
        {tab === undefined ? (
          "A tab-qualified A1 address is required for this mapping."
        ) : (
          <>
            Mapping <span className="font-bold text-white">{target.label}</span> from{" "}
            <code className="text-[#9ef4e8]">{tab.title}</code>. Type an A1 address or stage one in
            the grid, then apply it to update the draft.
          </>
        )}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-[#8fbab4]">
        Expected: <span className="text-[#b6e9e2]">{target.expected}</span>
      </p>
      <div className="mt-3 flex min-w-0 items-center gap-2">
        <label
          htmlFor="range-a1"
          className="shrink-0 border border-[#33ccbb]/25 bg-[#08100e] px-2 py-2 font-mono text-[10px] font-black tracking-[0.12em] text-[#9ef4e8]"
        >
          A1
        </label>
        <input
          id="range-a1"
          ref={inputRef}
          data-configuration-path={target.path}
          aria-label={"A1 range for " + target.label}
          className={`studioInput min-w-0 flex-1 font-mono ${error ? "border-[#ff7b72]" : ""}`}
          value={value}
          readOnly={metadataUnavailable}
          onChange={(event) => {
            const nextValue = event.target.value;
            setValue(nextValue);
            setShowError(false);
            if (metadataUnavailable) return;
            const nextParsed = parseRangeInput(nextValue, target, tab, tabs);
            if (nextParsed === undefined) {
              onPendingRangeStateChange({ dirty: true, invalid: true });
              return;
            }
            if (Equal.equals(target.range, nextParsed)) {
              setValue(formatted);
              onPendingRangeStateChange(cleanPendingRangeState);
              return;
            }
            onPendingRangeStateChange({ dirty: true, invalid: false });
          }}
          onBlur={() => setShowError(invalid || metadataUnavailable)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              apply();
            } else if (event.key === "Escape") {
              event.preventDefault();
              revert();
            }
          }}
          aria-invalid={error}
          aria-describedby={error ? "range-a1-error" : "range-a1-hint"}
        />
      </div>
      {error ? (
        <p id="range-a1-error" className="mt-2 text-xs font-bold text-[#ff9d94]">
          {metadataUnavailable
            ? "The sheet tab name is unavailable. Retry the preview before editing this range."
            : `Enter a valid range with a tab name, such as ${target.example}.`}
        </p>
      ) : (
        <p id="range-a1-hint" className="mt-2 text-[11px] leading-relaxed text-[#8fbab4]">
          {metadataUnavailable ? (
            "The current range is shown by Sheet ID until tab metadata is available."
          ) : (
            <>
              Example only: <code className="text-[#9ef4e8]">{target.example}</code>. Press Enter or
              Apply to draft to commit; press Escape to revert an incomplete edit.
            </>
          )}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
        <p className="text-[11px] text-[#8fbab4]">
          {metadataUnavailable
            ? "Retry the sheet preview to edit this range."
            : invalid
              ? "Fix or revert this range before saving."
              : dirty
                ? "This range is pending. Apply it to the draft before saving."
                : draftDirty
                  ? "This range is part of draft changes. Save the draft to persist it."
                  : "This range is current. Edit the address or stage a selection in the grid."}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={`${smallButton} border-[#33ccbb]/45 text-[#9ef4e8]`}
            disabled={!dirty || invalid || metadataUnavailable}
            data-sheet-editor-apply="true"
            onClick={apply}
          >
            APPLY TO DRAFT
          </button>
          <button type="button" className={smallButton} disabled={!dirty} onClick={revert}>
            REVERT
          </button>
        </div>
      </div>
      <details className="mt-3 border border-white/10 bg-[#0a1210] px-3 py-2 text-[11px]">
        <summary className="cursor-pointer font-bold text-white/65 marker:text-[#33ccbb]">
          A1 range examples
        </summary>
        <div className="mt-3 grid gap-2 border-t border-white/10 pt-3 sm:grid-cols-3">
          <div>
            <code className="text-[#9ef4e8]">Roster!B8:B</code>
            <p className="mt-1 leading-relaxed text-[#8fbab4]">Column B, starting at row 8.</p>
          </div>
          <div>
            <code className="text-[#9ef4e8]">Roster!B8:C</code>
            <p className="mt-1 leading-relaxed text-[#8fbab4]">Columns B–C, starting at row 8.</p>
          </div>
          <div>
            <code className="text-[#9ef4e8]">'Team Roster'!A2:A5</code>
            <p className="mt-1 leading-relaxed text-[#8fbab4]">
              Use quotes when a tab name contains spaces.
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}

const rangeTint = (path: string) =>
  path.startsWith("users")
    ? "bg-[#33ccbb]/10"
    : path.startsWith("teams")
      ? "bg-[#c792ea]/10"
      : path.startsWith("schedules")
        ? "bg-[#ffb86c]/10"
        : "bg-[#82aaff]/10";

// fallow-ignore-next-line complexity
function DataStatusNotice({
  kind,
  message,
  actionLabel,
  onAction,
}: {
  readonly kind: "warning" | "error";
  readonly message: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-xs leading-relaxed ${kind === "error" ? "border-[#ff7b72]/25 bg-[#251412] text-[#ffb5ae]" : "border-[#ffb86c]/25 bg-[#1a1710] text-[#ffcf91]"}`}
      role={kind === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      <span className="flex min-w-0 items-start gap-2">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{message}</span>
      </span>
      {actionLabel !== undefined && onAction !== undefined ? (
        <button type="button" className={smallButton} onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

// fallow-ignore-next-line complexity
function FullState({
  label,
  busy = false,
  denied = false,
  retryLabel,
  onRetry,
}: {
  readonly label: string;
  readonly busy?: boolean;
  readonly denied?: boolean;
  readonly retryLabel?: string | undefined;
  readonly onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="flex min-h-[24rem] items-center justify-center border border-[#33ccbb]/20 bg-[#080d0c] p-8">
      <div className="max-w-md text-center">
        {busy ? (
          <LoaderCircle className="mx-auto h-7 w-7 animate-spin text-[#33ccbb] motion-reduce:animate-none" />
        ) : (
          <CircleAlert
            className={`mx-auto h-7 w-7 ${denied ? "text-[#ffb86c]" : "text-white/35"}`}
          />
        )}
        <p className="mt-4 text-sm leading-relaxed text-white/60">{label}</p>
        {retryLabel !== undefined && onRetry !== undefined ? (
          <button type="button" className={`${secondaryButton} mt-5`} onClick={onRetry}>
            <RotateCcw className="h-4 w-4" />
            {retryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DraftNavigationConfirmation({
  blocker,
}: {
  readonly blocker: ReturnType<typeof useBlocker<RegisteredRouter, true>>;
}) {
  if (blocker.status !== "blocked") return null;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) blocker.reset();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/80" />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Popup
            role="alertdialog"
            className="w-full max-w-md border border-[#33ccbb]/35 bg-[#0b1210] p-6 shadow-[12px_12px_0_rgba(51,204,187,0.12)]"
          >
            <CircleAlert className="h-7 w-7 text-[#ffb86c]" />
            <Dialog.Title className="mt-4 text-xl font-black">
              Leave with unsaved sheet changes?
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-relaxed text-white/50">
              Changes since the last draft save will be lost. Save the draft first, or leave this
              editor and discard them.
            </Dialog.Description>
            <div className="mt-6 flex flex-col-reverse justify-end gap-2 sm:flex-row">
              <Dialog.Close className={secondaryButton}>STAY IN EDITOR</Dialog.Close>
              <button
                type="button"
                className={`${secondaryButton} border-[#ff6257]/45 text-[#ff8a80] hover:bg-[#ff6257]/10`}
                onClick={() => blocker.proceed()}
              >
                LEAVE WITHOUT SAVING
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ActionConfirmationDialog({
  request,
  onCancel,
}: {
  readonly request: ConfirmationRequest | undefined;
  readonly onCancel: () => void;
}) {
  if (request === undefined) return null;
  const confirmClass =
    request.tone === "danger"
      ? "border-[#ff6257]/45 bg-[#ff6257]/10 text-[#ff9d94] hover:bg-[#ff6257]/20"
      : "border-[#ffb86c]/45 bg-[#ffb86c]/10 text-[#ffcf91] hover:bg-[#ffb86c]/20";
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/80" />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Popup
            role="alertdialog"
            className="w-full max-w-md border border-[#33ccbb]/35 bg-[#0b1210] p-6 shadow-[12px_12px_0_rgba(51,204,187,0.12)]"
          >
            <CircleAlert
              className={`h-7 w-7 ${request.tone === "danger" ? "text-[#ff7b72]" : "text-[#ffb86c]"}`}
            />
            <Dialog.Title className="mt-4 text-xl font-black">{request.title}</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-relaxed text-white/65">
              {request.description}
            </Dialog.Description>
            <div className="mt-6 flex flex-col-reverse justify-end gap-2 sm:flex-row">
              <Dialog.Close className={secondaryButton}>CANCEL</Dialog.Close>
              <button
                type="button"
                className={`${secondaryButton} ${confirmClass}`}
                onClick={() => {
                  request.onConfirm();
                  onCancel();
                }}
              >
                {request.confirmLabel}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ActivationReceiptBanner({
  receipt,
  onViewHistory,
}: {
  readonly receipt: ActivationReceipt;
  readonly onViewHistory: () => void;
}) {
  const activatedAt = new Date(receipt.activatedAtEpochMs);
  const activatedAtLabel = Number.isNaN(activatedAt.getTime())
    ? "Activation time unavailable"
    : `${new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(activatedAt)} UTC`;
  return (
    <div
      className="flex flex-wrap items-start justify-between gap-3 border-b border-[#33ccbb]/30 bg-[#0d211c] px-4 py-3 sm:px-7"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Check className="mt-0.5 h-5 w-5 shrink-0 text-[#73e9dc]" />
        <div className="min-w-0">
          <p className="text-sm font-black text-[#b6e9e2]">
            Revision {receipt.revisionId.slice(0, 8)} is live.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#8fbab4]">
            {receipt.changedCount} {receipt.changedCount === 1 ? "setting" : "settings"} activated
            {receipt.changedGroups ? ` across ${receipt.changedGroups}.` : "."} {activatedAtLabel}.
          </p>
        </div>
      </div>
      <button type="button" className={smallButton} onClick={onViewHistory}>
        VIEW ACTIVATION HISTORY
      </button>
    </div>
  );
}

const primaryButton =
  "inline-flex items-center justify-center gap-2 bg-[#33ccbb] px-4 py-2.5 text-xs font-black tracking-wide text-[#07100e] transition hover:bg-[#73e9dc] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc] disabled:cursor-not-allowed disabled:opacity-40";
const secondaryButton =
  "inline-flex items-center justify-center gap-2 border border-white/15 bg-[#101a17] px-4 py-2.5 text-xs font-black tracking-wide text-white/70 transition hover:border-[#33ccbb]/45 hover:bg-[#33ccbb]/10 hover:text-[#9ef4e8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc] disabled:cursor-not-allowed disabled:opacity-35";
const smallButton =
  "inline-flex min-h-11 items-center justify-center border border-white/15 px-3 py-2 font-mono text-[9px] font-black tracking-wide text-white/75 transition hover:border-[#33ccbb]/45 hover:text-[#9ef4e8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc] disabled:cursor-not-allowed disabled:opacity-30 sm:min-h-9";
const iconButton =
  "inline-flex h-11 w-11 items-center justify-center border border-white/10 text-white/65 transition hover:border-[#33ccbb]/45 hover:text-[#9ef4e8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc] disabled:cursor-not-allowed disabled:opacity-25 sm:h-9 sm:w-9";
