import { DateTime, Effect, Option, Predicate } from "effect";
import {
  MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE,
  type CheckinDispatchPayload,
  type RoomOrderDispatchPayload,
} from "sheet-ingress-api/sheet-apis-rpc";
import { ClientDeliveryClientRef } from "../../clientDeliveryClient";
import { SheetApisClient } from "../../sheetApisClient";

type MessageKey = {
  readonly clientPlatform: string;
  readonly clientId: string;
  readonly messageId: string;
};

type RoomOrderGeneratePayload =
  | RoomOrderDispatchPayload
  | { readonly workspaceId: string; readonly conversationId: string; readonly hour: number };

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

const isArgumentErrorWithMessage = (expectedMessage: string) => (error: unknown) =>
  Predicate.isTagged("ArgumentError")(error) &&
  Predicate.hasProperty(error, "message") &&
  Predicate.isString(error.message) &&
  error.message === expectedMessage;

const optionalArgumentError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  isNotFound: (error: E) => boolean,
) =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchIf(isNotFound, () => Effect.succeed(Option.none<A>())),
  );

const omitUndefined = <T extends Readonly<Record<string, unknown>>>(values: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(values).filter(([, value]) => Predicate.isNotUndefined(value)),
  ) as Partial<T>;

/** @internal */
export const makeSheetApisServices = (sheetApisClient: typeof SheetApisClient.Service) => {
  const sheetApis = sheetApisClient.get();

  const withMessagePayload = <Extra extends Readonly<Record<string, unknown>>, A, E, R>(
    messageId: string,
    extra: Extra,
    operation: (request: { readonly payload: MessageKey & Extra }) => Effect.Effect<A, E, R>,
  ) => withMessageKey(messageId, (key) => operation({ payload: { ...key, ...extra } }));

  const makeClaimMethod =
    <A, E, R>(
      operation: (request: {
        readonly payload: MessageKey & { readonly claimId: string };
      }) => Effect.Effect<A, E, R>,
    ) =>
    (messageId: string, claimId: string) =>
      withMessagePayload(messageId, { claimId }, operation);

  const messageRoomOrderService = {
    getMessageRoomOrder: (messageId: string) =>
      withMessageKey(messageId, (key) =>
        optionalArgumentError(
          sheetApis.messageRoomOrder.getMessageRoomOrder({ query: key }),
          isArgumentErrorWithMessage(MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE),
        ),
      ),
    upsertMessageRoomOrder: (
      messageId: string,
      data: Parameters<
        typeof sheetApis.messageRoomOrder.upsertMessageRoomOrder
      >[0]["payload"]["data"],
    ) => withMessagePayload(messageId, { data }, sheetApis.messageRoomOrder.upsertMessageRoomOrder),
    persistMessageRoomOrder: (
      messageId: string,
      payload: Omit<
        Parameters<typeof sheetApis.messageRoomOrder.persistMessageRoomOrder>[0]["payload"],
        keyof MessageKey
      >,
    ) => withMessagePayload(messageId, payload, sheetApis.messageRoomOrder.persistMessageRoomOrder),
    decrementMessageRoomOrderRank: (
      messageId: string,
      payload: Omit<
        Parameters<typeof sheetApis.messageRoomOrder.decrementMessageRoomOrderRank>[0]["payload"],
        keyof MessageKey
      >,
    ) =>
      withMessagePayload(
        messageId,
        payload,
        sheetApis.messageRoomOrder.decrementMessageRoomOrderRank,
      ),
    incrementMessageRoomOrderRank: (
      messageId: string,
      payload: Omit<
        Parameters<typeof sheetApis.messageRoomOrder.incrementMessageRoomOrderRank>[0]["payload"],
        keyof MessageKey
      >,
    ) =>
      withMessagePayload(
        messageId,
        payload,
        sheetApis.messageRoomOrder.incrementMessageRoomOrderRank,
      ),
    getMessageRoomOrderEntry: (messageId: string, rank: number) =>
      withMessageKey(messageId, (key) =>
        sheetApis.messageRoomOrder.getMessageRoomOrderEntry({
          query: { ...key, rank },
        }),
      ),
    getMessageRoomOrderRange: (messageId: string) =>
      withMessageKey(messageId, (key) =>
        optionalArgumentError(
          sheetApis.messageRoomOrder.getMessageRoomOrderRange({ query: key }),
          isArgumentErrorWithMessage(
            "Cannot get message room order range, the message might not be registered",
          ),
        ),
      ),
    removeMessageRoomOrderEntry: (messageId: string) =>
      withMessagePayload(messageId, {}, sheetApis.messageRoomOrder.removeMessageRoomOrderEntry),
    claimMessageRoomOrderSend: makeClaimMethod(
      sheetApis.messageRoomOrder.claimMessageRoomOrderSend,
    ),
    completeMessageRoomOrderSend: (
      messageId: string,
      claimId: string,
      sentMessage: { readonly id: string; readonly conversationId: string },
    ) =>
      withMessagePayload(
        messageId,
        { claimId, sentMessage },
        sheetApis.messageRoomOrder.completeMessageRoomOrderSend,
      ),
    releaseMessageRoomOrderSendClaim: makeClaimMethod(
      sheetApis.messageRoomOrder.releaseMessageRoomOrderSendClaim,
    ),
    claimMessageRoomOrderTentativeUpdate: makeClaimMethod(
      sheetApis.messageRoomOrder.claimMessageRoomOrderTentativeUpdate,
    ),
    releaseMessageRoomOrderTentativeUpdateClaim: makeClaimMethod(
      sheetApis.messageRoomOrder.releaseMessageRoomOrderTentativeUpdateClaim,
    ),
    claimMessageRoomOrderTentativePin: makeClaimMethod(
      sheetApis.messageRoomOrder.claimMessageRoomOrderTentativePin,
    ),
    completeMessageRoomOrderTentativePin: (messageId: string, claimId: string) =>
      withMessagePayload(
        messageId,
        { claimId },
        sheetApis.messageRoomOrder.completeMessageRoomOrderTentativePin,
      ),
    releaseMessageRoomOrderTentativePinClaim: makeClaimMethod(
      sheetApis.messageRoomOrder.releaseMessageRoomOrderTentativePinClaim,
    ),
    markMessageRoomOrderTentative: (messageId: string) =>
      withMessagePayload(messageId, {}, sheetApis.messageRoomOrder.markMessageRoomOrderTentative),
  };

  return {
    checkinService: {
      generate: (payload: CheckinDispatchPayload) =>
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
    userConfigService: {
      getUserPlatformConfig: (platform: string, userId: string) =>
        sheetApis.userConfig.getUserPlatformConfig({
          payload: { platform, userId },
        }),
      upsertUserPlatformConfig: (
        platform: string,
        userId: string,
        config: {
          readonly checkinDmEnabled?: boolean | undefined;
          readonly monitorDmEnabled?: boolean | undefined;
          readonly defaultClientId?: string | null | undefined;
        },
      ) =>
        sheetApis.userConfig.upsertUserPlatformConfig({
          payload: { platform, userId, ...config },
        }),
      getCheckinDmRecipients: (platform: string, userIds: ReadonlyArray<string>) =>
        sheetApis.userConfig.getCheckinDmRecipients({
          payload: { platform, userIds: [...userIds] },
        }),
      getMonitorDmRecipients: (platform: string, userIds: ReadonlyArray<string>) =>
        sheetApis.userConfig.getMonitorDmRecipients({
          payload: { platform, userIds: [...userIds] },
        }),
    },
    workspaceConfigService: {
      getWorkspaceConfig: (workspaceId: string) =>
        optionalArgumentError(
          sheetApis.workspaceConfig.getWorkspaceConfig({ query: { workspaceId } }),
          isArgumentErrorWithMessage(
            "Cannot get workspace config, the workspace might not be registered",
          ),
        ),
      upsertWorkspaceConfig: (
        workspaceId: string,
        config: {
          readonly sheetId?: string | null | undefined;
          readonly autoCheckin?: boolean | null | undefined;
        },
      ) => sheetApis.workspaceConfig.upsertWorkspaceConfig({ payload: { workspaceId, config } }),
      getWorkspaceMonitorRoles: (workspaceId: string) =>
        sheetApis.workspaceConfig.getWorkspaceMonitorRoles({ query: { workspaceId } }),
      getWorkspaceFeatureFlags: (workspaceId: string) =>
        sheetApis.workspaceConfig.getWorkspaceFeatureFlags({ query: { workspaceId } }),
      claimWorkspaceUpdateAnnouncementDelivery: (claim: {
        readonly workspaceId: string;
        readonly announcementId: string;
        readonly publishedAt: DateTime.Utc;
        readonly claimToken: string;
      }) => sheetApis.workspaceConfig.claimWorkspaceUpdateAnnouncementDelivery({ payload: claim }),
      releaseWorkspaceUpdateAnnouncementDeliveryClaim: (claim: {
        readonly workspaceId: string;
        readonly announcementId: string;
        readonly claimToken: string;
      }) =>
        sheetApis.workspaceConfig.releaseWorkspaceUpdateAnnouncementDeliveryClaim({
          payload: claim,
        }),
      addWorkspaceMonitorRole: (workspaceId: string, roleId: string) =>
        sheetApis.workspaceConfig.addWorkspaceMonitorRole({ payload: { workspaceId, roleId } }),
      removeWorkspaceMonitorRole: (workspaceId: string, roleId: string) =>
        sheetApis.workspaceConfig.removeWorkspaceMonitorRole({ payload: { workspaceId, roleId } }),
      addWorkspaceFeatureFlag: (workspaceId: string, flagName: string) =>
        sheetApis.workspaceConfig.addWorkspaceFeatureFlag({ payload: { workspaceId, flagName } }),
      removeWorkspaceFeatureFlag: (workspaceId: string, flagName: string) =>
        sheetApis.workspaceConfig.removeWorkspaceFeatureFlag({
          payload: { workspaceId, flagName },
        }),
      recordWorkspaceUpdateAnnouncementDelivery: (delivery: {
        readonly workspaceId: string;
        readonly announcementId: string;
        readonly publishedAt: DateTime.Utc;
        readonly deliveredAt: DateTime.Utc;
        readonly conversationId: string;
        readonly messageId: string;
        readonly claimToken: string;
      }) =>
        sheetApis.workspaceConfig.recordWorkspaceUpdateAnnouncementDelivery({ payload: delivery }),
      upsertWorkspaceConversationConfig: (
        workspaceId: string,
        conversationId: string,
        config: {
          readonly name?: string | null | undefined;
          readonly running?: boolean | null | undefined;
          readonly roleId?: string | null | undefined;
          readonly checkinConversationId?: string | null | undefined;
        },
      ) =>
        sheetApis.workspaceConfig.upsertWorkspaceConversationConfig({
          payload: { workspaceId, conversationId, config },
        }),
      getWorkspaceConversationById: (query: {
        readonly workspaceId: string;
        readonly conversationId: string;
        readonly running?: boolean | undefined;
      }) =>
        optionalArgumentError(
          sheetApis.workspaceConfig.getWorkspaceConversationById({ query }),
          isArgumentErrorWithMessage(
            Predicate.isUndefined(query.running)
              ? "Cannot get conversation by id, the workspace or the conversation id might not be registered"
              : "Cannot get conversation by id, the workspace or the conversation id might not be registered or does not match the specified running status",
          ),
        ),
      getWorkspaceConversationByName: (query: {
        readonly workspaceId: string;
        readonly conversationName: string;
        readonly running?: boolean | undefined;
      }) =>
        optionalArgumentError(
          sheetApis.workspaceConfig.getWorkspaceConversationByName({ query }),
          isArgumentErrorWithMessage(
            Predicate.isUndefined(query.running)
              ? "Cannot get conversation by name, the workspace or the conversation name might not be registered"
              : "Cannot get conversation by name, the workspace or the conversation name might not be registered or does not match the specified running status",
          ),
        ),
      getWorkspaceConversations: (workspaceId: string, running: boolean) =>
        sheetApis.workspaceConfig.getWorkspaceConversations({ query: { workspaceId, running } }),
    },
    messageCheckinService: {
      getMessageCheckinData: (messageId: string) =>
        withMessageKey(messageId, (key) =>
          optionalArgumentError(
            sheetApis.messageCheckin.getMessageCheckinData({ query: key }),
            isArgumentErrorWithMessage(
              "Cannot get message checkin data, the message might not be registered",
            ),
          ),
        ),
      getMessageCheckinMembers: (messageId: string) =>
        withMessageKey(messageId, (key) =>
          sheetApis.messageCheckin.getMessageCheckinMembers({ query: key }),
        ),
      persistMessageCheckin: (
        messageId: string,
        payload: Omit<
          Parameters<typeof sheetApis.messageCheckin.persistMessageCheckin>[0]["payload"],
          keyof MessageKey
        >,
      ) =>
        withMessageKey(messageId, (key) =>
          sheetApis.messageCheckin.persistMessageCheckin({
            payload: { ...key, ...payload },
          }),
        ),
      removeMessageCheckin: (messageId: string) =>
        withMessagePayload(messageId, {}, sheetApis.messageCheckin.removeMessageCheckin),
      setMessageCheckinMemberCheckinAtIfUnset: (
        messageId: string,
        memberId: string,
        checkinAt: number,
        checkinClaimId: string,
      ) =>
        withMessageKey(messageId, (key) =>
          sheetApis.messageCheckin.setMessageCheckinMemberCheckinAtIfUnset({
            payload: { ...key, memberId, checkinAt, checkinClaimId },
          }),
        ),
    },
    messageRoomOrderService,
    messageSlotService: {
      getMessageSlotData: (messageId: string) =>
        withMessageKey(messageId, (key) =>
          optionalArgumentError(
            sheetApis.messageSlot.getMessageSlotData({ query: key }),
            isArgumentErrorWithMessage(
              "Cannot get message slot data, the message might not be registered",
            ),
          ),
        ),
      upsertMessageSlotData: (
        messageId: string,
        data: Parameters<typeof sheetApis.messageSlot.upsertMessageSlotData>[0]["payload"]["data"],
      ) =>
        withMessageKey(messageId, (key) =>
          sheetApis.messageSlot.upsertMessageSlotData({
            payload: { ...key, data },
          }),
        ),
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
