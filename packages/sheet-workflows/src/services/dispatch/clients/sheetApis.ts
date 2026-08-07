import { Effect, Predicate } from "effect";
import type {
  CheckinDispatchPayload,
  RoomOrderDispatchPayload,
} from "sheet-ingress-api/sheet-apis-rpc";
import type { TrustedSheetPersistenceShape } from "sheet-zero-server/persistence";
import { ClientDeliveryClientRef, type ClientDeliveryClient } from "../../clientDeliveryClient";
import { SheetApisClient } from "../../sheetApisClient";
import { makeTrustedPersistenceServices, type MessageKey } from "./trustedPersistence";

type RoomOrderGeneratePayload =
  | RoomOrderDispatchPayload
  | { readonly workspaceId: string; readonly conversationId: string; readonly hour: number };

type CheckinGeneratePayload =
  | CheckinDispatchPayload
  | (Pick<CheckinDispatchPayload, "workspaceId"> &
      Partial<
        Pick<CheckinDispatchPayload, "conversationId" | "conversationName" | "hour" | "template">
      >);

const isRoomOrderDispatchPayload = (
  payload: RoomOrderGeneratePayload,
): payload is RoomOrderDispatchPayload => Predicate.hasProperty(payload, "dispatchRequestId");

const messageKeyFor = (messageId: string): Effect.Effect<MessageKey, never, never> =>
  Effect.map(ClientDeliveryClientRef, (client) => ({
    clientPlatform: client.platform,
    clientId: client.clientId,
    messageId,
  }));

const withMessageKey = <A, E, R>(
  messageId: string,
  operation: (key: MessageKey) => Effect.Effect<A, E, R>,
) => Effect.flatMap(messageKeyFor(messageId), operation);

const omitUndefined = <T extends Readonly<Record<string, unknown>>>(values: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(values).filter(([, value]) => Predicate.isNotUndefined(value)),
  ) as Partial<T>;

/** @internal */
export const makeSheetApisServices = (
  sheetApisClient: typeof SheetApisClient.Service,
  trustedPersistence: TrustedSheetPersistenceShape,
  botClient: typeof ClientDeliveryClient.Service,
) => {
  const sheetApis = sheetApisClient.get();
  const persistenceServices = makeTrustedPersistenceServices(
    trustedPersistence,
    botClient,
    withMessageKey,
  );

  return {
    ...persistenceServices,
    checkinService: {
      generate: (payload: CheckinGeneratePayload) =>
        sheetApis.checkin.generate({
          payload: {
            workspaceId: payload.workspaceId,
            ...omitUndefined({
              conversationId: payload.conversationId,
              conversationName: payload.conversationName,
              hour: payload.hour,
              template: payload.template,
            }),
          },
        }),
    },
    roomOrderService: {
      generate: (payload: RoomOrderGeneratePayload) =>
        sheetApis.roomOrder.generate({
          payload: isRoomOrderDispatchPayload(payload)
            ? {
                workspaceId: payload.workspaceId,
                ...omitUndefined({
                  conversationId: payload.conversationId,
                  conversationName: payload.conversationName,
                  hour: payload.hour,
                  healNeeded: payload.healNeeded,
                }),
              }
            : payload,
        }),
    },
    scheduleService: {
      dayPopulatedFillerSchedules: (workspaceId: string, day: number) =>
        sheetApis.schedule
          .getDayPopulatedSchedules({ query: { workspaceId, day, view: "filler" } })
          .pipe(Effect.map(({ schedules }) => schedules)),
      dayPlayerSchedule: (workspaceId: string, day: number, accountId: string) =>
        sheetApis.schedule.getDayPlayerSchedule({
          query: { workspaceId, day, accountId, view: "filler" },
        }),
      conversationPopulatedMonitorSchedules: (workspaceId: string, conversation: string) =>
        sheetApis.schedule
          .getConversationPopulatedSchedules({
            query: { workspaceId, conversationName: conversation, view: "monitor" },
          })
          .pipe(Effect.map(({ schedules }) => schedules)),
    },
    sheetService: {
      getEventConfig: (workspaceId: string) =>
        sheetApis.sheet.getEventConfig({ query: { workspaceId } }),
    },
    statusService: {
      getServicesStatus: () => sheetApis.status.getServices({}),
    },
    playerService: {
      getTeamsByIds: (workspaceId: string, ids: readonly string[]) =>
        sheetApis.player.getTeamsByIds({ query: { workspaceId, ids } }),
    },
    screenshotService: {
      getScreenshot: (workspaceId: string, conversation: string, day: number) =>
        sheetApis.screenshot.getScreenshot({
          query: { workspaceId, conversationName: conversation, day },
        }),
    },
  };
};
