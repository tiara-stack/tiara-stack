import { Context, Data, type Effect } from "effect";
import type { RespondReceipt, ResponseReference } from "sheet-bot-api";
import { DeliveryKey } from "sheet-bot-api";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import type { AuthorizedRoomOrderSendContext } from "../readOnly/authorization";
import type {
  RoomOrderSendClaim,
  RoomOrderSendCommit,
  RoomOrderSendPinDisposition,
  RoomOrderSendRecordDisposition,
  RoomOrderSendResponse,
  RoomOrderSendView,
} from "./sendSchema";

export class RoomOrderSendOperationsError extends Data.TaggedError("RoomOrderSendOperationsError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type SendResult<A> = Effect.Effect<A, InteractiveDeclaredFailure | RoomOrderSendOperationsError>;

interface RoomOrderSendOperationsShape {
  readonly claim: (
    context: AuthorizedRoomOrderSendContext,
    claimId: string,
    policy: string,
  ) => SendResult<RoomOrderSendClaim>;
  readonly loadView: (claim: RoomOrderSendClaim, policy: string) => SendResult<RoomOrderSendView>;
  readonly send: (
    view: RoomOrderSendView,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => SendResult<RoomOrderSendCommit>;
  readonly record: (
    commit: RoomOrderSendCommit,
    policy: string,
  ) => SendResult<RoomOrderSendRecordDisposition>;
  readonly pin: (
    commit: RoomOrderSendCommit,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => SendResult<RoomOrderSendPinDisposition>;
  readonly respond: (
    response: RoomOrderSendResponse,
    responseReference: ResponseReference,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => SendResult<RespondReceipt>;
  readonly release: (claim: RoomOrderSendClaim) => SendResult<void>;
}

export class RoomOrderSendOperations extends Context.Service<
  RoomOrderSendOperations,
  RoomOrderSendOperationsShape
>()("sheet-workflows/RoomOrderSendOperations") {}
