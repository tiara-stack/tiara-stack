import { Cause, Clock, Effect, Layer, Option, Predicate, Schema } from "effect";
import {
  BotOutboundMessage,
  conversationRefFrom,
  messageRefFrom,
  workspaceRefFrom,
} from "sheet-bot-api";
import {
  checkinAnnouncementMessage,
  checkinButtonAcknowledgementMessage,
} from "sheet-message-content/checkinAnnouncement";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveAuthorizationRevoked,
  interactiveDeliveryRejected,
  mapDeliveryFailure,
} from "../shared/interactive";
import {
  isCanonicalCheckinParticipant,
  type AuthorizedCheckinRespondContext,
} from "../readOnly/authorization";
import { CheckinWorkflowOperations, CheckinWorkflowOperationsError } from "./service";

const operationError = (operation: string, cause: unknown) =>
  new CheckinWorkflowOperationsError({ operation, cause });

const messageKey = (context: AuthorizedCheckinRespondContext) => ({
  clientPlatform: context.clientPlatform,
  clientId: context.clientId,
  messageId: context.messageId,
});

const postCommitDeliveryFailure = (
  policy: string,
  operation: string,
  resource: string,
  rejectedMessage: string,
  committedReference: string,
) => {
  const mapFailure = mapDeliveryFailure(
    policy,
    operation,
    resource,
    true,
    rejectedMessage,
    operationError,
    committedReference,
  );
  return (error: unknown) => {
    const mapped = mapFailure(error);
    return Predicate.isTagged("ResourceNotFound")(mapped)
      ? interactiveDeliveryRejected(operation, rejectedMessage, true, committedReference)
      : mapped;
  };
};

export const checkinWorkflowOperationsLayer = Layer.effect(
  CheckinWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const delivery = yield* SheetBotDeliveryClient;

    const loadParticipant = (
      context: AuthorizedCheckinRespondContext,
      policy: string,
      operation: string,
    ) =>
      persistence.checkinState.getMessageCheckinMembers(messageKey(context)).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) => operationError(operation, cause)),
        Effect.flatMap((members) => {
          const member = members.find((candidate) => candidate.memberId === context.memberId);
          return Predicate.isNotUndefined(member) && isCanonicalCheckinParticipant(context, member)
            ? Effect.succeed(member)
            : Effect.fail(interactiveAuthorizationRevoked(policy));
        }),
      );

    const committedFrom = (
      context: AuthorizedCheckinRespondContext,
      claimId: string,
      member: {
        readonly checkinAt: number | null;
        readonly checkinClaimId: string | null;
      },
    ) =>
      Predicate.isNotNull(member.checkinAt) && Predicate.isNotNull(member.checkinClaimId)
        ? Effect.succeed({
            context,
            checkinAt: member.checkinAt,
            checkinClaimId: member.checkinClaimId,
            isFirst: member.checkinClaimId === claimId,
          })
        : Effect.fail(
            operationError(
              "checkins.respond.commitCheckin.reconcile",
              "The canonical participant row has no committed check-in",
            ),
          );

    const commitCheckin: typeof CheckinWorkflowOperations.Service.commitCheckin = (
      context,
      claimId,
      policy,
    ) =>
      Effect.gen(function* () {
        const checkinAt = yield* Clock.currentTimeMillis;
        const mutation = persistence.checkinState
          .setMessageCheckinMemberCheckinAtIfUnset({
            ...messageKey(context),
            memberId: context.memberId,
            checkinAt,
            checkinClaimId: claimId,
          })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) => operationError("checkins.respond.commitCheckin", cause)),
          );
        const reconciled = yield* mutation.pipe(
          Effect.as(Option.none()),
          Effect.catchCause((mutationCause) =>
            Cause.hasInterrupts(mutationCause)
              ? Effect.failCause(mutationCause)
              : Effect.uninterruptible(
                  loadParticipant(context, policy, "checkins.respond.commitCheckin.reconcile").pipe(
                    Effect.flatMap((member) =>
                      Predicate.isNotNull(member.checkinAt) &&
                      Predicate.isNotNull(member.checkinClaimId)
                        ? Effect.succeed(Option.some(member))
                        : Effect.failCause(mutationCause),
                    ),
                    Effect.catchCause((reconciliationCause) =>
                      Effect.failCause(Cause.combine(mutationCause, reconciliationCause)),
                    ),
                  ),
                ),
          ),
        );
        const member = yield* Option.match(reconciled, {
          onNone: () =>
            loadParticipant(context, policy, "checkins.respond.commitCheckin.loadResult"),
          onSome: Effect.succeed,
        });
        return yield* committedFrom(context, claimId, member);
      });

    const deliver = <A>(
      effect: Effect.Effect<A, unknown>,
      context: AuthorizedCheckinRespondContext,
      policy: string,
      operation: string,
      resource: string,
      rejectedMessage: string,
    ) =>
      effect.pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError(
          postCommitDeliveryFailure(
            policy,
            operation,
            resource,
            rejectedMessage,
            context.messageId,
          ),
        ),
      );

    const respond: typeof CheckinWorkflowOperations.Service.respond = (
      context,
      responseReference,
      isFirst,
      deliveryKey,
      policy,
    ) =>
      deliver(
        delivery.get().delivery.respond({
          payload: {
            responseReference,
            deliveryKey,
            message: checkinButtonAcknowledgementMessage(isFirst),
          },
        }),
        context,
        policy,
        "checkins.respond.respond",
        "response",
        "The check-in response was rejected",
      );

    const setMemberRole: typeof CheckinWorkflowOperations.Service.setMemberRole = (
      context,
      roleId,
      deliveryKey,
      policy,
    ) =>
      deliver(
        delivery.get().delivery.setMemberRole({
          payload: {
            workspace: workspaceRefFrom(
              { platform: context.clientPlatform, clientId: context.clientId },
              context.workspaceId,
            ),
            userId: context.memberId,
            roleId,
            present: true,
            deliveryKey,
          },
        }),
        context,
        policy,
        "checkins.respond.setMemberRole",
        "member role",
        "The check-in role repair was rejected",
      );

    const loadCurrentView: typeof CheckinWorkflowOperations.Service.loadCurrentView = (
      context,
      policy,
    ) =>
      persistence.checkinState.getMessageCheckinMembers(messageKey(context)).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) =>
          operationError("checkins.respond.loadCurrentCheckinView", cause),
        ),
        Effect.flatMap((members) =>
          members.some(
            (member) =>
              member.memberId === context.memberId &&
              isCanonicalCheckinParticipant(context, member),
          )
            ? Effect.succeed({
                context,
                members: members.map(({ memberId, checkinAt }) => ({ memberId, checkinAt })),
              })
            : Effect.fail(interactiveAuthorizationRevoked(policy)),
        ),
      );

    const editCheckinMessage: typeof CheckinWorkflowOperations.Service.editCheckinMessage = (
      view,
      content,
      deliveryKey,
      policy,
    ) => {
      const context = view.context;
      return deliver(
        delivery.get().delivery.editMessage({
          payload: {
            message: messageRefFrom(
              { platform: context.clientPlatform, clientId: context.clientId },
              context.workspaceId,
              context.conversationId,
              context.messageId,
            ),
            deliveryKey,
            content,
          },
        }),
        context,
        policy,
        "checkins.respond.editCheckinMessage",
        "check-in message",
        "The check-in message update was rejected",
      );
    };

    const announceFirstCheckin: typeof CheckinWorkflowOperations.Service.announceFirstCheckin = (
      context,
      deliveryKey,
      policy,
    ) =>
      deliver(
        Schema.decodeUnknownEffect(BotOutboundMessage)(
          checkinAnnouncementMessage(context.memberId),
        ).pipe(
          Effect.flatMap((message) =>
            delivery.get().delivery.sendMessage({
              payload: {
                conversation: conversationRefFrom(
                  { platform: context.clientPlatform, clientId: context.clientId },
                  context.workspaceId,
                  context.runningConversationId,
                ),
                deliveryKey,
                message,
              },
            }),
          ),
        ),
        context,
        policy,
        "checkins.respond.announceFirstCheckin",
        "running conversation",
        "The first check-in announcement was rejected",
      );

    return {
      commitCheckin,
      respond,
      setMemberRole,
      loadCurrentView,
      editCheckinMessage,
      announceFirstCheckin,
    };
  }),
);
