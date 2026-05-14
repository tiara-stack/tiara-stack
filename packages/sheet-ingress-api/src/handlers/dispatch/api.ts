import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import {
  CheckinDispatchErrorSchemas,
  CheckinDispatchPayload,
  DispatchAcceptedResult,
  CheckinHandleButtonErrorSchemas,
  CheckinHandleButtonPayload,
  DispatchRoomOrderButtonMethods,
  KickoutDispatchErrorSchemas,
  KickoutDispatchPayload,
  RoomOrderDispatchErrorSchemas,
  RoomOrderDispatchPayload,
  RoomOrderHandleButtonErrorSchemas,
  RoomOrderNextButtonPayload,
  RoomOrderPinTentativeButtonPayload,
  RoomOrderPreviousButtonPayload,
  RoomOrderSendButtonPayload,
  SlotButtonDispatchPayload,
  SlotDispatchErrorSchemas,
  SlotListDispatchPayload,
  SlotOpenButtonPayload,
} from "./schema";

export class DispatchApi extends HttpApiGroup.make("dispatch")
  .add(
    HttpApiEndpoint.post("checkin", "/dispatch/checkin", {
      payload: CheckinDispatchPayload,
      success: DispatchAcceptedResult,
      error: CheckinDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("checkinButton", "/dispatch/checkin/buttons/handle", {
      payload: CheckinHandleButtonPayload,
      success: DispatchAcceptedResult,
      error: CheckinHandleButtonErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("roomOrder", "/dispatch/roomOrder", {
      payload: RoomOrderDispatchPayload,
      success: DispatchAcceptedResult,
      error: RoomOrderDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("kickout", "/dispatch/kickout", {
      payload: KickoutDispatchPayload,
      success: DispatchAcceptedResult,
      error: KickoutDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("slotButton", "/dispatch/slot/button", {
      payload: SlotButtonDispatchPayload,
      success: DispatchAcceptedResult,
      error: SlotDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("slotList", "/dispatch/slot/list", {
      payload: SlotListDispatchPayload,
      success: DispatchAcceptedResult,
      error: SlotDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("slotOpenButton", "/dispatch/slot/buttons/open", {
      payload: SlotOpenButtonPayload,
      success: DispatchAcceptedResult,
      error: SlotDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post(
      DispatchRoomOrderButtonMethods.previous.endpointName,
      DispatchRoomOrderButtonMethods.previous.path,
      {
        payload: RoomOrderPreviousButtonPayload,
        success: DispatchAcceptedResult,
        error: RoomOrderHandleButtonErrorSchemas,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      DispatchRoomOrderButtonMethods.next.endpointName,
      DispatchRoomOrderButtonMethods.next.path,
      {
        payload: RoomOrderNextButtonPayload,
        success: DispatchAcceptedResult,
        error: RoomOrderHandleButtonErrorSchemas,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      DispatchRoomOrderButtonMethods.send.endpointName,
      DispatchRoomOrderButtonMethods.send.path,
      {
        payload: RoomOrderSendButtonPayload,
        success: DispatchAcceptedResult,
        error: RoomOrderHandleButtonErrorSchemas,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      DispatchRoomOrderButtonMethods.pinTentative.endpointName,
      DispatchRoomOrderButtonMethods.pinTentative.path,
      {
        payload: RoomOrderPinTentativeButtonPayload,
        success: DispatchAcceptedResult,
        error: RoomOrderHandleButtonErrorSchemas,
      },
    ),
  )
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Dispatch")
  .annotate(OpenApi.Description, "Dispatch and Discord interaction endpoints") {}
