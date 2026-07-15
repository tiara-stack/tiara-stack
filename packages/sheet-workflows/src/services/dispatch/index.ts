import { Context, Effect } from "effect";
import { config } from "@/config";
import { ClientDeliveryClient } from "../clientDeliveryClient";
import { SheetApisClient } from "../sheetApisClient";
import { makeSheetApisServices } from "./clients/sheetApis";
import { makeCheckinOperations } from "./domain/checkin";
import { makeCheckinButtonOperations } from "./domain/checkinButton";
import { makeGuildConfigOperations } from "./domain/guildConfig";
import { makeGuildLifecycleOperations } from "./domain/guildLifecycle";
import { makeKickoutOperation } from "./domain/kickout";
import { makePreferenceDmOperations } from "./domain/preferenceOperations";
import { makePreferenceDmHelpers } from "./domain/preferences";
import { makeRoomOrderHelpers } from "./domain/roomOrder";
import { makeRoomOrderButtonOperations, makeRoomOrderOperations } from "./domain/roomOrderDispatch";
import { makeSlotButtonOperations } from "./domain/slotButton";
import { makeSlotEmbedRenderer } from "./domain/slotRendering";
import { makeSlotOperations } from "./domain/slots";
import { makeStatusOperations } from "./domain/status";
import { makeTeamSubmissionOperations } from "./domain/teamSubmission";
import { makeTeamSubmissionButtonOperations } from "./domain/teamSubmissionButtons";
import { renderRoomOrderReply } from "./domain/roomOrderRendering";
import { mergeUniqueOperations } from "./pure/operationCollection";

export class DispatchService extends Context.Service<DispatchService>()("DispatchService", {
  make: Effect.gen(function* () {
    const botClient = yield* ClientDeliveryClient;
    const sheetApisClient = yield* SheetApisClient;
    const {
      checkinService,
      userConfigService,
      workspaceConfigService,
      messageCheckinService,
      messageRoomOrderService,
      messageSlotService,
      roomOrderService,
      scheduleService,
      sheetService,
      statusService,
      playerService,
      screenshotService,
    } = makeSheetApisServices(sheetApisClient);
    const autoCheckinConcurrency = yield* config.autoCheckinConcurrency;

    const {
      disabledPreferenceDmResult,
      dmKindEnabled,
      dmKindLabel,
      preferenceDmResultFromConfig,
      respondPreferenceDm,
    } = makePreferenceDmHelpers(botClient);

    const {
      handleRoomOrderPinTentativeButton,
      handleRoomOrderRankButton,
      handleRoomOrderSendButton,
    } = makeRoomOrderHelpers({
      botClient,
      messageRoomOrderService,
      renderRoomOrderReply,
      sheetService,
      workspaceConfigService,
    });

    const makeSlotEmbeds = makeSlotEmbedRenderer({ scheduleService, sheetService });
    const checkinOperations = makeCheckinOperations({
      autoCheckinConcurrency,
      botClient,
      checkinService,
      messageCheckinService,
      messageRoomOrderService,
      roomOrderService,
      userConfigService,
      workspaceConfigService,
    });
    const roomOrderOperations = makeRoomOrderOperations({
      botClient,
      messageRoomOrderService,
      roomOrderService,
    });
    const slotOperations = makeSlotOperations({
      botClient,
      makeSlotEmbeds,
      messageSlotService,
    });
    const guildConfigOperations = makeGuildConfigOperations({ botClient, workspaceConfigService });
    const kickoutOperations = {
      kickout: makeKickoutOperation({
        botClient,
        scheduleService,
        sheetService,
        workspaceConfigService,
      }),
    };
    const teamSubmissionOperations = makeTeamSubmissionOperations({
      botClient,
      playerService,
      sheetApisClient,
      workspaceConfigService,
    });
    const statusOperations = makeStatusOperations({
      botClient,
      scheduleService,
      screenshotService,
      statusService,
    });
    const preferenceDmOperations = makePreferenceDmOperations({
      helpers: {
        disabledPreferenceDmResult,
        dmKindEnabled,
        dmKindLabel,
        preferenceDmResultFromConfig,
        respondPreferenceDm,
      },
      userConfigService,
    });
    const guildLifecycleOperations = makeGuildLifecycleOperations({
      botClient,
      workspaceConfigService,
    });
    const slotButtonOperations = makeSlotButtonOperations({ botClient, makeSlotEmbeds });
    const checkinButtonOperations = makeCheckinButtonOperations({
      botClient,
      messageCheckinService,
    });
    const roomOrderButtonOperations = makeRoomOrderButtonOperations({
      handleRoomOrderPinTentativeButton,
      handleRoomOrderRankButton,
      handleRoomOrderSendButton,
    });
    const teamSubmissionButtonOperations = makeTeamSubmissionButtonOperations({
      botClient,
      sheetApisClient,
    });

    return mergeUniqueOperations([
      checkinOperations,
      roomOrderOperations,
      slotOperations,
      guildConfigOperations,
      kickoutOperations,
      teamSubmissionOperations,
      statusOperations,
      preferenceDmOperations,
      guildLifecycleOperations,
      slotButtonOperations,
      checkinButtonOperations,
      roomOrderButtonOperations,
      teamSubmissionButtonOperations,
    ] as const);
  }),
}) {}
