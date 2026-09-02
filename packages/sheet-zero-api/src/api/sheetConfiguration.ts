import { Predicate, Schema } from "effect";
import type {
  DefaultSchema as RocicorpSchema,
  ReadonlyJSONValue as ZeroReadonlyJSONValue,
  Transaction,
} from "@rocicorp/zero";
import { ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import { makeArgumentError } from "typhoon-core/error";
import { ReadonlyJSONValue as ReadonlyJSONValueSchema } from "typhoon-zero/schema";
import {
  LegacySourceBinding,
  migrateLegacySource,
  migrateLegacySourceBinding,
  SheetConfigurationAuditOutcome,
  SheetConfigurationImportAttemptStatus,
  SheetConfigurationSource,
  WebSheetConfiguration,
} from "sheet-domain";
import { zeroTableAccess } from "../accessors";
import { activeRecord } from "../timestamps";
import type { SheetZeroApiSuccessSchemas } from "./successSchemas";

const sheetConfigurationVersionConflictCode = "SHEET_CONFIGURATION_VERSION_CONFLICT";

type SheetConfigurationTransaction = Transaction<RocicorpSchema, unknown>;

const WorkspaceId = Schema.String;
const RevisionId = Schema.String;
const webSheetConfigurationEquivalence = Schema.toEquivalence(WebSheetConfiguration);
const readonlyJsonValueEquivalence = Schema.toEquivalence(ReadonlyJSONValueSchema);

// These attribution fields remain in the wire request for compatibility with older workflow
// callers. The service derives audit attribution from the verified Zero context instead of
// trusting either request field.
const configurationDraftRequest = Schema.Struct({
  workspaceId: WorkspaceId,
  expectedDraftVersion: Schema.Int,
  source: ReadonlyJSONValueSchema,
  legacyBinding: Schema.NullOr(ReadonlyJSONValueSchema),
  baseRevisionId: Schema.NullOr(RevisionId),
  baselineDigest: Schema.NullOr(Schema.String),
  draft: Schema.NullOr(ReadonlyJSONValueSchema),
  diagnostics: Schema.Array(ReadonlyJSONValueSchema),
  invocationId: Schema.String,
  effectivePrincipal: ReadonlyJSONValueSchema,
  actorProvenance: Schema.NullOr(ReadonlyJSONValueSchema),
});

// Compatibility-only attribution fields: writeAudit deliberately ignores these values and uses
// auditContext(ctx), which is derived from the verified dispatch identity.
const auditRequestFields = {
  invocationId: Schema.String,
  effectivePrincipal: ReadonlyJSONValueSchema,
  actorProvenance: Schema.NullOr(ReadonlyJSONValueSchema),
} as const;

const auditMetadata = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Null, Schema.String, Schema.Boolean, Schema.Number]),
);

const importAuditOutcomes = {
  succeeded: "succeeded",
  "needs-review": "invalid",
  failed: "failed",
} satisfies Record<
  Exclude<typeof SheetConfigurationImportAttemptStatus.Type, "running">,
  typeof SheetConfigurationAuditOutcome.Type
>;

const importAuditReasons = {
  succeeded: null,
  "needs-review": "The legacy source was imported but requires configuration review.",
  failed: "The legacy import failed.",
} satisfies Record<
  Exclude<typeof SheetConfigurationImportAttemptStatus.Type, "running">,
  string | null
>;

const actorField = (ctx: unknown, field: string): string | undefined =>
  Predicate.isObject(ctx) && Predicate.hasProperty(ctx, field) && Predicate.isString(ctx[field])
    ? ctx[field]
    : undefined;

const auditContext = (ctx: unknown) => ({
  // The request carries attribution for workflow compatibility, but it is not trusted here.
  // Zero dispatch has already derived these fields from the verified OAuth token.
  effectivePrincipal: {
    kind: actorField(ctx, "visibilityKey")?.startsWith("service:") === true ? "service" : "user",
    id: actorField(ctx, "principalId") ?? "unknown",
  },
  actorProvenance: null,
});

const auditId = (
  operation: string,
  workspaceId: string,
  invocationId: string,
  metadata: ZeroReadonlyJSONValue,
) => {
  const status =
    Predicate.isObject(metadata) &&
    Predicate.hasProperty(metadata, "status") &&
    Predicate.isString(metadata.status)
      ? metadata.status
      : undefined;
  const parts = [operation, workspaceId, invocationId];
  if (Predicate.isString(status)) parts.push(status);
  return parts.map((part) => encodeURIComponent(part)).join(":");
};

const writeAudit = async (options: {
  readonly tx: SheetConfigurationTransaction;
  readonly ctx: unknown;
  readonly workspaceId: string;
  readonly operation: string;
  readonly invocationId: string;
  readonly metadata: ZeroReadonlyJSONValue;
  readonly outcome?: typeof SheetConfigurationAuditOutcome.Type;
  readonly reason?: string | null;
}) => {
  const eventId = auditId(
    options.operation,
    options.workspaceId,
    options.invocationId,
    options.metadata,
  );
  // Audit events are append-only application records. A retry of the same event is idempotent,
  // including when a Zero tombstone for the event is still present.
  const existing = await options.tx.run(
    zeroTableAccess.auditSheetConfiguration.table.where("eventId", "=", eventId).one(),
  );
  if (existing !== undefined) return;
  await options.tx.mutate.auditSheetConfiguration.upsert(
    zeroTableAccess.auditSheetConfiguration.upsertWithTimestamps(
      {
        eventId,
        workspaceId: options.workspaceId,
        operation: options.operation,
        outcome: options.outcome ?? "succeeded",
        invocationId: options.invocationId,
        ...auditContext(options.ctx),
        metadata: options.metadata,
        reason: options.reason ?? null,
        deletedAt: null,
      },
      undefined,
    ),
  );
};

const diagnosticsAreEmpty = (value: unknown): boolean => Array.isArray(value) && value.length === 0;

export const makeSheetConfigurationGroup = <
  const SuccessSchemas extends SheetZeroApiSuccessSchemas,
>(
  success: SuccessSchemas,
) =>
  ZeroApiGroup.make("sheetConfiguration").add(
    ZeroApiEndpoint.query("getSheetConfiguration", {
      request: Schema.Struct({ workspaceId: WorkspaceId }),
      success: success.sheetConfiguration.getSheetConfiguration,
      query: ({ args: { workspaceId } }) =>
        zeroTableAccess.configWorkspaceSheet.getActiveByPrimaryKey(
          zeroTableAccess.configWorkspaceSheet.table,
          { workspaceId },
        ),
    }),
    ZeroApiEndpoint.query("getSheetConfigurationRevisions", {
      request: Schema.Struct({ workspaceId: WorkspaceId }),
      success: success.sheetConfiguration.getSheetConfigurationRevisions,
      query: ({ args: { workspaceId } }) =>
        zeroTableAccess.configWorkspaceSheetRevision.listActiveWhere(
          zeroTableAccess.configWorkspaceSheetRevision.table.where("workspaceId", "=", workspaceId),
        ),
    }),
    ZeroApiEndpoint.query("getSheetConfigurationRevisionById", {
      visibility: "service",
      request: Schema.Struct({ workspaceId: WorkspaceId, revisionId: RevisionId }),
      success: success.sheetConfiguration.getSheetConfigurationRevisionById,
      query: ({ args: { workspaceId, revisionId } }) =>
        zeroTableAccess.configWorkspaceSheetRevision
          .listActiveWhere(
            zeroTableAccess.configWorkspaceSheetRevision.table
              .where("workspaceId", "=", workspaceId)
              .where("revisionId", "=", revisionId),
          )
          .one(),
    }),
    ZeroApiEndpoint.query("getSheetConfigurationRevisionsBySpreadsheetId", {
      visibility: "service",
      request: Schema.Struct({ spreadsheetId: Schema.String }),
      success: success.sheetConfiguration.getSheetConfigurationRevisionsBySpreadsheetId,
      query: ({ args: { spreadsheetId } }) =>
        zeroTableAccess.configWorkspaceSheetRevision.listActiveWhere(
          zeroTableAccess.configWorkspaceSheetRevision.table.where(
            "spreadsheetId",
            "=",
            spreadsheetId,
          ),
        ),
    }),
    ZeroApiEndpoint.query("getSheetConfigurationImportAttempt", {
      request: Schema.Struct({ workspaceId: WorkspaceId, attemptId: Schema.String }),
      success: success.sheetConfiguration.getSheetConfigurationImportAttempt,
      query: ({ args: { workspaceId, attemptId } }) =>
        zeroTableAccess.configWorkspaceSheetImportAttempt
          .listActiveWhere(
            zeroTableAccess.configWorkspaceSheetImportAttempt.table
              .where("workspaceId", "=", workspaceId)
              .where("attemptId", "=", attemptId),
          )
          .one(),
    }),
    ZeroApiEndpoint.mutator("recordSheetConfigurationAudit", {
      visibility: "service",
      request: Schema.Struct({
        workspaceId: WorkspaceId,
        operation: Schema.String,
        outcome: SheetConfigurationAuditOutcome,
        metadata: auditMetadata,
        reason: Schema.NullOr(Schema.String),
        ...auditRequestFields,
      }),
      mutator: async ({ tx, args, ctx }) => {
        await writeAudit({
          tx,
          ctx,
          workspaceId: args.workspaceId,
          operation: args.operation,
          invocationId: args.invocationId,
          metadata: args.metadata,
          outcome: args.outcome,
          reason: args.reason,
        });
      },
    }),
    ZeroApiEndpoint.mutator("upsertSheetConfigurationDraft", {
      visibility: "service",
      request: configurationDraftRequest,
      // This mutator validates the source transition and draft CAS before writing the row.
      // fallow-ignore-next-line complexity
      mutator: async ({ tx, args, ctx }) => {
        const existing = await tx.run(
          zeroTableAccess.configWorkspaceSheet.table
            .where("workspaceId", "=", args.workspaceId)
            .one(),
        );
        const active = activeRecord(existing);
        const currentVersion = active?.draftVersion ?? 0;
        if (active === undefined && args.expectedDraftVersion !== 0) {
          throw makeArgumentError("There is no Sheet Configuration draft");
        }
        if (active !== undefined && args.expectedDraftVersion !== currentVersion) {
          throw makeArgumentError("The Sheet Configuration draft changed in another session", {
            code: sheetConfigurationVersionConflictCode,
          });
        }
        let requestedSource: typeof SheetConfigurationSource.Type;
        try {
          requestedSource = Schema.decodeUnknownSync(SheetConfigurationSource)(
            migrateLegacySource(args.source),
            { onExcessProperty: "error" },
          );
        } catch {
          throw makeArgumentError("The Sheet Configuration source is not valid");
        }
        let source = requestedSource;
        if (active !== undefined) {
          let currentSource: typeof SheetConfigurationSource.Type;
          try {
            currentSource = Schema.decodeUnknownSync(SheetConfigurationSource)(
              migrateLegacySource(active.source),
              { onExcessProperty: "error" },
            );
          } catch {
            throw makeArgumentError("The current Sheet Configuration source is not valid");
          }
          if (currentSource.kind !== requestedSource.kind) {
            throw makeArgumentError("The active Sheet Configuration source cannot be changed here");
          }
          source = currentSource.kind === "legacy" ? requestedSource : currentSource;
        }
        await tx.mutate.configWorkspaceSheet.upsert(
          zeroTableAccess.configWorkspaceSheet.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              source,
              legacyBinding:
                source.kind === "legacy"
                  ? source.binding
                  : (active?.legacyBinding ?? args.legacyBinding),
              draftVersion: currentVersion + 1,
              baseRevisionId: args.baseRevisionId,
              baselineDigest: args.baselineDigest,
              draft: args.draft,
              diagnostics: args.diagnostics,
              activeRevisionId: active?.activeRevisionId ?? null,
              updatedBy: null,
              deletedAt: null,
            },
            active,
          ),
        );
        await writeAudit({
          tx,
          ctx,
          workspaceId: args.workspaceId,
          operation: "saveDraft",
          invocationId: args.invocationId,
          metadata: {
            draftVersion: currentVersion + 1,
            diagnosticCount: args.diagnostics.length,
          },
        });
      },
    }),
    ZeroApiEndpoint.mutator("saveSheetConfigurationRevision", {
      visibility: "service",
      request: Schema.Struct({
        workspaceId: WorkspaceId,
        expectedDraftVersion: Schema.Int,
        revisionId: RevisionId,
        createdAtEpochMs: Schema.Int,
        createdBy: Schema.String,
        configuration: ReadonlyJSONValueSchema,
        ...auditRequestFields,
      }),
      mutator: async ({ tx, args, ctx }) => {
        const workspace = activeRecord(
          await tx.run(
            zeroTableAccess.configWorkspaceSheet.table
              .where("workspaceId", "=", args.workspaceId)
              .one(),
          ),
        );
        if (workspace === undefined) {
          throw makeArgumentError("There is no Sheet Configuration draft");
        }
        if (workspace.draftVersion !== args.expectedDraftVersion) {
          throw makeArgumentError("The Sheet Configuration draft changed in another session", {
            code: sheetConfigurationVersionConflictCode,
          });
        }
        let configuration: typeof WebSheetConfiguration.Type;
        try {
          configuration = Schema.decodeUnknownSync(WebSheetConfiguration)(args.configuration, {
            onExcessProperty: "error",
          });
        } catch {
          throw makeArgumentError("The Sheet Configuration is not valid");
        }
        if (!diagnosticsAreEmpty(workspace.diagnostics)) {
          throw makeArgumentError("Resolve Sheet Configuration diagnostics before saving");
        }
        if (workspace.draft === null) {
          throw makeArgumentError("There is no Sheet Configuration draft to save");
        }
        let draft: typeof WebSheetConfiguration.Type;
        try {
          draft = Schema.decodeUnknownSync(WebSheetConfiguration)(workspace.draft, {
            onExcessProperty: "error",
          });
        } catch {
          throw makeArgumentError("The current Sheet Configuration draft is not valid");
        }
        if (!webSheetConfigurationEquivalence(draft, configuration)) {
          throw makeArgumentError("Save the current Sheet Configuration draft before publishing");
        }
        const existingRevision = activeRecord(
          await tx.run(
            zeroTableAccess.configWorkspaceSheetRevision.table
              .where("workspaceId", "=", args.workspaceId)
              .where("revisionId", "=", args.revisionId)
              .one(),
          ),
        );
        if (existingRevision !== undefined) {
          throw makeArgumentError("The Sheet Configuration revision already exists");
        }
        await tx.mutate.configWorkspaceSheetRevision.upsert(
          zeroTableAccess.configWorkspaceSheetRevision.upsertWithTimestamps({
            workspaceId: args.workspaceId,
            revisionId: args.revisionId,
            spreadsheetId: configuration.spreadsheetId,
            configuration: args.configuration,
            createdBy: args.createdBy,
            createdAt: args.createdAtEpochMs,
            deletedAt: null,
          }),
        );
        await writeAudit({
          tx,
          ctx,
          workspaceId: args.workspaceId,
          operation: "saveRevision",
          invocationId: args.invocationId,
          metadata: { revisionId: args.revisionId, draftVersion: args.expectedDraftVersion },
        });
      },
    }),
    ZeroApiEndpoint.mutator("activateSheetConfigurationRevision", {
      visibility: "service",
      request: Schema.Struct({
        workspaceId: WorkspaceId,
        revisionId: RevisionId,
        expectedDraftVersion: Schema.Int,
        expectedBaselineDigest: Schema.NullOr(Schema.String),
        ...auditRequestFields,
      }),
      // Activation checks both draft and legacy baselines before changing the active revision.
      // fallow-ignore-next-line complexity
      mutator: async ({ tx, args, ctx }) => {
        const existing = await tx.run(
          zeroTableAccess.configWorkspaceSheet.table
            .where("workspaceId", "=", args.workspaceId)
            .one(),
        );
        const active = activeRecord(existing);
        if (active === undefined) {
          throw makeArgumentError("There is no Sheet Configuration draft");
        }
        if (active.draftVersion !== args.expectedDraftVersion) {
          throw makeArgumentError("The Sheet Configuration draft changed in another session", {
            code: sheetConfigurationVersionConflictCode,
          });
        }
        if (active.baselineDigest !== args.expectedBaselineDigest) {
          throw makeArgumentError("The legacy Sheet Configuration changed since it was imported");
        }
        const revision = activeRecord(
          await tx.run(
            zeroTableAccess.configWorkspaceSheetRevision.table
              .where("workspaceId", "=", args.workspaceId)
              .where("revisionId", "=", args.revisionId)
              .one(),
          ),
        );
        if (revision === undefined)
          throw makeArgumentError("The Sheet Configuration revision was not found");
        if (active.draft === null) {
          throw makeArgumentError(
            "The revision is not the current Sheet Configuration activation candidate",
          );
        }
        let draft: typeof WebSheetConfiguration.Type;
        let candidate: typeof WebSheetConfiguration.Type;
        try {
          draft = Schema.decodeUnknownSync(WebSheetConfiguration)(active.draft, {
            onExcessProperty: "error",
          });
          candidate = Schema.decodeUnknownSync(WebSheetConfiguration)(revision.configuration, {
            onExcessProperty: "error",
          });
        } catch {
          throw makeArgumentError(
            "The current Sheet Configuration activation candidate is not valid",
          );
        }
        if (!webSheetConfigurationEquivalence(draft, candidate)) {
          throw makeArgumentError(
            "The revision is not the current Sheet Configuration activation candidate",
          );
        }
        let source: typeof SheetConfigurationSource.Type;
        try {
          source = Schema.decodeUnknownSync(SheetConfigurationSource)(
            migrateLegacySource(active.source),
            { onExcessProperty: "error" },
          );
        } catch {
          throw makeArgumentError("The current Sheet Configuration source is not valid");
        }
        if (args.expectedBaselineDigest !== null && source.kind !== "legacy") {
          throw makeArgumentError("The legacy Sheet Configuration is no longer active");
        }
        if (args.expectedBaselineDigest === null && source.kind === "legacy") {
          throw makeArgumentError("Import the active legacy Sheet Configuration before activating");
        }
        if (!diagnosticsAreEmpty(active.diagnostics)) {
          throw makeArgumentError("Resolve Sheet Configuration diagnostics before activating");
        }
        await tx.mutate.configWorkspaceSheet.upsert(
          zeroTableAccess.configWorkspaceSheet.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              source: { kind: "owned", revisionId: args.revisionId },
              legacyBinding: active.legacyBinding,
              draftVersion: active.draftVersion + 1,
              baseRevisionId: args.revisionId,
              baselineDigest: null,
              draft: active.draft,
              diagnostics: active.diagnostics,
              activeRevisionId: args.revisionId,
              updatedBy: null,
              deletedAt: null,
            },
            active,
          ),
        );
        await writeAudit({
          tx,
          ctx,
          workspaceId: args.workspaceId,
          operation: "activate",
          invocationId: args.invocationId,
          metadata: { revisionId: args.revisionId, draftVersion: args.expectedDraftVersion },
        });
      },
    }),
    ZeroApiEndpoint.mutator("rollbackSheetConfiguration", {
      visibility: "service",
      request: Schema.Struct({
        workspaceId: WorkspaceId,
        revisionId: Schema.NullOr(RevisionId),
        expectedDraftVersion: Schema.Int,
        ...auditRequestFields,
      }),
      mutator: async ({ tx, args, ctx }) => {
        const existing = await tx.run(
          zeroTableAccess.configWorkspaceSheet.table
            .where("workspaceId", "=", args.workspaceId)
            .one(),
        );
        const active = activeRecord(existing);
        if (active === undefined) {
          throw makeArgumentError("There is no Sheet Configuration draft");
        }
        if (active.draftVersion !== args.expectedDraftVersion) {
          throw makeArgumentError("The Sheet Configuration draft changed in another session", {
            code: sheetConfigurationVersionConflictCode,
          });
        }
        let source: typeof SheetConfigurationSource.Type;
        try {
          source = Schema.decodeUnknownSync(SheetConfigurationSource)(
            migrateLegacySource(active.source),
            { onExcessProperty: "error" },
          );
        } catch {
          throw makeArgumentError("The current Sheet Configuration source is not valid");
        }
        if (source.kind !== "owned") {
          throw makeArgumentError("Rollback is available only for an owned Sheet Configuration");
        }
        if (args.revisionId === null) {
          let legacyBinding: typeof LegacySourceBinding.Type;
          try {
            legacyBinding = Schema.decodeUnknownSync(LegacySourceBinding)(
              migrateLegacySourceBinding(active.legacyBinding),
              { onExcessProperty: "error" },
            );
          } catch {
            throw makeArgumentError(
              "The retained legacy Sheet Configuration binding was not found",
            );
          }
          await tx.mutate.configWorkspaceSheet.upsert(
            zeroTableAccess.configWorkspaceSheet.upsertWithTimestamps(
              {
                workspaceId: args.workspaceId,
                source: { kind: "legacy", binding: legacyBinding },
                legacyBinding,
                draftVersion: active.draftVersion + 1,
                baseRevisionId: null,
                baselineDigest: null,
                draft: null,
                diagnostics: [],
                activeRevisionId: null,
                updatedBy: null,
                deletedAt: null,
              },
              active,
            ),
          );
          await writeAudit({
            tx,
            ctx,
            workspaceId: args.workspaceId,
            operation: "rollback",
            invocationId: args.invocationId,
            metadata: { revisionId: null, draftVersion: active.draftVersion + 1 },
          });
          return;
        }
        const revision = activeRecord(
          await tx.run(
            zeroTableAccess.configWorkspaceSheetRevision.table
              .where("workspaceId", "=", args.workspaceId)
              .where("revisionId", "=", args.revisionId)
              .one(),
          ),
        );
        if (revision === undefined)
          throw makeArgumentError("The Sheet Configuration revision was not found");
        await tx.mutate.configWorkspaceSheet.upsert(
          zeroTableAccess.configWorkspaceSheet.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              source: { kind: "owned", revisionId: args.revisionId },
              legacyBinding: active.legacyBinding,
              draftVersion: active.draftVersion + 1,
              baseRevisionId: args.revisionId,
              baselineDigest: null,
              draft: revision.configuration,
              diagnostics: [],
              activeRevisionId: args.revisionId,
              updatedBy: null,
              deletedAt: null,
            },
            active,
          ),
        );
        await writeAudit({
          tx,
          ctx,
          workspaceId: args.workspaceId,
          operation: "rollback",
          invocationId: args.invocationId,
          metadata: { revisionId: args.revisionId, draftVersion: active.draftVersion + 1 },
        });
      },
    }),
    ZeroApiEndpoint.mutator("discardSheetConfigurationDraft", {
      visibility: "service",
      request: Schema.Struct({
        workspaceId: WorkspaceId,
        expectedDraftVersion: Schema.Int,
        ...auditRequestFields,
      }),
      mutator: async ({ tx, args, ctx }) => {
        const existing = await tx.run(
          zeroTableAccess.configWorkspaceSheet.table
            .where("workspaceId", "=", args.workspaceId)
            .one(),
        );
        const active = activeRecord(existing);
        if (active === undefined) {
          throw makeArgumentError("There is no Sheet Configuration draft");
        }
        if (active.draftVersion !== args.expectedDraftVersion) {
          throw makeArgumentError("The Sheet Configuration draft changed in another session", {
            code: sheetConfigurationVersionConflictCode,
          });
        }
        await tx.mutate.configWorkspaceSheet.upsert(
          zeroTableAccess.configWorkspaceSheet.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              source: active.source,
              legacyBinding: active.legacyBinding,
              draftVersion: active.draftVersion + 1,
              baseRevisionId: null,
              baselineDigest: null,
              draft: null,
              diagnostics: [],
              activeRevisionId: active.activeRevisionId,
              updatedBy: null,
              deletedAt: null,
            },
            active,
          ),
        );
        await writeAudit({
          tx,
          ctx,
          workspaceId: args.workspaceId,
          operation: "discardDraft",
          invocationId: args.invocationId,
          metadata: { draftVersion: active.draftVersion + 1 },
        });
      },
    }),
    ZeroApiEndpoint.mutator("upsertSheetConfigurationImportAttempt", {
      visibility: "service",
      request: Schema.Struct({
        attemptId: RevisionId,
        workspaceId: WorkspaceId,
        status: SheetConfigurationImportAttemptStatus,
        sourceBinding: ReadonlyJSONValueSchema,
        baselineDigest: Schema.String,
        result: Schema.NullOr(ReadonlyJSONValueSchema),
        createdBy: Schema.String,
        ...auditRequestFields,
      }),
      // Import-attempt writes reconcile idempotency, workspace ownership, and audit provenance.
      // fallow-ignore-next-line complexity
      mutator: async ({ tx, args, ctx }) => {
        const existing = activeRecord(
          await tx.run(
            zeroTableAccess.configWorkspaceSheetImportAttempt.table
              .where("attemptId", "=", args.attemptId)
              .one(),
          ),
        );
        if (existing !== undefined && existing.workspaceId !== args.workspaceId) {
          throw makeArgumentError(
            "The Sheet Configuration import attempt belongs to another workspace",
          );
        }
        if (existing !== undefined) {
          const sameAttempt =
            existing.status === args.status &&
            existing.baselineDigest === args.baselineDigest &&
            existing.createdBy === args.createdBy &&
            readonlyJsonValueEquivalence(existing.sourceBinding, args.sourceBinding) &&
            readonlyJsonValueEquivalence(existing.result, args.result);
          if (existing.status !== "running" && !sameAttempt) {
            throw makeArgumentError("The Sheet Configuration import attempt is already complete");
          }
          if (existing.status === "running" && args.status === "running" && !sameAttempt) {
            throw makeArgumentError(
              "The Sheet Configuration import attempt is already in progress",
            );
          }
          if (sameAttempt) return;
        }
        await tx.mutate.configWorkspaceSheetImportAttempt.upsert(
          zeroTableAccess.configWorkspaceSheetImportAttempt.upsertWithTimestamps(
            {
              attemptId: args.attemptId,
              workspaceId: args.workspaceId,
              status: args.status,
              sourceBinding: args.sourceBinding,
              baselineDigest: args.baselineDigest,
              result: args.result,
              createdBy: args.createdBy,
              deletedAt: null,
            },
            existing,
          ),
        );
        if (args.status === "running") return;
        await writeAudit({
          tx,
          ctx,
          workspaceId: args.workspaceId,
          operation: "import",
          invocationId: args.invocationId,
          metadata: { attemptId: args.attemptId, status: args.status },
          outcome: importAuditOutcomes[args.status],
          reason: importAuditReasons[args.status],
        });
      },
    }),
  );

export type SheetConfigurationGroup<SuccessSchemas extends SheetZeroApiSuccessSchemas> = ReturnType<
  typeof makeSheetConfigurationGroup<SuccessSchemas>
>;
