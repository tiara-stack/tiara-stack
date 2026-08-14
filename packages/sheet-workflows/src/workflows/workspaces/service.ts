import { Context, Data, Effect } from "effect";
import type {
  BotOutboundMessage,
  ConversationRef,
  DeliveryKey,
  SendMessageReceipt,
} from "sheet-bot-api";
import type { AutonomousDeclaredFailure } from "sheet-workflow-contracts";
import type { WorkspacesDeliverWelcomeInput } from "sheet-workflow-contracts/values";

export class WorkspaceWelcomeWorkflowOperationsError extends Data.TaggedError(
  "WorkspaceWelcomeWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type WorkspaceWelcomeResult<A> = Effect.Effect<
  A,
  AutonomousDeclaredFailure | WorkspaceWelcomeWorkflowOperationsError
>;

interface WorkspaceWelcomeWorkflowOperationsShape {
  readonly selectConversation: (
    input: WorkspacesDeliverWelcomeInput,
    policy: string,
  ) => WorkspaceWelcomeResult<ConversationRef>;
  readonly deliverWelcome: (
    input: WorkspacesDeliverWelcomeInput,
    conversation: ConversationRef,
    message: typeof BotOutboundMessage.Type,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => WorkspaceWelcomeResult<SendMessageReceipt>;
}

export class WorkspaceWelcomeWorkflowOperations extends Context.Service<
  WorkspaceWelcomeWorkflowOperations,
  WorkspaceWelcomeWorkflowOperationsShape
>()("sheet-workflows/WorkspaceWelcomeWorkflowOperations") {}
