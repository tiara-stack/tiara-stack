import { Schema } from "effect";
import { ConversationRef, SendMessageReceipt } from "sheet-bot-api";
import { WorkspacesFeatureFlagsSetAndDeliver } from "sheet-workflow-contracts";
import { FeatureFlagName, WorkspaceId } from "sheet-workflow-contracts/values";
import { workflowContractExecutionSchema } from "../shared/execution";

export const WorkspaceFeatureFlagExecution = workflowContractExecutionSchema(
  WorkspacesFeatureFlagsSetAndDeliver,
);

export const WorkspaceFeatureFlagState = Schema.Struct({
  workspaceId: WorkspaceId,
  flagName: FeatureFlagName,
  enabled: Schema.Boolean,
  committedReference: Schema.String,
});
export type WorkspaceFeatureFlagState = typeof WorkspaceFeatureFlagState.Type;

export const OptionalWorkspaceFeatureFlagConversation = Schema.NullOr(ConversationRef);
export type OptionalWorkspaceFeatureFlagConversation =
  typeof OptionalWorkspaceFeatureFlagConversation.Type;

export const OptionalWorkspaceFeatureFlagAnnouncementReceipt = Schema.NullOr(SendMessageReceipt);
export type OptionalWorkspaceFeatureFlagAnnouncementReceipt =
  typeof OptionalWorkspaceFeatureFlagAnnouncementReceipt.Type;
