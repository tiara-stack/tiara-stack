import { Effect } from "effect";
import type {
  ScheduleListDispatchPayload,
  ScheduleListDispatchResult,
  ScreenshotDispatchPayload,
  ScreenshotDispatchResult,
  ServiceStatusDispatchPayload,
  ServiceStatusDispatchResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import * as MessageText from "sheet-message-content/text";
import { logNonInterruptFailure } from "../clients/messageDelivery";
import { makeSheetApisServices } from "../clients/sheetApis";
import {
  escapeMarkdown,
  formatHourRanges,
  formatServiceStatusFieldValue,
  makeEmbed,
  makeWebScheduleEmbed,
} from "sheet-message-content/rendering";

type SheetApisServices = ReturnType<typeof makeSheetApisServices>;

export const makeStatusOperations = ({
  botClient,
  scheduleService,
  screenshotService,
  statusService,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly scheduleService: SheetApisServices["scheduleService"];
  readonly screenshotService: SheetApisServices["screenshotService"];
  readonly statusService: SheetApisServices["statusService"];
}) => ({
  scheduleList: Effect.fn("DispatchService.scheduleList")(function* (
    payload: ScheduleListDispatchPayload,
  ) {
    const { schedule } = yield* scheduleService.dayPlayerSchedule(
      payload.workspaceId,
      payload.day,
      payload.targetUserId,
    );
    yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
      embeds: [
        makeEmbed({
          title: `${escapeMarkdown(payload.targetUsername)}'s Schedule for Day ${payload.day}`,
          description: schedule.invisible
            ? "It is kinda foggy around here... This schedule is not visible to you yet."
            : null,
          fields: schedule.invisible
            ? []
            : [
                { name: "Fill", value: formatHourRanges(schedule.fillHours) },
                { name: "Overfill", value: formatHourRanges(schedule.overfillHours) },
                { name: "Standby", value: formatHourRanges(schedule.standbyHours) },
              ],
        }),
        makeWebScheduleEmbed(),
      ],
    });

    return {
      workspaceId: payload.workspaceId,
      day: payload.day,
      targetUserId: payload.targetUserId,
      invisible: schedule.invisible,
    } satisfies ScheduleListDispatchResult;
  }),
  screenshot: Effect.fn("DispatchService.screenshot")(function* (
    payload: ScreenshotDispatchPayload,
  ) {
    const screenshot = yield* screenshotService.getScreenshot(
      payload.workspaceId,
      payload.conversationName,
      payload.day,
    );
    yield* botClient.updateOriginalInteractionResponseWithFiles(
      payload.interactionResponseToken,
      {},
      [
        {
          name: "screenshot.png",
          contentType: "image/png",
          content: screenshot,
        },
      ],
    );

    return {
      workspaceId: payload.workspaceId,
      conversationName: payload.conversationName,
      day: payload.day,
      byteLength: screenshot.byteLength,
    } satisfies ScreenshotDispatchResult;
  }),
  serviceStatus: Effect.fn("DispatchService.serviceStatus")(function* (
    payload: ServiceStatusDispatchPayload,
  ) {
    yield* Effect.annotateCurrentSpan({ operation: "serviceStatus" });
    const status = yield* statusService.getServicesStatus().pipe(
      Effect.catch((error) =>
        botClient
          .updateOriginalInteractionResponse(payload.interactionResponseToken, {
            content: "Failed to check service status. Please try again.",
            allowedMentions: "none",
          })
          .pipe(
            logNonInterruptFailure(
              "Failed to send service-status lookup failure response",
              {},
              Effect.fail(error),
            ),
            Effect.andThen(Effect.fail(markInteractionFailureHandled(error))),
          ),
      ),
    );
    const okCount = status.services.filter((service) => service.status === "ok").length;
    const downCount = status.services.length - okCount;

    yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
      embeds: [
        makeEmbed({
          title: "Service Status",
          description: MessageText.parts(
            MessageText.text(
              status.overallStatus === "ok"
                ? "All services are ready."
                : "Some services are not ready.",
            ),
            MessageText.text("\nChecked at "),
            MessageText.timestamp(status.checkedAt.epochMilliseconds),
          ),
          color: status.overallStatus === "ok" ? 0x57f287 : 0xfee75c,
          fields: status.services.map((service) => ({
            name: service.name,
            value: formatServiceStatusFieldValue(service),
            inline: true,
          })),
        }),
      ],
    });

    return {
      overallStatus: status.overallStatus,
      okCount,
      downCount,
    } satisfies ServiceStatusDispatchResult;
  }),
});
