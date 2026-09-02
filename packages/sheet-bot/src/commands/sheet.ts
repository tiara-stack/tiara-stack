import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import {
  Cause,
  Data,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Random,
  Schema,
  Stream,
} from "effect";
import {
  SheetConfigurationDiagnostic,
  SheetConfigurationSource,
  WebSheetConfiguration,
  sourceForLegacySettings,
} from "sheet-domain";
import {
  SheetConfigurationEditDraftInput,
  SheetConfigurationScalarEdit,
  SpreadsheetId,
  WorkspaceCapabilities,
  WorkspaceId,
} from "sheet-workflow-contracts";
import {
  SheetWorkflowHttpRequestContext,
  SheetWorkflowHttpClient,
  SheetZeroClient,
  enqueueSheetConfigurationActivateWorkflow,
  enqueueSheetConfigurationDiscardDraftWorkflow,
  enqueueSheetConfigurationEditDraftWorkflow,
  enqueueSheetConfigurationRollbackWorkflow,
  enqueueSheetConfigurationSaveDraftWorkflow,
  enqueueSheetConfigurationSaveRevisionWorkflow,
  type AuthorizationLoadWorkspaceCapabilitiesWorkflow,
  type SheetWorkflowHttpClientShape,
} from "../services";
import {
  decodeWorkflowWorkspaceId,
  requireBoolean,
  requireString,
  resolveGuildId,
  serverIdOption,
} from "../utils/commandHelpers";
import { registerGlobalCommandLayer } from "../utils/registerGlobalCommandLayer";

class SheetCommandError extends Data.TaggedError("SheetCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type SheetConfigurationState = {
  readonly draftVersion: number;
  readonly source: typeof SheetConfigurationSource.Type;
  readonly baseRevisionId: string | null;
  readonly baselineDigest: string | null;
  readonly configuration: typeof WebSheetConfiguration.Type | null;
  readonly diagnostics: ReadonlyArray<typeof SheetConfigurationDiagnostic.Type>;
  readonly activeRevisionId: string | null;
};

type OwnedSheetConfigurationState = Omit<SheetConfigurationState, "source"> & {
  readonly source: Extract<SheetConfigurationState["source"], { readonly kind: "owned" }>;
};

type AuthorizationWorkflowRun =
  Stream.Success<
    ReturnType<AuthorizationLoadWorkspaceCapabilitiesWorkflow["get"]>
  > extends Option.Option<infer Run>
    ? Run
    : never;

type SheetConfigurationAuthorizationClient = Pick<
  SheetWorkflowHttpClientShape,
  "authorizationLoadWorkspaceCapabilities"
>;

const workflowObservationInitialPollInterval = Duration.millis(250);
const workflowObservationMaxPollInterval = Duration.seconds(2);
const workflowObservationTimeout = Duration.seconds(60);

const nextWorkflowObservationPollInterval = (current: Duration.Duration) =>
  Duration.min(Duration.times(current, 2), workflowObservationMaxPollInterval);

const observeAuthorizationWorkflowUntilTerminal = (
  workflow: AuthorizationLoadWorkspaceCapabilitiesWorkflow,
  reference: Effect.Success<ReturnType<AuthorizationLoadWorkspaceCapabilitiesWorkflow["enqueue"]>>,
  pollInterval: Duration.Duration = workflowObservationInitialPollInterval,
): Effect.Effect<Option.Option<AuthorizationWorkflowRun>, unknown> =>
  workflow.get(reference).pipe(
    Stream.filter((run): run is Option.Some<AuthorizationWorkflowRun> => Option.isSome(run)),
    Stream.map((run) => run.value),
    Stream.takeUntil((run) => run.result._tag !== "Pending"),
    Stream.runLast,
    Effect.flatMap((observed) => {
      const pollAgain = Effect.sleep(pollInterval).pipe(
        Effect.flatMap(() =>
          Effect.suspend(() =>
            observeAuthorizationWorkflowUntilTerminal(
              workflow,
              reference,
              nextWorkflowObservationPollInterval(pollInterval),
            ),
          ),
        ),
      );
      return Option.match(observed, {
        onNone: () => pollAgain,
        onSome: (run) =>
          run.result._tag === "Pending" ? pollAgain : Effect.succeed(Option.some(run)),
      });
    }),
  );

const makeDefaultState = (
  source: typeof SheetConfigurationSource.Type,
): SheetConfigurationState => ({
  draftVersion: 0,
  source,
  baseRevisionId: null,
  baselineDigest: null,
  configuration: null,
  diagnostics: [],
  activeRevisionId: null,
});

const decodeValue = <A>(schema: Schema.Decoder<A, never>, value: unknown, message: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => new SheetCommandError({ message, cause })),
  );

const decodeStored = <A>(schema: Schema.Decoder<A, never>, value: unknown, label: string) =>
  decodeValue(schema, value, `Stored ${label} is invalid.`);

const loadConfigurationState = Effect.fn("sheet.loadConfigurationState")(function* (
  client: Pick<typeof SheetZeroClient.Service, "getSheetConfiguration" | "getWorkspaceConfig">,
  workspaceId: string,
) {
  const row = yield* client.getSheetConfiguration(workspaceId);
  if (Option.isNone(row)) {
    const workspace = yield* client.getWorkspaceConfig(workspaceId);
    return Option.match(workspace, {
      onNone: () => makeDefaultState({ kind: "owned", revisionId: null }),
      onSome: ({ sheetId }) =>
        Predicate.isString(sheetId) && sheetId.trim().length > 0
          ? makeDefaultState(sourceForLegacySettings())
          : makeDefaultState({ kind: "owned", revisionId: null }),
    });
  }

  const source = yield* decodeStored(
    SheetConfigurationSource,
    row.value.source,
    "configuration source",
  );
  const configuration =
    row.value.draft === null
      ? null
      : yield* decodeStored(WebSheetConfiguration, row.value.draft, "configuration draft");
  const diagnostics = yield* decodeStored(
    Schema.Array(SheetConfigurationDiagnostic),
    row.value.diagnostics,
    "configuration diagnostics",
  );

  return {
    draftVersion: row.value.draftVersion,
    source,
    baseRevisionId: row.value.baseRevisionId,
    baselineDigest: row.value.baselineDigest,
    configuration,
    diagnostics,
    activeRevisionId: row.value.activeRevisionId,
  } satisfies SheetConfigurationState;
});

const loadActiveConfiguration = Effect.fn("sheet.loadActiveConfiguration")(function* (
  client: Pick<typeof SheetZeroClient.Service, "getSheetConfigurationRevisions">,
  workspaceId: string,
  revisionId: string | null,
) {
  if (revisionId === null) return null;
  const revisions = yield* client.getSheetConfigurationRevisions(workspaceId);
  const revision = revisions.find((candidate) => candidate.revisionId === revisionId);
  return revision === undefined
    ? null
    : yield* decodeStored(WebSheetConfiguration, revision.configuration, "active configuration");
});

const starterRange = (startColumn: number, endColumn: number) => ({
  sheetId: 0,
  startRow: 7,
  endRow: "sheet-end" as const,
  startColumn,
  endColumn,
});

const starterConfiguration = (spreadsheetId: typeof SpreadsheetId.Type) =>
  ({
    schemaVersion: 1,
    spreadsheetId,
    users: {
      userIds: starterRange(1, 2),
      userSheetNames: starterRange(2, 3),
    },
    teams: [],
    event: { startTimeEpochMs: 0 },
    schedules: [],
    runners: [],
  }) satisfies typeof WebSheetConfiguration.Type;

const hasConfigurationErrors = (
  diagnostics: ReadonlyArray<typeof SheetConfigurationDiagnostic.Type>,
) => diagnostics.some(({ severity }) => severity === "error");

const isSheetCommandError = (error: unknown): error is SheetCommandError =>
  Predicate.isTagged("SheetCommandError")(error) &&
  Predicate.hasProperty(error, "message") &&
  Predicate.isString(error.message);

const isCommandHelperError = (error: unknown): error is { readonly message: string } =>
  Predicate.isTagged("SheetBotUtilsCommandHelpersError")(error) &&
  Predicate.hasProperty(error, "message") &&
  Predicate.isString(error.message);

const sourceLabel = (source: typeof SheetConfigurationSource.Type) =>
  source.kind === "legacy"
    ? `legacy (${source.binding.expectedTitle})`
    : source.revisionId === null
      ? "owned (unconfigured)"
      : `owned (${source.revisionId})`;

// The user-facing error map preserves actionable messages while hiding provider details.
const workflowErrorMessages = {
  WorkflowInvocationUnauthorized:
    "You aren't allowed to manage Sheet Configuration in that server.",
  WorkflowInputRejected: "The Sheet Configuration request was rejected as invalid.",
  WorkflowTransportUnavailable:
    "The Sheet Configuration request could not reach the workflow service. Try again.",
} as const;

type WorkflowErrorTag = keyof typeof workflowErrorMessages;

const isWorkflowError = (error: unknown): error is { readonly _tag: WorkflowErrorTag } =>
  (Object.keys(workflowErrorMessages) as ReadonlyArray<WorkflowErrorTag>).some((tag) =>
    Predicate.isTagged(tag)(error),
  );

const errorMessage = (error: unknown): string =>
  Match.value(error).pipe(
    Match.when(isWorkflowError, ({ _tag }) => workflowErrorMessages[_tag]),
    Match.when(isSheetCommandError, ({ message }) => message),
    Match.when(isCommandHelperError, ({ message }) => message),
    Match.orElse(() => "I couldn't complete that Sheet Configuration request. Try again."),
  );

const runCommand = <A, E, R>(
  response: Pick<CommandInteractionResponseContext, "editReply">,
  action: Effect.Effect<A, E, R>,
): Effect.Effect<void, unknown, R> =>
  action.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      return Effect.logWarning("Sheet Configuration command failed", { error }).pipe(
        Effect.andThen(response.editReply({ payload: { content: errorMessage(error) } })),
        Effect.asVoid,
      );
    }),
    Effect.asVoid,
  );

const runDeferredCommand = <Command, A, E, R>(
  command: Command,
  action: (
    command: Command,
    response: Pick<CommandInteractionResponseContext, "editReply">,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const response = yield* InteractionResponse;
    yield* response.deferReply({ flags: MessageFlags.Ephemeral });
    yield* runCommand(response, action(command, response));
  });

const requireSheetConfigurationManageAccess = (
  workflowClient: SheetConfigurationAuthorizationClient,
  workspaceId: string,
) =>
  SheetWorkflowHttpRequestContext.asInteractionUser(() =>
    Effect.gen(function* () {
      const typedWorkspaceId = yield* decodeValue(
        WorkspaceId,
        workspaceId,
        "Workspace ID is invalid.",
      );
      const reference = yield* workflowClient.authorizationLoadWorkspaceCapabilities
        .enqueue({ workspaceId: typedWorkspaceId })
        .pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(30),
            orElse: () =>
              Effect.fail(
                new SheetCommandError({
                  message: "The Sheet Configuration permission check timed out.",
                }),
              ),
          }),
        );
      const terminal = yield* observeAuthorizationWorkflowUntilTerminal(
        workflowClient.authorizationLoadWorkspaceCapabilities,
        reference,
      ).pipe(
        Effect.timeoutOrElse({
          duration: workflowObservationTimeout,
          orElse: () =>
            Effect.fail(
              new SheetCommandError({
                message: "The Sheet Configuration permission check timed out.",
              }),
            ),
        }),
      );
      if (Option.isNone(terminal)) {
        return yield* Effect.fail(
          new SheetCommandError({
            message: "The Sheet Configuration permission check returned no result.",
          }),
        );
      }
      if (terminal.value.result._tag !== "Success") {
        return yield* Effect.fail(
          new SheetCommandError({
            message: "Could not verify Sheet Configuration access. Try again.",
          }),
        );
      }
      const capabilities = yield* decodeValue(
        WorkspaceCapabilities,
        terminal.value.result.value,
        "The Sheet Configuration permission check returned invalid data.",
      );
      if (!capabilities.capabilities.includes("manage")) {
        return yield* Effect.fail(
          new SheetCommandError({
            message: "You aren't allowed to manage Sheet Configuration in that server.",
          }),
        );
      }
    }),
  )();

const loadOwnedConfigurationState = (
  client: Pick<typeof SheetZeroClient.Service, "getSheetConfiguration" | "getWorkspaceConfig">,
  workspaceId: string,
  legacyMessage = "The legacy source is read-only. Import it from the web editor first.",
) =>
  Effect.gen(function* () {
    const state = yield* loadConfigurationState(client, workspaceId);
    if (state.source.kind === "legacy") {
      return yield* Effect.fail(new SheetCommandError({ message: legacyMessage }));
    }
    return { ...state, source: state.source } satisfies OwnedSheetConfigurationState;
  });

const loadOwnedCommandState = (
  client: Pick<typeof SheetZeroClient.Service, "getSheetConfiguration" | "getWorkspaceConfig">,
  workflowClient: SheetConfigurationAuthorizationClient,
  serverId: Option.Option<string>,
  legacyMessage?: string,
) =>
  Effect.gen(function* () {
    const workspaceId = yield* resolveWorkspace(serverId);
    yield* requireSheetConfigurationManageAccess(workflowClient, workspaceId);
    const state = yield* loadOwnedConfigurationState(client, workspaceId, legacyMessage);
    return { workspaceId, state };
  });

const requireConfigurationDraft = (
  configuration: typeof WebSheetConfiguration.Type | null,
): Effect.Effect<typeof WebSheetConfiguration.Type, SheetCommandError, never> => {
  if (Predicate.isNull(configuration)) {
    return Effect.fail(
      new SheetCommandError({
        message: "There is no Sheet Configuration draft to edit.",
      }),
    );
  }
  return Effect.succeed(configuration);
};

const loadCommandState = (
  client: Pick<typeof SheetZeroClient.Service, "getSheetConfiguration" | "getWorkspaceConfig">,
  workflowClient: SheetConfigurationAuthorizationClient,
  serverId: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const workspaceId = yield* resolveWorkspace(serverId);
    yield* requireSheetConfigurationManageAccess(workflowClient, workspaceId);
    const state = yield* loadConfigurationState(client, workspaceId);
    return { workspaceId, state };
  });

const enqueueAndReport = <A extends { readonly invocationId: string }, E>(
  response: Pick<CommandInteractionResponseContext, "editReply">,
  operation: string,
  enqueue: Effect.Effect<A, E, never>,
  details?: string,
) =>
  SheetWorkflowHttpRequestContext.asInteractionUser(() => enqueue)().pipe(
    Effect.flatMap((reference) =>
      response.editReply({
        payload: {
          content: `${operation} queued.${details === undefined ? "" : ` ${details}`} Workflow reference: ${reference.invocationId}`,
        },
      }),
    ),
  );

const resolveWorkspace = (serverId: Option.Option<string>) =>
  resolveGuildId(serverId).pipe(Effect.flatMap(decodeWorkflowWorkspaceId));

const decodeCommandValue = <A>(schema: Schema.Decoder<A, never>, value: unknown, label: string) =>
  decodeValue(schema, value, `${label} is invalid.`);

const scalarEditField = Schema.Literals([
  "spreadsheet",
  "event_start_time",
  "team_name",
  "schedule_channel",
  "schedule_day",
  "schedule_encoding",
  "runner_name",
  "team_tags",
]);

const rangeEditPath = Schema.Literals([
  "users.userIds",
  "users.userSheetNames",
  "users.userNotes",
  "users.monitors.ids",
  "users.monitors.names",
  "users.oshis",
  "teams.teamName",
  "teams.userNames",
  "teams.isv",
  "teams.isv.lead",
  "teams.isv.backline",
  "teams.isv.talent",
  "teams.tags",
  "teams.oshiRange",
  "schedules.hourRange",
  "schedules.breakRange",
  "schedules.monitorRange",
  "schedules.fillRange",
  "schedules.overfillRange",
  "schedules.standbyRange",
  "schedules.screenshotRange",
  "schedules.noteRange",
  "schedules.visibleCell",
]);

const entryCollection = Schema.Literals(["teams", "schedules", "runners"]);
const entryAction = Schema.Literals(["add", "remove", "reorder"]);

const commandStringOption = (value: Option.Option<unknown>, label: string) =>
  Option.match(value, {
    onNone: () =>
      Effect.fail(
        new SheetCommandError({
          message: `${label} is required.`,
        }),
      ),
    onSome: (candidate) => requireString(candidate, label),
  });

const commandNumberOption = (value: Option.Option<unknown>, label: string) =>
  Option.match(value, {
    onNone: () =>
      Effect.fail(
        new SheetCommandError({
          message: `${label} is required.`,
        }),
      ),
    onSome: (candidate) =>
      Schema.decodeUnknownEffect(Schema.Int)(candidate).pipe(
        Effect.mapError(() => new SheetCommandError({ message: `${label} must be an integer.` })),
      ),
  });

const makeListSubCommand = Effect.gen(function* () {
  const zeroClient = yield* SheetZeroClient;
  const workflowClient = yield* SheetWorkflowHttpClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("list")
        .setDescription("Show the active Sheet Configuration and drafts")
        .addStringOption(serverIdOption("The server to inspect")),
    Effect.fn("sheet.list")(function* (command) {
      yield* runDeferredCommand(command, (command, response) =>
        // Listing combines the compatibility source state with immutable revision metadata.
        // fallow-ignore-next-line complexity
        Effect.gen(function* () {
          const { workspaceId, state } = yield* loadCommandState(
            zeroClient,
            workflowClient,
            command.optionValueOptional("server_id"),
          );
          const revisions = yield* zeroClient.getSheetConfigurationRevisions(workspaceId);
          const draft = state.configuration === null ? "no draft" : `draft v${state.draftVersion}`;
          const legacyHint =
            state.source.kind === "legacy"
              ? " Use the web editor to import the legacy settings before editing."
              : "";
          return yield* response.editReply({
            payload: {
              content: [
                `Sheet Configuration: ${sourceLabel(state.source)}`,
                `State: ${draft}; ${revisions.length} immutable revision${revisions.length === 1 ? "" : "s"}.`,
                `Active revision: ${state.activeRevisionId ?? "none"}.${legacyHint}`,
              ].join("\n"),
            },
          });
        }),
      );
    }),
  );
});

const makeSetSubCommand = Effect.gen(function* () {
  const zeroClient = yield* SheetZeroClient;
  const workflowClient = yield* SheetWorkflowHttpClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("set")
        .setDescription("Start or update an owned draft for a spreadsheet")
        .addStringOption((option) =>
          option
            .setName("spreadsheet_id")
            .setDescription("The Google Spreadsheet ID")
            .setRequired(true),
        )
        .addStringOption(serverIdOption("The server to configure")),
    // Each sheet command shares this deferred interaction boundary before its command-specific decode.
    // fallow-ignore-next-line code-duplication
    Effect.fn("sheet.set")(function* (command) {
      yield* runDeferredCommand(command, (command, response) =>
        // The set command validates ownership and spreadsheet binding before saving a draft.
        // fallow-ignore-next-line complexity
        Effect.gen(function* () {
          const { workspaceId, state } = yield* loadOwnedCommandState(
            zeroClient,
            workflowClient,
            command.optionValueOptional("server_id"),
          );
          const spreadsheetId = yield* Schema.decodeUnknownEffect(SpreadsheetId)(
            yield* requireString(command.optionValue("spreadsheet_id"), "spreadsheet_id"),
          ).pipe(
            Effect.mapError(
              () =>
                new SheetCommandError({
                  message: "The spreadsheet ID is not a valid Google Spreadsheet ID.",
                }),
            ),
          );
          const activeConfiguration =
            state.configuration ??
            (yield* loadActiveConfiguration(
              zeroClient,
              workspaceId,
              state.activeRevisionId ?? state.source.revisionId,
            ));
          const configuration = activeConfiguration
            ? { ...activeConfiguration, spreadsheetId }
            : starterConfiguration(spreadsheetId);
          const source = state.source;
          const editReply = yield* enqueueAndReport(
            response,
            "Sheet Configuration draft update",
            enqueueSheetConfigurationSaveDraftWorkflow(workflowClient, {
              workspaceId,
              expectedDraftVersion: state.draftVersion,
              source,
              legacyBinding: null,
              baseRevisionId: state.baseRevisionId ?? state.activeRevisionId,
              baselineDigest: state.baselineDigest,
              configuration,
              diagnostics: [],
            }),
          );
          return editReply;
        }),
      );
    }),
  );
});

const makeScalarEditSubCommand = Effect.gen(function* () {
  const zeroClient = yield* SheetZeroClient;
  const workflowClient = yield* SheetWorkflowHttpClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("edit_scalar")
        .setDescription("Set a typed scalar Sheet Configuration field")
        .addStringOption((option) =>
          option
            .setName("field")
            .setDescription("The scalar field to change")
            .setRequired(true)
            .addChoices(
              { name: "Spreadsheet ID", value: "spreadsheet" },
              { name: "Event start time (UTC ms)", value: "event_start_time" },
              { name: "Team name", value: "team_name" },
              { name: "Schedule channel", value: "schedule_channel" },
              { name: "Schedule day", value: "schedule_day" },
              { name: "Schedule encoding", value: "schedule_encoding" },
              { name: "Runner name", value: "runner_name" },
              { name: "Team constant tags", value: "team_tags" },
            ),
        )
        .addStringOption((option) =>
          option.setName("entry_id").setDescription("Stable team, schedule, or runner entry ID"),
        )
        .addStringOption((option) =>
          option.setName("text").setDescription("Text value, or comma-separated team tags"),
        )
        .addIntegerOption((option) =>
          option.setName("number").setDescription("Integer value for time or day fields"),
        )
        .addStringOption(serverIdOption("The server to configure")),
    // fallow-ignore-next-line code-duplication
    Effect.fn("sheet.editScalar")(function* (command) {
      yield* runDeferredCommand(command, (command, response) =>
        Effect.gen(function* () {
          const { workspaceId, state } = yield* loadOwnedCommandState(
            zeroClient,
            workflowClient,
            command.optionValueOptional("server_id"),
          );
          yield* requireConfigurationDraft(state.configuration);
          const field = yield* decodeCommandValue(
            scalarEditField,
            command.optionValue("field"),
            "field",
          );
          const entryId = () =>
            commandStringOption(command.optionValueOptional("entry_id"), "entry_id");
          const text = () => commandStringOption(command.optionValueOptional("text"), "text");
          const scalarEditBuilders: Record<
            typeof scalarEditField.Type,
            () => Effect.Effect<typeof SheetConfigurationScalarEdit.Type, unknown, never>
          > = {
            spreadsheet: () =>
              Effect.gen(function* () {
                return {
                  kind: "setSpreadsheetId" as const,
                  value: yield* decodeCommandValue(SpreadsheetId, yield* text(), "spreadsheet ID"),
                };
              }),
            event_start_time: () =>
              Effect.gen(function* () {
                return {
                  kind: "setEventStartTime" as const,
                  value: yield* commandNumberOption(
                    command.optionValueOptional("number"),
                    "event start time",
                  ),
                };
              }),
            team_name: () =>
              Effect.gen(function* () {
                return {
                  kind: "setTeamName" as const,
                  entryId: yield* entryId(),
                  value: yield* text(),
                };
              }),
            schedule_channel: () =>
              Effect.gen(function* () {
                return {
                  kind: "setScheduleChannel" as const,
                  entryId: yield* entryId(),
                  value: yield* text(),
                };
              }),
            schedule_day: () =>
              Effect.gen(function* () {
                return {
                  kind: "setScheduleDay" as const,
                  entryId: yield* entryId(),
                  value: yield* commandNumberOption(
                    command.optionValueOptional("number"),
                    "schedule day",
                  ),
                };
              }),
            schedule_encoding: () =>
              Effect.gen(function* () {
                return {
                  kind: "setScheduleEncoding" as const,
                  entryId: yield* entryId(),
                  value: yield* decodeCommandValue(
                    Schema.Literals(["none", "regex", "bold", "underline"]),
                    yield* text(),
                    "schedule encoding",
                  ),
                };
              }),
            runner_name: () =>
              Effect.gen(function* () {
                return {
                  kind: "setRunnerName" as const,
                  entryId: yield* entryId(),
                  value: yield* text(),
                };
              }),
            team_tags: () =>
              Effect.gen(function* () {
                return {
                  kind: "setTeamTags" as const,
                  entryId: yield* entryId(),
                  values: (yield* text())
                    .split(",")
                    .map((value) => value.trim())
                    .filter((value) => value.length > 0),
                };
              }),
          };
          const edit = yield* scalarEditBuilders[field]();
          const input = yield* decodeCommandValue(
            SheetConfigurationEditDraftInput,
            { workspaceId, expectedDraftVersion: state.draftVersion, edit },
            "edit",
          );
          return yield* enqueueAndReport(
            response,
            "Sheet Configuration scalar edit",
            enqueueSheetConfigurationEditDraftWorkflow(workflowClient, input),
          );
        }),
      );
    }),
  );
});

const makeRangeEditSubCommand = Effect.gen(function* () {
  const zeroClient = yield* SheetZeroClient;
  const workflowClient = yield* SheetWorkflowHttpClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("edit_range")
        .setDescription("Set one contiguous tab-qualified A1 range")
        .addStringOption((option) =>
          option
            .setName("field")
            .setDescription("The range field to change")
            .setRequired(true)
            .addChoices(...rangeEditPath.literals.map((value) => ({ name: value, value }))),
        )
        .addStringOption((option) =>
          option
            .setName("range")
            .setDescription("For example: 'Schedule Tab'!$D$3:$F$5")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("entry_id").setDescription("Stable team or schedule entry ID"),
        )
        .addStringOption(serverIdOption("The server to configure")),
    // fallow-ignore-next-line code-duplication
    Effect.fn("sheet.editRange")(function* (command) {
      yield* runDeferredCommand(command, (command, response) =>
        Effect.gen(function* () {
          const { workspaceId, state } = yield* loadOwnedCommandState(
            zeroClient,
            workflowClient,
            command.optionValueOptional("server_id"),
          );
          yield* requireConfigurationDraft(state.configuration);
          const path = yield* decodeCommandValue(
            rangeEditPath,
            command.optionValue("field"),
            "field",
          );
          const a1 = yield* commandStringOption(command.optionValueOptional("range"), "range");
          const rawEntryId = Option.getOrUndefined(command.optionValueOptional("entry_id"));
          const entryId =
            rawEntryId === undefined ? null : yield* requireString(rawEntryId, "entry_id");
          const input = yield* decodeCommandValue(
            SheetConfigurationEditDraftInput,
            {
              workspaceId,
              expectedDraftVersion: state.draftVersion,
              edit: { kind: "setRange", path, entryId, a1 },
            },
            "edit",
          );
          return yield* enqueueAndReport(
            response,
            "Sheet Configuration range edit",
            enqueueSheetConfigurationEditDraftWorkflow(workflowClient, input),
          );
        }),
      );
    }),
  );
});

const makeEntryEditSubCommand = Effect.gen(function* () {
  const zeroClient = yield* SheetZeroClient;
  const workflowClient = yield* SheetWorkflowHttpClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("edit_entry")
        .setDescription("Add, remove, or reorder a stable configuration entry")
        .addStringOption((option) =>
          option
            .setName("collection")
            .setDescription("The entry collection")
            .setRequired(true)
            .addChoices(
              { name: "Teams", value: "teams" },
              { name: "Schedules", value: "schedules" },
              { name: "Runners", value: "runners" },
            ),
        )
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("The collection operation")
            .setRequired(true)
            .addChoices(
              { name: "Add", value: "add" },
              { name: "Remove", value: "remove" },
              { name: "Reorder", value: "reorder" },
            ),
        )
        .addStringOption((option) =>
          option.setName("entry_id").setDescription("Stable entry ID; generated for add"),
        )
        .addIntegerOption((option) =>
          option.setName("position").setDescription("Zero-based position for add or reorder"),
        )
        .addBooleanOption((option) =>
          option.setName("confirm").setDescription("Required and true when removing an entry"),
        )
        .addStringOption(serverIdOption("The server to configure")),
    // fallow-ignore-next-line code-duplication
    Effect.fn("sheet.editEntry")(function* (command) {
      yield* runDeferredCommand(command, (command, response) =>
        // Entry edits validate collection/action combinations before enqueueing one CAS operation.
        // fallow-ignore-next-line complexity
        Effect.gen(function* () {
          const { workspaceId, state } = yield* loadOwnedCommandState(
            zeroClient,
            workflowClient,
            command.optionValueOptional("server_id"),
          );
          const collection = yield* decodeCommandValue(
            entryCollection,
            command.optionValue("collection"),
            "collection",
          );
          const action = yield* decodeCommandValue(
            entryAction,
            command.optionValue("action"),
            "action",
          );
          const configuration = yield* requireConfigurationDraft(state.configuration);
          const collectionLength = configuration[collection].length;
          const rawEntryId = Option.getOrUndefined(command.optionValueOptional("entry_id"));
          const entryId =
            rawEntryId === undefined
              ? action === "add"
                ? yield* Random.nextUUIDv4
                : yield* Effect.fail(
                    new SheetCommandError({
                      message: `entry_id is required for ${action}.`,
                    }),
                  )
              : yield* requireString(rawEntryId, "entry_id");
          const confirm = yield* requireBoolean(
            Option.getOrElse(command.optionValueOptional("confirm"), () => false),
            "confirm",
          );
          if (action === "remove" && !confirm) {
            return yield* Effect.fail(
              new SheetCommandError({
                message: "Removing an entry requires the confirm option to be true.",
              }),
            );
          }
          if (
            action !== "add" &&
            !configuration[collection].some(({ entryId: candidate }) => candidate === entryId)
          ) {
            return yield* Effect.fail(
              new SheetCommandError({
                message: `entry_id "${entryId}" was not found in ${collection}.`,
              }),
            );
          }
          const edit = yield* Match.value(action).pipe(
            Match.when("add", () =>
              Effect.gen(function* () {
                const position = Option.isNone(command.optionValueOptional("position"))
                  ? collectionLength
                  : yield* commandNumberOption(command.optionValueOptional("position"), "position");
                if (position < 0) {
                  return yield* Effect.fail(
                    new SheetCommandError({ message: "position must be zero or greater." }),
                  );
                }
                if (position > collectionLength) {
                  return yield* Effect.fail(
                    new SheetCommandError({
                      message: "The new entry position is outside the collection.",
                    }),
                  );
                }
                return { kind: "addEntry" as const, collection, entryId, position };
              }),
            ),
            Match.when("reorder", () =>
              Effect.gen(function* () {
                const position = yield* commandNumberOption(
                  command.optionValueOptional("position"),
                  "position",
                );
                if (position < 0) {
                  return yield* Effect.fail(
                    new SheetCommandError({ message: "position must be zero or greater." }),
                  );
                }
                if (position >= collectionLength) {
                  return yield* Effect.fail(
                    new SheetCommandError({
                      message: "The entry position is outside the collection.",
                    }),
                  );
                }
                return { kind: "reorderEntry" as const, collection, entryId, position };
              }),
            ),
            Match.when("remove", () =>
              Effect.succeed({
                kind: "removeEntry" as const,
                collection,
                entryId,
                confirm: true as const,
              }),
            ),
            Match.exhaustive,
          );
          const input = yield* decodeCommandValue(
            SheetConfigurationEditDraftInput,
            { workspaceId, expectedDraftVersion: state.draftVersion, edit },
            "edit",
          );
          return yield* enqueueAndReport(
            response,
            `Sheet Configuration ${action} entry`,
            enqueueSheetConfigurationEditDraftWorkflow(workflowClient, input),
            rawEntryId === undefined && action === "add"
              ? `Generated entry_id: ${entryId}.`
              : undefined,
          );
        }),
      );
    }),
  );
});

const makeSaveSubCommand = Effect.gen(function* () {
  const zeroClient = yield* SheetZeroClient;
  const workflowClient = yield* SheetWorkflowHttpClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("save")
        .setDescription("Save the current owned draft as an immutable revision")
        .addStringOption(serverIdOption("The server to configure")),
    Effect.fn("sheet.save")(function* (command) {
      yield* runDeferredCommand(command, (command, response) =>
        Effect.gen(function* () {
          const { workspaceId, state } = yield* loadOwnedCommandState(
            zeroClient,
            workflowClient,
            command.optionValueOptional("server_id"),
            "Legacy drafts cannot be saved from Discord. Review them in the web editor.",
          );
          if (state.configuration === null) {
            return yield* Effect.fail(
              new SheetCommandError({ message: "There is no editable draft to save." }),
            );
          }
          if (hasConfigurationErrors(state.diagnostics)) {
            return yield* Effect.fail(
              new SheetCommandError({ message: "Resolve configuration errors before saving." }),
            );
          }
          const revisionId = yield* Random.nextUUIDv4;
          return yield* enqueueAndReport(
            response,
            "Sheet Configuration revision save",
            enqueueSheetConfigurationSaveRevisionWorkflow(workflowClient, {
              workspaceId,
              expectedDraftVersion: state.draftVersion,
              revisionId,
              configuration: state.configuration,
            }),
          );
        }),
      );
    }),
  );
});

const makeActivateSubCommand = Effect.gen(function* () {
  const zeroClient = yield* SheetZeroClient;
  const workflowClient = yield* SheetWorkflowHttpClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("activate")
        .setDescription("Activate a saved Sheet Configuration revision")
        .addStringOption((option) =>
          option.setName("revision_id").setDescription("The revision ID").setRequired(true),
        )
        .addStringOption(serverIdOption("The server to configure")),
    Effect.fn("sheet.activate")(function* (command) {
      yield* runDeferredCommand(command, (command, response) =>
        Effect.gen(function* () {
          const { workspaceId, state } = yield* loadCommandState(
            zeroClient,
            workflowClient,
            command.optionValueOptional("server_id"),
          );
          const revisionId = yield* requireString(
            command.optionValue("revision_id"),
            "revision_id",
          );
          return yield* enqueueAndReport(
            response,
            "Sheet Configuration activation",
            enqueueSheetConfigurationActivateWorkflow(workflowClient, {
              workspaceId,
              expectedDraftVersion: state.draftVersion,
              revisionId,
              expectedBaselineDigest: state.baselineDigest,
            }),
          );
        }),
      );
    }),
  );
});

const makeRollbackSubCommand = Effect.gen(function* () {
  const zeroClient = yield* SheetZeroClient;
  const workflowClient = yield* SheetWorkflowHttpClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("rollback")
        .setDescription("Roll back to a revision or the retained legacy source")
        .addStringOption((option) =>
          option
            .setName("revision_id")
            .setDescription("Revision ID, or legacy to restore the retained legacy source")
            .setRequired(true),
        )
        .addStringOption(serverIdOption("The server to configure")),
    Effect.fn("sheet.rollback")(function* (command) {
      yield* runDeferredCommand(command, (command, response) =>
        Effect.gen(function* () {
          const { workspaceId, state } = yield* loadOwnedCommandState(
            zeroClient,
            workflowClient,
            command.optionValueOptional("server_id"),
            "Activate an owned revision before rolling back.",
          );
          const revisionText = yield* requireString(
            command.optionValue("revision_id"),
            "revision_id",
          );
          const revisionId = revisionText.toLowerCase() === "legacy" ? null : revisionText;
          return yield* enqueueAndReport(
            response,
            "Sheet Configuration rollback",
            enqueueSheetConfigurationRollbackWorkflow(workflowClient, {
              workspaceId,
              expectedDraftVersion: state.draftVersion,
              revisionId,
            }),
          );
        }),
      );
    }),
  );
});

const makeDiscardSubCommand = Effect.gen(function* () {
  const zeroClient = yield* SheetZeroClient;
  const workflowClient = yield* SheetWorkflowHttpClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("discard")
        .setDescription("Discard the current Sheet Configuration draft")
        .addStringOption(serverIdOption("The server to configure")),
    Effect.fn("sheet.discard")(function* (command) {
      yield* runDeferredCommand(command, (command, response) =>
        Effect.gen(function* () {
          const { workspaceId, state } = yield* loadOwnedCommandState(
            zeroClient,
            workflowClient,
            command.optionValueOptional("server_id"),
            "The legacy source is read-only. Discard its imported draft from the web editor.",
          );
          if (state.configuration === null && state.baselineDigest === null) {
            return yield* Effect.fail(
              new SheetCommandError({
                message: "There is no Sheet Configuration draft to discard.",
              }),
            );
          }
          return yield* enqueueAndReport(
            response,
            "Sheet Configuration draft discard",
            enqueueSheetConfigurationDiscardDraftWorkflow(workflowClient, {
              workspaceId,
              expectedDraftVersion: state.draftVersion,
            }),
          );
        }),
      );
    }),
  );
});

const makeSheetCommand = Effect.gen(function* () {
  const listSubCommand = yield* makeListSubCommand;
  const setSubCommand = yield* makeSetSubCommand;
  const scalarEditSubCommand = yield* makeScalarEditSubCommand;
  const rangeEditSubCommand = yield* makeRangeEditSubCommand;
  const entryEditSubCommand = yield* makeEntryEditSubCommand;
  const saveSubCommand = yield* makeSaveSubCommand;
  const activateSubCommand = yield* makeActivateSubCommand;
  const rollbackSubCommand = yield* makeRollbackSubCommand;
  const discardSubCommand = yield* makeDiscardSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("sheet")
        .setDescription("Manage the web-native Sheet Configuration")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        )
        .addSubcommand(() => listSubCommand.data)
        .addSubcommand(() => setSubCommand.data)
        .addSubcommand(() => scalarEditSubCommand.data)
        .addSubcommand(() => rangeEditSubCommand.data)
        .addSubcommand(() => entryEditSubCommand.data)
        .addSubcommand(() => saveSubCommand.data)
        .addSubcommand(() => activateSubCommand.data)
        .addSubcommand(() => rollbackSubCommand.data)
        .addSubcommand(() => discardSubCommand.data),
    (command) =>
      command.subCommands({
        list: listSubCommand.handler,
        set: setSubCommand.handler,
        edit_scalar: scalarEditSubCommand.handler,
        edit_range: rangeEditSubCommand.handler,
        edit_entry: entryEditSubCommand.handler,
        save: saveSubCommand.handler,
        activate: activateSubCommand.handler,
        rollback: rollbackSubCommand.handler,
        discard: discardSubCommand.handler,
      }),
  );
});

export const sheetCommandLayer = registerGlobalCommandLayer(makeSheetCommand).pipe(
  Layer.provide(Layer.mergeAll(SheetWorkflowHttpClient.layer, SheetZeroClient.layer)),
);
