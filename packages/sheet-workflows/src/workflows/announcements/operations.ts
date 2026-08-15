import { Cause, Clock, Effect, Layer, Match, Option, Predicate, Schema } from "effect";
import type { ConversationRef } from "sheet-bot-api";
import { conversationRefFrom, messageRefFrom } from "sheet-bot-api";
import type { AutonomousDeclaredFailure } from "sheet-workflow-contracts";
import { AnnouncementsDeliverUpdate } from "sheet-workflow-contracts";
import type { AnnouncementsDeliverUpdateInput } from "sheet-workflow-contracts/values";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { config } from "@/config";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveAuthorizationRevoked,
  interactiveDeliveryRejected,
  interactiveInvalidRequest,
  interactiveResourceNotFound,
} from "../shared/interactive";
import {
  loadWorkspaceConversations,
  selectWorkspaceConversation,
} from "../workspaces/conversationSelection";
import { makeUpdateAnnouncementDeliveryKey, makeUpdateAnnouncementSerializationKey } from "./keys";
import type { UpdateAnnouncementClaim, UpdateAnnouncementCommit } from "./schema";
import { UpdateAnnouncementExecution } from "./schema";
import { UpdateAnnouncementWorkflowOperations } from "./service";
import { UpdateAnnouncementWorkflowOperationsError } from "./service";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";

type ConfigWorkspaceUpdateAnnouncementDeliveryRow = Option.Option.Value<
  Effect.Success<
    ReturnType<TrustedSheetPersistenceShape["workspaces"]["getWorkspaceUpdateAnnouncementDelivery"]>
  >
>;

const pendingConversationId = "__pending_update_announcement_delivery__";
const gateName = "update-announcements";
const claimOperation = "announcements.deliverUpdate.claim-update-announcement-delivery";
const selectOperation = "announcements.deliverUpdate.select-update-announcement-conversation";
const deliverOperation = "announcements.deliverUpdate.deliver-update-announcement";
const recordOperation = "announcements.deliverUpdate.record-update-announcement-delivery";
const releaseOperation = "announcements.deliverUpdate.release-update-announcement-claim";

const operationError = (operation: string, cause: unknown) =>
  new UpdateAnnouncementWorkflowOperationsError({ operation, cause });

const isDeclaredFailure = Schema.is(AnnouncementsDeliverUpdate.declaredFailure);

const mapDeliveryError = (
  policy: string,
  error: unknown,
): AutonomousDeclaredFailure | UpdateAnnouncementWorkflowOperationsError =>
  Match.value(error).pipe(
    Match.when(isDeclaredFailure, (failure) => failure),
    Match.when(
      Predicate.or(
        Predicate.isTagged("BotUnauthenticated"),
        Predicate.isTagged("BotAdmissionDenied"),
      ),
      () => interactiveAuthorizationRevoked(policy),
    ),
    Match.when(
      Predicate.some([
        Predicate.isTagged("BotResourceNotFound"),
        Predicate.isTagged("BotResponseExpired"),
        Predicate.isTagged("BotRequestRejected"),
      ]),
      () =>
        interactiveDeliveryRejected(
          deliverOperation,
          "The update announcement was rejected",
          false,
        ),
    ),
    Match.orElse((cause) => operationError(deliverOperation, cause)),
  );

const causeHasDeclaredFailure = (cause: Cause.Cause<unknown>): boolean =>
  Option.exists(Cause.findErrorOption(cause), isDeclaredFailure);

// Canonical configured-client/workspace comparisons intentionally mirror sibling gateway slices.
// fallow-ignore-next-line code-duplication
const sameConversation = (left: ConversationRef, right: ConversationRef): boolean =>
  left.workspace.client.platform === right.workspace.client.platform &&
  left.workspace.client.clientId === right.workspace.client.clientId &&
  left.workspace.workspaceId === right.workspace.workspaceId &&
  left.conversationId === right.conversationId;

const activeCanonicalRow = (
  row: ConfigWorkspaceUpdateAnnouncementDeliveryRow,
  workspaceId: string,
  announcementId: string,
  publishedAt: number,
): boolean =>
  row.workspaceId === workspaceId &&
  row.announcementId === announcementId &&
  row.publishedAt === publishedAt &&
  Predicate.isNull(row.deletedAt);

const isOwnedRow = (row: ConfigWorkspaceUpdateAnnouncementDeliveryRow, claimId: string): boolean =>
  row.conversationId === pendingConversationId && row.messageId === claimId;

const isCanonicalOwnedRow = (
  row: ConfigWorkspaceUpdateAnnouncementDeliveryRow,
  claim: UpdateAnnouncementClaim,
): boolean =>
  activeCanonicalRow(row, claim.workspaceId, claim.announcementId, claim.publishedAt) &&
  isOwnedRow(row, claim.claimId);

const recoveryRequired = (
  clientId: string,
  workspaceId: string,
  announcementId: string,
  message: string,
): AutonomousDeclaredFailure =>
  interactiveDeliveryRejected(
    recordOperation,
    message,
    true,
    makeUpdateAnnouncementSerializationKey(clientId, workspaceId, announcementId),
  );

const decodeInput = (input: unknown) =>
  Schema.is(AnnouncementsDeliverUpdate.input)(input)
    ? Effect.succeed(input)
    : Schema.decodeUnknownEffect(AnnouncementsDeliverUpdate.input)(input).pipe(Effect.orDie);

const validateInput = (input: AnnouncementsDeliverUpdateInput) => {
  const announcementId = input.announcement.id;
  return announcementId.length > 0 &&
    announcementId.trim() === announcementId &&
    input.announcement.publishedAt.getTime() > input.joinedAt.getTime()
    ? Effect.void
    : Effect.fail(
        interactiveInvalidRequest(
          "InvalidUpdateAnnouncement",
          "The announcement identity must be canonical and published after the workspace join time",
        ),
      );
};

const mapAuthorizationError = (operation: string) => (error: unknown) =>
  isDeclaredFailure(error) ? error : operationError(`${operation}.authorize`, error);

const classifyClaim = (
  client: { readonly platform: "discord"; readonly clientId: string },
  input: AnnouncementsDeliverUpdateInput,
  claimId: string,
  row: ConfigWorkspaceUpdateAnnouncementDeliveryRow,
): UpdateAnnouncementClaim => {
  const publishedAt = input.announcement.publishedAt.getTime();
  if (!activeCanonicalRow(row, input.workspaceId, input.announcement.id, publishedAt)) {
    throw operationError(claimOperation, "Trusted persistence returned a non-canonical claim row");
  }
  if (row.conversationId === pendingConversationId) {
    return {
      workspaceId: input.workspaceId,
      announcementId: input.announcement.id,
      publishedAt,
      claimId,
      status: row.messageId === claimId ? "owned" : "skipped_already_claimed",
      delivery: null,
    };
  }
  return {
    workspaceId: input.workspaceId,
    announcementId: input.announcement.id,
    publishedAt,
    claimId,
    status: "skipped_already_delivered",
    delivery: messageRefFrom(client, input.workspaceId, row.conversationId, row.messageId),
  };
};

const canonicalClaim = (
  input: AnnouncementsDeliverUpdateInput,
  claim: UpdateAnnouncementClaim,
): boolean =>
  claim.workspaceId === input.workspaceId &&
  claim.announcementId === input.announcement.id &&
  claim.publishedAt === input.announcement.publishedAt.getTime();

export const updateAnnouncementWorkflowOperationsLayer = Layer.effect(
  UpdateAnnouncementWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const cache = yield* SheetBotCacheClient;
    const delivery = yield* SheetBotDeliveryClient;
    const authorization = yield* ReadOnlyWorkflowAuthorization;
    const clientId = yield* config.sheetBotClientId;
    const client = { platform: "discord", clientId } as const;

    const reauthorize = (execution: typeof UpdateAnnouncementExecution.Type, operation: string) =>
      authorization
        .authorize(AnnouncementsDeliverUpdate, execution.principal, execution.input)
        .pipe(
          Effect.mapError((error) =>
            Predicate.isTagged("WorkflowInvocationUnauthorized")(error)
              ? interactiveAuthorizationRevoked(
                  AnnouncementsDeliverUpdate.authorizationPolicy.policy,
                )
              : mapAuthorizationError(operation)(error),
          ),
        );

    const loadDelivery = (execution: typeof UpdateAnnouncementExecution.Type, operation: string) =>
      Effect.gen(function* () {
        const input = yield* decodeInput(execution.input);
        return yield* reauthorize(execution, operation).pipe(
          Effect.andThen(
            persistence.workspaces.getWorkspaceUpdateAnnouncementDelivery({
              workspaceId: input.workspaceId,
              announcementId: input.announcement.id,
            }),
          ),
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) =>
            isDeclaredFailure(cause) ? cause : operationError(operation, cause),
          ),
        );
      });

    const claim: typeof UpdateAnnouncementWorkflowOperations.Service.claim = (execution, claimId) =>
      Effect.gen(function* () {
        const input = yield* decodeInput(execution.input);
        yield* validateInput(input);
        const flag = yield* reauthorize(execution, `${claimOperation}.load-gate`).pipe(
          Effect.andThen(
            persistence.workspaces.getWorkspaceFeatureFlag({
              workspaceId: input.workspaceId,
              flagName: gateName,
            }),
          ),
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) =>
            isDeclaredFailure(cause) ? cause : operationError(`${claimOperation}.load-gate`, cause),
          ),
        );
        if (Option.isNone(flag)) {
          return {
            workspaceId: input.workspaceId,
            announcementId: input.announcement.id,
            publishedAt: input.announcement.publishedAt.getTime(),
            claimId,
            status: "skipped_not_gated" as const,
            delivery: null,
          };
        }
        if (
          flag.value.workspaceId !== input.workspaceId ||
          flag.value.flagName !== gateName ||
          Predicate.isNotNull(flag.value.deletedAt)
        ) {
          return yield* Effect.fail(
            operationError(claimOperation, "Trusted persistence returned a non-canonical gate"),
          );
        }
        const mutate = reauthorize(execution, `${claimOperation}.mutate`).pipe(
          Effect.andThen(
            persistence.workspaces.claimWorkspaceUpdateAnnouncementDelivery({
              workspaceId: input.workspaceId,
              announcementId: input.announcement.id,
              publishedAt: input.announcement.publishedAt.getTime(),
              claimToken: claimId,
            }),
          ),
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) =>
            isDeclaredFailure(cause) ? cause : operationError(`${claimOperation}.mutate`, cause),
          ),
        );
        yield* mutate.pipe(
          Effect.catchCause((mutationCause) =>
            Cause.hasInterrupts(mutationCause) || causeHasDeclaredFailure(mutationCause)
              ? Effect.failCause(mutationCause)
              : Effect.uninterruptible(
                  loadDelivery(execution, `${claimOperation}.reconcile`).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () => Effect.failCause(mutationCause),
                        onSome: () => Effect.void,
                      }),
                    ),
                  ),
                ),
          ),
        );
        const current = yield* loadDelivery(execution, `${claimOperation}.load-result`);
        return yield* Option.match(current, {
          onNone: () => Effect.fail(operationError(claimOperation, "Claim row is missing")),
          onSome: (row) =>
            Effect.try({
              try: () => classifyClaim(client, input, claimId, row),
              catch: (cause) => operationError(claimOperation, cause),
            }),
        });
      });

    const select: typeof UpdateAnnouncementWorkflowOperations.Service.select = (
      execution,
      currentClaim,
      policy,
    ) =>
      Effect.gen(function* () {
        const input = yield* decodeInput(execution.input);
        if (currentClaim.status !== "owned" || !canonicalClaim(input, currentClaim)) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "AnnouncementClaimMismatch",
              "The announcement claim is not canonical",
            ),
          );
        }
        const current = yield* loadDelivery(execution, `${selectOperation}.load-claim`);
        if (Option.isNone(current) || !isCanonicalOwnedRow(current.value, currentClaim)) {
          return yield* Effect.fail(interactiveAuthorizationRevoked(policy));
        }
        const conversations = yield* loadWorkspaceConversations({
          cache: cache.get().cache,
          client,
          workspaceId: input.workspaceId,
          policy,
          operation: selectOperation,
          operationError,
          beforeRead: () => reauthorize(execution, `${selectOperation}.read-page`),
        });
        const selected = selectWorkspaceConversation(conversations, input.systemConversationId);
        return Predicate.isUndefined(selected)
          ? yield* Effect.fail(interactiveResourceNotFound("sendable workspace conversation"))
          : conversationRefFrom(client, input.workspaceId, selected.id);
      });

    const deliver: typeof UpdateAnnouncementWorkflowOperations.Service.deliver = (
      execution,
      currentClaim,
      conversation,
      message,
      deliveryKey,
      policy,
    ) =>
      Effect.gen(function* () {
        const input = yield* decodeInput(execution.input);
        const expected = conversationRefFrom(
          client,
          input.workspaceId,
          conversation.conversationId,
        );
        if (
          currentClaim.status !== "owned" ||
          !canonicalClaim(input, currentClaim) ||
          !sameConversation(conversation, expected)
        ) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "AnnouncementDeliveryContextMismatch",
              "The claim and selected conversation must belong to the configured client and workspace",
            ),
          );
        }
        const current = yield* loadDelivery(execution, `${deliverOperation}.load-claim`);
        if (Option.isNone(current) || !isCanonicalOwnedRow(current.value, currentClaim)) {
          return yield* Effect.fail(interactiveAuthorizationRevoked(policy));
        }
        const sent = yield* reauthorize(execution, `${deliverOperation}.send`).pipe(
          Effect.andThen(
            delivery.get().delivery.sendMessage({
              payload: { conversation, deliveryKey, message },
            }),
          ),
          Effect.timeout("30 seconds"),
          Effect.mapError((error) => mapDeliveryError(policy, error)),
        );
        if (
          sent.deliveryKey !== deliveryKey ||
          !sameConversation(sent.target.message.conversation, conversation)
        ) {
          return yield* Effect.fail(
            operationError(deliverOperation, "The bot returned a receipt for a different delivery"),
          );
        }
        const deliveredAt = yield* Clock.currentTimeMillis;
        return { claim: currentClaim, conversation, receipt: sent, deliveredAt };
      });

    const finalRowMatches = (
      commit: UpdateAnnouncementCommit,
      row: ConfigWorkspaceUpdateAnnouncementDeliveryRow,
    ) =>
      activeCanonicalRow(
        row,
        commit.claim.workspaceId,
        commit.claim.announcementId,
        commit.claim.publishedAt,
      ) &&
      row.conversationId === commit.conversation.conversationId &&
      row.messageId === commit.receipt.target.message.messageId &&
      row.deliveredAt === commit.deliveredAt;

    const record: typeof UpdateAnnouncementWorkflowOperations.Service.record = (
      execution,
      commit,
    ) =>
      Effect.gen(function* () {
        const input = yield* decodeInput(execution.input);
        if (
          commit.claim.status !== "owned" ||
          !canonicalClaim(input, commit.claim) ||
          commit.receipt.deliveryKey !==
            makeUpdateAnnouncementDeliveryKey(execution.invocationId) ||
          !sameConversation(commit.conversation, commit.receipt.target.message.conversation)
        ) {
          return yield* Effect.fail(
            recoveryRequired(
              clientId,
              input.workspaceId,
              input.announcement.id,
              "The committed receipt is inconsistent",
            ),
          );
        }
        const before = yield* loadDelivery(execution, `${recordOperation}.load-claim`);
        if (Option.isNone(before) || !isCanonicalOwnedRow(before.value, commit.claim)) {
          return yield* Effect.fail(
            recoveryRequired(
              clientId,
              input.workspaceId,
              input.announcement.id,
              "The committed claim is no longer owned",
            ),
          );
        }
        const mutate = reauthorize(execution, `${recordOperation}.mutate`).pipe(
          Effect.andThen(
            persistence.workspaces.recordWorkspaceUpdateAnnouncementDelivery({
              workspaceId: commit.claim.workspaceId,
              announcementId: commit.claim.announcementId,
              publishedAt: commit.claim.publishedAt,
              deliveredAt: commit.deliveredAt,
              conversationId: commit.conversation.conversationId,
              messageId: commit.receipt.target.message.messageId,
              claimToken: commit.claim.claimId,
            }),
          ),
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) =>
            isDeclaredFailure(cause) ? cause : operationError(`${recordOperation}.mutate`, cause),
          ),
        );
        yield* mutate.pipe(
          Effect.catchCause((mutationCause) =>
            Cause.hasInterrupts(mutationCause) || causeHasDeclaredFailure(mutationCause)
              ? Effect.failCause(mutationCause)
              : Effect.uninterruptible(
                  loadDelivery(execution, `${recordOperation}.reconcile`).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () => Effect.failCause(mutationCause),
                        onSome: (row) =>
                          finalRowMatches(commit, row)
                            ? Effect.void
                            : Effect.failCause(mutationCause),
                      }),
                    ),
                  ),
                ),
          ),
        );
        const after = yield* loadDelivery(execution, `${recordOperation}.load-result`);
        if (Option.isNone(after) || !finalRowMatches(commit, after.value)) {
          return yield* Effect.fail(
            recoveryRequired(
              clientId,
              input.workspaceId,
              input.announcement.id,
              "Delivery tracking could not be confirmed",
            ),
          );
        }
        return { commit, status: "tracked" as const };
      });

    const release: typeof UpdateAnnouncementWorkflowOperations.Service.release = (
      execution,
      currentClaim,
      policy,
    ) =>
      Effect.gen(function* () {
        const input = yield* decodeInput(execution.input);
        if (currentClaim.status !== "owned" || !canonicalClaim(input, currentClaim)) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "AnnouncementClaimMismatch",
              "Only an owned canonical claim can be released",
            ),
          );
        }
        const before = yield* loadDelivery(execution, `${releaseOperation}.load`);
        if (Option.isNone(before)) return;
        if (
          !activeCanonicalRow(
            before.value,
            currentClaim.workspaceId,
            currentClaim.announcementId,
            currentClaim.publishedAt,
          )
        ) {
          return yield* Effect.fail(interactiveAuthorizationRevoked(policy));
        }
        if (before.value.conversationId !== pendingConversationId) {
          return yield* Effect.fail(
            recoveryRequired(
              clientId,
              input.workspaceId,
              input.announcement.id,
              "A committed delivery claim cannot be released",
            ),
          );
        }
        if (!isOwnedRow(before.value, currentClaim.claimId)) return;
        yield* reauthorize(execution, `${releaseOperation}.mutate`).pipe(
          Effect.andThen(
            persistence.workspaces.releaseWorkspaceUpdateAnnouncementDeliveryClaim({
              workspaceId: currentClaim.workspaceId,
              announcementId: currentClaim.announcementId,
              claimToken: currentClaim.claimId,
            }),
          ),
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) =>
            isDeclaredFailure(cause) ? cause : operationError(`${releaseOperation}.mutate`, cause),
          ),
          Effect.catchCause((mutationCause) =>
            Cause.hasInterrupts(mutationCause) || causeHasDeclaredFailure(mutationCause)
              ? Effect.failCause(mutationCause)
              : Effect.uninterruptible(
                  loadDelivery(execution, `${releaseOperation}.reconcile`).pipe(
                    Effect.flatMap((row) =>
                      Option.isNone(row) || !isOwnedRow(row.value, currentClaim.claimId)
                        ? Effect.void
                        : Effect.failCause(mutationCause),
                    ),
                  ),
                ),
          ),
        );
        const after = yield* loadDelivery(execution, `${releaseOperation}.verify`);
        if (Option.isSome(after) && isOwnedRow(after.value, currentClaim.claimId)) {
          return yield* Effect.fail(
            operationError(releaseOperation, "Claim release was not confirmed"),
          );
        }
      });

    return { claim, select, deliver, record, release };
  }),
);
