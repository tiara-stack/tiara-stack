import { Cause, Effect, Exit, Layer, Match, Option, Predicate, Schema } from "effect";
import {
  BotOutboundMessage,
  DeliveryReceipt,
  type MessageRef,
  workspaceRefFrom,
} from "sheet-bot-api";
import {
  isTeamSubmissionEnabled,
  MessageTeamSubmission,
  ParsedTeamEntry,
  type TeamSubmissionConfigurationBinding,
  TeamSubmissionRollbackSnapshot,
  TeamSubmissionRowMapping,
  type TeamSubmissionSkippedEntry,
  RangesConfig,
  TeamConfig,
  WorkspaceTeamSubmissionChannel,
} from "./values";
import {
  AutonomousDeclaredFailure,
  InteractiveDeclaredFailure,
  TeamSubmissionsDecide,
  TeamSubmissionsProcess,
  WorkspaceId,
} from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import type { EffectivePrincipal } from "sheet-auth/identity";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  missingConfigurationKey,
  resolveAuthoritativeSheetConfiguration,
  type AuthoritativeSheetConfiguration,
} from "@/services/authoritativeSheetConfiguration";
import { config } from "@/config";
import { teamSubmissionReaction } from "./reaction";
import {
  teamSubmissionConfirmationActionRow,
  teamSubmissionRollbackFailedMessage,
} from "sheet-message-content";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";
import {
  interactiveBusinessRuleRejected,
  interactiveConfigurationMissing,
  interactiveDeliveryRejected,
  interactiveExternalOperationRejected,
  interactiveAuthorizationRevoked,
  interactiveInvalidRequest,
  interactiveResourceNotFound,
  isInteractiveDeclaredFailure,
} from "../shared/interactive";
import { optionValue } from "../shared/option";
import {
  appendRangeForCells,
  appendRowValues,
  actualMatchesExpectedCells,
  actionableSubmissionStatuses,
  appendedRowIndex,
  appendedRowTarget,
  blankRemovedRows,
  blankRollbackSnapshotForAppendedRows,
  chooseNamedTeamConfig,
  existingMappingByKey,
  existingTeamKeys,
  editableSubmissionStatuses,
  flattenRangeValues,
  isUsableTeamConfig,
  matchOshi,
  optionString,
  parseA1Start,
  parseTeamSubmissionMessage,
  pendingAppendRollbackRange,
  preserveExistingStableKeys,
  renderConfirmation,
  rollbackValuesForRange,
  tagMatchesEntry,
  type ProcessedTeamSubmissionEntry,
  type SheetValueUpdate,
  type TeamSubmissionRowTarget,
  type TeamConfigLookup,
} from "./pure";
import { TeamSubmissionProvider, type TeamSubmissionValueRange } from "./provider";
import {
  makeTeamSubmissionsDeliveryKey,
  teamSubmissionActionIdentities,
  type TeamSubmissionActionIdentity,
} from "./keys";
import { TeamSubmissionsDecideExecution, TeamSubmissionsProcessExecution } from "./schema";
import { TeamSubmissionsWorkflowOperations } from "./service";

const processOperation = TeamSubmissionsProcess.identity;
const decideOperation = TeamSubmissionsDecide.identity;
const progressColor = 0xfee75c;
const successColor = 0x57f287;
const errorColor = 0xed4245;

type ProcessFailure = typeof AutonomousDeclaredFailure.Type;
type DecideFailure = typeof InteractiveDeclaredFailure.Type;

const clientFor = (sourceMessage: MessageRef) => sourceMessage.conversation.workspace.client;

const sameMessage = (left: MessageRef, right: MessageRef) =>
  left.messageId === right.messageId &&
  left.conversation.conversationId === right.conversation.conversationId &&
  left.conversation.workspace.workspaceId === right.conversation.workspace.workspaceId &&
  left.conversation.workspace.client.platform === right.conversation.workspace.client.platform &&
  left.conversation.workspace.client.clientId === right.conversation.workspace.client.clientId;

const asProcessFailure = (failure: DecideFailure): ProcessFailure => failure;

const externalFailure = (operation: string, error: unknown): DecideFailure =>
  isInteractiveDeclaredFailure(error)
    ? error
    : interactiveExternalOperationRejected(
        operation,
        "ProviderUnavailable",
        "The team-submission workflow dependency was unavailable",
      );

const externalFailureEffect = (operation: string, error: unknown) =>
  isInteractiveDeclaredFailure(error)
    ? Effect.fail(error)
    : Effect.logError("Team submission workflow dependency failed", error).pipe(
        Effect.annotateLogs({ operation }),
        Effect.andThen(Effect.fail(externalFailure(operation, error))),
      );

const decodePersistedTagged = <SchemaValue extends Schema.Top>(
  schema: SchemaValue,
  tag: string,
  value: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(
    Predicate.isObject(value) && !Predicate.hasProperty(value, "_tag")
      ? { _tag: tag, ...value }
      : value,
  );

const decodeSubmission = (value: unknown) =>
  decodePersistedTagged(MessageTeamSubmission, "MessageTeamSubmission", value);

const submissionKey = (sourceMessage: MessageRef) => ({
  workspaceId: sourceMessage.conversation.workspace.workspaceId,
  conversationId: sourceMessage.conversation.conversationId,
  messageId: sourceMessage.messageId,
});

const sourceRecord = (options: {
  readonly sourceMessage: MessageRef;
  readonly client: MessageRef["conversation"]["workspace"]["client"];
  readonly authorId: string;
  readonly sheetId: string;
  readonly sheetConfigurationBinding: TeamSubmissionConfigurationBinding | null;
  readonly confirmationMessageId: string | null;
  readonly parsedSubmission: ReadonlyArray<ParsedTeamEntry>;
  readonly rowMappings: ReadonlyArray<TeamSubmissionRowMapping>;
  readonly rollbackSnapshot: TeamSubmissionRollbackSnapshot | null;
  readonly status: (typeof MessageTeamSubmission.Type)["status"];
  readonly expectedVersion?: number;
}) => ({
  ...submissionKey(options.sourceMessage),
  clientPlatform: options.client.platform,
  clientId: options.client.clientId,
  discordGuildId: options.sourceMessage.conversation.workspace.workspaceId,
  discordChannelId: options.sourceMessage.conversation.conversationId,
  discordAuthorId: options.authorId,
  sheetId: options.sheetId,
  sheetConfigurationBinding: options.sheetConfigurationBinding,
  confirmationMessageId: options.confirmationMessageId,
  parsedSubmission: options.parsedSubmission,
  rowMappings: options.rowMappings,
  rollbackSnapshot: options.rollbackSnapshot,
  status: options.status,
  ...(options.expectedVersion === undefined ? {} : { expectedVersion: options.expectedVersion }),
});

const configurationBindingFromActive = (
  active: AuthoritativeSheetConfiguration,
): TeamSubmissionConfigurationBinding => ({
  revisionId: active.source.kind === "owned" ? active.source.revisionId : null,
  configuration: active.configuration,
});

const missingConfigurationBinding = () =>
  interactiveBusinessRuleRejected(
    "SubmissionConfigurationBindingMissing",
    "This team submission was created before stable Sheet Configuration bindings were recorded. Submit it again to continue safely.",
  );

const messageRefFor = (sourceMessage: MessageRef, messageId: string): MessageRef => ({
  conversation: sourceMessage.conversation,
  messageId,
});

const processProgressMessage = (sourceMessage: MessageRef): BotOutboundMessage => ({
  embeds: [
    {
      title: "Adding teams to the sheet",
      description: "Tiara is parsing this submission and writing the teams now.",
      color: progressColor,
    },
  ],
  messageReference: { message: sourceMessage, failIfNotExists: false },
  allowedMentions: "none",
});

const processResultMessage = (
  sourceMessage: MessageRef,
  entries: ReadonlyArray<ParsedTeamEntry>,
  skippedEntries: ReadonlyArray<TeamSubmissionSkippedEntry>,
  controlsDisabled = false,
): BotOutboundMessage => ({
  embeds: [
    {
      title: "Teams added to the sheet",
      description: renderConfirmation(sourceMessage, entries, skippedEntries),
      color: successColor,
    },
  ],
  components: [teamSubmissionConfirmationActionRow(controlsDisabled)],
  allowedMentions: "none",
});

const rollbackFailedMessage = (detail: string): BotOutboundMessage =>
  teamSubmissionRollbackFailedMessage(detail, errorColor);

const responseMessage = (content: string): BotOutboundMessage => ({
  content,
  visibility: "ephemeral",
  allowedMentions: "none",
});

const valuesByRequestedRange = (
  ranges: ReadonlyArray<TeamSubmissionValueRange>,
  requested: ReadonlyArray<string>,
) => new Map(requested.map((range, index) => [range, ranges[index]?.values ?? []] as const));

const channelFrom = (value: unknown) =>
  decodePersistedTagged(WorkspaceTeamSubmissionChannel, "WorkspaceTeamSubmissionChannel", value);

const teamConfigTags = (config: TeamConfig) =>
  Option.match(config.tagsConfig, {
    onNone: () => ({ range: null as string | null, constants: [] as ReadonlyArray<string> }),
    onSome: (tagsConfig) =>
      Predicate.isTagged("TeamTagsRangesConfig")(tagsConfig)
        ? { range: tagsConfig.tagsRange, constants: [] as ReadonlyArray<string> }
        : { range: null, constants: tagsConfig.tags },
  });

// fallow-ignore-next-line code-duplication
const chooseTeamConfig = (
  teamConfigs: ReadonlyArray<TeamConfigLookup>,
  entry: ParsedTeamEntry,
  destinationTeamConfigName: Option.Option<string>,
) => {
  const named = chooseNamedTeamConfig(teamConfigs, destinationTeamConfigName);
  if (named !== null) return named;
  const configs = teamConfigs.filter(({ config }) => isUsableTeamConfig(config));
  const matched = configs
    .map((lookup) => ({
      lookup,
      score: lookup.tags.filter((tag) => tagMatchesEntry(tag, entry)).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)[0];
  return matched?.lookup ?? (configs.length === 1 ? (configs[0] ?? null) : null);
};

const writableRanges = (config: TeamConfig) => {
  const playerNameRange = optionString(config.playerNameRange);
  const teamNameRange = optionString(config.teamNameRange);
  return playerNameRange && teamNameRange && teamNameRange !== "auto"
    ? { playerNameRange, teamNameRange }
    : null;
};

const updateForMapping = (
  mapping: TeamSubmissionRowTarget,
  entry: ParsedTeamEntry,
): ReadonlyArray<SheetValueUpdate> => [
  { range: mapping.playerNameRange, values: [[entry.playerName]] },
  { range: mapping.teamNameRange, values: [[entry.teamName]] },
  ...(mapping.oshiRange === null
    ? []
    : [{ range: mapping.oshiRange, values: [[entry.oshi.value ?? ""]] }]),
];

type ResolvedAppendTarget = {
  readonly target: TeamSubmissionRowTarget;
  readonly duplicateTargets: ReadonlyArray<TeamSubmissionRowTarget>;
  readonly appended: boolean;
};

const rangesForTarget = (target: TeamSubmissionRowTarget): ReadonlyArray<string> => [
  target.playerNameRange,
  target.teamNameRange,
  ...(target.oshiRange === null ? [] : [target.oshiRange]),
];

const blankForTarget = (target: TeamSubmissionRowTarget): ReadonlyArray<SheetValueUpdate> =>
  rangesForTarget(target).map((range) => ({ range, values: [[""]] }));

const rowTargetFromMapping = (mapping: TeamSubmissionRowMapping): TeamSubmissionRowTarget => ({
  rowIndex: mapping.rowIndex,
  playerNameRange: mapping.playerNameRange,
  teamNameRange: mapping.teamNameRange,
  oshiRange: mapping.oshiRange,
});

const mappingFromTarget = (
  entry: ParsedTeamEntry,
  target: TeamSubmissionRowTarget,
): TeamSubmissionRowMapping => ({
  stableKey: entry.stableKey,
  playerNameRange: target.playerNameRange,
  teamNameRange: target.teamNameRange,
  oshiRange: target.oshiRange,
  rowIndex: target.rowIndex,
});

const markedPlayerName = (playerName: string, appendIdentity: string) =>
  `${playerName}\u2063tiara:${appendIdentity}\u2063`;

const sameConfigClient = (sourceMessage: MessageRef, clientId: string) =>
  sourceMessage.conversation.workspace.client.platform === "discord" &&
  sourceMessage.conversation.workspace.client.clientId === clientId;

const principalUserId = (execution: typeof TeamSubmissionsDecideExecution.Type) =>
  Match.type<EffectivePrincipal>().pipe(
    Match.discriminatorsExhaustive("kind")({
      user: ({ discordAccount }) => discordAccount?.accountId,
      service: () => undefined,
    }),
  )(execution.principal);

const requireActionableForDecision = (
  submission: typeof MessageTeamSubmission.Type,
): Effect.Effect<void, DecideFailure> =>
  actionableSubmissionStatuses.has(submission.status)
    ? Effect.void
    : Effect.fail(
        interactiveBusinessRuleRejected(
          "SubmissionNotActionable",
          `Team submission is already ${submission.status}`,
        ),
      );

export const teamSubmissionsWorkflowOperationsLayer = Layer.effect(
  TeamSubmissionsWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* TeamSubmissionProvider;
    const delivery = yield* SheetBotDeliveryClient;
    const authorization = yield* ReadOnlyWorkflowAuthorization;
    const configuredClientId = yield* config.sheetBotClientId;

    const getSubmission = (sourceMessage: MessageRef) =>
      persistence.teamSubmissionState.getMessageTeamSubmission(submissionKey(sourceMessage)).pipe(
        Effect.flatMap((row) =>
          Option.match(row, {
            onNone: () => Effect.succeed(Option.none()),
            onSome: (value) => decodeSubmission(value).pipe(Effect.map(Option.some)),
          }),
        ),
      );

    const persistSubmission = (options: {
      readonly sourceMessage: MessageRef;
      readonly client: MessageRef["conversation"]["workspace"]["client"];
      readonly authorId: string;
      readonly sheetId: string;
      readonly sheetConfigurationBinding: TeamSubmissionConfigurationBinding | null;
      readonly confirmationMessageId: string | null;
      readonly entries: ReadonlyArray<ParsedTeamEntry>;
      readonly rowMappings: ReadonlyArray<TeamSubmissionRowMapping>;
      readonly rollbackSnapshot: TeamSubmissionRollbackSnapshot | null;
      readonly status: (typeof MessageTeamSubmission.Type)["status"];
      readonly expectedVersion?: number;
    }) =>
      persistence.teamSubmissionState.upsertMessageTeamSubmission(
        sourceRecord({
          sourceMessage: options.sourceMessage,
          client: options.client,
          authorId: options.authorId,
          sheetId: options.sheetId,
          sheetConfigurationBinding: options.sheetConfigurationBinding,
          confirmationMessageId: options.confirmationMessageId,
          parsedSubmission: options.entries,
          rowMappings: options.rowMappings,
          rollbackSnapshot: options.rollbackSnapshot,
          status: options.status,
          ...(options.expectedVersion === undefined
            ? {}
            : { expectedVersion: options.expectedVersion }),
        }),
      );

    const readSnapshot = (
      sheetId: string,
      updates: ReadonlyArray<SheetValueUpdate>,
      stableKeyByRange: ReadonlyMap<string, string>,
    ) => {
      const requested = [...new Set(updates.map(({ range }) => range))];
      if (requested.length === 0) return Effect.succeed([] as TeamSubmissionRollbackSnapshot);
      return provider.read(sheetId, requested).pipe(
        Effect.map((ranges) =>
          ranges.flatMap((range, index) => {
            // Provider reads currently preserve the requested order and use the requested range
            // identity. If they begin returning API-reported ranges, stable-key resolution here
            // must be updated to use those reported ranges.
            const resolvedRange = range.range || requested[index] || "";
            return resolvedRange.length > 0
              ? [
                  {
                    stableKey: stableKeyByRange.get(resolvedRange) ?? resolvedRange,
                    range: resolvedRange,
                    values: range.values.map((row) => [...row]),
                  },
                ]
              : [];
          }),
        ),
      );
    };

    const featureEnabled = (workspaceId: string) =>
      persistence.workspaces
        .getWorkspaceFeatureFlags({ workspaceId })
        .pipe(Effect.map(isTeamSubmissionEnabled));

    const makeTeamConfigLookups = ({
      rangesConfig,
      teamConfigs,
      valuesByRange,
    }: {
      readonly rangesConfig: RangesConfig;
      readonly teamConfigs: ReadonlyArray<TeamConfig>;
      readonly valuesByRange: ReadonlyMap<string, ReadonlyArray<ReadonlyArray<string>>>;
    }): ReadonlyArray<TeamConfigLookup> => {
      const oshiRange = optionString(rangesConfig.oshis);
      const validOshis =
        oshiRange === undefined
          ? []
          : flattenRangeValues({ values: valuesByRange.get(oshiRange) ?? [] });
      return teamConfigs.map((config) => {
        const tags = teamConfigTags(config);
        return {
          config,
          oshis: validOshis,
          tags:
            tags.range === null
              ? tags.constants
              : flattenRangeValues({ values: valuesByRange.get(tags.range) ?? [] }),
        };
      });
    };

    // fallow-ignore-next-line complexity
    const resolveAppendTarget = (options: {
      readonly sheetId: string;
      readonly appendIdentity: string;
      readonly entry: ParsedTeamEntry;
      readonly oshi: ParsedTeamEntry["oshi"];
      readonly playerNameRange: string;
      readonly teamNameRange: string;
      readonly oshiRange: string | null;
      readonly previousMapping: TeamSubmissionRowMapping | undefined;
      readonly beforeAppend: (mapping: TeamSubmissionRowMapping) => Effect.Effect<void, unknown>;
    }) => {
      const {
        appendIdentity,
        entry,
        oshi,
        oshiRange,
        playerNameRange,
        previousMapping,
        sheetId,
        teamNameRange,
      } = options;
      const appendRange = appendRangeForCells(playerNameRange, teamNameRange, oshiRange);
      if (appendRange === null) {
        return Effect.fail(
          interactiveInvalidRequest(
            "InvalidTeamConfig",
            "The configured team ranges cannot be appended as one row",
          ),
        );
      }
      const markedEntry = {
        ...entry,
        playerName: markedPlayerName(entry.playerName, appendIdentity),
      };
      const expected = appendRowValues(appendRange, markedEntry, oshi);
      const cleanExpected = appendRowValues(appendRange, entry, oshi);
      const matchesExpected = (row: ReadonlyArray<string>) =>
        actualMatchesExpectedCells([row], [expected]) ||
        actualMatchesExpectedCells([row], [cleanExpected]);
      const matchesMarked = (row: ReadonlyArray<string>) =>
        actualMatchesExpectedCells([row], [expected]);
      const resolveReconciledTarget = (
        ranges: ReadonlyArray<TeamSubmissionValueRange>,
      ): ResolvedAppendTarget | null => {
        const baseRow = parseA1Start(appendRange.range)?.row ?? 1;
        const rows = ranges[0]?.values ?? [];
        const marked = rows.flatMap((row, index) => (matchesMarked(row) ? [index] : []));
        const matches =
          marked.length > 0
            ? marked
            : rows.flatMap((row, index) => (matchesExpected(row) ? [index] : [])).slice(0, 1);
        const targets = matches.flatMap((match) => {
          const target = appendedRowTarget({
            rowIndex: baseRow + match,
            playerNameRange,
            teamNameRange,
            oshiRange,
          });
          return target === null ? [] : [target];
        });
        const target = targets[0];
        return target === undefined
          ? null
          : { target, duplicateTargets: targets.slice(1), appended: true };
      };
      const reconcile = provider
        .read(sheetId, [appendRange.range])
        .pipe(Effect.map(resolveReconciledTarget));

      const resolveExistingMapping = (mapping: TeamSubmissionRowMapping) => {
        const baseRow = parseA1Start(appendRange.range)?.row ?? 1;
        const rowIndex = mapping.rowIndex - baseRow;
        return provider.read(sheetId, [appendRange.range]).pipe(
          Effect.map((ranges) => {
            const row = rowIndex < 0 ? undefined : ranges[0]?.values[rowIndex];
            if (row !== undefined && matchesExpected(row)) {
              return {
                target: rowTargetFromMapping(mapping),
                duplicateTargets: [],
                appended: false,
              };
            }
            return (
              resolveReconciledTarget(ranges) ?? {
                // A durable row mapping is the idempotency record for this entry. Reuse the
                // mapped row for the later absolute update instead of appending a duplicate
                // when its current contents no longer match.
                target: rowTargetFromMapping(mapping),
                duplicateTargets: [],
                appended: false,
              }
            );
          }),
        );
      };

      const resolvePendingAppend = reconcile.pipe(
        Effect.flatMap((reconciled) =>
          reconciled === null
            ? Effect.fail(
                interactiveExternalOperationRejected(
                  `${processOperation}.append`,
                  "AppendPendingReconciliation",
                  "A pending team row append could not be reconciled safely",
                ),
              )
            : Effect.succeed(reconciled),
        ),
      );

      const appendFreshRow = Effect.gen(function* () {
        yield* options.beforeAppend({
          stableKey: entry.stableKey,
          playerNameRange,
          teamNameRange,
          oshiRange,
          rowIndex: 0,
        });
        const updatedRange = yield* provider.append(sheetId, appendRange.range, [expected]);
        const rowIndex = appendedRowIndex(updatedRange);
        if (rowIndex !== null) {
          const target = appendedRowTarget({ rowIndex, playerNameRange, teamNameRange, oshiRange });
          if (target !== null) return { target, duplicateTargets: [], appended: true };
        }
        const reconciled = yield* reconcile;
        return reconciled === null
          ? yield* Effect.fail(
              interactiveExternalOperationRejected(
                `${processOperation}.append`,
                "AppendReconciliationFailed",
                "The appended team row could not be reconciled",
              ),
            )
          : reconciled;
      });

      return Effect.gen(function* () {
        if (previousMapping !== undefined) {
          if (previousMapping.rowIndex > 0) {
            return yield* resolveExistingMapping(previousMapping);
          }
          if (previousMapping.rowIndex === 0) {
            return yield* resolvePendingAppend;
          }
        }
        return yield* appendFreshRow;
      });
    };

    const deliverProgress = (
      execution: typeof TeamSubmissionsProcessExecution.Type,
      sourceMessage: MessageRef,
    ) => {
      const deliveryKey = makeTeamSubmissionsDeliveryKey(
        execution.invocationId,
        teamSubmissionActionIdentities.progress,
      );
      return delivery
        .get()
        .delivery.sendMessage({
          payload: {
            conversation: sourceMessage.conversation,
            deliveryKey,
            message: processProgressMessage(sourceMessage),
          },
        })
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.tapError((error) =>
            Effect.logError("Team submission progress delivery failed", error).pipe(
              Effect.annotateLogs({ operation: `${processOperation}.progress` }),
            ),
          ),
          Effect.mapError(() =>
            interactiveDeliveryRejected(
              `${processOperation}.progress`,
              "The team-submission progress message was rejected",
              false,
            ),
          ),
          Effect.flatMap((receipt) =>
            delivery
              .get()
              .delivery.setMessageReaction({
                payload: {
                  message: sourceMessage,
                  deliveryKey: makeTeamSubmissionsDeliveryKey(
                    execution.invocationId,
                    teamSubmissionActionIdentities.reaction,
                  ),
                  emoji: teamSubmissionReaction,
                  present: true,
                },
              })
              .pipe(
                Effect.timeout("30 seconds"),
                Effect.catch((error) =>
                  Effect.logWarning("Team submission reaction delivery failed", error).pipe(
                    Effect.as(undefined),
                  ),
                ),
                Effect.map((reactionReceipt) => ({
                  progress: receipt,
                  reaction: reactionReceipt,
                })),
              ),
          ),
        );
    };

    const editProgress = (
      execution: typeof TeamSubmissionsProcessExecution.Type,
      progressMessage: MessageRef,
      message: BotOutboundMessage,
      action: TeamSubmissionActionIdentity = teamSubmissionActionIdentities.confirmation,
    ) =>
      delivery
        .get()
        .delivery.editMessage({
          payload: {
            message: progressMessage,
            deliveryKey: makeTeamSubmissionsDeliveryKey(execution.invocationId, action),
            content: message,
          },
        })
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.tapError((error) =>
            Effect.logError("Team submission progress edit failed", error).pipe(
              Effect.annotateLogs({ operation: `${processOperation}.${action}` }),
            ),
          ),
          Effect.mapError(() =>
            interactiveDeliveryRejected(
              `${processOperation}.confirmation`,
              "The team-submission confirmation message could not be delivered",
              true,
              progressMessage.messageId,
            ),
          ),
        );

    const reportProcessWriteFailure = (
      execution: typeof TeamSubmissionsProcessExecution.Type,
      progressMessage: MessageRef,
      error: unknown,
    ) =>
      editProgress(
        execution,
        progressMessage,
        {
          embeds: [
            {
              title: "Could not add teams",
              description: "Tiara could not write this submission to the sheet.",
              color: errorColor,
            },
          ],
          components: [],
          allowedMentions: "none",
        },
        teamSubmissionActionIdentities.writeFailure,
      ).pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(Effect.fail(error)),
      );

    // fallow-ignore-next-line complexity
    const process = (execution: typeof TeamSubmissionsProcessExecution.Type) =>
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const input = yield* decodeWorkflowContractInputOrDie(
          TeamSubmissionsProcess,
          execution.input,
        );
        const sourceMessage = input.sourceMessage;
        yield* authorization
          .authorize(TeamSubmissionsProcess, execution.principal, input)
          .pipe(
            Effect.catch((error) =>
              Predicate.isTagged("WorkflowInvocationUnauthorized")(error)
                ? Effect.fail(
                    interactiveAuthorizationRevoked(
                      TeamSubmissionsProcess.authorizationPolicy.policy,
                    ),
                  )
                : externalFailureEffect(`${processOperation}.authorization`, error),
            ),
          );
        const enabled = yield* featureEnabled(sourceMessage.conversation.workspace.workspaceId);
        if (!enabled || !sameConfigClient(sourceMessage, configuredClientId)) {
          return {
            sourceMessage,
            confirmationMessage: null,
            parsedTeamCount: 0,
            skippedTeamCount: 0,
            status: "empty" as const,
            deliveryReceipts: [],
          };
        }

        const parsed = parseTeamSubmissionMessage(input.content, input.authorDisplayName);
        if (parsed.disposition !== "accepted") {
          return {
            sourceMessage,
            confirmationMessage: null,
            parsedTeamCount: 0,
            skippedTeamCount: 0,
            status: "empty" as const,
            deliveryReceipts: [],
          };
        }

        const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(
          sourceMessage.conversation.workspace.workspaceId,
        ).pipe(
          Effect.mapError(() =>
            interactiveInvalidRequest(
              "InvalidWorkspaceId",
              "The workspace ID is missing or invalid",
            ),
          ),
        );
        const channelRow = yield* persistence.workspaces.getTeamSubmissionChannelByConversationId({
          workspaceId,
          conversationId: sourceMessage.conversation.conversationId,
        });
        if (Option.isNone(channelRow)) {
          return yield* Effect.fail(interactiveConfigurationMissing("teamSubmissionChannel"));
        }
        const channel = yield* channelFrom(channelRow.value);
        const existingOption = yield* getSubmission(sourceMessage);
        const existing = Option.getOrNull(existingOption);
        if (existing !== null && !editableSubmissionStatuses.has(existing.status)) {
          return yield* Effect.fail(
            interactiveBusinessRuleRejected(
              "SubmissionNotEditable",
              `Team submission is already ${existing.status} and cannot be changed`,
            ),
          );
        }

        let sheetId: string;
        let sheetConfigurationBinding: TeamSubmissionConfigurationBinding;
        let configuration: TeamSubmissionConfigurationBinding["configuration"];
        if (existing === null) {
          const active = yield* resolveAuthoritativeSheetConfiguration(persistence, workspaceId);
          if (Option.isNone(active)) {
            return yield* Effect.fail(
              interactiveConfigurationMissing(missingConfigurationKey(persistence)),
            );
          }
          sheetId = active.value.spreadsheetId;
          sheetConfigurationBinding = configurationBindingFromActive(active.value);
          configuration = active.value.configuration;
        } else {
          const persistedBinding = optionValue(existing.sheetConfigurationBinding);
          if (persistedBinding === undefined) {
            return yield* Effect.fail(missingConfigurationBinding());
          }
          sheetId = existing.sheetId;
          sheetConfigurationBinding = persistedBinding;
          configuration = persistedBinding.configuration;
        }

        const teamConfigData = yield* provider.loadConfiguration(sheetId, configuration);
        const oshiRange = optionString(teamConfigData.rangesConfig.oshis);
        const tagRanges = teamConfigData.teamConfigs.flatMap((config) => {
          const tags = teamConfigTags(config);
          return tags.range === null ? [] : [tags.range];
        });
        const requested = [
          ...new Set([...(oshiRange === undefined ? [] : [oshiRange]), ...tagRanges]),
        ];
        const values = yield* provider.read(sheetId, requested);
        const teamConfigs = makeTeamConfigLookups({
          ...teamConfigData,
          valuesByRange: valuesByRequestedRange(values, requested),
        });
        const parsedEntries =
          existing === null ? parsed.entries : preserveExistingStableKeys(existing, parsed.entries);
        const previousMappings = existingMappingByKey(existing);
        const previousKeys = existingTeamKeys(existing);
        const client = clientFor(sourceMessage);
        let version = existing?.version ?? 0;
        let persisted = existing !== null;
        const interimMappings = new Map(previousMappings);
        let recoverySnapshot: TeamSubmissionRollbackSnapshot = [
          ...(optionValue(existing?.rollbackSnapshot) ?? []),
        ];
        const registered: ProcessedTeamSubmissionEntry[] = [];
        const skipped: TeamSubmissionSkippedEntry[] = [];

        const persistCurrent = (options: {
          readonly entries: ReadonlyArray<ParsedTeamEntry>;
          readonly mappings: ReadonlyArray<TeamSubmissionRowMapping>;
          readonly snapshot: TeamSubmissionRollbackSnapshot;
          readonly status: (typeof MessageTeamSubmission.Type)["status"];
        }) =>
          persistSubmission({
            sourceMessage,
            client,
            authorId: input.authorId,
            sheetId,
            sheetConfigurationBinding,
            confirmationMessageId: optionValue(existing?.confirmationMessageId) ?? null,
            entries: options.entries,
            rowMappings: options.mappings,
            rollbackSnapshot: options.snapshot,
            status: options.status,
            ...(persisted ? { expectedVersion: version } : {}),
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                version = persisted ? version + 1 : 1;
                persisted = true;
              }),
            ),
          );

        const beforeAppend = (mapping: TeamSubmissionRowMapping) =>
          persistCurrent({
            entries: [
              ...registered.map(({ entry }) => entry),
              ...parsedEntries.filter((entry) => entry.stableKey === mapping.stableKey),
            ],
            mappings: [...interimMappings.values(), mapping],
            snapshot: [
              ...recoverySnapshot.filter(({ stableKey }) => stableKey !== mapping.stableKey),
              { stableKey: mapping.stableKey, range: pendingAppendRollbackRange, values: [] },
            ],
            status: "applying",
          });

        const processEntry = (entry: ParsedTeamEntry) =>
          // fallow-ignore-next-line complexity
          Effect.gen(function* () {
            const selected = chooseTeamConfig(
              teamConfigs,
              entry,
              channel.destinationTeamConfigName,
            );
            const ranges = selected === null ? null : writableRanges(selected.config);
            if (selected === null || ranges === null) {
              skipped.push({
                stableKey: entry.stableKey,
                playerName: entry.playerName,
                teamName: entry.teamName,
                teamType: entry.teamType,
                reason: "No writable team config matched this team",
              });
              return;
            }
            const oshiCandidate = entry.oshi.candidate ?? parsed.oshiCandidate;
            const oshi = matchOshi(oshiCandidate, selected.oshis);
            if (channel.requireValidOshi && oshi.status !== "matched") {
              skipped.push({
                stableKey: entry.stableKey,
                playerName: entry.playerName,
                teamName: entry.teamName,
                teamType: entry.teamType,
                reason:
                  oshiCandidate === null
                    ? "Oshi is required"
                    : `Oshi ${oshiCandidate} is not valid`,
              });
              return;
            }
            const previousMapping = previousMappings.get(entry.stableKey);
            const resolvedTarget = yield* resolveAppendTarget({
              sheetId,
              appendIdentity: `${sourceMessage.conversation.workspace.workspaceId}:${sourceMessage.conversation.conversationId}:${sourceMessage.messageId}:${entry.stableKey}`,
              entry,
              oshi,
              playerNameRange: ranges.playerNameRange,
              teamNameRange: ranges.teamNameRange,
              oshiRange: optionString(selected.config.oshiRange) ?? null,
              previousMapping,
              beforeAppend,
            });
            const parsedEntry = {
              ...entry,
              teamConfigName: optionString(selected.config.name) ?? null,
              oshi,
            } satisfies ParsedTeamEntry;
            const processedEntry: ProcessedTeamSubmissionEntry = {
              appended: resolvedTarget.appended,
              duplicateTargets: resolvedTarget.duplicateTargets,
              entry: parsedEntry,
              mapping: mappingFromTarget(entry, resolvedTarget.target),
              updates: updateForMapping(resolvedTarget.target, parsedEntry),
            };
            registered.push(processedEntry);
            interimMappings.set(processedEntry.mapping.stableKey, processedEntry.mapping);
            if (processedEntry.appended) {
              recoverySnapshot = [
                ...recoverySnapshot.filter(
                  ({ stableKey }) => stableKey !== processedEntry.mapping.stableKey,
                ),
                ...blankRollbackSnapshotForAppendedRows([processedEntry]),
              ];
              yield* persistCurrent({
                entries: registered.map(({ entry: value }) => value),
                mappings: [...interimMappings.values()],
                snapshot: recoverySnapshot,
                status: "applying",
              });
            }
          });

        const progress = yield* deliverProgress(execution, sourceMessage);
        const progressMessage = progress.progress.target.message;
        const reactionReceipt = progress.reaction;
        // Each append persists a version that the next append must observe.
        yield* Effect.forEach(parsedEntries, processEntry, {
          discard: true,
          concurrency: 1,
        }).pipe(
          Effect.catch((error) => reportProcessWriteFailure(execution, progressMessage, error)),
        );

        const entries = registered.map(({ entry }) => entry);
        const mappings = registered.map(({ mapping }) => mapping);
        const nextKeys = new Set(mappings.map(({ stableKey }) => stableKey));
        const data = [
          ...registered.flatMap(({ updates }) => updates),
          ...registered.flatMap(({ duplicateTargets }) => duplicateTargets.flatMap(blankForTarget)),
          ...blankRemovedRows(previousKeys, nextKeys, previousMappings),
        ];
        const stableKeyByRange = new Map(
          registered.flatMap(({ mapping, duplicateTargets }) => [
            ...rangesForTarget(mapping).map((range) => [range, mapping.stableKey] as const),
            ...duplicateTargets.flatMap((target) =>
              rangesForTarget(target).map((range) => [range, mapping.stableKey] as const),
            ),
          ]),
        );
        const beforeWriteSnapshot = yield* readSnapshot(sheetId, data, stableKeyByRange);
        const appendedKeys = new Set(
          registered.filter(({ appended }) => appended).map(({ mapping }) => mapping.stableKey),
        );
        const snapshot =
          existing?.status === "applying"
            ? recoverySnapshot
            : [
                ...beforeWriteSnapshot.filter(({ stableKey }) => !appendedKeys.has(stableKey)),
                ...blankRollbackSnapshotForAppendedRows(registered),
              ];
        const status: (typeof MessageTeamSubmission.Type)["status"] =
          entries.length === 0 ? "empty" : existing === null ? "registered" : "updated";
        if (data.length > 0) {
          yield* persistCurrent({ entries, mappings, snapshot, status: "applying" }).pipe(
            Effect.catch((error) => externalFailureEffect(`${processOperation}.persist`, error)),
          );
          yield* provider
            .write(sheetId, data)
            .pipe(
              Effect.catch((error) =>
                externalFailureEffect(`${processOperation}.sheet-write`, error).pipe(
                  Effect.catch((failure) =>
                    reportProcessWriteFailure(execution, progressMessage, failure),
                  ),
                ),
              ),
            );
        }
        yield* persistCurrent({ entries, mappings, snapshot, status }).pipe(
          Effect.catch((error) =>
            externalFailureEffect(`${processOperation}.persist-terminal`, error),
          ),
        );
        const confirmationReceipt = yield* editProgress(
          execution,
          progressMessage,
          processResultMessage(sourceMessage, entries, skipped, true),
        );
        yield* persistence.teamSubmissionState
          .setMessageTeamSubmissionConfirmation({
            ...submissionKey(sourceMessage),
            confirmationMessageId: confirmationReceipt.target.message.messageId,
          })
          .pipe(
            Effect.tapError((error) =>
              data.length > 0
                ? Effect.logError(
                    "Team submission confirmation state persistence failed after sheet write commit",
                  ).pipe(
                    Effect.annotateLogs({
                      operation: `${processOperation}.confirmation-persistence`,
                      errorCategory: "ConfirmationPersistenceFailure",
                      workspaceId: sourceMessage.conversation.workspace.workspaceId,
                      conversationId: sourceMessage.conversation.conversationId,
                      sourceMessageId: sourceMessage.messageId,
                      confirmationMessageId: confirmationReceipt.target.message.messageId,
                      sheetId,
                    }),
                    Effect.andThen(Effect.logError(error)),
                  )
                : Effect.void,
            ),
            Effect.mapError(() =>
              interactiveDeliveryRejected(
                `${processOperation}.confirmation-persistence`,
                "The sheet write committed but confirmation state could not be persisted",
                true,
                confirmationReceipt.target.message.messageId,
              ),
            ),
          );
        const controlsReceipt = yield* editProgress(
          execution,
          confirmationReceipt.target.message,
          processResultMessage(sourceMessage, entries, skipped),
          teamSubmissionActionIdentities.confirmationControls,
        );
        const deliveryReceipts: Array<typeof DeliveryReceipt.Type> = [
          progress.progress,
          ...(reactionReceipt === undefined ? [] : [reactionReceipt]),
          confirmationReceipt,
          controlsReceipt,
        ];
        return {
          sourceMessage,
          confirmationMessage: confirmationReceipt.target.message,
          parsedTeamCount: entries.length,
          skippedTeamCount: skipped.length,
          status,
          deliveryReceipts,
        };
      }).pipe(
        Effect.catch((error) =>
          isInteractiveDeclaredFailure(error)
            ? Effect.fail(asProcessFailure(error))
            : externalFailureEffect(`${processOperation}.execute`, error),
        ),
      );

    const bestEffortDelivery = <A>(effect: Effect.Effect<A, unknown>, operation: string) =>
      effect.pipe(
        Effect.timeout("30 seconds"),
        Effect.exit,
        Effect.flatMap((exit) =>
          Exit.isSuccess(exit)
            ? Effect.succeed(Option.some(exit.value))
            : Cause.hasInterruptsOnly(exit.cause)
              ? Effect.interrupt
              : Effect.logWarning("Team submission post-commit delivery failed", exit.cause).pipe(
                  Effect.annotateLogs({ operation }),
                  Effect.as(Option.none<A>()),
                ),
        ),
      );

    const cleanupConfirmation = (
      execution: typeof TeamSubmissionsDecideExecution.Type,
      input: typeof TeamSubmissionsDecide.input.Type,
      sourceMessage: MessageRef,
      confirmationMessage: MessageRef,
      responseText: string,
      deleteConfirmation: boolean,
    ) =>
      Effect.gen(function* () {
        const receipts: Array<typeof DeliveryReceipt.Type> = [];
        const response = yield* bestEffortDelivery(
          delivery.get().delivery.respond({
            payload: {
              responseReference: input.responseReference,
              deliveryKey: makeTeamSubmissionsDeliveryKey(
                execution.invocationId,
                teamSubmissionActionIdentities.confirmation,
              ),
              message: responseMessage(responseText),
              workspace: workspaceRefFrom(
                clientFor(sourceMessage),
                sourceMessage.conversation.workspace.workspaceId,
              ),
            },
          }),
          `${decideOperation}.respond`,
        );
        if (Option.isSome(response)) receipts.push(response.value);
        if (deleteConfirmation) {
          const deleted = yield* bestEffortDelivery(
            delivery.get().delivery.deleteMessage({
              payload: {
                message: confirmationMessage,
                deliveryKey: makeTeamSubmissionsDeliveryKey(
                  execution.invocationId,
                  teamSubmissionActionIdentities.cleanup,
                  "delete",
                ),
              },
            }),
            `${decideOperation}.delete-confirmation`,
          );
          if (Option.isSome(deleted)) receipts.push(deleted.value);
        }
        const reaction = yield* bestEffortDelivery(
          delivery.get().delivery.setMessageReaction({
            payload: {
              message: sourceMessage,
              deliveryKey: makeTeamSubmissionsDeliveryKey(
                execution.invocationId,
                teamSubmissionActionIdentities.cleanup,
                "reaction",
              ),
              emoji: teamSubmissionReaction,
              present: false,
            },
          }),
          `${decideOperation}.remove-reaction`,
        );
        if (Option.isSome(reaction)) receipts.push(reaction.value);
        return receipts;
      });

    const reconcileRollback = (sheetId: string, snapshot: TeamSubmissionRollbackSnapshot) => {
      const resolved = snapshot.filter(({ range }) => range !== pendingAppendRollbackRange);
      if (resolved.length === 0) return Effect.succeed(false);
      const updates = resolved.map(({ range, values }) => ({
        range,
        values: rollbackValuesForRange(range, values),
      }));
      return provider.write(sheetId, updates).pipe(
        Effect.as(true),
        Effect.catch(() =>
          provider
            .read(
              sheetId,
              updates.map(({ range }) => range),
            )
            .pipe(
              Effect.map((ranges) =>
                updates.every((update, index) =>
                  actualMatchesExpectedCells(ranges[index]?.values ?? [], update.values),
                ),
              ),
              Effect.catch(() => Effect.succeed(false)),
            ),
        ),
      );
    };

    // fallow-ignore-next-line complexity
    const decide = (execution: typeof TeamSubmissionsDecideExecution.Type) =>
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const input = yield* decodeWorkflowContractInputOrDie(
          TeamSubmissionsDecide,
          execution.input,
        );
        const sourceMessage = input.sourceMessage;
        const confirmationMessage = input.confirmationMessage;
        yield* authorization
          .authorize(TeamSubmissionsDecide, execution.principal, input)
          .pipe(
            Effect.catch((error) =>
              Predicate.isTagged("WorkflowInvocationUnauthorized")(error)
                ? Effect.fail(
                    interactiveAuthorizationRevoked(
                      TeamSubmissionsDecide.authorizationPolicy.policy,
                    ),
                  )
                : externalFailureEffect(`${decideOperation}.authorization`, error),
            ),
          );
        const existingOption = yield* getSubmission(sourceMessage);
        if (Option.isNone(existingOption)) {
          return yield* Effect.fail(
            interactiveResourceNotFound("team submission", sourceMessage.messageId),
          );
        }
        const submission = existingOption.value;
        const requesterId = principalUserId(execution);
        if (requesterId === undefined || requesterId !== submission.discordAuthorId) {
          return yield* Effect.fail(
            interactiveBusinessRuleRejected(
              "OriginalSubmitterOnly",
              "Only the original submitter can decide this team submission",
            ),
          );
        }
        const persistedConfirmationId = optionValue(submission.confirmationMessageId);
        if (
          persistedConfirmationId === undefined ||
          persistedConfirmationId !== confirmationMessage.messageId ||
          !sameMessage(confirmationMessage, messageRefFor(sourceMessage, persistedConfirmationId))
        ) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "ConfirmationMessageMismatch",
              "The confirmation message does not match the persisted team submission",
            ),
          );
        }

        const persistedBinding = optionValue(submission.sheetConfigurationBinding);
        const persistedSnapshot = optionValue(submission.rollbackSnapshot);

        let version = submission.version;
        let currentStatus = submission.status;
        const persistStatus = (status: (typeof MessageTeamSubmission.Type)["status"]) =>
          persistence.teamSubmissionState
            .upsertMessageTeamSubmission(
              sourceRecord({
                sourceMessage,
                client: clientFor(sourceMessage),
                authorId: submission.discordAuthorId,
                sheetId: submission.sheetId,
                sheetConfigurationBinding: persistedBinding ?? null,
                confirmationMessageId: persistedConfirmationId,
                parsedSubmission: submission.parsedSubmission,
                rowMappings: submission.rowMappings,
                rollbackSnapshot: persistedSnapshot ?? null,
                status,
                expectedVersion: version,
              }),
            )
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  version += 1;
                  currentStatus = status;
                }),
              ),
            );

        if (input.decision === "confirm") {
          if (currentStatus === "confirmed") {
            const receipts = yield* cleanupConfirmation(
              execution,
              input,
              sourceMessage,
              confirmationMessage,
              "Team submission confirmed.",
              true,
            );
            return { sourceMessage, status: "confirmed" as const, deliveryReceipts: receipts };
          }
          yield* requireActionableForDecision(submission);
          // This is the business commit point. Every acknowledgement and cleanup below is
          // explicitly post-commit and therefore cannot revert the persisted decision.
          yield* persistStatus("confirmed").pipe(
            Effect.catch((error) => externalFailureEffect(`${decideOperation}.confirm`, error)),
          );
          const receipts = yield* cleanupConfirmation(
            execution,
            input,
            sourceMessage,
            confirmationMessage,
            "Team submission confirmed.",
            true,
          );
          return { sourceMessage, status: "confirmed" as const, deliveryReceipts: receipts };
        }

        if (currentStatus === "rejected") {
          const receipts = yield* cleanupConfirmation(
            execution,
            input,
            sourceMessage,
            confirmationMessage,
            "Team submission rejected and rolled back.",
            true,
          );
          return { sourceMessage, status: "rejected" as const, deliveryReceipts: receipts };
        }
        const snapshot = persistedSnapshot ?? null;
        const canResumeRollback =
          (currentStatus === "empty" && snapshot !== null && snapshot.length > 0) ||
          currentStatus === "applying" ||
          currentStatus === "reverting" ||
          currentStatus === "rollbackFailed";
        const pendingAppendRanges = [
          ...new Set(
            submission.rowMappings
              .filter(({ rowIndex }) => rowIndex === 0)
              .flatMap(({ playerNameRange, teamNameRange, oshiRange }) => [
                playerNameRange,
                teamNameRange,
                ...(oshiRange === null ? [] : [oshiRange]),
              ]),
          ),
        ];
        const rollbackFailureDetail =
          pendingAppendRanges.length > 0 &&
          snapshot?.some(({ range }) => range === pendingAppendRollbackRange)
            ? "Rollback failed: pending team row append could not be reconciled; affected ranges: " +
              pendingAppendRanges.join(", ") +
              ". Other changes may also remain unreverted."
            : "Rollback failed: Tiara could not restore the sheet.";
        if (
          (currentStatus === "empty" || submission.rowMappings.length === 0) &&
          (snapshot === null || snapshot.length === 0)
        ) {
          if (currentStatus !== "empty" && !canResumeRollback) {
            yield* requireActionableForDecision(submission);
          }
          yield* persistStatus("rejected").pipe(
            Effect.catch((error) => externalFailureEffect(`${decideOperation}.rejected`, error)),
          );
          const receipts = yield* cleanupConfirmation(
            execution,
            input,
            sourceMessage,
            confirmationMessage,
            "Team submission rejected.",
            true,
          );
          return { sourceMessage, status: "rejected" as const, deliveryReceipts: receipts };
        }
        if (snapshot === null || snapshot.length === 0) {
          if (!canResumeRollback) {
            yield* requireActionableForDecision(submission);
          }
          if (currentStatus !== "rollbackFailed") {
            yield* persistStatus("rollbackFailed").pipe(
              Effect.catch((error) =>
                externalFailureEffect(`${decideOperation}.rollback-state`, error),
              ),
            );
          }
          const edited = yield* bestEffortDelivery(
            delivery.get().delivery.editMessage({
              payload: {
                message: confirmationMessage,
                deliveryKey: makeTeamSubmissionsDeliveryKey(
                  execution.invocationId,
                  teamSubmissionActionIdentities.rollback,
                ),
                content: rollbackFailedMessage(
                  "Rollback failed: no rollback snapshot is available.",
                ),
              },
            }),
            `${decideOperation}.rollback-failed-message`,
          );
          const response = yield* cleanupConfirmation(
            execution,
            input,
            sourceMessage,
            confirmationMessage,
            "Rollback failed. The persisted snapshot is retained for recovery.",
            false,
          );
          return {
            sourceMessage,
            status: "rollbackFailed" as const,
            deliveryReceipts: [...(Option.isSome(edited) ? [edited.value] : []), ...response],
          };
        }
        if (currentStatus !== "reverting") {
          if (!canResumeRollback) {
            yield* requireActionableForDecision(submission);
          }
          yield* persistStatus("reverting").pipe(
            Effect.catch((error) => externalFailureEffect(`${decideOperation}.reverting`, error)),
          );
        }
        const restored = yield* reconcileRollback(submission.sheetId, snapshot);
        if (!restored) {
          if (currentStatus !== "rollbackFailed") {
            yield* persistStatus("rollbackFailed").pipe(
              Effect.catch((error) =>
                externalFailureEffect(`${decideOperation}.rollback-failed`, error),
              ),
            );
          }
          const edited = yield* bestEffortDelivery(
            delivery.get().delivery.editMessage({
              payload: {
                message: confirmationMessage,
                deliveryKey: makeTeamSubmissionsDeliveryKey(
                  execution.invocationId,
                  teamSubmissionActionIdentities.rollback,
                ),
                content: rollbackFailedMessage(rollbackFailureDetail),
              },
            }),
            `${decideOperation}.rollback-failed-message`,
          );
          const response = yield* cleanupConfirmation(
            execution,
            input,
            sourceMessage,
            confirmationMessage,
            "Rollback failed. The persisted snapshot is retained for recovery.",
            false,
          );
          return {
            sourceMessage,
            status: "rollbackFailed" as const,
            deliveryReceipts: [...(Option.isSome(edited) ? [edited.value] : []), ...response],
          };
        }
        yield* persistStatus("rejected").pipe(
          Effect.catch((error) => externalFailureEffect(`${decideOperation}.rejected`, error)),
        );
        const receipts = yield* cleanupConfirmation(
          execution,
          input,
          sourceMessage,
          confirmationMessage,
          "Team submission rejected and rolled back.",
          true,
        );
        return { sourceMessage, status: "rejected" as const, deliveryReceipts: receipts };
      }).pipe(
        Effect.catch((error) =>
          isInteractiveDeclaredFailure(error)
            ? Effect.fail(error)
            : externalFailureEffect(`${decideOperation}.execute`, error),
        ),
      );

    return { process, decide };
  }),
);
