import { Data, Effect, Option, Predicate, Schema } from "effect";
import {
  SheetConfigurationSource,
  sourceForLegacySettings,
  WebSheetConfiguration,
} from "sheet-domain";
import {
  SpreadsheetId,
  WorkspaceId,
  type WorkspaceId as WorkspaceIdValue,
} from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";

/** The source and revision selected for one workspace at one read boundary. */
export interface AuthoritativeSheetConfiguration {
  readonly workspaceId: WorkspaceIdValue;
  readonly spreadsheetId: typeof SpreadsheetId.Type;
  readonly source: typeof SheetConfigurationSource.Type;
  /** Legacy workspaces intentionally have no web configuration value here. */
  readonly configuration: typeof WebSheetConfiguration.Type | null;
}

export const missingConfigurationKey = (
  persistence: TrustedSheetPersistence["Service"],
  workspaceSheetId?: unknown,
): "workspace.sheetId" | "workspace.sheetConfiguration" =>
  Predicate.isUndefined(persistence.sheetConfiguration) &&
  (!Predicate.isString(workspaceSheetId) || workspaceSheetId.trim().length === 0)
    ? "workspace.sheetId"
    : "workspace.sheetConfiguration";

class AuthoritativeSheetConfigurationError extends Data.TaggedError(
  "AuthoritativeSheetConfigurationError",
)<{
  readonly operation: "load-workspace" | "load-source" | "load-revision";
  readonly cause: unknown;
}> {}

const resolverError = (
  operation: AuthoritativeSheetConfigurationError["operation"],
  cause: unknown,
) => new AuthoritativeSheetConfigurationError({ operation, cause });

const decodeSource = (value: unknown) =>
  Schema.decodeUnknownEffect(SheetConfigurationSource)(value).pipe(
    Effect.mapError((cause) => resolverError("load-source", cause)),
  );

const decodeSpreadsheetId = (value: unknown) =>
  Schema.decodeUnknownEffect(SpreadsheetId)(value).pipe(
    Effect.mapError((cause) => resolverError("load-source", cause)),
  );

const resolveLegacyConfiguration = (
  workspaceId: WorkspaceId,
  spreadsheetId: Option.Option<string>,
  source: typeof SheetConfigurationSource.Type,
) =>
  Option.match(spreadsheetId, {
    onNone: () => Effect.succeed(Option.none<AuthoritativeSheetConfiguration>()),
    onSome: (value) =>
      decodeSpreadsheetId(value).pipe(
        Effect.map((resolvedSpreadsheetId) =>
          Option.some({
            workspaceId,
            spreadsheetId: resolvedSpreadsheetId,
            source,
            configuration: null,
          }),
        ),
      ),
  });

/**
 * Resolves the active source exactly once for a provider operation.
 *
 * A missing `config_workspace_sheet` row is the compatibility state for an existing
 * workspace, so it remains legacy until an explicit activation creates the row. An owned
 * row with a null revision is deliberately returned as `None`; callers must report an
 * unconfigured workspace instead of falling back to the old workspace sheet column.
 */
type WorkspaceConfiguration = Effect.Success<
  ReturnType<TrustedSheetPersistence["Service"]["workspaces"]["getWorkspaceConfigByWorkspaceId"]>
>;

export const resolveAuthoritativeSheetConfigurationForWorkspace = (
  persistence: TrustedSheetPersistence["Service"],
  workspaceId: WorkspaceId,
  workspace: WorkspaceConfiguration,
): Effect.Effect<
  Option.Option<AuthoritativeSheetConfiguration>,
  AuthoritativeSheetConfigurationError
> =>
  Effect.gen(function* () {
    const legacySpreadsheetId = Option.flatMap(workspace, ({ sheetId }) =>
      Predicate.isString(sheetId) && sheetId.trim().length > 0
        ? Option.some(sheetId.trim())
        : Option.none(),
    );
    const configurationPersistence = persistence.sheetConfiguration;
    if (Predicate.isUndefined(configurationPersistence)) {
      return yield* resolveLegacyConfiguration(
        workspaceId,
        legacySpreadsheetId,
        sourceForLegacySettings(),
      );
    }

    const stored = yield* configurationPersistence
      .getSheetConfiguration({ workspaceId })
      .pipe(Effect.mapError((cause) => resolverError("load-source", cause)));
    if (Option.isNone(stored)) {
      return yield* resolveLegacyConfiguration(
        workspaceId,
        legacySpreadsheetId,
        sourceForLegacySettings(),
      );
    }

    const source = yield* decodeSource(stored.value.source);
    if (source.kind === "legacy") {
      const spreadsheetId =
        source.binding.status === "bound"
          ? Option.some(source.binding.spreadsheetId)
          : legacySpreadsheetId;
      return yield* resolveLegacyConfiguration(workspaceId, spreadsheetId, source);
    }
    if (source.revisionId === null) {
      return Option.none<AuthoritativeSheetConfiguration>();
    }

    const revision = yield* configurationPersistence
      .getSheetConfigurationRevisionById({
        workspaceId,
        revisionId: source.revisionId,
      })
      .pipe(Effect.mapError((cause) => resolverError("load-revision", cause)));
    if (Option.isNone(revision)) {
      return yield* Effect.fail(
        resolverError(
          "load-revision",
          new Error("The active Sheet Configuration revision was not found"),
        ),
      );
    }
    const configuration = yield* Schema.decodeUnknownEffect(WebSheetConfiguration)(
      revision.value.configuration,
    ).pipe(Effect.mapError((cause) => resolverError("load-revision", cause)));
    const spreadsheetId = yield* decodeSpreadsheetId(configuration.spreadsheetId);
    return Option.some({ workspaceId, spreadsheetId, source, configuration });
  });

export const resolveAuthoritativeSheetConfiguration = (
  persistence: TrustedSheetPersistence["Service"],
  workspaceId: WorkspaceId,
): Effect.Effect<
  Option.Option<AuthoritativeSheetConfiguration>,
  AuthoritativeSheetConfigurationError
> =>
  persistence.workspaces.getWorkspaceConfigByWorkspaceId({ workspaceId }).pipe(
    Effect.mapError((cause) => resolverError("load-workspace", cause)),
    Effect.flatMap((workspace) =>
      resolveAuthoritativeSheetConfigurationForWorkspace(persistence, workspaceId, workspace),
    ),
  );

export const resolveAuthoritativeSpreadsheetId = (
  persistence: TrustedSheetPersistence["Service"],
  workspaceId: WorkspaceIdValue,
) =>
  resolveAuthoritativeSheetConfiguration(persistence, workspaceId).pipe(
    Effect.map(Option.map(({ spreadsheetId }) => spreadsheetId)),
  );

/**
 * Resolves an owned configuration when a caller only has the spreadsheet identity.
 *
 * Apps Script recalculation predates workspace-scoped inputs, so it cannot carry a workspace
 * identifier through its published contract. The active revision index provides the reverse
 * lookup without treating an inactive revision or a legacy workspace as authoritative.
 */
export const resolveAuthoritativeSheetConfigurationBySpreadsheetId = (
  persistence: TrustedSheetPersistence["Service"],
  spreadsheetId: string,
): Effect.Effect<
  Option.Option<AuthoritativeSheetConfiguration>,
  AuthoritativeSheetConfigurationError
> =>
  Effect.gen(function* () {
    const configurationPersistence = persistence.sheetConfiguration;
    if (Predicate.isUndefined(configurationPersistence)) {
      return yield* Effect.succeed(Option.none<AuthoritativeSheetConfiguration>());
    }
    const resolvedSpreadsheetId = yield* decodeSpreadsheetId(spreadsheetId);
    const revisions = yield* configurationPersistence
      .getSheetConfigurationRevisionsBySpreadsheetId({
        spreadsheetId: resolvedSpreadsheetId,
      })
      .pipe(Effect.mapError((cause) => resolverError("load-revision", cause)));
    const candidates: Array<AuthoritativeSheetConfiguration> = [];
    type StoredConfiguration = Effect.Success<
      ReturnType<typeof configurationPersistence.getSheetConfiguration>
    >;
    const sourceByWorkspaceId = new Map<string, StoredConfiguration>();
    for (const revision of revisions) {
      const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(revision.workspaceId).pipe(
        Effect.mapError((cause) => resolverError("load-workspace", cause)),
      );
      const cached = sourceByWorkspaceId.get(workspaceId);
      const stored =
        cached ??
        (yield* configurationPersistence
          .getSheetConfiguration({ workspaceId })
          .pipe(Effect.mapError((cause) => resolverError("load-source", cause))));
      sourceByWorkspaceId.set(workspaceId, stored);
      if (Option.isNone(stored)) continue;
      const source = yield* decodeSource(stored.value.source);
      if (source.kind !== "owned" || source.revisionId !== revision.revisionId) continue;
      const configuration = yield* Schema.decodeUnknownEffect(WebSheetConfiguration)(
        revision.configuration,
      ).pipe(Effect.mapError((cause) => resolverError("load-revision", cause)));
      const configurationSpreadsheetId = yield* decodeSpreadsheetId(configuration.spreadsheetId);
      if (configurationSpreadsheetId !== resolvedSpreadsheetId) {
        return yield* Effect.fail(
          resolverError(
            "load-revision",
            new Error(
              "The active Sheet Configuration revision has a mismatched spreadsheet binding",
            ),
          ),
        );
      }
      candidates.push({
        workspaceId,
        spreadsheetId: resolvedSpreadsheetId,
        source,
        configuration,
      });
    }
    if (candidates.length > 1) {
      return yield* Effect.fail(
        resolverError(
          "load-revision",
          new Error("More than one workspace owns the requested spreadsheet configuration"),
        ),
      );
    }
    return Option.fromUndefinedOr(candidates[0]);
  });
