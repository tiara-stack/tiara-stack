import { useAtomRefresh, useAtomSet, useAtomSuspense } from "@effect/atom-react";
import { Duration, Effect, Option, Schema } from "effect";
import { useCallback } from "react";
import * as Data from "effect/Data";
import { AsyncResult, Atom, Reactivity } from "effect/unstable/reactivity";
import {
  SheetConfigurationDiagnostic,
  SheetConfigurationRevision,
  SheetConfigurationSource,
  LegacySourceBinding,
  WebSheetConfiguration,
  sourceForLegacySettings,
} from "sheet-domain";
import { api as sheetZeroApi } from "sheet-zero-api";
import {
  ConfigWorkspaceRow,
  ConfigWorkspaceSheetRevisionRow,
  ConfigWorkspaceSheetRow,
} from "sheet-zero-api/rows";
import {
  SheetConfigurationActivateInput,
  SheetConfigurationActivateSuccess,
  SheetConfigurationDiscardDraftInput,
  SheetConfigurationDiscardDraftSuccess,
  SheetConfigurationImportLegacyInput,
  SheetConfigurationImportLegacySuccess,
  SheetConfigurationRollbackInput,
  SheetConfigurationRollbackSuccess,
  SheetConfigurationSaveDraftInput,
  SheetConfigurationSaveDraftSuccess,
  SheetConfigurationSaveRevisionInput,
  SheetConfigurationSaveRevisionSuccess,
  WorkspaceId,
  type WorkspaceInput,
} from "sheet-workflow-contracts";
import { runtimeAtom } from "#/lib/runtime";
import { runSheetWorkflow, sheetZeroClientAtom } from "#/lib/sheetZero";
import { makeQuery } from "typhoon-zero/zeroApiAtom";
import { decodeOptionalQueryResult } from "./zeroQuery";

const SheetConfigurationState = Schema.Struct({
  workspaceId: Schema.String,
  draftVersion: Schema.Int,
  source: SheetConfigurationSource,
  legacyBinding: Schema.NullOr(LegacySourceBinding),
  baseRevisionId: Schema.NullOr(Schema.String),
  baselineDigest: Schema.NullOr(Schema.String),
  configuration: Schema.NullOr(WebSheetConfiguration),
  diagnostics: Schema.Array(SheetConfigurationDiagnostic),
  activeRevisionId: Schema.NullOr(Schema.String),
  updatedAtEpochMs: Schema.Int,
});
export type SheetConfigurationState = Schema.Schema.Type<typeof SheetConfigurationState>;

const revisionsSchema = Schema.Array(SheetConfigurationRevision);
type SheetConfigurationRevisionValue = Schema.Schema.Type<typeof SheetConfigurationRevision>;

const asyncResultSchema = <A extends Schema.Top>(success: A) =>
  Schema.revealCodec(
    AsyncResult.Schema({
      success,
      error: Schema.Unknown,
    }),
  );

const configurationKey = (workspaceId: string) => `sheetConfiguration:${workspaceId}`;
const revisionsKey = (workspaceId: string) => `sheetConfigurationRevisions:${workspaceId}`;

const defaultState = (
  workspaceId: string,
  source: typeof SheetConfigurationSource.Type = { kind: "owned", revisionId: null },
): SheetConfigurationState => ({
  workspaceId,
  draftVersion: 0,
  source,
  legacyBinding: null,
  baseRevisionId: null,
  baselineDigest: null,
  configuration: null,
  diagnostics: [],
  activeRevisionId: null,
  updatedAtEpochMs: 0,
});

const decodeState = (
  workspaceId: string,
  row: Option.Option<ConfigWorkspaceSheetRow>,
  defaultSource: typeof SheetConfigurationSource.Type,
) => {
  if (Option.isNone(row)) return Effect.succeed(defaultState(workspaceId, defaultSource));
  return Effect.gen(function* () {
    const source = yield* Schema.decodeUnknownEffect(SheetConfigurationSource)(row.value.source);
    const legacyBinding = yield* Schema.decodeUnknownEffect(Schema.NullOr(LegacySourceBinding))(
      row.value.legacyBinding,
    );
    const configuration =
      row.value.draft === null
        ? null
        : yield* Schema.decodeUnknownEffect(WebSheetConfiguration)(row.value.draft);
    const diagnostics = yield* Schema.decodeUnknownEffect(
      Schema.Array(SheetConfigurationDiagnostic),
    )(row.value.diagnostics);
    return {
      workspaceId,
      draftVersion: row.value.draftVersion,
      source,
      legacyBinding,
      baseRevisionId: row.value.baseRevisionId,
      baselineDigest: row.value.baselineDigest,
      configuration,
      diagnostics,
      activeRevisionId: row.value.activeRevisionId,
      updatedAtEpochMs: row.value.updatedAt,
    };
  });
};

const decodeRevisions = (rows: ReadonlyArray<ConfigWorkspaceSheetRevisionRow>) =>
  Effect.forEach(rows, (row) =>
    Schema.decodeUnknownEffect(WebSheetConfiguration)(row.configuration).pipe(
      Effect.map(
        (configuration): SheetConfigurationRevisionValue => ({
          revisionId: row.revisionId,
          workspaceId: row.workspaceId,
          createdAtEpochMs: row.createdAt,
          createdBy: row.createdBy,
          configuration,
        }),
      ),
    ),
  );

// State and revision atoms intentionally share the same runtime/query loading boundary.
// fallow-ignore-next-line code-duplication
const sheetConfigurationAtom = Atom.family((workspaceId: string) =>
  Atom.make<SheetConfigurationState, unknown>(
    Effect.fnUntraced(function* (get) {
      const runtime = yield* get.result(sheetZeroClientAtom);
      const rawConfiguration = yield* get.result(
        makeQuery(runtime.sheet, sheetZeroApi.sheetConfiguration.getSheetConfiguration, {
          workspaceId,
        }),
      );
      const configurationRow = yield* decodeOptionalQueryResult(
        ConfigWorkspaceSheetRow,
        rawConfiguration,
      );
      const rawWorkspace = yield* get.result(
        makeQuery(runtime.sheet, sheetZeroApi.workspaceConfig.getWorkspaceConfigByWorkspaceId, {
          workspaceId,
        }),
      );
      const workspace = yield* decodeOptionalQueryResult(ConfigWorkspaceRow, rawWorkspace);
      const defaultSource = Option.match(workspace, {
        onNone: () => ({ kind: "owned" as const, revisionId: null }),
        onSome: ({ sheetId }) =>
          sheetId === null || sheetId.trim().length === 0
            ? { kind: "owned" as const, revisionId: null }
            : sourceForLegacySettings(),
      });
      return yield* decodeState(workspaceId, configurationRow, defaultSource);
    }),
  ).pipe(
    Atom.setIdleTTL(Duration.minutes(2)),
    Atom.serializable({
      key: `sheetConfiguration.state.${workspaceId}`,
      schema: asyncResultSchema(SheetConfigurationState),
    }),
    Atom.withReactivity([configurationKey(workspaceId)]),
  ),
);

const sheetConfigurationRevisionsAtom = Atom.family((workspaceId: string) =>
  Atom.make<ReadonlyArray<SheetConfigurationRevisionValue>, unknown>(
    Effect.fnUntraced(function* (get) {
      const runtime = yield* get.result(sheetZeroClientAtom);
      const raw = yield* get.result(
        makeQuery(runtime.sheet, sheetZeroApi.sheetConfiguration.getSheetConfigurationRevisions, {
          workspaceId,
        }),
      );
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ConfigWorkspaceSheetRevisionRow))(
        raw,
      );
      return yield* decodeRevisions(rows);
    }),
  ).pipe(
    Atom.setIdleTTL(Duration.minutes(2)),
    Atom.serializable({
      key: `sheetConfiguration.revisions.${workspaceId}`,
      schema: asyncResultSchema(revisionsSchema),
    }),
    Atom.withReactivity([revisionsKey(workspaceId)]),
  ),
);

export const useSheetConfigurationResult = (workspaceId: string) =>
  useAtomSuspense(sheetConfigurationAtom(workspaceId), {
    suspendOnWaiting: false,
    includeFailure: true,
  });

export const useRefreshSheetConfiguration = (workspaceId: string) =>
  useAtomRefresh(sheetConfigurationAtom(workspaceId));

export const useSheetConfigurationRevisionsResult = (workspaceId: string) =>
  useAtomSuspense(sheetConfigurationRevisionsAtom(workspaceId), {
    suspendOnWaiting: false,
    includeFailure: true,
  });

export const useRefreshSheetConfigurationRevisions = (workspaceId: string) =>
  useAtomRefresh(sheetConfigurationRevisionsAtom(workspaceId));

const invalidateConfiguration = (workspaceId: string) =>
  Reactivity.invalidate([configurationKey(workspaceId), revisionsKey(workspaceId)]);

// The fallback preserves request-ID generation in runtimes without crypto.randomUUID.
// fallow-ignore-next-line complexity
const makeUuid = () => {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  if (crypto === undefined || !crypto.getRandomValues) {
    throw new Error("Secure randomness is required to create a Sheet Configuration request ID");
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `sheet-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

class SheetConfigurationRequestIdError extends Data.TaggedError(
  "SheetConfigurationRequestIdError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const makeUuidEffect = Effect.try({
  try: makeUuid,
  catch: (cause) =>
    new SheetConfigurationRequestIdError({
      message: "Secure randomness is required to create a Sheet Configuration request ID",
      cause,
    }),
});

type SheetZeroClient = Atom.Success<typeof sheetZeroClientAtom>;

const makeConfigurationMutation = <
  InputSchema extends Schema.Codec<WorkspaceInput, unknown, never, never>,
  SuccessSchema extends Schema.Codec<unknown, unknown, never, never>,
>(
  inputSchema: InputSchema,
  successSchema: SuccessSchema,
  run: (
    runtime: SheetZeroClient,
    input: InputSchema["Type"],
  ) => Effect.Effect<SuccessSchema["Type"], unknown>,
) =>
  runtimeAtom.fn(
    Effect.fnUntraced(function* (payload: Schema.Schema.Type<InputSchema>, ctx: Atom.FnContext) {
      const runtime = yield* ctx.result(sheetZeroClientAtom);
      const input = yield* Schema.decodeUnknownEffect(inputSchema)(payload);
      const result = yield* run(runtime, input);
      yield* invalidateConfiguration(payload.workspaceId);
      return yield* Schema.decodeUnknownEffect(successSchema)(result);
    }),
  );

const SheetConfigurationImportLegacyMutationInput = Schema.Struct({
  workspaceId: WorkspaceId,
  attemptId: Schema.optional(Schema.String),
});

const importLegacyMutation = makeConfigurationMutation(
  SheetConfigurationImportLegacyMutationInput,
  SheetConfigurationImportLegacySuccess,
  (runtime, payload) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(SheetConfigurationImportLegacyInput)({
        workspaceId: payload.workspaceId,
        attemptId: payload.attemptId ?? (yield* makeUuidEffect),
      });
      return yield* runSheetWorkflow(
        runtime.workflows.sheetConfiguration.importLegacy,
        input,
        SheetConfigurationImportLegacySuccess,
      );
    }),
);

const saveDraftMutation = makeConfigurationMutation(
  SheetConfigurationSaveDraftInput,
  SheetConfigurationSaveDraftSuccess,
  (runtime, input) =>
    runSheetWorkflow(
      runtime.workflows.sheetConfiguration.saveDraft,
      input,
      SheetConfigurationSaveDraftSuccess,
    ),
);

const saveRevisionMutation = makeConfigurationMutation(
  SheetConfigurationSaveRevisionInput,
  SheetConfigurationSaveRevisionSuccess,
  (runtime, input) =>
    runSheetWorkflow(
      runtime.workflows.sheetConfiguration.saveRevision,
      input,
      SheetConfigurationSaveRevisionSuccess,
    ),
);

const activateMutation = makeConfigurationMutation(
  SheetConfigurationActivateInput,
  SheetConfigurationActivateSuccess,
  (runtime, input) =>
    runSheetWorkflow(
      runtime.workflows.sheetConfiguration.activate,
      input,
      SheetConfigurationActivateSuccess,
    ),
);

const rollbackMutation = makeConfigurationMutation(
  SheetConfigurationRollbackInput,
  SheetConfigurationRollbackSuccess,
  (runtime, input) =>
    runSheetWorkflow(
      runtime.workflows.sheetConfiguration.rollback,
      input,
      SheetConfigurationRollbackSuccess,
    ),
);

const discardDraftMutation = makeConfigurationMutation(
  SheetConfigurationDiscardDraftInput,
  SheetConfigurationDiscardDraftSuccess,
  (runtime, input) =>
    runSheetWorkflow(
      runtime.workflows.sheetConfiguration.discardDraft,
      input,
      SheetConfigurationDiscardDraftSuccess,
    ),
);

export const useImportLegacyConfiguration = () => {
  const mutate = useAtomSet(importLegacyMutation, { mode: "promise" });
  return useCallback(
    (workspaceId: typeof WorkspaceId.Type, attemptId?: string) =>
      mutate({ workspaceId, ...(attemptId === undefined ? {} : { attemptId }) }),
    [mutate],
  );
};

export const useSaveSheetConfigurationDraft = () => {
  const mutate = useAtomSet(saveDraftMutation, { mode: "promise" });
  return useCallback((input: SheetConfigurationSaveDraftInput) => mutate(input), [mutate]);
};

export const useSaveSheetConfigurationRevision = () => {
  const mutate = useAtomSet(saveRevisionMutation, { mode: "promise" });
  return useCallback((input: SheetConfigurationSaveRevisionInput) => mutate(input), [mutate]);
};

export const useActivateSheetConfiguration = () => {
  const mutate = useAtomSet(activateMutation, { mode: "promise" });
  return useCallback((input: SheetConfigurationActivateInput) => mutate(input), [mutate]);
};

export const useRollbackSheetConfiguration = () => {
  const mutate = useAtomSet(rollbackMutation, { mode: "promise" });
  return useCallback((input: SheetConfigurationRollbackInput) => mutate(input), [mutate]);
};

export const useDiscardSheetConfigurationDraft = () => {
  const mutate = useAtomSet(discardDraftMutation, { mode: "promise" });
  return useCallback((input: SheetConfigurationDiscardDraftInput) => mutate(input), [mutate]);
};

export const newSheetConfigurationRevisionId = makeUuid;
