import { Context, Data, Effect } from "effect";
import type {
  BotOutboundMessage,
  ConversationRef,
  DeliveryKey,
  RespondReceipt,
  SendMessageReceipt,
} from "sheet-bot-api";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import type { WorkspacesFeatureFlagsSetAndDeliverInput } from "sheet-workflow-contracts/values";
import type { WorkspaceFeatureFlagState } from "./featureFlagSchema";

export class WorkspaceFeatureFlagWorkflowOperationsError extends Data.TaggedError(
  "WorkspaceFeatureFlagWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type WorkspaceFeatureFlagResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | WorkspaceFeatureFlagWorkflowOperationsError
>;

interface WorkspaceFeatureFlagWorkflowOperationsShape {
  readonly setDesiredState: (
    input: WorkspacesFeatureFlagsSetAndDeliverInput,
  ) => WorkspaceFeatureFlagResult<WorkspaceFeatureFlagState>;
  readonly selectAnnouncementConversation: (
    input: WorkspacesFeatureFlagsSetAndDeliverInput,
    state: WorkspaceFeatureFlagState,
    policy: string,
  ) => WorkspaceFeatureFlagResult<ConversationRef | null>;
  readonly respond: (
    input: WorkspacesFeatureFlagsSetAndDeliverInput,
    state: WorkspaceFeatureFlagState,
    message: typeof BotOutboundMessage.Type,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => WorkspaceFeatureFlagResult<RespondReceipt>;
  readonly announce: (
    input: WorkspacesFeatureFlagsSetAndDeliverInput,
    state: WorkspaceFeatureFlagState,
    conversation: ConversationRef,
    message: typeof BotOutboundMessage.Type,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => WorkspaceFeatureFlagResult<SendMessageReceipt | null>;
}

export class WorkspaceFeatureFlagWorkflowOperations extends Context.Service<
  WorkspaceFeatureFlagWorkflowOperations,
  WorkspaceFeatureFlagWorkflowOperationsShape
>()("sheet-workflows/WorkspaceFeatureFlagWorkflowOperations") {}
