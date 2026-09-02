import { Clock, Context, Data, Effect, Layer, Option, Predicate, Schema } from "effect";
import { ReadonlyJSONValue as ReadonlyJSONValueSchema } from "typhoon-zero/schema";
import type { ActorProvenance, EffectivePrincipal } from "sheet-auth/identity";
import {
  SheetConfigurationDiagnostic,
  SheetConfigurationSource,
  SheetConfigurationSource as ConfigurationSource,
  LegacySourceBinding,
  migrateLegacySource,
  migrateLegacySourceBinding,
  SheetRange,
  SheetRangeCoordinates,
  WebSheetConfiguration,
  normalizeConfiguration,
  parseSheetRange,
  sheetRangeCoordinatesFrom,
  sheetTitleFromRange,
  sourceForLegacySettings,
  sheetConfigurationRanges,
  validateWebSheetConfiguration,
} from "sheet-domain";
import {
  type SheetConfigurationActivateInput,
  type SheetConfigurationActivateSuccess,
  type SheetConfigurationDiscardDraftInput,
  type SheetConfigurationDiscardDraftSuccess,
  type SheetConfigurationEditDraftInput,
  type SheetConfigurationEditDraftSuccess,
  type SheetConfigurationImportLegacyInput,
  type SheetConfigurationImportLegacySuccess,
  type SheetConfigurationRollbackInput,
  type SheetConfigurationRollbackSuccess,
  type SheetConfigurationSaveDraftInput,
  type SheetConfigurationSaveDraftSuccess,
  type SheetConfigurationSaveRevisionInput,
  type SheetConfigurationSaveRevisionSuccess,
  type SheetSnapshotTab,
  type WorkspaceId,
  type InteractiveDeclaredFailure,
} from "sheet-workflow-contracts";
import { SheetDataProvider } from "@/services/sheetDataProvider";
import {
  SheetSnapshotProvider,
  SheetSnapshotProviderError,
} from "../readOnly/sheetSnapshotProvider";
import {
  interactiveBusinessRuleRejected,
  interactiveConfigurationMissing,
  interactiveExternalOperationRejected,
  interactiveInvalidRequest,
  interactiveResourceNotFound,
} from "../shared/interactive";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import {
  legacyConfigurationRowsFromSnapshot,
  legacySettingsExpectedTitle,
  legacySettingsSnapshotWindow,
  parseLegacyConfiguration,
} from "../configuration/legacyConfiguration";

class SheetConfigurationWorkflowOperationsError extends Data.TaggedError(
  "SheetConfigurationWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type ReadonlyJSONValue = typeof ReadonlyJSONValueSchema.Type;
type LifecycleResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | SheetConfigurationWorkflowOperationsError
>;

export type Attribution = {
  readonly invocationId: string;
  readonly principal: EffectivePrincipal;
  readonly actorProvenance?: ActorProvenance | undefined;
};

type SheetConfigurationPersistence = NonNullable<
  TrustedSheetPersistence["Service"]["sheetConfiguration"]
>;

type ImportAttemptResult = {
  readonly draftVersion: number;
  readonly source: typeof SheetConfigurationSource.Type;
  readonly configuration: typeof WebSheetConfiguration.Type | null;
  readonly diagnostics: ReadonlyArray<typeof SheetConfigurationDiagnostic.Type>;
  readonly baselineDigest: string;
};

type Configuration = typeof WebSheetConfiguration.Type;
type DraftEdit = SheetConfigurationEditDraftInput["edit"];
type ConfigurationEntry =
  | Configuration["teams"][number]
  | Configuration["schedules"][number]
  | Configuration["runners"][number];

const ImportAttemptResultSchema = Schema.Struct({
  draftVersion: Schema.Int,
  source: SheetConfigurationSource,
  configuration: Schema.NullOr(WebSheetConfiguration),
  diagnostics: Schema.Array(SheetConfigurationDiagnostic),
  baselineDigest: Schema.String,
});

const operationError = (operation: string, cause: unknown) =>
  new SheetConfigurationWorkflowOperationsError({ operation, cause });

const optionalPersistence = (
  persistence: TrustedSheetPersistence["Service"],
): Effect.Effect<SheetConfigurationPersistence, SheetConfigurationWorkflowOperationsError> =>
  Predicate.isUndefined(persistence.sheetConfiguration)
    ? Effect.fail(
        operationError(
          "sheetConfiguration.persistence",
          "Configuration persistence is unavailable",
        ),
      )
    : Effect.succeed(persistence.sheetConfiguration);

const decodeSource = (value: unknown): typeof SheetConfigurationSource.Type | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(SheetConfigurationSource)(migrateLegacySource(value)),
  );

const principalJson = (principal: EffectivePrincipal): ReadonlyJSONValue => principal;
const provenanceJson = (provenance: ActorProvenance | undefined): ReadonlyJSONValue | null =>
  provenance ?? null;

const attributionFields = (attribution: Attribution) => ({
  invocationId: attribution.invocationId,
  effectivePrincipal: principalJson(attribution.principal),
  actorProvenance: provenanceJson(attribution.actorProvenance),
});

type FailureAuditOutcome = "invalid" | "conflict" | "denied" | "failed";

const conflictFailureCodes = new Set(["ConfigurationConflict"]);
const sheetConfigurationVersionConflictCode = "SHEET_CONFIGURATION_VERSION_CONFLICT";

const stringProperty = (value: unknown, property: string): string | undefined =>
  Predicate.isObject(value) &&
  Predicate.hasProperty(value, property) &&
  Predicate.isString(value[property])
    ? value[property]
    : undefined;

const isSheetConfigurationVersionConflict = (error: unknown): boolean =>
  Predicate.isTagged("ArgumentError")(error) &&
  Predicate.hasProperty(error, "cause") &&
  stringProperty(error.cause, "code") === sheetConfigurationVersionConflictCode;

// Failure classification keeps all externally observable audit outcomes in one decision table.
// fallow-ignore-next-line complexity
const failureAuditDetails = (
  error: unknown,
): {
  readonly outcome: FailureAuditOutcome;
  readonly reason: string;
  readonly metadata: Readonly<Record<string, string>>;
} => {
  const failureTag = stringProperty(error, "_tag") ?? "UnknownFailure";
  const code = stringProperty(error, "code");
  if (failureTag === "AuthorizationRevoked") {
    return {
      outcome: "denied",
      reason: failureTag,
      metadata: { failureTag },
    };
  }
  if (code !== undefined && conflictFailureCodes.has(code)) {
    return {
      outcome: "conflict",
      reason: code,
      metadata: { failureTag, code },
    };
  }
  if (
    failureTag === "ExternalOperationRejected" ||
    failureTag === "SheetConfigurationWorkflowOperationsError"
  ) {
    return {
      outcome: "failed",
      reason: code ?? failureTag,
      metadata: { failureTag, ...(code === undefined ? {} : { code }) },
    };
  }
  return {
    outcome: "invalid",
    reason: code ?? failureTag,
    metadata: { failureTag, ...(code === undefined ? {} : { code }) },
  };
};

const mapPersistenceError = (operation: string) => (error: unknown) =>
  isSheetConfigurationVersionConflict(error)
    ? interactiveInvalidRequest(
        "ConfigurationConflict",
        "The Sheet Configuration changed in another session.",
      )
    : operationError(operation, error);

const mapSnapshotError = (error: unknown) => {
  if (!Predicate.isTagged("SheetSnapshotProviderError")(error)) {
    return operationError("sheetConfiguration.importLegacy.snapshot", error);
  }
  const providerError = error as SheetSnapshotProviderError;
  return providerError.code === "SheetMissing"
    ? interactiveResourceNotFound("sheet")
    : providerError.code === "UnsupportedSheetType"
      ? interactiveInvalidRequest(
          "UnsupportedSheetType",
          "The legacy settings source must be a Google Sheets GRID tab.",
        )
      : interactiveExternalOperationRejected(
          "sheetConfiguration.importLegacy.snapshot",
          providerError.code,
          "Google Sheets rejected the legacy configuration read.",
        );
};

const settingsTab = (
  tabs: ReadonlyArray<SheetSnapshotTab>,
  expectedTitle: string,
  boundSheetId?: number,
): SheetSnapshotTab | undefined =>
  boundSheetId === undefined
    ? (() => {
        const matches = tabs.filter((tab) => tab.title === expectedTitle);
        return matches.length === 1 ? matches[0] : undefined;
      })()
    : tabs.find((tab) => tab.sheetId === boundSheetId);

const configurationBindingDiagnostics = (
  configuration: typeof WebSheetConfiguration.Type,
  tabs: ReadonlyArray<SheetSnapshotTab>,
): ReadonlyArray<typeof SheetConfigurationDiagnostic.Type> => {
  const tabsById = new Map(tabs.map((tab) => [tab.sheetId, tab] as const));
  const diagnostics: Array<typeof SheetConfigurationDiagnostic.Type> = [];
  for (const [path, range] of sheetConfigurationRanges(configuration)) {
    const tab = tabsById.get(range.sheetId);
    if (tab === undefined) {
      diagnostics.push({
        code: "SheetMissing",
        path,
        message: `The configured sheet tab ${range.sheetId} is missing or was recreated.`,
        severity: "error",
      });
      continue;
    }
    const endRowOutOfBounds = range.endRow !== "sheet-end" && range.endRow > tab.rowCount;
    const rowStartOutOfBounds = range.startRow >= tab.rowCount;
    const columnOutOfBounds =
      range.startColumn >= tab.columnCount || range.endColumn > tab.columnCount;
    if (rowStartOutOfBounds || endRowOutOfBounds || columnOutOfBounds) {
      diagnostics.push({
        code: "SheetOutOfBounds",
        path,
        message: `The configured range is outside the current bounds of ${tab.title}.`,
        severity: "error",
      });
    }
  }
  return diagnostics;
};

const validateConfigurationBindings = (options: {
  readonly configuration: typeof WebSheetConfiguration.Type;
  readonly snapshotProvider: SheetSnapshotProvider["Service"];
}): LifecycleResult<ReadonlyArray<typeof SheetConfigurationDiagnostic.Type>> =>
  options.snapshotProvider.describe(options.configuration.spreadsheetId, "fresh").pipe(
    Effect.mapError(mapSnapshotError),
    Effect.map(({ tabs }) => configurationBindingDiagnostics(options.configuration, tabs)),
  );

const currentSource = (
  persistence: TrustedSheetPersistence["Service"],
  workspaceId: WorkspaceId,
): LifecycleResult<typeof SheetConfigurationSource.Type> =>
  Effect.gen(function* () {
    if (persistence.sheetConfiguration !== undefined) {
      const current = yield* persistence.sheetConfiguration
        .getSheetConfiguration({ workspaceId })
        .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.load")));
      if (Option.isSome(current)) {
        const source = decodeSource(current.value.source);
        if (source === undefined) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "InvalidStoredSource",
              "The stored Sheet Configuration source is invalid.",
            ),
          );
        }
        return source;
      }
    }

    const workspace = yield* persistence.workspaces
      .getWorkspaceConfigByWorkspaceId({ workspaceId })
      .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.loadWorkspace")));
    if (
      Option.isSome(workspace) &&
      Predicate.isString(workspace.value.sheetId) &&
      workspace.value.sheetId.trim().length > 0
    ) {
      return sourceForLegacySettings();
    }
    return { kind: "owned" as const, revisionId: null };
  });

const sourceForWorkspace = (
  persistence: TrustedSheetPersistence["Service"],
  workspaceId: WorkspaceId,
): LifecycleResult<typeof SheetConfigurationSource.Type> =>
  currentSource(persistence, workspaceId).pipe(
    Effect.flatMap((source) => {
      if (source.kind === "legacy") return Effect.succeed(source);
      return source.revisionId === null
        ? Effect.fail(interactiveConfigurationMissing("legacy spreadsheet"))
        : Effect.fail(
            interactiveInvalidRequest(
              "OwnedSourceActive",
              "Legacy import is available only while the legacy source is active.",
            ),
          );
    }),
  );

const sourceForDraft = (
  persistence: TrustedSheetPersistence["Service"],
  workspaceId: WorkspaceId,
): LifecycleResult<typeof SheetConfigurationSource.Type> => currentSource(persistence, workspaceId);

const spreadsheetForLegacySource = (
  dataProvider: SheetDataProvider["Service"],
  workspaceId: WorkspaceId,
  source: typeof ConfigurationSource.Type,
): LifecycleResult<string> =>
  Effect.gen(function* () {
    if (source.kind !== "legacy") {
      return yield* Effect.fail(
        interactiveInvalidRequest("OwnedSourceActive", "The legacy source is not active."),
      );
    }
    if (source.binding.status === "bound") return source.binding.spreadsheetId;
    const resolved = yield* dataProvider
      .resolveSpreadsheetId(workspaceId)
      .pipe(
        Effect.mapError((error) => operationError("sheetConfiguration.resolveSpreadsheet", error)),
      );
    return yield* Option.match(resolved, {
      onNone: () => Effect.fail(interactiveConfigurationMissing("legacy spreadsheet")),
      onSome: (spreadsheetId) => Effect.succeed(spreadsheetId),
    });
  });

const persistAttempt = (
  persistence: SheetConfigurationPersistence,
  input: {
    readonly attemptId: string;
    readonly workspaceId: WorkspaceId;
    readonly status: "running" | "succeeded" | "needs-review" | "failed";
    readonly sourceBinding: ReadonlyJSONValue;
    readonly baselineDigest: string;
    readonly result: ReadonlyJSONValue | null;
    readonly createdBy: string;
  },
  attribution: Attribution,
): LifecycleResult<void> =>
  persistence
    .upsertSheetConfigurationImportAttempt({
      ...input,
      ...attributionFields(attribution),
    })
    .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.importAttempt")));

const importResultFromRow = (value: unknown): ImportAttemptResult | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(ImportAttemptResultSchema)(value));

const readLegacySnapshot = (options: {
  readonly spreadsheetId: string;
  readonly source: typeof SheetConfigurationSource.Type;
  readonly snapshotProvider: SheetSnapshotProvider["Service"];
}): LifecycleResult<{
  readonly source: typeof SheetConfigurationSource.Type;
  readonly configuration: typeof WebSheetConfiguration.Type | null;
  readonly diagnostics: ReadonlyArray<typeof SheetConfigurationDiagnostic.Type>;
  readonly baselineDigest: string;
}> =>
  // Legacy import is one transactional boundary so its read, parse, baseline, and audit result
  // cannot drift apart.
  // fallow-ignore-next-line complexity
  Effect.gen(function* () {
    const description = yield* options.snapshotProvider
      .describe(options.spreadsheetId, "fresh")
      .pipe(Effect.mapError(mapSnapshotError));
    const expectedTitle =
      options.source.kind === "legacy"
        ? options.source.binding.expectedTitle
        : legacySettingsExpectedTitle;
    const boundSheetId =
      options.source.kind === "legacy" && options.source.binding.status === "bound"
        ? options.source.binding.sheetId
        : undefined;
    const tab = settingsTab(description.tabs, expectedTitle, boundSheetId);
    const snapshot =
      tab === undefined
        ? undefined
        : yield* options.snapshotProvider
            .readSnapshot(options.spreadsheetId, tab.sheetId, legacySettingsSnapshotWindow, "fresh")
            .pipe(Effect.mapError(mapSnapshotError));
    const rows = legacyConfigurationRowsFromSnapshot(snapshot?.cells ?? []);
    const parsed = parseLegacyConfiguration({
      spreadsheetId: options.spreadsheetId,
      tabs: description.tabs,
      rows,
      expectedTitle,
      ...(boundSheetId === undefined ? {} : { boundSheetId }),
    });
    const parsedDiagnostics = parsed.diagnostics;
    const validated =
      parsed.configuration === null
        ? []
        : yield* validateWebSheetConfiguration(parsed.configuration).pipe(
            Effect.mapError((error) => operationError("sheetConfiguration.validate", error)),
          );
    const bindingDiagnostics =
      parsed.configuration === null
        ? []
        : configurationBindingDiagnostics(parsed.configuration, description.tabs);
    const diagnostics = [...parsedDiagnostics, ...validated, ...bindingDiagnostics];
    return {
      source: parsed.source,
      configuration:
        parsed.configuration === null ? null : normalizeConfiguration(parsed.configuration),
      diagnostics,
      baselineDigest: parsed.baselineDigest,
    };
  });

const hasBlockingDiagnostics = (
  diagnostics: ReadonlyArray<typeof SheetConfigurationDiagnostic.Type>,
): boolean => diagnostics.some(({ severity }) => severity === "error");

const configurationEntryNotFound = (collection: string, entryId: string) =>
  interactiveResourceNotFound(`${collection} configuration entry`, entryId);

const requireConfigurationEntry = <A extends ConfigurationEntry>(
  entries: ReadonlyArray<A>,
  collection: string,
  entryId: string,
): LifecycleResult<{ readonly index: number; readonly entry: A }> => {
  const index = entries.findIndex(({ entryId: candidate }) => candidate === entryId);
  const entry = entries[index];
  return entry === undefined
    ? Effect.fail(configurationEntryNotFound(collection, entryId))
    : Effect.succeed({ index, entry });
};

const invalidDraftEdit = (message: string) =>
  interactiveInvalidRequest("InvalidDraftEdit", message);

const insertAt = <A>(entries: ReadonlyArray<A>, entry: A, position: number): ReadonlyArray<A> => [
  ...entries.slice(0, position),
  entry,
  ...entries.slice(position),
];

const replaceAt = <A>(entries: ReadonlyArray<A>, index: number, entry: A): ReadonlyArray<A> => [
  ...entries.slice(0, index),
  entry,
  ...entries.slice(index + 1),
];

const moveEntry = <A>(entries: ReadonlyArray<A>, from: number, to: number): ReadonlyArray<A> => {
  const entry = entries[from];
  if (entry === undefined) return entries;
  const withoutEntry = [...entries.slice(0, from), ...entries.slice(from + 1)];
  return insertAt(withoutEntry, entry, to);
};

const localRangeFrom = (range: typeof SheetRange.Type): typeof SheetRangeCoordinates.Type =>
  sheetRangeCoordinatesFrom(range);

const resolveSheetRange = (options: {
  readonly snapshotProvider: SheetSnapshotProvider["Service"];
  readonly spreadsheetId: string;
  readonly a1: string;
}): LifecycleResult<typeof SheetRange.Type> =>
  Effect.gen(function* () {
    const title = sheetTitleFromRange(options.a1);
    if (title === undefined) {
      return yield* Effect.fail(
        invalidDraftEdit("Ranges must be one contiguous tab-qualified A1 reference."),
      );
    }
    const description = yield* options.snapshotProvider
      .describe(options.spreadsheetId, "fresh")
      .pipe(Effect.mapError(mapSnapshotError));
    const matchingTabs = description.tabs.filter((candidate) => candidate.title === title);
    const tab = matchingTabs.length === 1 ? matchingTabs[0] : undefined;
    if (tab === undefined) {
      return yield* Effect.fail(
        matchingTabs.length > 1
          ? invalidDraftEdit("The tab-qualified A1 range must identify one unique sheet tab.")
          : interactiveResourceNotFound("sheet tab", title),
      );
    }
    const range = parseSheetRange(options.a1, tab.sheetId);
    if (range === undefined) {
      return yield* Effect.fail(invalidDraftEdit("The tab-qualified A1 range is not valid."));
    }
    return range;
  });

const applyDraftEdit = (options: {
  readonly configuration: Configuration;
  readonly edit: DraftEdit;
  readonly resolveRange: (a1: string) => LifecycleResult<typeof SheetRange.Type>;
}): LifecycleResult<Configuration> =>
  // Draft edits intentionally centralize the typed field/path state machine at the workflow edge.
  // fallow-ignore-next-line complexity
  Effect.gen(function* () {
    const { configuration, edit } = options;
    if (edit.kind === "setSpreadsheetId") {
      return { ...configuration, spreadsheetId: edit.value };
    }
    if (edit.kind === "setEventStartTime") {
      return { ...configuration, event: { startTimeEpochMs: edit.value } };
    }
    if (edit.kind === "setTeamName") {
      const { index, entry: team } = yield* requireConfigurationEntry(
        configuration.teams,
        "team",
        edit.entryId,
      );
      const updatedTeam =
        edit.value === null
          ? (() => {
              const { name: _name, ...withoutName } = team;
              return withoutName;
            })()
          : { ...team, name: edit.value };
      return { ...configuration, teams: replaceAt(configuration.teams, index, updatedTeam) };
    }
    if (edit.kind === "setScheduleChannel") {
      const { index, entry: schedule } = yield* requireConfigurationEntry(
        configuration.schedules,
        "schedule",
        edit.entryId,
      );
      return {
        ...configuration,
        schedules: replaceAt(configuration.schedules, index, { ...schedule, channel: edit.value }),
      };
    }
    if (edit.kind === "setScheduleDay") {
      const { index, entry: schedule } = yield* requireConfigurationEntry(
        configuration.schedules,
        "schedule",
        edit.entryId,
      );
      return {
        ...configuration,
        schedules: replaceAt(configuration.schedules, index, { ...schedule, day: edit.value }),
      };
    }
    if (edit.kind === "setScheduleEncoding") {
      const { index, entry: schedule } = yield* requireConfigurationEntry(
        configuration.schedules,
        "schedule",
        edit.entryId,
      );
      return {
        ...configuration,
        schedules: replaceAt(configuration.schedules, index, {
          ...schedule,
          encoding: edit.value,
        }),
      };
    }
    if (edit.kind === "setRunnerName") {
      const { index, entry: runner } = yield* requireConfigurationEntry(
        configuration.runners,
        "runner",
        edit.entryId,
      );
      return {
        ...configuration,
        runners: replaceAt(configuration.runners, index, { ...runner, name: edit.value }),
      };
    }
    if (edit.kind === "setTeamTags") {
      const { index, entry: team } = yield* requireConfigurationEntry(
        configuration.teams,
        "team",
        edit.entryId,
      );
      return {
        ...configuration,
        teams: replaceAt(configuration.teams, index, {
          ...team,
          tags: { kind: "constants", values: edit.values },
        }),
      };
    }
    if (edit.kind === "setRange") {
      const parsedRange = yield* options.resolveRange(edit.a1);
      const localRange = localRangeFrom(parsedRange);
      if (edit.path.startsWith("users.")) {
        if (edit.entryId !== null) {
          return yield* Effect.fail(invalidDraftEdit("User ranges do not accept an entry ID."));
        }
        if (edit.path === "users.userIds") {
          return { ...configuration, users: { ...configuration.users, userIds: parsedRange } };
        }
        if (edit.path === "users.userSheetNames") {
          return {
            ...configuration,
            users: { ...configuration.users, userSheetNames: parsedRange },
          };
        }
        if (edit.path === "users.userNotes") {
          return { ...configuration, users: { ...configuration.users, userNotes: parsedRange } };
        }
        if (edit.path === "users.oshis") {
          return { ...configuration, users: { ...configuration.users, oshis: parsedRange } };
        }
        if (configuration.users.monitors === undefined) {
          return yield* Effect.fail(
            invalidDraftEdit("Configure both monitor ranges before editing either monitor range."),
          );
        }
        const monitors = configuration.users.monitors;
        return {
          ...configuration,
          users: {
            ...configuration.users,
            monitors: {
              ...monitors,
              [edit.path.endsWith(".ids") ? "ids" : "names"]: parsedRange,
            },
          },
        };
      }
      if (edit.entryId === null) {
        return yield* Effect.fail(
          invalidDraftEdit("Team and schedule ranges require a stable entry ID."),
        );
      }
      if (edit.path.startsWith("teams.")) {
        const { index, entry: team } = yield* requireConfigurationEntry(
          configuration.teams,
          "team",
          edit.entryId,
        );
        if (edit.path === "teams.teamName") {
          return {
            ...configuration,
            teams: replaceAt(configuration.teams, index, { ...team, teamName: localRange }),
          };
        }
        if (edit.path === "teams.userNames") {
          return {
            ...configuration,
            teams: replaceAt(configuration.teams, index, { ...team, userNames: localRange }),
          };
        }
        if (edit.path === "teams.oshiRange") {
          return {
            ...configuration,
            teams: replaceAt(configuration.teams, index, { ...team, oshiRange: localRange }),
          };
        }
        if (edit.path === "teams.tags") {
          if (team.tags.kind !== "ranges") {
            return yield* Effect.fail(
              invalidDraftEdit("The selected team uses constant tags, not a tag range."),
            );
          }
          return {
            ...configuration,
            teams: replaceAt(configuration.teams, index, {
              ...team,
              tags: { kind: "ranges", range: localRange },
            }),
          };
        }
        if (edit.path === "teams.isv") {
          if (team.isv.kind !== "combined") {
            return yield* Effect.fail(invalidDraftEdit("The selected team uses split ISV ranges."));
          }
          return {
            ...configuration,
            teams: replaceAt(configuration.teams, index, {
              ...team,
              isv: { kind: "combined", range: localRange },
            }),
          };
        }
        if (team.isv.kind !== "split" || !edit.path.startsWith("teams.isv.")) {
          return yield* Effect.fail(
            invalidDraftEdit("The selected team ISV shape does not match the range field."),
          );
        }
        const candidateIsvField = edit.path.slice("teams.isv.".length);
        if (
          candidateIsvField !== "lead" &&
          candidateIsvField !== "backline" &&
          candidateIsvField !== "talent"
        ) {
          return yield* Effect.fail(invalidDraftEdit("The ISV range field is not recognized."));
        }
        const isvField = candidateIsvField;
        return {
          ...configuration,
          teams: replaceAt(configuration.teams, index, {
            ...team,
            isv: { ...team.isv, [isvField]: localRange },
          }),
        };
      }
      if (!edit.path.startsWith("schedules.")) {
        return yield* Effect.fail(invalidDraftEdit("The schedule range field is not recognized."));
      }
      const { index, entry: schedule } = yield* requireConfigurationEntry(
        configuration.schedules,
        "schedule",
        edit.entryId,
      );
      const scheduleRangeFields = [
        "hourRange",
        "breakRange",
        "monitorRange",
        "fillRange",
        "overfillRange",
        "standbyRange",
        "screenshotRange",
        "noteRange",
        "visibleCell",
      ] as const;
      const candidateScheduleField = edit.path.slice("schedules.".length);
      const scheduleField = scheduleRangeFields.find((field) => field === candidateScheduleField);
      if (scheduleField === undefined) {
        return yield* Effect.fail(invalidDraftEdit("The schedule range field is not recognized."));
      }
      return {
        ...configuration,
        schedules: replaceAt(configuration.schedules, index, {
          ...schedule,
          [scheduleField]: localRange,
        }),
      };
    }
    if (edit.kind === "addEntry") {
      const coordinates = localRangeFrom(configuration.users.userIds);
      if (edit.position > configuration[edit.collection].length) {
        return yield* Effect.fail(
          invalidDraftEdit("The new entry position is outside the collection."),
        );
      }
      if (
        configuration.teams.some(({ entryId }) => entryId === edit.entryId) ||
        configuration.schedules.some(({ entryId }) => entryId === edit.entryId) ||
        configuration.runners.some(({ entryId }) => entryId === edit.entryId)
      ) {
        return yield* Effect.fail(
          invalidDraftEdit("Entry IDs must be unique across the configuration."),
        );
      }
      if (edit.collection === "teams") {
        const entry = {
          entryId: edit.entryId,
          name: `Team ${edit.position + 1}`,
          sheetId: configuration.users.userIds.sheetId,
          teamName: "auto" as const,
          userNames: { ...coordinates },
          isv: { kind: "combined" as const, range: { ...coordinates } },
          tags: { kind: "constants" as const, values: [] },
        };
        return { ...configuration, teams: insertAt(configuration.teams, entry, edit.position) };
      }
      if (edit.collection === "schedules") {
        const usedChannels = new Set(configuration.schedules.map(({ channel }) => channel));
        let channel = `channel-${edit.position + 1}`;
        let suffix = edit.position + 1;
        while (usedChannels.has(channel)) channel = `channel-${++suffix}`;
        const usedDays = new Set(configuration.schedules.map(({ day }) => day));
        let day = 1;
        while (usedDays.has(day)) day += 1;
        const entry = {
          entryId: edit.entryId,
          channel,
          day,
          sheetId: configuration.users.userIds.sheetId,
          hourRange: { ...coordinates },
          breakRange: "auto" as const,
          encoding: "none" as const,
          fillRange: { ...coordinates },
          overfillRange: { ...coordinates },
          standbyRange: { ...coordinates },
          visibleCell: { ...coordinates },
        };
        return {
          ...configuration,
          schedules: insertAt(configuration.schedules, entry, edit.position),
        };
      }
      const entry = {
        entryId: edit.entryId,
        name: `Runner ${edit.position + 1}`,
        hours: [],
      };
      return { ...configuration, runners: insertAt(configuration.runners, entry, edit.position) };
    }
    if (edit.kind === "removeEntry") {
      const entries: ReadonlyArray<ConfigurationEntry> = configuration[edit.collection];
      const { index } = yield* requireConfigurationEntry(entries, edit.collection, edit.entryId);
      return {
        ...configuration,
        [edit.collection]: [...entries.slice(0, index), ...entries.slice(index + 1)],
      };
    }
    const entries: ReadonlyArray<ConfigurationEntry> = configuration[edit.collection];
    const { index } = yield* requireConfigurationEntry(entries, edit.collection, edit.entryId);
    if (edit.position >= entries.length) {
      return yield* Effect.fail(invalidDraftEdit("The entry position is outside the collection."));
    }
    return { ...configuration, [edit.collection]: moveEntry(entries, index, edit.position) };
  });

export interface SheetConfigurationWorkflowOperationsShape {
  readonly recordFailureAudit: (input: {
    readonly workspaceId: WorkspaceId;
    readonly operation: string;
    readonly attribution: Attribution;
    readonly error: unknown;
  }) => Effect.Effect<void, never>;
  readonly importLegacy: (
    input: SheetConfigurationImportLegacyInput,
    attribution: Attribution,
  ) => LifecycleResult<SheetConfigurationImportLegacySuccess>;
  readonly saveDraft: (
    input: SheetConfigurationSaveDraftInput,
    attribution: Attribution,
  ) => LifecycleResult<SheetConfigurationSaveDraftSuccess>;
  readonly editDraft: (
    input: SheetConfigurationEditDraftInput,
    attribution: Attribution,
  ) => LifecycleResult<SheetConfigurationEditDraftSuccess>;
  readonly saveRevision: (
    input: SheetConfigurationSaveRevisionInput,
    attribution: Attribution,
  ) => LifecycleResult<SheetConfigurationSaveRevisionSuccess>;
  readonly activate: (
    input: SheetConfigurationActivateInput,
    attribution: Attribution,
  ) => LifecycleResult<SheetConfigurationActivateSuccess>;
  readonly rollback: (
    input: SheetConfigurationRollbackInput,
    attribution: Attribution,
  ) => LifecycleResult<SheetConfigurationRollbackSuccess>;
  readonly discardDraft: (
    input: SheetConfigurationDiscardDraftInput,
    attribution: Attribution,
  ) => LifecycleResult<SheetConfigurationDiscardDraftSuccess>;
}

export class SheetConfigurationWorkflowOperations extends Context.Service<
  SheetConfigurationWorkflowOperations,
  SheetConfigurationWorkflowOperationsShape
>()("sheet-workflows/SheetConfigurationWorkflowOperations") {}

export const sheetConfigurationWorkflowOperationsLayer = Layer.effect(
  SheetConfigurationWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const dataProvider = yield* SheetDataProvider;
    const snapshotProvider = yield* SheetSnapshotProvider;

    const recordFailureAudit: SheetConfigurationWorkflowOperationsShape["recordFailureAudit"] = ({
      workspaceId,
      operation,
      attribution,
      error,
    }) => {
      const details = failureAuditDetails(error);
      return optionalPersistence(persistence).pipe(
        Effect.flatMap((configurationPersistence) =>
          configurationPersistence
            .recordSheetConfigurationAudit({
              workspaceId,
              operation,
              outcome: details.outcome,
              metadata: details.metadata,
              reason: details.reason,
              ...attributionFields(attribution),
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Unable to record Sheet Configuration failure audit").pipe(
                  Effect.annotateLogs({
                    auditFailure: "persistence",
                    workspaceId,
                    operation,
                    cause,
                  }),
                  Effect.asVoid,
                ),
              ),
            ),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Unable to resolve Sheet Configuration failure audit persistence").pipe(
            Effect.annotateLogs({
              auditFailure: "optional-persistence",
              workspaceId,
              operation,
              cause,
            }),
            Effect.asVoid,
          ),
        ),
      );
    };

    const importLegacy: SheetConfigurationWorkflowOperationsShape["importLegacy"] = (
      input,
      attribution,
    ) =>
      // Import attempts are idempotent and reconcile persistence, provider reads, and audit
      // outcomes in one reviewable operation.
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const configurationPersistence = yield* optionalPersistence(persistence);
        const currentAttempt = yield* configurationPersistence
          .getSheetConfigurationImportAttempt({
            workspaceId: input.workspaceId,
            attemptId: input.attemptId,
          })
          .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.importAttempt")));
        if (Option.isSome(currentAttempt)) {
          if (currentAttempt.value.workspaceId !== input.workspaceId) {
            return yield* Effect.fail(
              interactiveInvalidRequest(
                "ImportAttemptWorkspaceMismatch",
                "The import attempt belongs to another workspace.",
              ),
            );
          }
          const result = importResultFromRow(currentAttempt.value.result);
          if (
            result !== undefined &&
            (currentAttempt.value.status === "succeeded" ||
              currentAttempt.value.status === "needs-review")
          ) {
            return {
              workspaceId: input.workspaceId,
              attemptId: input.attemptId,
              status: currentAttempt.value.status,
              ...result,
            };
          }
          if (currentAttempt.value.status === "running") {
            return yield* Effect.fail(
              interactiveBusinessRuleRejected(
                "ImportInProgress",
                "This legacy import is already in progress.",
              ),
            );
          }
          if (currentAttempt.value.status === "failed") {
            return yield* Effect.fail(
              interactiveBusinessRuleRejected(
                "ImportAttemptFailed",
                "Start a new import attempt after a failed legacy import.",
              ),
            );
          }
        }

        const source = yield* sourceForWorkspace(persistence, input.workspaceId);
        const current = yield* configurationPersistence
          .getSheetConfiguration({ workspaceId: input.workspaceId })
          .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.load")));
        if (
          Option.isSome(current) &&
          (current.value.draft !== null || current.value.baselineDigest !== null) &&
          Option.isNone(currentAttempt)
        ) {
          return yield* Effect.fail(
            interactiveBusinessRuleRejected(
              "DraftAlreadyExists",
              "Discard the existing draft before starting another legacy import.",
            ),
          );
        }

        const sourceBinding: ReadonlyJSONValue = source.kind === "legacy" ? source.binding : source;
        const createdBy =
          attribution.principal.kind === "user"
            ? attribution.principal.userId
            : attribution.principal.kind === "service"
              ? attribution.principal.serviceId
              : "unknown";
        const markAttemptFailed = (baselineDigest: string) =>
          persistAttempt(
            configurationPersistence,
            {
              attemptId: input.attemptId,
              workspaceId: input.workspaceId,
              status: "failed",
              sourceBinding,
              baselineDigest,
              result: null,
              createdBy,
            },
            attribution,
          ).pipe(Effect.catch(() => Effect.void));
        const failAfterMarking = (
          baselineDigest: string,
          error: InteractiveDeclaredFailure | SheetConfigurationWorkflowOperationsError,
        ): LifecycleResult<never> =>
          markAttemptFailed(baselineDigest).pipe(Effect.andThen(Effect.fail(error)));

        yield* persistAttempt(
          configurationPersistence,
          {
            attemptId: input.attemptId,
            workspaceId: input.workspaceId,
            status: "running",
            sourceBinding,
            baselineDigest: "pending",
            result: null,
            createdBy,
          },
          attribution,
        );
        const spreadsheetId = yield* spreadsheetForLegacySource(
          dataProvider,
          input.workspaceId,
          source,
        ).pipe(Effect.tapError((error) => markAttemptFailed("pending").pipe(Effect.as(error))));

        const observed = yield* readLegacySnapshot({
          spreadsheetId,
          source,
          snapshotProvider,
        }).pipe(Effect.tapError((error) => markAttemptFailed("pending").pipe(Effect.as(error))));
        if (observed.source.kind === "legacy" && observed.source.binding.status === "unresolved") {
          return yield* failAfterMarking(
            observed.baselineDigest,
            interactiveResourceNotFound("legacy settings tab"),
          );
        }
        if (observed.diagnostics.some(({ code }) => code === "LegacySourceChanged")) {
          return yield* failAfterMarking(
            observed.baselineDigest,
            interactiveBusinessRuleRejected(
              "LegacySourceChanged",
              "The legacy settings tab changed since this workspace was bound. Rebind the source before importing.",
            ),
          );
        }
        const diagnostics = observed.diagnostics;
        const existingDraft = Option.isSome(current) ? current.value : undefined;
        const reused =
          existingDraft !== undefined &&
          existingDraft.draft !== null &&
          existingDraft.baselineDigest === observed.baselineDigest;
        let draftVersion: number;
        let configuration = observed.configuration;
        let draftSource = observed.source;
        let draftDiagnostics = diagnostics;
        if (reused) {
          draftVersion = existingDraft.draftVersion;
          configuration = yield* Schema.decodeUnknownEffect(WebSheetConfiguration)(
            existingDraft.draft,
          ).pipe(
            Effect.mapError(() =>
              interactiveInvalidRequest(
                "InvalidStoredDraft",
                "The stored Sheet Configuration draft is invalid. Discard it and re-import.",
              ),
            ),
          );
          draftSource = yield* Schema.decodeUnknownEffect(SheetConfigurationSource)(
            existingDraft.source,
          ).pipe(
            Effect.mapError(() =>
              interactiveInvalidRequest(
                "InvalidStoredDraft",
                "The stored Sheet Configuration source is invalid. Discard it and re-import.",
              ),
            ),
          );
          draftDiagnostics = yield* Schema.decodeUnknownEffect(
            Schema.Array(SheetConfigurationDiagnostic),
          )(existingDraft.diagnostics).pipe(
            Effect.mapError(() =>
              interactiveInvalidRequest(
                "InvalidStoredDraft",
                "The stored Sheet Configuration diagnostics are invalid. Discard it and re-import.",
              ),
            ),
          );
        } else {
          if (existingDraft !== undefined && existingDraft.draft !== null) {
            return yield* Effect.fail(
              interactiveBusinessRuleRejected(
                "DraftAlreadyExists",
                "The existing draft is based on a different legacy snapshot. Discard it before re-importing.",
              ),
            );
          }
          const expectedDraftVersion = existingDraft?.draftVersion ?? 0;
          yield* configurationPersistence
            .upsertSheetConfigurationDraft({
              workspaceId: input.workspaceId,
              expectedDraftVersion,
              source: observed.source,
              legacyBinding: observed.source.kind === "legacy" ? observed.source.binding : null,
              baseRevisionId: null,
              baselineDigest: observed.baselineDigest,
              draft: observed.configuration,
              diagnostics,
              ...attributionFields(attribution),
            })
            .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.saveDraft")));
          draftVersion = expectedDraftVersion + 1;
        }
        const result: ImportAttemptResult = {
          draftVersion,
          source: draftSource,
          configuration,
          diagnostics: draftDiagnostics,
          baselineDigest: observed.baselineDigest,
        };
        const status = hasBlockingDiagnostics(draftDiagnostics) ? "needs-review" : "succeeded";
        yield* persistAttempt(
          configurationPersistence,
          {
            attemptId: input.attemptId,
            workspaceId: input.workspaceId,
            status,
            sourceBinding: draftSource.kind === "legacy" ? draftSource.binding : draftSource,
            baselineDigest: observed.baselineDigest,
            result,
            createdBy,
          },
          attribution,
        );
        return { workspaceId: input.workspaceId, attemptId: input.attemptId, status, ...result };
      });

    const saveDraft: SheetConfigurationWorkflowOperationsShape["saveDraft"] = (
      input,
      attribution,
    ) =>
      // Draft saves normalize the configuration and validate its semantics and live sheet bindings.
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const configurationPersistence = yield* optionalPersistence(persistence);
        const source = yield* sourceForDraft(persistence, input.workspaceId);
        const configuration =
          input.configuration === null ? null : normalizeConfiguration(input.configuration);
        const semanticDiagnostics =
          configuration === null
            ? input.diagnostics
            : yield* validateWebSheetConfiguration(configuration).pipe(
                Effect.mapError((error) => operationError("sheetConfiguration.validate", error)),
              );
        const bindingDiagnostics =
          configuration === null
            ? []
            : yield* validateConfigurationBindings({
                configuration,
                snapshotProvider,
              });
        const validation = [...semanticDiagnostics, ...bindingDiagnostics];
        yield* configurationPersistence
          .upsertSheetConfigurationDraft({
            workspaceId: input.workspaceId,
            expectedDraftVersion: input.expectedDraftVersion,
            source,
            legacyBinding: source.kind === "legacy" ? source.binding : null,
            baseRevisionId: input.baseRevisionId,
            baselineDigest: input.baselineDigest,
            draft: configuration,
            diagnostics: validation,
            ...attributionFields(attribution),
          })
          .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.saveDraft")));
        return {
          workspaceId: input.workspaceId,
          draftVersion: input.expectedDraftVersion + 1,
          source,
          baseRevisionId: input.baseRevisionId,
          baselineDigest: input.baselineDigest,
          configuration,
          diagnostics: validation,
        };
      });

    const editDraft: SheetConfigurationWorkflowOperationsShape["editDraft"] = (
      input,
      attribution,
    ) =>
      Effect.gen(function* () {
        const configurationPersistence = yield* optionalPersistence(persistence);
        const current = yield* configurationPersistence
          .getSheetConfiguration({ workspaceId: input.workspaceId })
          .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.load")));
        if (Option.isNone(current)) {
          return yield* Effect.fail(interactiveConfigurationMissing("Sheet Configuration draft"));
        }
        const source = decodeSource(current.value.source);
        if (source === undefined) {
          return yield* Effect.fail(
            interactiveInvalidRequest("InvalidStoredSource", "The stored source is invalid."),
          );
        }
        if (source.kind === "legacy") {
          return yield* Effect.fail(
            interactiveBusinessRuleRejected(
              "LegacySourceActive",
              "The legacy source is read-only. Import it from the web editor before editing.",
            ),
          );
        }
        if (current.value.draftVersion !== input.expectedDraftVersion) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "ConfigurationConflict",
              "The Sheet Configuration draft changed in another session.",
            ),
          );
        }

        let configuration: Configuration;
        let baseRevisionId = current.value.baseRevisionId;
        if (current.value.draft !== null) {
          configuration = yield* Schema.decodeUnknownEffect(WebSheetConfiguration)(
            current.value.draft,
          ).pipe(
            Effect.mapError((error) => operationError("sheetConfiguration.decodeDraft", error)),
          );
        } else if (current.value.activeRevisionId !== null) {
          const revision = yield* configurationPersistence
            .getSheetConfigurationRevisionById({
              workspaceId: input.workspaceId,
              revisionId: current.value.activeRevisionId,
            })
            .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.loadRevisions")));
          if (Option.isNone(revision)) {
            return yield* Effect.fail(
              interactiveResourceNotFound(
                "active Sheet Configuration revision",
                current.value.activeRevisionId,
              ),
            );
          }
          configuration = yield* Schema.decodeUnknownEffect(WebSheetConfiguration)(
            revision.value.configuration,
          ).pipe(
            Effect.mapError((error) => operationError("sheetConfiguration.decodeRevision", error)),
          );
          baseRevisionId = current.value.activeRevisionId;
        } else {
          return yield* Effect.fail(interactiveConfigurationMissing("Sheet Configuration draft"));
        }

        const edited = yield* applyDraftEdit({
          configuration,
          edit: input.edit,
          resolveRange: (a1) =>
            resolveSheetRange({
              snapshotProvider,
              spreadsheetId: configuration.spreadsheetId,
              a1,
            }),
        });
        const normalized = normalizeConfiguration(edited);
        const saved = yield* saveDraft(
          {
            workspaceId: input.workspaceId,
            expectedDraftVersion: input.expectedDraftVersion,
            source,
            legacyBinding: null,
            baseRevisionId,
            baselineDigest: current.value.baselineDigest,
            configuration: normalized,
            diagnostics: [],
          },
          attribution,
        );
        return {
          workspaceId: input.workspaceId,
          draftVersion: saved.draftVersion,
          source: saved.source,
          baseRevisionId: saved.baseRevisionId,
          baselineDigest: saved.baselineDigest,
          configuration: normalized,
          diagnostics: saved.diagnostics,
        };
      });

    const saveRevision: SheetConfigurationWorkflowOperationsShape["saveRevision"] = (
      input,
      attribution,
    ) =>
      // Revision saves validate, bind, persist, and audit a complete configuration in one boundary.
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const configurationPersistence = yield* optionalPersistence(persistence);
        const diagnostics = yield* validateWebSheetConfiguration(input.configuration).pipe(
          Effect.mapError((error) => operationError("sheetConfiguration.validate", error)),
        );
        if (hasBlockingDiagnostics(diagnostics)) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "InvalidConfiguration",
              "Resolve Sheet Configuration errors before saving a revision.",
            ),
          );
        }
        const source = yield* sourceForDraft(persistence, input.workspaceId);
        const bindingDiagnostics = yield* validateConfigurationBindings({
          configuration: input.configuration,
          snapshotProvider,
        });
        if (hasBlockingDiagnostics(bindingDiagnostics)) {
          return yield* Effect.fail(
            interactiveBusinessRuleRejected(
              "ConfigurationBindingChanged",
              "One or more configured sheet tabs or ranges are no longer available. Refresh the configuration and repair its bindings.",
            ),
          );
        }
        if (source.kind === "legacy") {
          const current = yield* configurationPersistence
            .getSheetConfiguration({ workspaceId: input.workspaceId })
            .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.load")));
          const baselineDigest = Option.isSome(current) ? current.value.baselineDigest : null;
          if (baselineDigest === null) {
            return yield* Effect.fail(
              interactiveBusinessRuleRejected(
                "LegacyImportRequired",
                "Import the active legacy Sheet Configuration before saving a revision.",
              ),
            );
          }
          const spreadsheetId = yield* spreadsheetForLegacySource(
            dataProvider,
            input.workspaceId,
            source,
          );
          const observed = yield* readLegacySnapshot({
            spreadsheetId,
            source,
            snapshotProvider,
          });
          if (
            hasBlockingDiagnostics(observed.diagnostics) ||
            observed.baselineDigest !== baselineDigest
          ) {
            return yield* Effect.fail(
              interactiveBusinessRuleRejected(
                "LegacySourceChanged",
                "The legacy settings changed after import. Re-import them before saving this revision.",
              ),
            );
          }
        }
        const createdBy =
          attribution.principal.kind === "user"
            ? attribution.principal.userId
            : attribution.principal.kind === "service"
              ? attribution.principal.serviceId
              : "unknown";
        const createdAtEpochMs = yield* Clock.currentTimeMillis;
        yield* configurationPersistence
          .saveSheetConfigurationRevision({
            workspaceId: input.workspaceId,
            expectedDraftVersion: input.expectedDraftVersion,
            revisionId: input.revisionId,
            createdAtEpochMs,
            createdBy,
            configuration: input.configuration,
            ...attributionFields(attribution),
          })
          .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.saveRevision")));
        return {
          workspaceId: input.workspaceId,
          draftVersion: input.expectedDraftVersion,
          revision: {
            revisionId: input.revisionId,
            workspaceId: input.workspaceId,
            createdAtEpochMs,
            createdBy,
            configuration: input.configuration,
          },
        };
      });

    const activate: SheetConfigurationWorkflowOperationsShape["activate"] = (input, attribution) =>
      Effect.gen(function* () {
        const configurationPersistence = yield* optionalPersistence(persistence);
        if (input.expectedBaselineDigest !== null) {
          const source = yield* sourceForWorkspace(persistence, input.workspaceId);
          const spreadsheetId = yield* spreadsheetForLegacySource(
            dataProvider,
            input.workspaceId,
            source,
          );
          const observed = yield* readLegacySnapshot({
            spreadsheetId,
            source,
            snapshotProvider,
          });
          if (hasBlockingDiagnostics(observed.diagnostics)) {
            return yield* Effect.fail(
              interactiveBusinessRuleRejected(
                "LegacySourceChanged",
                "The legacy settings are no longer valid. Re-import them before activating this revision.",
              ),
            );
          }
          if (observed.baselineDigest !== input.expectedBaselineDigest) {
            return yield* Effect.fail(
              interactiveBusinessRuleRejected(
                "LegacySourceChanged",
                "The legacy settings changed after import. Re-import it before activating this revision.",
              ),
            );
          }
        }
        const candidate = yield* configurationPersistence
          .getSheetConfigurationRevisionById({
            workspaceId: input.workspaceId,
            revisionId: input.revisionId,
          })
          .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.loadRevisions")));
        if (Option.isNone(candidate)) {
          return yield* Effect.fail(
            interactiveResourceNotFound("Sheet Configuration activation revision"),
          );
        }
        const candidateConfiguration = yield* Schema.decodeUnknownEffect(WebSheetConfiguration)(
          candidate.value.configuration,
        ).pipe(
          Effect.mapError((error) => operationError("sheetConfiguration.decodeRevision", error)),
        );
        const bindingDiagnostics = yield* validateConfigurationBindings({
          configuration: candidateConfiguration,
          snapshotProvider,
        });
        if (hasBlockingDiagnostics(bindingDiagnostics)) {
          return yield* Effect.fail(
            interactiveBusinessRuleRejected(
              "ConfigurationBindingChanged",
              "One or more configured sheet tabs or ranges are no longer available. Repair the activation candidate before activating it.",
            ),
          );
        }
        yield* configurationPersistence
          .activateSheetConfigurationRevision({
            workspaceId: input.workspaceId,
            revisionId: input.revisionId,
            expectedDraftVersion: input.expectedDraftVersion,
            expectedBaselineDigest: input.expectedBaselineDigest,
            ...attributionFields(attribution),
          })
          .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.activate")));
        const source = { kind: "owned" as const, revisionId: input.revisionId };
        return {
          workspaceId: input.workspaceId,
          draftVersion: input.expectedDraftVersion + 1,
          activeRevisionId: input.revisionId,
          source,
        };
      });

    const rollback: SheetConfigurationWorkflowOperationsShape["rollback"] = (input, attribution) =>
      // Rollback has separate legacy and owned-source paths with optimistic concurrency checks.
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const configurationPersistence = yield* optionalPersistence(persistence);
        const source = yield* currentSource(persistence, input.workspaceId);
        if (source.kind !== "owned") {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "LegacySourceActive",
              "Rollback is available only after an owned Sheet Configuration revision is active.",
            ),
          );
        }
        if (source.revisionId === null) {
          return yield* Effect.fail(
            interactiveConfigurationMissing("active Sheet Configuration revision"),
          );
        }
        if (input.revisionId === null) {
          const current = yield* configurationPersistence
            .getSheetConfiguration({ workspaceId: input.workspaceId })
            .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.load")));
          if (Option.isNone(current)) {
            return yield* Effect.fail(
              interactiveConfigurationMissing("retained legacy Sheet Configuration binding"),
            );
          }
          const legacyBinding = Option.getOrUndefined(
            Schema.decodeUnknownOption(LegacySourceBinding)(
              migrateLegacySourceBinding(current.value.legacyBinding),
            ),
          );
          if (legacyBinding === undefined) {
            return yield* Effect.fail(
              interactiveInvalidRequest(
                "LegacySourceNotRetained",
                "This workspace has no retained legacy source to roll back to.",
              ),
            );
          }
          const legacySource = { kind: "legacy" as const, binding: legacyBinding };
          const spreadsheetId = yield* spreadsheetForLegacySource(
            dataProvider,
            input.workspaceId,
            legacySource,
          );
          const observed = yield* readLegacySnapshot({
            spreadsheetId,
            source: legacySource,
            snapshotProvider,
          });
          if (hasBlockingDiagnostics(observed.diagnostics)) {
            return yield* Effect.fail(
              interactiveBusinessRuleRejected(
                "LegacySourceChanged",
                "The retained legacy settings could not be verified. Resolve the source and try again.",
              ),
            );
          }
          if (observed.configuration !== null) {
            const bindingDiagnostics = yield* validateConfigurationBindings({
              configuration: observed.configuration,
              snapshotProvider,
            });
            if (hasBlockingDiagnostics(bindingDiagnostics)) {
              return yield* Effect.fail(
                interactiveBusinessRuleRejected(
                  "ConfigurationBindingChanged",
                  "One or more retained legacy ranges are no longer available. Refresh the source and try again.",
                ),
              );
            }
          }
          yield* configurationPersistence
            .rollbackSheetConfiguration({
              workspaceId: input.workspaceId,
              revisionId: null,
              expectedDraftVersion: input.expectedDraftVersion,
              ...attributionFields(attribution),
            })
            .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.rollback")));
          return {
            workspaceId: input.workspaceId,
            draftVersion: input.expectedDraftVersion + 1,
            activeRevisionId: null,
            source: legacySource,
          };
        }
        const revision = yield* configurationPersistence
          .getSheetConfigurationRevisionById({
            workspaceId: input.workspaceId,
            revisionId: input.revisionId,
          })
          .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.loadRevisions")));
        if (Option.isNone(revision)) {
          return yield* Effect.fail(
            interactiveResourceNotFound("Sheet Configuration rollback revision"),
          );
        }
        const configuration = yield* Schema.decodeUnknownEffect(WebSheetConfiguration)(
          revision.value.configuration,
        ).pipe(
          Effect.mapError((error) => operationError("sheetConfiguration.decodeRevision", error)),
        );
        const bindingDiagnostics = yield* validateConfigurationBindings({
          configuration,
          snapshotProvider,
        });
        if (hasBlockingDiagnostics(bindingDiagnostics)) {
          return yield* Effect.fail(
            interactiveBusinessRuleRejected(
              "ConfigurationBindingChanged",
              "One or more rollback ranges are no longer available. Repair the revision before rolling back.",
            ),
          );
        }
        yield* configurationPersistence
          .rollbackSheetConfiguration({
            workspaceId: input.workspaceId,
            revisionId: input.revisionId,
            expectedDraftVersion: input.expectedDraftVersion,
            ...attributionFields(attribution),
          })
          .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.rollback")));
        const activatedSource = { kind: "owned" as const, revisionId: input.revisionId };
        return {
          workspaceId: input.workspaceId,
          draftVersion: input.expectedDraftVersion + 1,
          activeRevisionId: input.revisionId,
          source: activatedSource,
        };
      });

    const discardDraft: SheetConfigurationWorkflowOperationsShape["discardDraft"] = (
      input,
      attribution,
    ) =>
      Effect.gen(function* () {
        const configurationPersistence = yield* optionalPersistence(persistence);
        const current = yield* configurationPersistence
          .getSheetConfiguration({ workspaceId: input.workspaceId })
          .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.load")));
        if (Option.isNone(current)) {
          return yield* Effect.fail(interactiveConfigurationMissing("Sheet Configuration draft"));
        }
        const source = decodeSource(current.value.source);
        if (source === undefined) {
          return yield* Effect.fail(
            interactiveInvalidRequest("InvalidStoredSource", "The stored source is invalid."),
          );
        }
        yield* configurationPersistence
          .discardSheetConfigurationDraft({
            workspaceId: input.workspaceId,
            expectedDraftVersion: input.expectedDraftVersion,
            ...attributionFields(attribution),
          })
          .pipe(Effect.mapError(mapPersistenceError("sheetConfiguration.discardDraft")));
        return {
          workspaceId: input.workspaceId,
          draftVersion: input.expectedDraftVersion + 1,
          source,
        };
      });

    return {
      recordFailureAudit,
      importLegacy,
      saveDraft,
      editDraft,
      saveRevision,
      activate,
      rollback,
      discardDraft,
    };
  }),
);
