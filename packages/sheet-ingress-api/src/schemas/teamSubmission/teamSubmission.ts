import { Schema } from "effect";
import { TeamSubmissionStatus as TeamSubmissionStatusSchema } from "sheet-db-schema";
import { ClientPlatform, ClientRef, MessageRef } from "../client";

export const ParsedTeamType = Schema.Literals(["fullFill", "heal", "encore", "alt"]);
export type ParsedTeamType = Schema.Schema.Type<typeof ParsedTeamType>;

export const ParsedOshiStatus = Schema.Literals([
  "none",
  "matched",
  "invalid",
  "ambiguous",
  "notConfigured",
]);
export type ParsedOshiStatus = Schema.Schema.Type<typeof ParsedOshiStatus>;

export const ParsedOshi = Schema.Struct({
  candidate: Schema.NullOr(Schema.String),
  value: Schema.NullOr(Schema.String),
  status: ParsedOshiStatus,
});
export type ParsedOshi = Schema.Schema.Type<typeof ParsedOshi>;

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

export const TeamSubmissionRollbackSnapshotEntry = Schema.Struct({
  stableKey: Schema.String,
  range: Schema.String,
  values: Schema.Array(Schema.Array(Schema.String)),
});
export type TeamSubmissionRollbackSnapshotEntry = Schema.Schema.Type<
  typeof TeamSubmissionRollbackSnapshotEntry
>;

export const TeamSubmissionRollbackSnapshot = Schema.Array(TeamSubmissionRollbackSnapshotEntry);
export type TeamSubmissionRollbackSnapshot = Schema.Schema.Type<
  typeof TeamSubmissionRollbackSnapshot
>;

export const TeamSubmissionSkippedEntry = Schema.Struct({
  stableKey: Schema.String,
  playerName: Schema.String,
  teamName: Schema.String,
  teamType: ParsedTeamType,
  reason: Schema.String,
});
export type TeamSubmissionSkippedEntry = Schema.Schema.Type<typeof TeamSubmissionSkippedEntry>;

export const TeamSubmissionStatus = TeamSubmissionStatusSchema;
export type TeamSubmissionStatus = Schema.Schema.Type<typeof TeamSubmissionStatus>;

export const TeamSubmissionUpsertFromDiscordPayload = Schema.Struct({
  client: ClientRef,
  dispatchRequestId: Schema.String,
  workspaceId: Schema.String,
  conversationId: Schema.String,
  messageId: Schema.String,
  authorId: Schema.String,
  authorDisplayName: Schema.String,
  content: Schema.String,
  editedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export type TeamSubmissionUpsertFromDiscordPayload = Schema.Schema.Type<
  typeof TeamSubmissionUpsertFromDiscordPayload
>;

export const TeamSubmissionUpsertResult = Schema.Struct({
  sourceMessage: MessageRef,
  confirmationMessage: Schema.OptionFromNullOr(MessageRef),
  parsedTeams: Schema.Array(ParsedTeamEntry),
  rowMappings: Schema.Array(TeamSubmissionRowMapping),
  rollbackSnapshot: Schema.NullOr(TeamSubmissionRollbackSnapshot),
  skippedTeams: Schema.Array(TeamSubmissionSkippedEntry),
  confirmationText: Schema.String,
  status: TeamSubmissionStatus,
});
export type TeamSubmissionUpsertResult = Schema.Schema.Type<typeof TeamSubmissionUpsertResult>;

export const TeamSubmissionSetConfirmationPayload = Schema.Struct({
  workspaceId: Schema.String,
  conversationId: Schema.String,
  messageId: Schema.String,
  confirmationMessageId: Schema.String,
});
export type TeamSubmissionSetConfirmationPayload = Schema.Schema.Type<
  typeof TeamSubmissionSetConfirmationPayload
>;

export const TeamSubmissionButtonPayload = Schema.Struct({
  client: ClientRef,
  dispatchRequestId: Schema.String,
  workspaceId: Schema.String,
  conversationId: Schema.String,
  messageId: Schema.String,
  confirmationMessageId: Schema.String,
  interactionResponseToken: Schema.String,
  interactionResponseDeadlineEpochMs: Schema.Number,
});
export type TeamSubmissionButtonPayload = Schema.Schema.Type<typeof TeamSubmissionButtonPayload>;

export const TeamSubmissionConfirmButtonPayload = TeamSubmissionButtonPayload;
export type TeamSubmissionConfirmButtonPayload = Schema.Schema.Type<
  typeof TeamSubmissionConfirmButtonPayload
>;

export const TeamSubmissionRejectButtonPayload = TeamSubmissionButtonPayload;
export type TeamSubmissionRejectButtonPayload = Schema.Schema.Type<
  typeof TeamSubmissionRejectButtonPayload
>;

export const TeamSubmissionConfirmButtonResult = Schema.Struct({
  status: Schema.Literal("confirmed"),
});
export type TeamSubmissionConfirmButtonResult = Schema.Schema.Type<
  typeof TeamSubmissionConfirmButtonResult
>;

export const TeamSubmissionRejectButtonResult = Schema.Struct({
  status: Schema.Literals(["rejected", "rollbackFailed"]),
});
export type TeamSubmissionRejectButtonResult = Schema.Schema.Type<
  typeof TeamSubmissionRejectButtonResult
>;

export const TeamSubmissionConfirmFromDiscordPayload = Schema.Struct({
  client: ClientRef,
  workspaceId: Schema.String,
  conversationId: Schema.String,
  messageId: Schema.String,
  confirmationMessageId: Schema.String,
  requesterUserId: Schema.String,
});
export type TeamSubmissionConfirmFromDiscordPayload = Schema.Schema.Type<
  typeof TeamSubmissionConfirmFromDiscordPayload
>;

export const TeamSubmissionConfirmResult = Schema.Struct({
  status: Schema.Literal("confirmed"),
});
export type TeamSubmissionConfirmResult = Schema.Schema.Type<typeof TeamSubmissionConfirmResult>;

export const TeamSubmissionRevertFromDiscordPayload = Schema.Struct({
  client: ClientRef,
  workspaceId: Schema.String,
  conversationId: Schema.String,
  messageId: Schema.String,
  confirmationMessageId: Schema.String,
  requesterUserId: Schema.String,
});
export type TeamSubmissionRevertFromDiscordPayload = Schema.Schema.Type<
  typeof TeamSubmissionRevertFromDiscordPayload
>;

export const TeamSubmissionRevertResult = Schema.Struct({
  status: Schema.Literals(["rejected", "rollbackFailed"]),
  rowMappings: Schema.Array(TeamSubmissionRowMapping),
  rollbackSnapshot: Schema.NullOr(TeamSubmissionRollbackSnapshot),
  confirmationText: Schema.String,
});
export type TeamSubmissionRevertResult = Schema.Schema.Type<typeof TeamSubmissionRevertResult>;

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
    status: TeamSubmissionStatus,
    createdAt: Schema.DateTimeUtcFromMillis,
    updatedAt: Schema.DateTimeUtcFromMillis,
    deletedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  },
) {}
