import { Context, Data, type Effect } from "effect";
import type { EditMessageReceipt, RespondReceipt, ResponseReference } from "sheet-bot-api";
import { DeliveryKey } from "sheet-bot-api";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import type { AuthorizedRoomOrderPinTentativeContext } from "../readOnly/authorization";
import type {
  RoomOrderTentativePinAttempt,
  RoomOrderTentativePinClaim,
  RoomOrderTentativePinCommit,
  RoomOrderTentativePinFinalization,
  RoomOrderTentativePinRecordDisposition,
  RoomOrderTentativePinResponse,
  RoomOrderTentativePinView,
} from "./pinTentativeSchema";

export class RoomOrderTentativePinOperationsError extends Data.TaggedError(
  "RoomOrderTentativePinOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type PinResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | RoomOrderTentativePinOperationsError
>;

interface RoomOrderTentativePinOperationsShape {
  readonly claim: (
    context: AuthorizedRoomOrderPinTentativeContext,
    claimId: string,
    policy: string,
  ) => PinResult<RoomOrderTentativePinClaim>;
  readonly loadView: (
    claim: RoomOrderTentativePinClaim,
    policy: string,
  ) => PinResult<RoomOrderTentativePinView>;
  readonly pin: (
    view: RoomOrderTentativePinView,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => PinResult<RoomOrderTentativePinAttempt>;
  readonly record: (
    commit: RoomOrderTentativePinCommit,
    policy: string,
  ) => PinResult<RoomOrderTentativePinRecordDisposition>;
  readonly finalize: (
    finalization: RoomOrderTentativePinFinalization,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => PinResult<EditMessageReceipt>;
  readonly respond: (
    response: RoomOrderTentativePinResponse,
    responseReference: ResponseReference,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => PinResult<RespondReceipt>;
  readonly release: (claim: RoomOrderTentativePinClaim) => PinResult<void>;
}

export class RoomOrderTentativePinOperations extends Context.Service<
  RoomOrderTentativePinOperations,
  RoomOrderTentativePinOperationsShape
>()("sheet-workflows/RoomOrderTentativePinOperations") {}
