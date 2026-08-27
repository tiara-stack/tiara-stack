import { Schema } from "effect";
import { ClientPlatform } from "sheet-bot-api/references";
import { WorkflowTeamSubmissionStatus } from "sheet-workflow-contracts";

export const TEAM_SUBMISSION_FEATURE_FLAG = "team-submission-confirmations";

export const isTeamSubmissionEnabled = (
  featureFlags: ReadonlyArray<{ readonly flagName: string }>,
) => featureFlags.some(({ flagName }) => flagName === TEAM_SUBMISSION_FEATURE_FLAG);

const ParsedTeamType = Schema.Literals(["fullFill", "heal", "encore", "alt"]);
type ParsedTeamType = Schema.Schema.Type<typeof ParsedTeamType>;

const ParsedOshiStatus = Schema.Literals([
  "none",
  "matched",
  "invalid",
  "ambiguous",
  "notConfigured",
]);
type ParsedOshiStatus = Schema.Schema.Type<typeof ParsedOshiStatus>;

const ParsedOshi = Schema.Struct({
  candidate: Schema.NullOr(Schema.String),
  value: Schema.NullOr(Schema.String),
  status: ParsedOshiStatus,
});
type ParsedOshi = Schema.Schema.Type<typeof ParsedOshi>;

export const ParsedTeamEntry = Schema.Struct({
  stableKey: Schema.String,
  playerName: Schema.String,
  teamName: Schema.String,
  teamType: ParsedTeamType,
  notes: Schema.Array(Schema.String),
  teamConfigName: Schema.NullOr(Schema.String),
  oshi: ParsedOshi,
});
export type ParsedTeamEntry = Schema.Schema.Type<typeof ParsedTeamEntry>;

export const TeamSubmissionRowMapping = Schema.Struct({
  stableKey: Schema.String,
  playerNameRange: Schema.String,
  teamNameRange: Schema.String,
  oshiRange: Schema.NullOr(Schema.String),
  rowIndex: Schema.Number,
});
export type TeamSubmissionRowMapping = Schema.Schema.Type<typeof TeamSubmissionRowMapping>;

const TeamSubmissionRollbackSnapshotEntry = Schema.Struct({
  stableKey: Schema.String,
  range: Schema.String,
  values: Schema.Array(Schema.Array(Schema.String)),
});
type TeamSubmissionRollbackSnapshotEntry = Schema.Schema.Type<
  typeof TeamSubmissionRollbackSnapshotEntry
>;

export const TeamSubmissionRollbackSnapshot = Schema.Array(TeamSubmissionRollbackSnapshotEntry);
export type TeamSubmissionRollbackSnapshot = Schema.Schema.Type<
  typeof TeamSubmissionRollbackSnapshot
>;

const TeamSubmissionSkippedEntry = Schema.Struct({
  stableKey: Schema.String,
  playerName: Schema.String,
  teamName: Schema.String,
  teamType: ParsedTeamType,
  reason: Schema.String,
});
export type TeamSubmissionSkippedEntry = Schema.Schema.Type<typeof TeamSubmissionSkippedEntry>;

export class MessageTeamSubmission extends Schema.TaggedClass<MessageTeamSubmission>()(
  "MessageTeamSubmission",
  {
    workspaceId: Schema.String,
    conversationId: Schema.String,
    messageId: Schema.String,
    clientPlatform: ClientPlatform,
    clientId: Schema.String,
    discordGuildId: Schema.String,
    discordChannelId: Schema.String,
    discordAuthorId: Schema.String,
    sheetId: Schema.String,
    confirmationMessageId: Schema.OptionFromNullOr(Schema.String),
    parsedSubmission: Schema.Array(ParsedTeamEntry),
    rowMappings: Schema.Array(TeamSubmissionRowMapping),
    rollbackSnapshot: Schema.OptionFromNullOr(TeamSubmissionRollbackSnapshot),
    version: Schema.Number,
    status: WorkflowTeamSubmissionStatus,
    createdAt: Schema.DateTimeUtcFromMillis,
    updatedAt: Schema.DateTimeUtcFromMillis,
    deletedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  },
) {}

export class TeamTagsConstantsConfig extends Schema.TaggedClass<TeamTagsConstantsConfig>()(
  "TeamTagsConstantsConfig",
  { tags: Schema.Array(Schema.String) },
) {}

export class TeamTagsRangesConfig extends Schema.TaggedClass<TeamTagsRangesConfig>()(
  "TeamTagsRangesConfig",
  { tagsRange: Schema.String },
) {}

export class TeamIsvSplitConfig extends Schema.TaggedClass<TeamIsvSplitConfig>()(
  "TeamIsvSplitConfig",
  {
    leadRange: Schema.String,
    backlineRange: Schema.String,
    talentRange: Schema.String,
  },
) {}

export class TeamIsvCombinedConfig extends Schema.TaggedClass<TeamIsvCombinedConfig>()(
  "TeamIsvCombinedConfig",
  { isvRange: Schema.String },
) {}

export class TeamConfig extends Schema.TaggedClass<TeamConfig>()("TeamConfig", {
  name: Schema.OptionFromNullOr(Schema.String),
  sheet: Schema.OptionFromNullOr(Schema.String),
  playerNameRange: Schema.OptionFromNullOr(Schema.String),
  teamNameRange: Schema.OptionFromNullOr(Schema.String),
  isvConfig: Schema.OptionFromNullOr(Schema.Union([TeamIsvSplitConfig, TeamIsvCombinedConfig])),
  tagsConfig: Schema.OptionFromNullOr(
    Schema.Union([TeamTagsConstantsConfig, TeamTagsRangesConfig]),
  ),
  oshiRange: Schema.OptionFromNullOr(Schema.String),
}) {}

export class RangesConfig extends Schema.TaggedClass<RangesConfig>()("RangesConfig", {
  userIds: Schema.String,
  userSheetNames: Schema.String,
  userNotes: Schema.OptionFromNullOr(Schema.String),
  monitorIds: Schema.OptionFromNullOr(Schema.String),
  monitorNames: Schema.OptionFromNullOr(Schema.String),
  oshis: Schema.OptionFromNullOr(Schema.String),
}) {}

export type TeamSubmissionSheetConfiguration = {
  readonly rangesConfig: RangesConfig;
  readonly teamConfigs: ReadonlyArray<TeamConfig>;
};

const TeamSubmissionWriteMode = Schema.Literals(["upsert"]);
type TeamSubmissionWriteMode = Schema.Schema.Type<typeof TeamSubmissionWriteMode>;

const TeamSubmissionRemovedRowStrategy = Schema.Literals(["blank"]);
type TeamSubmissionRemovedRowStrategy = Schema.Schema.Type<typeof TeamSubmissionRemovedRowStrategy>;

export class WorkspaceTeamSubmissionChannel extends Schema.TaggedClass<WorkspaceTeamSubmissionChannel>()(
  "WorkspaceTeamSubmissionChannel",
  {
    workspaceId: Schema.String,
    conversationId: Schema.String,
    destinationTeamConfigName: Schema.OptionFromNullOr(Schema.String),
    writeMode: TeamSubmissionWriteMode,
    removedRowStrategy: TeamSubmissionRemovedRowStrategy,
    requireValidOshi: Schema.Boolean,
    createdAt: Schema.DateTimeUtcFromMillis,
    updatedAt: Schema.DateTimeUtcFromMillis,
    deletedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  },
) {}
