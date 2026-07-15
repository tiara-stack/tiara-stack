import { Effect, Option } from "effect";
import type { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import { makeArgumentError } from "typhoon-core/error";
import { buildRoomOrderContent } from "../../roomOrderContent";
import { roomOrderActionRow, tentativeRoomOrderActionRow } from "../../messageComponents";
import { tentativeRoomOrderContent } from "../../tentativeRoomOrder";
import { makeSheetApisServices } from "../clients/sheetApis";
import { requireSome } from "../pure/option";
import { fillParticipantFromName, hourWindowFor } from "../pure/rendering";

type SheetApisServices = ReturnType<typeof makeSheetApisServices>;

export const renderRoomOrderReply = Effect.fn("DispatchService.renderRoomOrderReply")(function* ({
  workspaceId,
  messageId,
  mode,
  roomOrder,
  sheetService,
  messageRoomOrderService,
}: {
  readonly workspaceId: string;
  readonly messageId: string;
  readonly mode: "normal" | "tentative";
  readonly roomOrder: MessageRoomOrder;
  readonly sheetService: SheetApisServices["sheetService"];
  readonly messageRoomOrderService: SheetApisServices["messageRoomOrderService"];
}) {
  yield* Effect.annotateCurrentSpan({ workspaceId, messageId, mode, hour: roomOrder.hour });
  const maybeRange = yield* messageRoomOrderService.getMessageRoomOrderRange(messageId);
  const range = yield* requireSome(maybeRange, () =>
    Effect.fail(makeArgumentError("Cannot render room order, no entries found")),
  );
  const [entries, eventConfig] = yield* Effect.all(
    [
      messageRoomOrderService.getMessageRoomOrderEntry(messageId, roomOrder.rank),
      sheetService.getEventConfig(workspaceId),
    ],
    { concurrency: 2 },
  );
  const { start, end } = hourWindowFor(eventConfig, roomOrder.hour);

  const content = buildRoomOrderContent(
    roomOrder.hour,
    start,
    end,
    Option.getOrNull(roomOrder.monitor),
    roomOrder.previousFills.map(fillParticipantFromName),
    roomOrder.fills.map(fillParticipantFromName),
    entries,
  );

  return mode === "tentative"
    ? {
        content: tentativeRoomOrderContent(content),
        components: [tentativeRoomOrderActionRow(range, roomOrder.rank)],
      }
    : {
        content,
        components: [roomOrderActionRow(range, roomOrder.rank)],
      };
});
