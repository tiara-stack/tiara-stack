import { Context, Data, type Effect } from "effect";
import type { BotOutboundMessage, ConversationRef, DeliveryKey } from "sheet-bot-api";
import type { AutonomousDeclaredFailure } from "sheet-workflow-contracts";
import {
  UpdateAnnouncementExecution,
  type UpdateAnnouncementClaim,
  type UpdateAnnouncementCommit,
  type UpdateAnnouncementRecordDisposition,
} from "./schema";

export class UpdateAnnouncementWorkflowOperationsError extends Data.TaggedError(
  "UpdateAnnouncementWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type UpdateAnnouncementResult<A> = Effect.Effect<
  A,
  AutonomousDeclaredFailure | UpdateAnnouncementWorkflowOperationsError
>;

interface UpdateAnnouncementWorkflowOperationsShape {
  readonly claim: (
    execution: typeof UpdateAnnouncementExecution.Type,
    claimId: string,
    policy: string,
  ) => UpdateAnnouncementResult<UpdateAnnouncementClaim>;
  readonly select: (
    execution: typeof UpdateAnnouncementExecution.Type,
    claim: UpdateAnnouncementClaim,
    policy: string,
  ) => UpdateAnnouncementResult<ConversationRef>;
  readonly deliver: (
    execution: typeof UpdateAnnouncementExecution.Type,
    claim: UpdateAnnouncementClaim,
    conversation: ConversationRef,
    message: typeof BotOutboundMessage.Type,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => UpdateAnnouncementResult<UpdateAnnouncementCommit>;
  readonly record: (
    execution: typeof UpdateAnnouncementExecution.Type,
    commit: UpdateAnnouncementCommit,
    policy: string,
  ) => UpdateAnnouncementResult<UpdateAnnouncementRecordDisposition>;
  readonly release: (
    execution: typeof UpdateAnnouncementExecution.Type,
    claim: UpdateAnnouncementClaim,
    policy: string,
  ) => UpdateAnnouncementResult<void>;
}

export class UpdateAnnouncementWorkflowOperations extends Context.Service<
  UpdateAnnouncementWorkflowOperations,
  UpdateAnnouncementWorkflowOperationsShape
>()("sheet-workflows/UpdateAnnouncementWorkflowOperations") {}
