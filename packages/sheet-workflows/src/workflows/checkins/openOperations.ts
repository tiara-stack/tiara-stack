import { Effect, Equal, Exit, Layer, Option, Predicate, Schema } from "effect";
import {
  BotOutboundMessage,
  BotTextPart,
  conversationRefFrom,
  type DeliveryKey,
  messageRefFrom,
  type MessageRef,
  SendMessageReceipt,
  workspaceRefFrom,
} from "sheet-bot-api";
import { shouldSendTentativeRoomOrder } from "sheet-ingress-api/clientActions";
import type {
  GeneratedRoomOrderEntry,
  RoomOrderGenerateResult,
} from "sheet-ingress-api/schemas/roomOrder";
import {
  autoCheckinSummaryMessage,
  autoMonitorCheckinDelivery,
  formatAutoCheckinContent,
  manualCheckinSummaryMessage,
} from "sheet-message-content/checkinSummary";
import {
  checkinPromptMessage,
  generatingCheckinMessage,
} from "sheet-message-content/checkinPrompt";
import {
  generatingRoomOrderMessage,
  tentativeRoomOrderContent,
  tentativeRoomOrderMessage,
} from "sheet-message-content/roomOrderMessage";
import * as MessageText from "sheet-message-content/text";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { CheckinsOpen, InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { ReadonlyJSONValue } from "typhoon-zero/schema";
import { SheetApisClient } from "@/services/sheetApisClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { config } from "@/config";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { decodeWorkflowContractInputOrDie } from "../shared/execution";
import {
  interactiveAuthorizationRevoked,
  interactiveDeliveryRejected,
  interactiveExternalOperationRejected,
  interactiveInvalidRequest,
  isInteractiveDeclaredFailure,
  mapDeliveryFailure,
} from "../shared/interactive";
import type { CheckinsOpenContext } from "./openSchema";
import { CheckinsOpenWorkflowOperations } from "./openService";

const policy = CheckinsOpen.authorizationPolicy.policy;
const operationPrefix = CheckinsOpen.identity;

const declaredOrExternal = (operation: string, error: unknown): InteractiveDeclaredFailure =>
  isInteractiveDeclaredFailure(error)
    ? error
    : interactiveExternalOperationRejected(
        operation,
        "ProviderUnavailable",
        "The check-in workflow dependency was unavailable",
      );

const providerFailure = <A>(
  effect: Effect.Effect<A, unknown>,
  operation: string,
  resource: string,
  rejectedMessage: string,
  recoveryRequired: boolean,
  committedReference?: string,
  ambiguousRecoveryRequired = recoveryRequired,
) =>
  effect.pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError(
      mapDeliveryFailure(
        policy,
        operation,
        resource,
        recoveryRequired,
        rejectedMessage,
        () =>
          interactiveDeliveryRejected(
            operation,
            rejectedMessage,
            ambiguousRecoveryRequired,
            committedReference,
          ),
        committedReference,
      ),
    ),
  );

const sameConversationRef = (left: MessageRef["conversation"], right: MessageRef["conversation"]) =>
  left.workspace.workspaceId === right.workspace.workspaceId &&
  left.workspace.client.platform === right.workspace.client.platform &&
  left.workspace.client.clientId === right.workspace.client.clientId &&
  left.conversationId === right.conversationId;

const sameMessageRef = (left: MessageRef, right: MessageRef) =>
  left.messageId === right.messageId && sameConversationRef(left.conversation, right.conversation);

const sameBotTextParts = (left: unknown, right: unknown) =>
  Option.all({
    left: Schema.decodeUnknownOption(Schema.Array(BotTextPart))(left),
    right: Schema.decodeUnknownOption(Schema.Array(BotTextPart))(right),
  }).pipe(
    Option.match({ onNone: () => false, onSome: ({ left, right }) => Equal.equals(left, right) }),
  );

const sameDirectMessageRecipient = (
  left: {
    readonly client: { readonly platform: string; readonly clientId: string };
    readonly userId: string;
  },
  right: typeof left,
) =>
  left.userId === right.userId &&
  left.client.platform === right.client.platform &&
  left.client.clientId === right.client.clientId;

const decodeMessage = (message: unknown, operation: string) =>
  Schema.decodeUnknownEffect(BotOutboundMessage)(message).pipe(
    Effect.mapError((error) =>
      interactiveInvalidRequest(
        "InvalidCheckinMessage",
        `${operation} produced an invalid provider message: ${String(error)}`,
      ),
    ),
  );

type CheckinPersistenceDetails = {
  readonly conversationId: string;
  readonly roleId: string | null;
  readonly memberIds: ReadonlyArray<string>;
  readonly operation: string;
};

const checkinDataFor = (
  context: CheckinsOpenContext,
  initialMessage: ReadonlyArray<typeof ReadonlyJSONValue.Type>,
  messageId: string,
  details: CheckinPersistenceDetails,
) => ({
  clientPlatform: context.clientPlatform,
  clientId: context.clientId,
  messageId,
  data: {
    initialMessage,
    hour: context.generated.hour,
    runningConversationId: context.generated.runningConversationId,
    roleId: details.roleId,
    workspaceId: context.workspaceId,
    conversationId: details.conversationId,
    createdByUserId: context.createdByUserId,
  },
  memberIds: details.memberIds,
});

const sameStringArray = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
};

const sameOrderedStringArray = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

type RoomOrderRow = Option.Option.Value<
  Effect.Success<
    ReturnType<TrustedSheetPersistence["Service"]["roomOrderState"]["getMessageRoomOrder"]>
  >
>;

type RoomOrderEntryRow = Effect.Success<
  ReturnType<TrustedSheetPersistence["Service"]["roomOrderState"]["getMessageRoomOrderRange"]>
>[number];

// Canonical reconciliation intentionally checks every persisted field.
// fallow-ignore-next-line complexity
const roomOrderRowMatches = (
  row: RoomOrderRow,
  context: CheckinsOpenContext,
  generated: RoomOrderGenerateResult,
  messageId: string,
  conversationId: string,
) =>
  row.clientPlatform === context.clientPlatform &&
  row.clientId === context.clientId &&
  row.messageId === messageId &&
  sameOrderedStringArray(row.previousFills, generated.previousFills) &&
  sameOrderedStringArray(row.fills, generated.fills) &&
  row.hour === generated.hour &&
  row.rank === generated.rank &&
  row.tentative &&
  row.monitor === generated.monitor &&
  row.workspaceId === context.workspaceId &&
  row.conversationId === conversationId &&
  row.createdByUserId === context.createdByUserId &&
  Predicate.isNull(row.deletedAt);

const roomOrderEntriesMatch = (
  rows: ReadonlyArray<RoomOrderEntryRow>,
  expected: ReadonlyArray<GeneratedRoomOrderEntry>,
  context: CheckinsOpenContext,
  messageId: string,
) => {
  if (rows.length !== expected.length) return false;
  const expectedByPosition = new Map(
    expected.map((entry) => [`${entry.rank}:${entry.position}`, entry] as const),
  );
  return rows.every((row) => {
    const entry = expectedByPosition.get(`${row.rank}:${row.position}`);
    return (
      Predicate.isNotUndefined(entry) &&
      row.clientPlatform === context.clientPlatform &&
      row.clientId === context.clientId &&
      row.messageId === messageId &&
      row.hour === entry.hour &&
      row.team === entry.team &&
      row.effectValue === entry.effectValue &&
      sameStringArray(row.tags, entry.tags) &&
      Predicate.isNull(row.deletedAt)
    );
  });
};

export const checkinsOpenWorkflowOperationsLayer = Layer.effect(
  CheckinsOpenWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const sheetApis = yield* SheetApisClient;
    const delivery = yield* SheetBotDeliveryClient;
    const authorization = yield* ReadOnlyWorkflowAuthorization;
    const clientId = yield* config.sheetBotClientId;
    const client = { platform: "discord", clientId } as const;
    const ensureConfiguredClient = (context: CheckinsOpenContext, operation: string) =>
      context.clientPlatform === client.platform && context.clientId === client.clientId
        ? Effect.void
        : Effect.fail(
            interactiveDeliveryRejected(
              operation,
              "The workflow context does not match the configured bot client",
              true,
            ),
          );

    const resolve: typeof CheckinsOpenWorkflowOperations.Service.resolve = (execution) =>
      // Context resolution deliberately keeps authorization, generation, and materialization together.
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const input = yield* decodeWorkflowContractInputOrDie(CheckinsOpen, execution.input);
        yield* authorization
          .authorize(CheckinsOpen, execution.principal, input)
          .pipe(
            Effect.mapError((error) =>
              Predicate.isTagged("WorkflowInvocationUnauthorized")(error)
                ? interactiveAuthorizationRevoked(policy)
                : declaredOrExternal(`${operationPrefix}.authorize`, error),
            ),
          );

        const generated = yield* sheetApis
          .get()
          .checkin.generate({
            payload: {
              workspaceId: input.workspaceId,
              ...(Predicate.isUndefined(input.conversationId)
                ? {}
                : { conversationId: input.conversationId }),
              ...(Predicate.isUndefined(input.conversationName)
                ? {}
                : { conversationName: input.conversationName }),
              ...(Predicate.isUndefined(input.hour) ? {} : { hour: input.hour }),
              ...(Predicate.isUndefined(input.template) ? {} : { template: input.template }),
            },
          })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((error) =>
              interactiveExternalOperationRejected(
                `${operationPrefix}.resolve-context`,
                "ProviderRejected",
                `The Sheets provider rejected check-in generation: ${String(error)}`,
              ),
            ),
          );

        const initialMessage =
          generated.initialMessage === null
            ? null
            : MessageText.materializeGeneratedText(
                client,
                input.workspaceId,
                generated.initialMessage,
              );
        const monitorCheckinMessage = MessageText.materializeGeneratedText(
          client,
          input.workspaceId,
          generated.monitorCheckinMessage,
        );
        const monitorFailureMessage =
          generated.monitorFailureMessage === null
            ? null
            : MessageText.materializeGeneratedText(
                client,
                input.workspaceId,
                generated.monitorFailureMessage,
              );

        const summary =
          execution.principal.kind === "user"
            ? {
                primaryConversationId: generated.runningConversationId,
                primaryMessage: yield* decodeMessage(
                  manualCheckinSummaryMessage({ monitorCheckinMessage }),
                  `${operationPrefix}.resolve-context`,
                ),
              }
            : generated.monitorConversationId === null
              ? {
                  primaryConversationId: generated.runningConversationId,
                  primaryMessage: yield* decodeMessage(
                    autoCheckinSummaryMessage({
                      monitorUserId: generated.monitorUserId,
                      monitorCheckinMessage,
                      monitorFailureMessage,
                    }),
                    `${operationPrefix}.resolve-context`,
                  ),
                }
              : {
                  primaryConversationId: generated.monitorConversationId,
                  primaryMessage: yield* decodeMessage(
                    autoMonitorCheckinDelivery({
                      client,
                      workspaceId: input.workspaceId,
                      runningConversationId: generated.runningConversationId,
                      hour: generated.hour,
                      monitorUserId: generated.monitorUserId,
                      monitorCheckinRequired: generated.monitorCheckinRequired,
                      monitorCheckinMessage,
                      monitorFailureMessage,
                    }).message,
                    `${operationPrefix}.resolve-context`,
                  ),
                };

        return {
          clientPlatform: client.platform,
          clientId: client.clientId,
          workspaceId: input.workspaceId,
          principalKind: execution.principal.kind,
          createdByUserId:
            execution.principal.kind === "user"
              ? (execution.principal.discordAccount?.accountId ?? null)
              : null,
          responseReference: input.responseReference ?? null,
          generated,
          initialMessage,
          monitorCheckinMessage,
          monitorFailureMessage,
          ...summary,
        };
      }).pipe(
        Effect.mapError((error) => declaredOrExternal(`${operationPrefix}.resolve-context`, error)),
      );

    const reconcileCheckinCommit = (
      context: CheckinsOpenContext,
      data: ReadonlyArray<unknown>,
      messageId: string,
      receipt: SendMessageReceipt,
      cleanupKey: DeliveryKey,
      originalFailure: unknown,
      details: CheckinPersistenceDetails,
    ) =>
      // Reconciliation deliberately keeps the three-way persistence/send/cleanup decision together.
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const contextClient = {
          platform: context.clientPlatform,
          clientId: context.clientId,
        } as const;
        const key = {
          clientPlatform: context.clientPlatform,
          clientId: context.clientId,
          messageId,
        };
        const reconciliation = yield* Effect.all(
          {
            checkin: persistence.checkinState.getMessageCheckinData(key),
            members: persistence.checkinState.getMessageCheckinMembers(key),
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout("30 seconds"), Effect.exit);

        if (Exit.isSuccess(reconciliation)) {
          const { checkin, members } = reconciliation.value;
          if (
            Option.isSome(checkin) &&
            checkin.value.clientPlatform === context.clientPlatform &&
            checkin.value.clientId === context.clientId &&
            checkin.value.messageId === messageId &&
            checkin.value.hour === context.generated.hour &&
            checkin.value.runningConversationId === context.generated.runningConversationId &&
            checkin.value.roleId === details.roleId &&
            checkin.value.workspaceId === context.workspaceId &&
            checkin.value.conversationId === details.conversationId &&
            checkin.value.createdByUserId === context.createdByUserId &&
            sameBotTextParts(checkin.value.initialMessage, data) &&
            sameStringArray(
              members.map(({ memberId }) => memberId),
              details.memberIds,
            )
          ) {
            return { message: receipt.target.message, receipt };
          }
          if (Option.isSome(checkin)) {
            return yield* Effect.fail(
              interactiveDeliveryRejected(
                details.operation,
                "The persisted check-in does not match the requested invocation",
                true,
                messageId,
              ),
            );
          }

          const cleanup = yield* delivery
            .get()
            .delivery.deleteMessage({
              payload: {
                message: messageRefFrom(
                  contextClient,
                  context.workspaceId,
                  details.conversationId,
                  messageId,
                ),
                deliveryKey: cleanupKey,
              },
            })
            .pipe(Effect.timeout("30 seconds"), Effect.exit);
          return yield* Exit.isSuccess(cleanup)
            ? Effect.fail(
                interactiveExternalOperationRejected(
                  details.operation,
                  "PersistenceRejected",
                  `The canonical check-in could not be persisted: ${String(originalFailure)}`,
                ),
              )
            : Effect.fail(
                interactiveDeliveryRejected(
                  details.operation,
                  "The delivered check-in could not be reconciled after persistence failed",
                  true,
                  messageId,
                ),
              );
        }

        return yield* Effect.fail(
          interactiveDeliveryRejected(
            details.operation,
            "The delivered check-in could not be reconciled after persistence failed",
            true,
            messageId,
          ),
        );
      });

    const persistTentativeRoomOrderAndReconcile = (
      context: CheckinsOpenContext,
      generated: RoomOrderGenerateResult,
      sentMessage: MessageRef,
      receipt: SendMessageReceipt,
      cleanupKey: DeliveryKey,
      originalFailure: unknown,
    ) =>
      // Tentative room-order persistence is post-commit, but an ambiguous write still needs the
      // same canonical-state check and placeholder cleanup policy as the check-in commit.
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const key = {
          clientPlatform: context.clientPlatform,
          clientId: context.clientId,
          messageId: sentMessage.messageId,
        };
        const reconciliation = yield* Effect.all(
          {
            roomOrder: persistence.roomOrderState.getMessageRoomOrder(key),
            entries: persistence.roomOrderState.getMessageRoomOrderRange(key),
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout("30 seconds"), Effect.exit);

        if (Exit.isSuccess(reconciliation)) {
          const { entries, roomOrder } = reconciliation.value;
          if (
            Option.isSome(roomOrder) &&
            roomOrderRowMatches(
              roomOrder.value,
              context,
              generated,
              sentMessage.messageId,
              sentMessage.conversation.conversationId,
            ) &&
            roomOrderEntriesMatch(entries, generated.entries, context, sentMessage.messageId)
          ) {
            return receipt;
          }
          if (Option.isSome(roomOrder)) {
            return yield* Effect.fail(
              interactiveDeliveryRejected(
                `${operationPrefix}.deliver-tentative-room-order`,
                "The persisted tentative room order does not match the requested invocation",
                true,
                sentMessage.messageId,
              ),
            );
          }

          const cleanup = yield* delivery
            .get()
            .delivery.deleteMessage({
              payload: { message: sentMessage, deliveryKey: cleanupKey },
            })
            .pipe(Effect.timeout("30 seconds"), Effect.exit);
          return yield* Exit.isSuccess(cleanup)
            ? Effect.fail(
                interactiveExternalOperationRejected(
                  `${operationPrefix}.deliver-tentative-room-order`,
                  "PersistenceRejected",
                  `The tentative room order could not be persisted: ${String(originalFailure)}`,
                ),
              )
            : Effect.fail(
                interactiveDeliveryRejected(
                  `${operationPrefix}.deliver-tentative-room-order`,
                  "The delivered tentative room order could not be reconciled after persistence failed",
                  true,
                  sentMessage.messageId,
                ),
              );
        }

        return yield* Effect.fail(
          interactiveDeliveryRejected(
            `${operationPrefix}.deliver-tentative-room-order`,
            "The delivered tentative room order could not be reconciled after persistence failed",
            true,
            sentMessage.messageId,
          ),
        );
      });

    const deliverCheckin: typeof CheckinsOpenWorkflowOperations.Service.deliverCheckin = (
      execution,
      deliveryKey,
      cleanupKey,
    ) =>
      Effect.gen(function* () {
        yield* ensureConfiguredClient(execution.context, `${operationPrefix}.deliver-checkin`);
        if (execution.context.initialMessage === null) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "CheckinMessageNotRequired",
              "A check-in message cannot be delivered when there are no new participants",
            ),
          );
        }
        const content =
          execution.context.principalKind === "service"
            ? formatAutoCheckinContent(execution.context.initialMessage)
            : execution.context.initialMessage;
        const placeholder = yield* decodeMessage(
          generatingCheckinMessage(content),
          `${operationPrefix}.deliver-checkin`,
        );
        const receipt = yield* providerFailure(
          delivery.get().delivery.sendMessage({
            payload: {
              conversation: conversationRefFrom(
                client,
                execution.context.workspaceId,
                execution.context.generated.checkinConversationId,
              ),
              deliveryKey,
              message: placeholder,
            },
          }),
          `${operationPrefix}.deliver-checkin`,
          "check-in message",
          "The check-in message was rejected",
          false,
          undefined,
          true,
        );
        const sentMessage = receipt.target.message;
        if (
          !sameConversationRef(
            sentMessage.conversation,
            conversationRefFrom(
              client,
              execution.context.workspaceId,
              execution.context.generated.checkinConversationId,
            ),
          )
        ) {
          return yield* Effect.fail(
            interactiveDeliveryRejected(
              `${operationPrefix}.deliver-checkin`,
              "The bot returned a check-in message for the wrong conversation",
              true,
              sentMessage.messageId,
            ),
          );
        }

        const persistenceDetails = {
          conversationId: execution.context.generated.checkinConversationId,
          roleId: execution.context.generated.roleId,
          memberIds: execution.context.generated.fillIds,
          operation: `${operationPrefix}.deliver-checkin`,
        } satisfies CheckinPersistenceDetails;
        const persisted = yield* persistence.checkinState
          .persistMessageCheckin(
            checkinDataFor(execution.context, content, sentMessage.messageId, persistenceDetails),
          )
          .pipe(Effect.timeout("30 seconds"), Effect.exit);
        if (Exit.isFailure(persisted)) {
          return yield* reconcileCheckinCommit(
            execution.context,
            content,
            sentMessage.messageId,
            receipt,
            cleanupKey,
            persisted.cause,
            persistenceDetails,
          );
        }
        return { message: sentMessage, receipt };
      }).pipe(
        Effect.mapError((error) =>
          isInteractiveDeclaredFailure(error)
            ? error
            : declaredOrExternal(`${operationPrefix}.deliver-checkin`, error),
        ),
      );

    const finalizeCheckin: typeof CheckinsOpenWorkflowOperations.Service.finalizeCheckin = (
      execution,
      committed,
      deliveryKey,
    ) => {
      const content =
        execution.context.principalKind === "service"
          ? formatAutoCheckinContent(execution.context.initialMessage ?? [])
          : (execution.context.initialMessage ?? []);
      return decodeMessage(
        checkinPromptMessage(content),
        `${operationPrefix}.finalize-checkin`,
      ).pipe(
        Effect.flatMap((message) =>
          providerFailure(
            delivery.get().delivery.editMessage({
              payload: { message: committed.message, deliveryKey, content: message },
            }),
            `${operationPrefix}.finalize-checkin`,
            "check-in message",
            "The persisted check-in message could not be finalized",
            true,
            committed.message.messageId,
          ),
        ),
        Effect.flatMap((receipt) =>
          sameMessageRef(receipt.target.message, committed.message)
            ? Effect.succeed(receipt)
            : Effect.fail(
                interactiveDeliveryRejected(
                  `${operationPrefix}.finalize-checkin`,
                  "The finalized check-in message reference did not match the committed message",
                  true,
                  committed.message.messageId,
                ),
              ),
        ),
      );
    };

    const deliverPrimary: typeof CheckinsOpenWorkflowOperations.Service.deliverPrimary = (
      execution,
      deliveryKey,
      finalizeKey,
      cleanupKey,
    ) =>
      // Primary delivery owns the user response and automatic monitor commit paths.
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        yield* ensureConfiguredClient(execution.context, `${operationPrefix}.deliver-primary`);
        if (execution.context.principalKind === "user") {
          const responseReference = execution.context.responseReference;
          if (responseReference === null) {
            return yield* Effect.fail(interactiveAuthorizationRevoked(policy));
          }
          const receipt = yield* providerFailure(
            delivery.get().delivery.respond({
              payload: {
                responseReference,
                deliveryKey,
                message: execution.context.primaryMessage,
                workspace: workspaceRefFrom(client, execution.context.workspaceId),
              },
            }),
            `${operationPrefix}.deliver-primary`,
            "response",
            "The check-in summary response was rejected",
            true,
          );
          if (Predicate.isUndefined(receipt.target.message)) {
            return yield* Effect.fail(
              interactiveDeliveryRejected(
                `${operationPrefix}.deliver-primary`,
                "The check-in summary response did not return a message reference",
                true,
              ),
            );
          }
          if (receipt.target.responseReference !== responseReference) {
            return yield* Effect.fail(
              interactiveDeliveryRejected(
                `${operationPrefix}.deliver-primary`,
                "The summary response reference did not match the requested interaction",
                true,
              ),
            );
          }
          return { receipt, additionalReceipts: [] };
        }
        const monitorCheckinRequired =
          execution.context.generated.monitorConversationId !== null &&
          execution.context.generated.monitorCheckinRequired &&
          execution.context.generated.monitorUserId !== null;
        if (monitorCheckinRequired) {
          const monitorContent = yield* Schema.decodeUnknownEffect(Schema.Array(BotTextPart))(
            execution.context.primaryMessage.content,
          ).pipe(
            Effect.mapError(() =>
              interactiveInvalidRequest(
                "InvalidMonitorCheckinMessage",
                "The monitor check-in message did not contain persistable text",
              ),
            ),
          );
          const placeholder = yield* decodeMessage(
            generatingCheckinMessage(monitorContent),
            `${operationPrefix}.deliver-primary`,
          );
          const monitorPlaceholder = {
            ...placeholder,
            ...(Predicate.isUndefined(execution.context.primaryMessage.embeds)
              ? {}
              : { embeds: execution.context.primaryMessage.embeds }),
            ...(Predicate.isUndefined(execution.context.primaryMessage.allowedMentions)
              ? {}
              : { allowedMentions: execution.context.primaryMessage.allowedMentions }),
          };
          const monitorConversationId = execution.context.generated.monitorConversationId;
          const receipt = yield* providerFailure(
            delivery.get().delivery.sendMessage({
              payload: {
                conversation: conversationRefFrom(
                  client,
                  execution.context.workspaceId,
                  monitorConversationId,
                ),
                deliveryKey,
                message: monitorPlaceholder,
              },
            }),
            `${operationPrefix}.deliver-primary`,
            "monitor check-in message",
            "The monitor check-in message was rejected",
            false,
            undefined,
            true,
          );
          const sentMessage = receipt.target.message;
          if (
            !sameConversationRef(
              sentMessage.conversation,
              conversationRefFrom(client, execution.context.workspaceId, monitorConversationId),
            )
          ) {
            return yield* Effect.fail(
              interactiveDeliveryRejected(
                `${operationPrefix}.deliver-primary`,
                "The monitor check-in was delivered to the wrong conversation",
                true,
                sentMessage.messageId,
              ),
            );
          }
          const persistenceDetails = {
            conversationId: monitorConversationId,
            roleId: null,
            memberIds: [execution.context.generated.monitorUserId],
            operation: `${operationPrefix}.deliver-primary`,
          } satisfies CheckinPersistenceDetails;
          const persisted = yield* persistence.checkinState
            .persistMessageCheckin(
              checkinDataFor(
                execution.context,
                monitorContent,
                sentMessage.messageId,
                persistenceDetails,
              ),
            )
            .pipe(Effect.timeout("30 seconds"), Effect.exit);
          const commit = Exit.isSuccess(persisted)
            ? { message: sentMessage, receipt }
            : yield* reconcileCheckinCommit(
                execution.context,
                monitorContent,
                sentMessage.messageId,
                receipt,
                cleanupKey,
                persisted.cause,
                persistenceDetails,
              );
          const finalMessage = yield* decodeMessage(
            checkinPromptMessage(monitorContent),
            `${operationPrefix}.finalize-primary`,
          );
          const finalized = yield* providerFailure(
            delivery.get().delivery.editMessage({
              payload: { message: commit.message, deliveryKey: finalizeKey, content: finalMessage },
            }),
            `${operationPrefix}.finalize-primary`,
            "monitor check-in message",
            "The persisted monitor check-in message could not be finalized",
            true,
            commit.message.messageId,
          );
          if (!sameMessageRef(finalized.target.message, commit.message)) {
            return yield* Effect.fail(
              interactiveDeliveryRejected(
                `${operationPrefix}.finalize-primary`,
                "The finalized monitor check-in reference did not match the committed message",
                true,
                commit.message.messageId,
              ),
            );
          }
          return { receipt: commit.receipt, additionalReceipts: [finalized] };
        }
        const receipt = yield* providerFailure(
          delivery.get().delivery.sendMessage({
            payload: {
              conversation: conversationRefFrom(
                client,
                execution.context.workspaceId,
                execution.context.primaryConversationId,
              ),
              deliveryKey,
              message: execution.context.primaryMessage,
            },
          }),
          `${operationPrefix}.deliver-primary`,
          "summary",
          "The automatic check-in summary was rejected",
          true,
        );
        if (
          !sameConversationRef(
            receipt.target.message.conversation,
            conversationRefFrom(
              client,
              execution.context.workspaceId,
              execution.context.primaryConversationId,
            ),
          )
        ) {
          return yield* Effect.fail(
            interactiveDeliveryRejected(
              `${operationPrefix}.deliver-primary`,
              "The automatic check-in summary was delivered to the wrong conversation",
              true,
            ),
          );
        }
        return { receipt, additionalReceipts: [] };
      }).pipe(
        Effect.mapError((error) =>
          isInteractiveDeclaredFailure(error)
            ? error
            : declaredOrExternal(`${operationPrefix}.deliver-primary`, error),
        ),
      );

    const findDmRecipient = (
      userId: string,
      operation: string,
      preference: "checkin" | "monitor",
    ) =>
      (preference === "monitor"
        ? persistence.preferences.getMonitorDmEnabledUserConfigs({
            platform: client.platform,
            userIds: [userId],
          })
        : persistence.preferences.getCheckinDmEnabledUserConfigs({
            platform: client.platform,
            userIds: [userId],
          })
      ).pipe(
        Effect.timeout("30 seconds"),
        Effect.map((rows) => rows.find((row) => row.defaultClientId === client.clientId)),
        Effect.flatMap((row) =>
          Predicate.isUndefined(row)
            ? Effect.fail(
                interactiveExternalOperationRejected(
                  operation,
                  "DmNotConfigured",
                  preference === "monitor"
                    ? "The recipient has no enabled monitor DM for this bot client"
                    : "The recipient has no enabled check-in DM for this bot client",
                ),
              )
            : Effect.succeed(row),
        ),
        Effect.mapError((error) => declaredOrExternal(operation, error)),
      );

    const deliverParticipantDm: typeof CheckinsOpenWorkflowOperations.Service.deliverParticipantDm =
      (execution, userId, message, deliveryKey) =>
        Effect.gen(function* () {
          yield* ensureConfiguredClient(
            execution.context,
            `${operationPrefix}.deliver-participant-dm`,
          );
          yield* findDmRecipient(userId, `${operationPrefix}.deliver-participant-dm`, "checkin");
          const receipt = yield* providerFailure(
            delivery.get().delivery.sendDirectMessage({
              payload: {
                recipient: { client, userId },
                deliveryKey,
                message,
              },
            }),
            `${operationPrefix}.deliver-participant-dm`,
            "participant direct message",
            "The participant check-in reminder was rejected",
            true,
          );
          return sameDirectMessageRecipient(receipt.target.recipient, { client, userId })
            ? receipt
            : yield* Effect.fail(
                interactiveDeliveryRejected(
                  `${operationPrefix}.deliver-participant-dm`,
                  "The participant reminder was delivered to the wrong recipient",
                  true,
                ),
              );
        }).pipe(
          Effect.mapError((error) =>
            isInteractiveDeclaredFailure(error)
              ? error
              : declaredOrExternal(`${operationPrefix}.deliver-participant-dm`, error),
          ),
        );

    const deliverMonitorDm: typeof CheckinsOpenWorkflowOperations.Service.deliverMonitorDm = (
      execution,
      message,
      deliveryKey,
    ) =>
      Effect.gen(function* () {
        yield* ensureConfiguredClient(execution.context, `${operationPrefix}.deliver-monitor-dm`);
        const monitorUserId = execution.context.generated.monitorUserId;
        if (monitorUserId === null) {
          return yield* Effect.fail(
            interactiveInvalidRequest("MonitorUnavailable", "No monitor is assigned to this hour"),
          );
        }
        yield* findDmRecipient(monitorUserId, `${operationPrefix}.deliver-monitor-dm`, "monitor");
        const receipt = yield* providerFailure(
          delivery.get().delivery.sendDirectMessage({
            payload: {
              recipient: { client, userId: monitorUserId },
              deliveryKey,
              message,
            },
          }),
          `${operationPrefix}.deliver-monitor-dm`,
          "monitor direct message",
          "The monitor check-in reminder was rejected",
          true,
        );
        return sameDirectMessageRecipient(receipt.target.recipient, {
          client,
          userId: monitorUserId,
        })
          ? receipt
          : yield* Effect.fail(
              interactiveDeliveryRejected(
                `${operationPrefix}.deliver-monitor-dm`,
                "The monitor reminder was delivered to the wrong recipient",
                true,
              ),
            );
      }).pipe(
        Effect.mapError((error) =>
          isInteractiveDeclaredFailure(error)
            ? error
            : declaredOrExternal(`${operationPrefix}.deliver-monitor-dm`, error),
        ),
      );

    const deliverTentativeRoomOrder: typeof CheckinsOpenWorkflowOperations.Service.deliverTentativeRoomOrder =
      (execution, deliveryKey, finalizeKey, cleanupKey) =>
        Effect.gen(function* () {
          yield* ensureConfiguredClient(
            execution.context,
            `${operationPrefix}.deliver-tentative-room-order`,
          );
          if (
            execution.context.initialMessage === null ||
            !shouldSendTentativeRoomOrder(execution.context.generated.fillCount)
          ) {
            return yield* Effect.fail(
              interactiveInvalidRequest(
                "TentativeRoomOrderNotRequired",
                "No tentative room order is required for this check-in",
              ),
            );
          }
          const generated = yield* sheetApis
            .get()
            .roomOrder.generate({
              payload: {
                workspaceId: execution.context.workspaceId,
                conversationId: execution.context.generated.runningConversationId,
                hour: execution.context.generated.hour,
              },
            })
            .pipe(
              Effect.timeout("30 seconds"),
              Effect.mapError((error) =>
                interactiveExternalOperationRejected(
                  `${operationPrefix}.deliver-tentative-room-order`,
                  "ProviderRejected",
                  `The room-order provider rejected generation: ${String(error)}`,
                ),
              ),
            );
          const content = MessageText.materializeGeneratedText(
            client,
            execution.context.workspaceId,
            generated.content,
          );
          const placeholder = yield* decodeMessage(
            generatingRoomOrderMessage(tentativeRoomOrderContent(content)),
            `${operationPrefix}.deliver-tentative-room-order`,
          );
          const receipt = yield* providerFailure(
            delivery.get().delivery.sendMessage({
              payload: {
                conversation: conversationRefFrom(
                  client,
                  execution.context.workspaceId,
                  execution.context.generated.runningConversationId,
                ),
                deliveryKey,
                message: placeholder,
              },
            }),
            `${operationPrefix}.deliver-tentative-room-order`,
            "tentative room-order message",
            "The tentative room-order message was rejected",
            true,
          );
          const sentMessage = receipt.target.message;
          if (
            !sameConversationRef(
              sentMessage.conversation,
              conversationRefFrom(
                client,
                execution.context.workspaceId,
                execution.context.generated.runningConversationId,
              ),
            )
          ) {
            return yield* Effect.fail(
              interactiveDeliveryRejected(
                `${operationPrefix}.deliver-tentative-room-order`,
                "The tentative room order was delivered to the wrong conversation",
                true,
                sentMessage.messageId,
              ),
            );
          }
          const persisted = yield* persistence.roomOrderState
            .persistMessageRoomOrder({
              clientPlatform: execution.context.clientPlatform,
              clientId: execution.context.clientId,
              messageId: sentMessage.messageId,
              data: {
                previousFills: generated.previousFills,
                fills: generated.fills,
                hour: generated.hour,
                rank: generated.rank,
                tentative: true,
                monitor: generated.monitor,
                workspaceId: execution.context.workspaceId,
                conversationId: sentMessage.conversation.conversationId,
                createdByUserId: execution.context.createdByUserId,
              },
              entries: generated.entries,
            })
            .pipe(Effect.timeout("30 seconds"), Effect.exit);
          if (Exit.isFailure(persisted)) {
            yield* persistTentativeRoomOrderAndReconcile(
              execution.context,
              generated,
              sentMessage,
              receipt,
              cleanupKey,
              persisted.cause,
            );
          }
          const finalMessage = yield* decodeMessage(
            tentativeRoomOrderMessage(content, generated.range, generated.rank),
            `${operationPrefix}.deliver-tentative-room-order`,
          );
          const finalized = yield* providerFailure(
            delivery.get().delivery.editMessage({
              payload: { message: sentMessage, deliveryKey: finalizeKey, content: finalMessage },
            }),
            `${operationPrefix}.deliver-tentative-room-order`,
            "tentative room-order message",
            "The tentative room-order message could not be finalized",
            true,
            sentMessage.messageId,
          );
          return finalized;
        }).pipe(
          Effect.mapError((error) =>
            isInteractiveDeclaredFailure(error)
              ? error
              : declaredOrExternal(`${operationPrefix}.deliver-tentative-room-order`, error),
          ),
        );

    return {
      resolve,
      deliverCheckin,
      finalizeCheckin,
      deliverPrimary,
      deliverParticipantDm,
      deliverMonitorDm,
      deliverTentativeRoomOrder,
    };
  }),
);
