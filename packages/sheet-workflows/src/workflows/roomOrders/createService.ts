import { Context, Data, type Effect } from "effect";
import { DeliveryKey, type DeleteMessageReceipt, type EditMessageReceipt } from "sheet-bot-api";
import type { InteractiveDeclaredFailure, RoomOrdersCreateInput } from "sheet-workflow-contracts";
import type { AuthorizedRoomOrderCreateContext } from "../readOnly/authorization";
import type {
  RoomOrderCreateBindingOutcome,
  RoomOrderCreateDraft,
  RoomOrderCreatePublication,
} from "./createSchema";

export class RoomOrderCreateOperationsError extends Data.TaggedError(
  "RoomOrderCreateOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type CreateResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | RoomOrderCreateOperationsError
>;

interface RoomOrderCreateOperationsShape {
  readonly loadDraft: (
    context: AuthorizedRoomOrderCreateContext,
    input: RoomOrdersCreateInput,
  ) => CreateResult<RoomOrderCreateDraft>;
  readonly publishDraft: (
    draft: RoomOrderCreateDraft,
    responseReference: RoomOrdersCreateInput["responseReference"],
    keys: {
      readonly publishKey: typeof DeliveryKey.Type;
      readonly cleanupKey: typeof DeliveryKey.Type;
    },
    policy: string,
  ) => CreateResult<RoomOrderCreatePublication>;
  readonly bindState: (
    publication: RoomOrderCreatePublication,
  ) => CreateResult<RoomOrderCreateBindingOutcome>;
  readonly finalizeMessage: (
    publication: RoomOrderCreatePublication,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => CreateResult<EditMessageReceipt>;
  readonly deleteProvisional: (
    publication: RoomOrderCreatePublication,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => CreateResult<DeleteMessageReceipt>;
}

export class RoomOrderCreateOperations extends Context.Service<
  RoomOrderCreateOperations,
  RoomOrderCreateOperationsShape
>()("sheet-workflows/RoomOrderCreateOperations") {}
