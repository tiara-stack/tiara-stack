import { Cause, Effect, Layer, Match, Option, Predicate } from "effect";
import {
  type ConversationRef,
  type RespondReceipt,
  type SendMessageReceipt,
  conversationRefFrom,
} from "sheet-bot-api";
import type { WorkspacesFeatureFlagsSetAndDeliverInput } from "sheet-workflow-contracts/values";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { config } from "@/config";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveAuthorizationRevoked,
  interactiveDeliveryRejected,
  interactiveInvalidRequest,
} from "../shared/interactive";
import { loadWorkspaceConversations, selectWorkspaceConversation } from "./conversationSelection";
import {
  makeWorkspaceFeatureFlagCommittedReference,
  normalizeWorkspaceFeatureFlagName,
} from "./keys";
import {
  WorkspaceFeatureFlagWorkflowOperations,
  WorkspaceFeatureFlagWorkflowOperationsError,
} from "./featureFlagService";
import type { WorkspaceFeatureFlagState } from "./featureFlagSchema";

const setOperation = "workspaces.featureFlags.setAndDeliver.set-workspace-feature-flag";
const selectOperation =
  "workspaces.featureFlags.setAndDeliver.select-feature-flag-announcement-conversation";
const responseOperation = "workspaces.featureFlags.setAndDeliver.deliver-feature-flag-response";
const announcementOperation =
  "workspaces.featureFlags.setAndDeliver.deliver-feature-flag-announcement";

const operationError = (operation: string, cause: unknown) =>
  new WorkspaceFeatureFlagWorkflowOperationsError({ operation, cause });

const sameConversationReference = (left: ConversationRef, right: ConversationRef): boolean =>
  left.workspace.client.platform === right.workspace.client.platform &&
  left.workspace.client.clientId === right.workspace.client.clientId &&
  left.workspace.workspaceId === right.workspace.workspaceId &&
  left.conversationId === right.conversationId;

const loadFeatureFlag = (
  persistence: typeof TrustedSheetPersistence.Service,
  workspaceId: string,
  flagName: string,
  operation: string,
) =>
  persistence.workspaces.getWorkspaceFeatureFlag({ workspaceId, flagName }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) => operationError(operation, cause)),
    Effect.filterOrFail(
      (current) =>
        Option.match(current, {
          onNone: () => true,
          onSome: (row) => {
            const normalizedRow = { ...row, deletedAt: row.deletedAt ?? null };
            return (
              normalizedRow.workspaceId === workspaceId &&
              normalizedRow.flagName === flagName &&
              Predicate.isNull(normalizedRow.deletedAt)
            );
          },
        }),
      () => operationError(operation, "Trusted persistence returned a non-canonical feature flag"),
    ),
  );

const desiredStateMatches = (enabled: boolean, current: Option.Option<unknown>): boolean =>
  enabled === Option.isSome(current);

const stateMatchesInput = (
  clientId: string,
  input: WorkspacesFeatureFlagsSetAndDeliverInput,
  state: WorkspaceFeatureFlagState,
) => {
  const flagName = normalizeWorkspaceFeatureFlagName(input.flagName);
  return (
    state.workspaceId === input.workspaceId &&
    state.flagName === flagName &&
    state.enabled === input.enabled &&
    state.committedReference ===
      makeWorkspaceFeatureFlagCommittedReference(clientId, input.workspaceId, flagName)
  );
};

const requireCanonicalState = (
  clientId: string,
  input: WorkspacesFeatureFlagsSetAndDeliverInput,
  state: WorkspaceFeatureFlagState,
) =>
  stateMatchesInput(clientId, input, state)
    ? Effect.void
    : Effect.fail(
        interactiveInvalidRequest(
          "FeatureFlagStateMismatch",
          "The committed feature-flag state does not match the workflow input",
        ),
      );

const validateResponseReceipt = (
  receipt: RespondReceipt,
  deliveryKey: RespondReceipt["deliveryKey"],
  responseReference: string,
) => receipt.deliveryKey === deliveryKey && receipt.target.responseReference === responseReference;

const validateAnnouncementReceipt = (
  receipt: SendMessageReceipt,
  deliveryKey: SendMessageReceipt["deliveryKey"],
  conversation: ConversationRef,
) =>
  receipt.deliveryKey === deliveryKey &&
  sameConversationReference(receipt.target.message.conversation, conversation);

const mapResponseFailure = (policy: string, committedReference: string) => (error: unknown) =>
  Match.value(error).pipe(
    Match.when(
      Predicate.or(
        Predicate.isTagged("BotUnauthenticated"),
        Predicate.isTagged("BotAdmissionDenied"),
      ),
      () => interactiveAuthorizationRevoked(policy),
    ),
    Match.when(
      Predicate.or(
        Predicate.isTagged("BotResourceNotFound"),
        Predicate.or(
          Predicate.isTagged("BotResponseExpired"),
          Predicate.isTagged("BotRequestRejected"),
        ),
      ),
      () =>
        interactiveDeliveryRejected(
          responseOperation,
          "The feature-flag response was rejected",
          true,
          committedReference,
        ),
    ),
    Match.orElse((cause) => operationError(responseOperation, cause)),
  );

const handleAnnouncementFailure = (
  policy: string,
  error: unknown,
): Effect.Effect<null, InteractiveDeclaredFailure | WorkspaceFeatureFlagWorkflowOperationsError> =>
  Match.value(error).pipe(
    Match.when(
      Predicate.or(
        Predicate.isTagged("BotUnauthenticated"),
        Predicate.isTagged("BotAdmissionDenied"),
      ),
      () => Effect.fail(interactiveAuthorizationRevoked(policy)),
    ),
    Match.when(
      Predicate.or(
        Predicate.isTagged("BotResourceNotFound"),
        Predicate.or(
          Predicate.isTagged("BotResponseExpired"),
          Predicate.isTagged("BotRequestRejected"),
        ),
      ),
      () => Effect.succeed(null),
    ),
    Match.orElse((cause) => Effect.fail(operationError(announcementOperation, cause))),
  );

export const workspaceFeatureFlagWorkflowOperationsLayer = Layer.effect(
  WorkspaceFeatureFlagWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const cache = yield* SheetBotCacheClient;
    const delivery = yield* SheetBotDeliveryClient;
    const clientId = yield* config.sheetBotClientId;
    const client = { platform: "discord", clientId } as const;

    const setDesiredState: WorkspaceFeatureFlagWorkflowOperations["Service"]["setDesiredState"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const flagName = normalizeWorkspaceFeatureFlagName(input.flagName);
        const initial = yield* loadFeatureFlag(
          persistence,
          input.workspaceId,
          flagName,
          `${setOperation}.load`,
        );
        if (!desiredStateMatches(input.enabled, initial)) {
          const mutation = (
            input.enabled
              ? persistence.workspaces.addWorkspaceFeatureFlag
              : persistence.workspaces.removeWorkspaceFeatureFlag
          )({ workspaceId: input.workspaceId, flagName }).pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) => operationError(setOperation, cause)),
          );
          yield* mutation.pipe(
            Effect.catchCause((mutationCause) =>
              Cause.hasInterrupts(mutationCause)
                ? Effect.failCause(mutationCause)
                : Effect.uninterruptible(
                    loadFeatureFlag(
                      persistence,
                      input.workspaceId,
                      flagName,
                      `${setOperation}.reconcile`,
                    ).pipe(
                      Effect.flatMap((current) =>
                        desiredStateMatches(input.enabled, current)
                          ? Effect.void
                          : Effect.failCause(mutationCause),
                      ),
                    ),
                  ),
            ),
          );
        }
        const current = yield* loadFeatureFlag(
          persistence,
          input.workspaceId,
          flagName,
          `${setOperation}.load-result`,
        );
        if (!desiredStateMatches(input.enabled, current)) {
          return yield* Effect.fail(
            operationError(setOperation, "The authoritative feature-flag state conflicts"),
          );
        }
        return {
          workspaceId: input.workspaceId,
          flagName,
          enabled: input.enabled,
          committedReference: makeWorkspaceFeatureFlagCommittedReference(
            clientId,
            input.workspaceId,
            flagName,
          ),
        };
      });

    const selectAnnouncementConversation: WorkspaceFeatureFlagWorkflowOperations["Service"]["selectAnnouncementConversation"] =
      (input, state, policy) =>
        Effect.gen(function* () {
          yield* requireCanonicalState(clientId, input, state);
          if (Predicate.isNotUndefined(input.responseReference)) {
            return yield* Effect.fail(
              interactiveInvalidRequest(
                "UnexpectedResponseReference",
                "Announcement selection is unavailable for response delivery",
              ),
            );
          }
          const conversations = yield* loadWorkspaceConversations({
            cache: cache.get().cache,
            client,
            workspaceId: input.workspaceId,
            policy,
            operation: selectOperation,
            operationError,
          });
          const selected = selectWorkspaceConversation(conversations, input.systemConversationId);
          return Predicate.isUndefined(selected)
            ? null
            : conversationRefFrom(client, input.workspaceId, selected.id);
        });

    const respond: WorkspaceFeatureFlagWorkflowOperations["Service"]["respond"] = (
      input,
      state,
      message,
      deliveryKey,
      policy,
    ) =>
      Effect.gen(function* () {
        yield* requireCanonicalState(clientId, input, state);
        if (Predicate.isUndefined(input.responseReference)) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "ResponseReferenceRequired",
              "A Response Reference is required for response delivery",
            ),
          );
        }
        const receipt = yield* delivery
          .get()
          .delivery.respond({
            payload: { responseReference: input.responseReference, deliveryKey, message },
          })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(mapResponseFailure(policy, state.committedReference)),
          );
        return validateResponseReceipt(receipt, deliveryKey, input.responseReference)
          ? receipt
          : yield* Effect.fail(
              operationError(
                responseOperation,
                "The bot returned a receipt for a different response",
              ),
            );
      });

    const announce: WorkspaceFeatureFlagWorkflowOperations["Service"]["announce"] = (
      input,
      state,
      conversation,
      message,
      deliveryKey,
      policy,
    ) =>
      Effect.gen(function* () {
        yield* requireCanonicalState(clientId, input, state);
        if (Predicate.isNotUndefined(input.responseReference)) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "UnexpectedResponseReference",
              "Announcement delivery is unavailable for response delivery",
            ),
          );
        }
        const expected = conversationRefFrom(
          client,
          input.workspaceId,
          conversation.conversationId,
        );
        if (!sameConversationReference(conversation, expected)) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "ConversationWorkspaceMismatch",
              "The selected conversation must belong to the configured client and workspace",
            ),
          );
        }
        return yield* delivery
          .get()
          .delivery.sendMessage({ payload: { conversation, deliveryKey, message } })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.catch((error) => handleAnnouncementFailure(policy, error)),
            Effect.flatMap((receipt) =>
              Predicate.isNull(receipt) ||
              validateAnnouncementReceipt(receipt, deliveryKey, conversation)
                ? Effect.succeed(receipt)
                : Effect.fail(
                    operationError(
                      announcementOperation,
                      "The bot returned a receipt for a different announcement target",
                    ),
                  ),
            ),
          );
      });

    return { announce, respond, selectAnnouncementConversation, setDesiredState };
  }),
);
