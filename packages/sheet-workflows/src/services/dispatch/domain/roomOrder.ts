import { mergeUniqueOperations } from "../pure/operationCollection";
import { makeRoomOrderCommon, type RoomOrderHelperDependencies } from "./roomOrderCommon";
import { makeRoomOrderNavigation } from "./roomOrderNavigation";
import { makeRoomOrderSend } from "./roomOrderSend";
import { makeRoomOrderTentative } from "./roomOrderTentative";

export const makeRoomOrderHelpers = ({
  botClient,
  messageRoomOrderService,
  renderRoomOrderReply,
  sheetService,
  workspaceConfigService,
}: RoomOrderHelperDependencies) => {
  const common = makeRoomOrderCommon({
    botClient,
    messageRoomOrderService,
    renderRoomOrderReply,
    sheetService,
    workspaceConfigService,
  });

  return mergeUniqueOperations([
    makeRoomOrderNavigation({ botClient, common, messageRoomOrderService }),
    makeRoomOrderSend({ botClient, common, messageRoomOrderService }),
    makeRoomOrderTentative({ botClient, common, messageRoomOrderService }),
  ]);
};
