import { schema } from "effect-zero";
import {
  configGuild,
  configGuildChannel,
  configGuildFeatureFlag,
  configGuildManagerRole,
  messageCheckin,
  messageCheckinMember,
  messageRoomOrder,
  messageRoomOrderEntry,
  messageSlot,
  sheetApisDispatchJobs,
} from "./src/schema.internal";

export default schema(
  {
    configGuild,
    configGuildChannel,
    configGuildFeatureFlag,
    configGuildManagerRole,
    messageCheckin,
    messageCheckinMember,
    messageRoomOrder,
    messageRoomOrderEntry,
    messageSlot,
    sheetApisDispatchJobs,
  },
  {
    prefix: "sheet_db",
  },
);
