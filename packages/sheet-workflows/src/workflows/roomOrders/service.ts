import { Context, Data, type Effect } from "effect";
import type { EditMessageReceipt, RespondReceipt, ResponseReference } from "sheet-bot-api";
import { DeliveryKey } from "sheet-bot-api";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import type { AuthorizedRoomOrderNavigateContext } from "../readOnly/authorization";
import type {
  RoomOrderNavigationClaim,
  RoomOrderNavigationCommitted,
  RoomOrderNavigationView,
} from "./schema";

export class RoomOrderNavigationOperationsError extends Data.TaggedError(
  "RoomOrderNavigationOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type NavigationResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | RoomOrderNavigationOperationsError
>;

interface RoomOrderNavigationOperationsShape {
  readonly claim: (
    context: AuthorizedRoomOrderNavigateContext,
    claimId: string,
    policy: string,
  ) => NavigationResult<RoomOrderNavigationClaim>;
  readonly loadView: (
    claim: RoomOrderNavigationClaim,
    direction: "previous" | "next",
    policy: string,
  ) => NavigationResult<RoomOrderNavigationView>;
  readonly commit: (
    view: RoomOrderNavigationView,
    policy: string,
  ) => NavigationResult<RoomOrderNavigationCommitted>;
  readonly respond: (
    committed: RoomOrderNavigationCommitted,
    responseReference: ResponseReference,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => NavigationResult<RespondReceipt>;
  readonly editRoomOrderMessage: (
    committed: RoomOrderNavigationCommitted,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => NavigationResult<EditMessageReceipt>;
  readonly release: (committed: RoomOrderNavigationCommitted) => NavigationResult<void>;
}

export class RoomOrderNavigationOperations extends Context.Service<
  RoomOrderNavigationOperations,
  RoomOrderNavigationOperationsShape
>()("sheet-workflows/RoomOrderNavigationOperations") {}
