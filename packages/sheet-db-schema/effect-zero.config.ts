import { schema } from "effect-zero";
import {
  configGuild,
  configGuildChannel,
  configGuildManagerRole,
  messageCheckin,
  messageCheckinMember,
  messageRoomOrder,
  messageRoomOrderEntry,
  messageSlot,
  sheetApisDispatchJobs,
} from "./src/schema.internal";

export default schema({
  configGuild,
  configGuildChannel,
  configGuildManagerRole,
  messageCheckin,
  messageCheckinMember,
  messageRoomOrder,
  messageRoomOrderEntry,
  messageSlot,
  sheetApisDispatchJobs,
});
