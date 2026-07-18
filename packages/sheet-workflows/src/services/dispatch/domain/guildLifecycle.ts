import { Cause, DateTime, Duration, Effect, Match, Option, Predicate, Schedule } from "effect";
import type { SheetOutboundMessage } from "sheet-ingress-api/schemas/client";
import type {
  ServiceWorkspaceFeatureFlagDispatchPayload,
  ServiceWorkspaceFeatureFlagDispatchResult,
  UpdateAnnouncementDispatchPayload,
  UpdateAnnouncementDispatchResult,
  WorkspaceWelcomeDispatchPayload,
  WorkspaceWelcomeDispatchResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import { makeArgumentError, makeUnknownError } from "typhoon-core/error";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { makeSheetApisServices } from "../clients/sheetApis";
import { type DeliveredMessage, logNonInterruptFailure } from "../clients/messageDelivery";
import { sendWorkspaceAnnouncementWithWelcomeHeuristic } from "../clients/workspace";
import { makeDeliveryNonce } from "../pure/deliveryNonce";
import { recoverNonInterruptCause } from "../pure/failure";
import { escapeInlineCode, makeEmbed, welcomeEmbed } from "sheet-message-content/rendering";

type MessagePayload = SheetOutboundMessage;
const updateAnnouncementsFeatureFlag = "update-announcements";
const updateAnnouncementPersistenceRetry = {
  schedule: Schedule.exponential(Duration.millis(100)).pipe(Schedule.jittered),
  times: 2,
} as const;

const makeSerializableUnknownError = (message: string, cause: Cause.Cause<unknown>) =>
  makeUnknownError(message, Cause.pretty(cause).trim());

const failSerializableUnknownError = (message: string, cause: Cause.Cause<unknown>) =>
  recoverNonInterruptCause(cause, () => Effect.fail(makeSerializableUnknownError(message, cause)));

type WorkspaceConfigService = ReturnType<typeof makeSheetApisServices>["workspaceConfigService"];

export const makeGuildLifecycleOperations = ({
  botClient,
  workspaceConfigService,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly workspaceConfigService: WorkspaceConfigService;
}) => {
  const announceFeatureFlag = (
    payload: ServiceWorkspaceFeatureFlagDispatchPayload,
    flagName: string,
    messagePayload: MessagePayload,
    logLabel: string,
    failureMessage: string,
  ) =>
    sendWorkspaceAnnouncementWithWelcomeHeuristic({
      botClient,
      workspaceId: payload.workspaceId,
      systemConversationId: payload.systemConversationId,
      messagePayload: {
        ...messagePayload,
        nonce: makeDeliveryNonce(payload.dispatchRequestId),
        enforceNonce: true,
      },
      logLabel,
    }).pipe(
      Effect.map(Option.some),
      logNonInterruptFailure(
        failureMessage,
        { workspaceId: payload.workspaceId, flagName },
        Effect.succeed(Option.none<DeliveredMessage>()),
        "warning",
      ),
      Effect.map((sentMessage) => ({
        workspaceId: payload.workspaceId,
        flagName,
        announcementConversationId: Option.match(sentMessage, {
          onSome: (message) => message.conversation_id,
          onNone: () => null,
        }),
        announcementMessageId: Option.match(sentMessage, {
          onSome: (message) => message.id,
          onNone: () => null,
        }),
      })),
    );

  const updateWorkspaceFeatureFlag = Effect.fn("DispatchService.updateWorkspaceFeatureFlag")(
    function* ({
      payload,
      mutation,
      title,
      description,
      color,
      logLabel,
      failureMessage,
    }: {
      readonly payload: ServiceWorkspaceFeatureFlagDispatchPayload;
      readonly mutation: (
        workspaceId: string,
        flagName: string,
      ) => Effect.Effect<{ readonly flagName: string }, unknown>;
      readonly title: string;
      readonly description: (flagName: string) => string;
      readonly color: number;
      readonly logLabel: string;
      readonly failureMessage: string;
    }) {
      const flag = yield* mutation(payload.workspaceId, payload.flagName);
      return yield* announceFeatureFlag(
        payload,
        flag.flagName,
        {
          embeds: [makeEmbed({ title, description: description(flag.flagName), color })],
        },
        logLabel,
        failureMessage,
      );
    },
  );

  return {
    workspaceWelcome: Effect.fn("DispatchService.workspaceWelcome")(function* (
      payload: WorkspaceWelcomeDispatchPayload,
    ) {
      yield* Effect.annotateCurrentSpan({
        workspaceId: payload.workspaceId,
        workspaceName: payload.workspaceName,
        systemConversationId: payload.systemConversationId,
      });

      const messagePayload = {
        nonce: makeDeliveryNonce(payload.dispatchRequestId),
        enforceNonce: true,
        embeds: [welcomeEmbed()],
      } satisfies MessagePayload;

      const sentMessage = yield* sendWorkspaceAnnouncementWithWelcomeHeuristic({
        botClient,
        workspaceId: payload.workspaceId,
        systemConversationId: payload.systemConversationId,
        messagePayload,
        logLabel: "workspace welcome message",
      });

      return {
        workspaceId: payload.workspaceId,
        conversationId: sentMessage.conversation_id,
        messageId: sentMessage.id,
      } satisfies WorkspaceWelcomeDispatchResult;
    }),
    updateAnnouncement: Effect.fn("DispatchService.updateAnnouncement")(function* (
      payload: UpdateAnnouncementDispatchPayload,
    ) {
      yield* Effect.annotateCurrentSpan({
        workspaceId: payload.workspaceId,
        workspaceName: payload.workspaceName,
        announcementId: payload.announcement.id,
        systemConversationId: payload.systemConversationId,
      });

      const featureFlags = yield* workspaceConfigService.getWorkspaceFeatureFlags(
        payload.workspaceId,
      );
      if (!featureFlags.some((flag) => flag.flagName === updateAnnouncementsFeatureFlag)) {
        return {
          workspaceId: payload.workspaceId,
          announcementId: payload.announcement.id,
          status: "skipped_not_gated",
          announcementConversationId: null,
          announcementMessageId: null,
        } satisfies UpdateAnnouncementDispatchResult;
      }

      const publishedAt = yield* Option.match(DateTime.make(payload.announcement.publishedAt), {
        onNone: () =>
          Effect.fail(
            makeArgumentError(
              `Invalid update announcement publishedAt timestamp: ${payload.announcement.publishedAt}`,
            ),
          ),
        onSome: Effect.succeed,
      });
      const claimToken = payload.dispatchRequestId;
      const claim = yield* workspaceConfigService.claimWorkspaceUpdateAnnouncementDelivery({
        workspaceId: payload.workspaceId,
        announcementId: payload.announcement.id,
        publishedAt,
        claimToken,
      });
      const skippedResult: Option.Option<UpdateAnnouncementDispatchResult> = yield* Match.value(
        claim.status,
      ).pipe(
        Match.when("claimed", () => Effect.succeed(Option.none())),
        Match.when("already_claimed", () =>
          Effect.succeed(
            Option.some({
              workspaceId: payload.workspaceId,
              announcementId: payload.announcement.id,
              status: "skipped_already_claimed",
              announcementConversationId: null,
              announcementMessageId: null,
            } satisfies UpdateAnnouncementDispatchResult),
          ),
        ),
        Match.when("already_delivered", () =>
          Option.match(claim.delivery, {
            onSome: (delivery) =>
              Effect.succeed(
                Option.some({
                  workspaceId: payload.workspaceId,
                  announcementId: payload.announcement.id,
                  status: "skipped_already_delivered",
                  announcementConversationId: delivery.conversationId,
                  announcementMessageId: delivery.messageId,
                } satisfies UpdateAnnouncementDispatchResult),
              ),
            onNone: () =>
              Effect.logWarning(
                "Update announcement claim is already delivered but has no delivery record",
              ).pipe(
                Effect.annotateLogs({
                  workspaceId: payload.workspaceId,
                  announcementId: payload.announcement.id,
                }),
                Effect.as(
                  Option.some({
                    workspaceId: payload.workspaceId,
                    announcementId: payload.announcement.id,
                    status: "skipped_already_delivered",
                    announcementConversationId: null,
                    announcementMessageId: null,
                  } satisfies UpdateAnnouncementDispatchResult),
                ),
              ),
          }),
        ),
        Match.exhaustive,
      );
      if (Option.isSome(skippedResult)) {
        return skippedResult.value;
      }

      const messagePayload = {
        nonce: makeDeliveryNonce(payload.dispatchRequestId),
        enforceNonce: true,
        embeds: [
          makeEmbed({
            title: payload.announcement.title,
            description: payload.announcement.description,
            ...(Predicate.isNumber(payload.announcement.color)
              ? { color: payload.announcement.color }
              : {}),
          }),
        ],
      } satisfies MessagePayload;

      const sentMessage = yield* sendWorkspaceAnnouncementWithWelcomeHeuristic({
        botClient,
        workspaceId: payload.workspaceId,
        systemConversationId: payload.systemConversationId,
        messagePayload,
        logLabel: "update announcement",
      }).pipe(
        Effect.catchCause((cause) =>
          recoverNonInterruptCause(cause, () =>
            workspaceConfigService
              .releaseWorkspaceUpdateAnnouncementDeliveryClaim({
                workspaceId: payload.workspaceId,
                announcementId: payload.announcement.id,
                claimToken,
              })
              .pipe(
                Effect.retry(updateAnnouncementPersistenceRetry),
                Effect.catchCause((releaseCause) =>
                  recoverNonInterruptCause(releaseCause, () =>
                    Effect.logError(
                      "Update-announcement delivery claim requires intervention",
                    ).pipe(
                      Effect.annotateLogs({
                        workspaceId: payload.workspaceId,
                        announcementId: payload.announcement.id,
                        claimToken,
                        sendCause: Cause.pretty(cause),
                        releaseCause: Cause.pretty(releaseCause),
                      }),
                      Effect.andThen(
                        Effect.fail(
                          makeUnknownError(
                            "Failed to send update announcement",
                            [
                              `send: ${Cause.pretty(cause)}`,
                              `release: ${Cause.pretty(releaseCause)}`,
                              `claim ${claimToken} preserved for recovery`,
                            ].join("; "),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                Effect.andThen(
                  failSerializableUnknownError("Failed to send update announcement", cause),
                ),
              ),
          ),
        ),
      );
      const deliveredAt = yield* DateTime.now;

      yield* workspaceConfigService
        .recordWorkspaceUpdateAnnouncementDelivery({
          workspaceId: payload.workspaceId,
          announcementId: payload.announcement.id,
          publishedAt,
          deliveredAt,
          conversationId: sentMessage.conversation_id,
          messageId: sentMessage.id,
          claimToken,
        })
        .pipe(
          Effect.retry(updateAnnouncementPersistenceRetry),
          logNonInterruptFailure(
            "Failed to record update-announcement delivery after successful send; preserving the claimed delivery",
            {
              workspaceId: payload.workspaceId,
              announcementId: payload.announcement.id,
              claimToken,
              conversationId: sentMessage.conversation_id,
              messageId: sentMessage.id,
            },
            (cause) =>
              failSerializableUnknownError(
                "Failed to record update announcement delivery after successful send",
                cause,
              ),
          ),
        );

      return {
        workspaceId: payload.workspaceId,
        announcementId: payload.announcement.id,
        status: "sent",
        announcementConversationId: sentMessage.conversation_id,
        announcementMessageId: sentMessage.id,
      } satisfies UpdateAnnouncementDispatchResult;
    }),
    serviceAddWorkspaceFeatureFlag: Effect.fn("DispatchService.serviceAddWorkspaceFeatureFlag")(
      function* (payload: ServiceWorkspaceFeatureFlagDispatchPayload) {
        yield* Effect.annotateCurrentSpan({
          workspaceId: payload.workspaceId,
          flagName: payload.flagName,
          systemConversationId: payload.systemConversationId,
        });

        return (yield* updateWorkspaceFeatureFlag({
          payload,
          mutation: workspaceConfigService.addWorkspaceFeatureFlag,
          title: "Feature flag enabled",
          description: (flagName) =>
            `This server has been enlisted for \`${escapeInlineCode(flagName)}\`.`,
          color: 0x57f287,
          logLabel: "workspace feature flag enlistment announcement",
          failureMessage: "Failed to announce workspace feature flag enlistment",
        })) satisfies ServiceWorkspaceFeatureFlagDispatchResult;
      },
    ),
    serviceRemoveWorkspaceFeatureFlag: Effect.fn(
      "DispatchService.serviceRemoveWorkspaceFeatureFlag",
    )(function* (payload: ServiceWorkspaceFeatureFlagDispatchPayload) {
      yield* Effect.annotateCurrentSpan({
        workspaceId: payload.workspaceId,
        flagName: payload.flagName,
        systemConversationId: payload.systemConversationId,
      });

      return (yield* updateWorkspaceFeatureFlag({
        payload,
        mutation: workspaceConfigService.removeWorkspaceFeatureFlag,
        title: "Feature flag disabled",
        description: (flagName) =>
          `This server has been delisted from \`${escapeInlineCode(flagName)}\`.`,
        color: 0xed4245,
        logLabel: "workspace feature flag delistment announcement",
        failureMessage: "Failed to announce workspace feature flag delistment",
      })) satisfies ServiceWorkspaceFeatureFlagDispatchResult;
    }),
  };
};
