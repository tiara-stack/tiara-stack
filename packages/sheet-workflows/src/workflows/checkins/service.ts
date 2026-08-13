import { Context, Data, type Effect } from "effect";
import type {
  BotOutboundMessage,
  EditMessageReceipt,
  RespondReceipt,
  ResponseReference,
  SendMessageReceipt,
  SetMemberRoleReceipt,
} from "sheet-bot-api";
import { DeliveryKey } from "sheet-bot-api";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import type { AuthorizedCheckinRespondContext } from "../readOnly/authorization";
import type { CheckinCommit, CheckinView } from "./schema";

export class CheckinWorkflowOperationsError extends Data.TaggedError(
  "CheckinWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type CheckinResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | CheckinWorkflowOperationsError
>;

interface CheckinWorkflowOperationsShape {
  readonly commitCheckin: (
    context: AuthorizedCheckinRespondContext,
    claimId: string,
    policy: string,
  ) => CheckinResult<CheckinCommit>;
  readonly respond: (
    context: AuthorizedCheckinRespondContext,
    responseReference: ResponseReference,
    isFirst: boolean,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => CheckinResult<RespondReceipt>;
  readonly setMemberRole: (
    context: AuthorizedCheckinRespondContext,
    roleId: string,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => CheckinResult<SetMemberRoleReceipt>;
  readonly loadCurrentView: (
    context: AuthorizedCheckinRespondContext,
    policy: string,
  ) => CheckinResult<CheckinView>;
  readonly editCheckinMessage: (
    view: CheckinView,
    message: BotOutboundMessage,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => CheckinResult<EditMessageReceipt>;
  readonly announceFirstCheckin: (
    context: AuthorizedCheckinRespondContext,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => CheckinResult<SendMessageReceipt>;
}

export class CheckinWorkflowOperations extends Context.Service<
  CheckinWorkflowOperations,
  CheckinWorkflowOperationsShape
>()("sheet-workflows/CheckinWorkflowOperations") {}
