import { Schema } from "effect";
import { BotOutboundMessage } from "sheet-bot-api";
import { MembersKick, SpreadsheetId, WorkspaceId } from "sheet-workflow-contracts";
import { workflowContractExecutionSchema } from "../shared/execution";

export const MemberKickExecution = Schema.Struct({
  ...workflowContractExecutionSchema(MembersKick).fields,
  acceptedAt: Schema.Number,
});

export const MemberKickContext = Schema.Struct({
  clientPlatform: Schema.Literal("discord"),
  clientId: Schema.String,
  workspaceId: WorkspaceId,
  spreadsheetId: Schema.NullOr(SpreadsheetId),
  runningConversationId: Schema.String,
  conversationName: Schema.NullOr(Schema.String),
  roleId: Schema.NullOr(Schema.String),
  acceptedAt: Schema.Number,
  hour: Schema.Number,
  status: Schema.Literals(["ready", "tooEarly", "missingRole"]),
  principalKind: Schema.Literals(["user", "service"]),
});

export const MemberKickSchedule = Schema.Struct({
  scheduleFound: Schema.Boolean,
  scheduledMemberIds: Schema.Array(Schema.String),
});

export const MemberKickTargets = Schema.Struct({
  memberIds: Schema.Array(Schema.String),
});

export const MemberKickResolvedExecution = Schema.Struct({
  ...MemberKickExecution.fields,
  context: MemberKickContext,
});

export const MemberKickScheduleExecution = Schema.Struct({
  ...MemberKickResolvedExecution.fields,
  schedule: MemberKickSchedule,
});

export const MemberKickRemovalExecution = Schema.Struct({
  ...MemberKickResolvedExecution.fields,
  memberId: Schema.String,
});

export const MemberKickResponseExecution = Schema.Struct({
  ...MemberKickResolvedExecution.fields,
  message: BotOutboundMessage,
  recoveryRequired: Schema.Boolean,
});

export type MemberKickContext = typeof MemberKickContext.Type;
export type MemberKickSchedule = typeof MemberKickSchedule.Type;
export type MemberKickTargets = typeof MemberKickTargets.Type;
