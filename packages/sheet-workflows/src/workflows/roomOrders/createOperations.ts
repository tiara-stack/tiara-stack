import { Cause, Clock, DateTime, Duration, Effect, Exit, Layer, Option, Predicate } from "effect";
import { buildRoomOrderContent } from "sheet-message-content/roomOrderContent";
import {
  generatingRoomOrderMessage,
  roomOrderDraftMessage,
} from "sheet-message-content/roomOrderMessage";
import { fillParticipantFromName, hourWindowFor } from "sheet-message-content/rendering";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  missingConfigurationKey,
  resolveAuthoritativeSheetConfigurationForWorkspace,
} from "@/services/authoritativeSheetConfiguration";
import {
  interactiveBusinessRuleRejected,
  interactiveConfigurationMissing,
  interactiveDeliveryRejected,
  interactiveExternalOperationRejected,
  interactiveInvalidRequest,
  interactiveResourceNotFound,
  mapDeliveryFailure,
} from "../shared/interactive";
import { providerCauseKind } from "../shared/providerFailure";
import { calculateRoomOrderEntries } from "./createCalculation";
import { RoomOrderCreateProvider, RoomOrderCreateProviderError } from "./createProvider";
import type {
  RoomOrderCreateBindingOutcome,
  RoomOrderCreateDraft,
  RoomOrderCreatePublication,
} from "./createSchema";
import { RoomOrderCreateOperations, RoomOrderCreateOperationsError } from "./createService";

const operationError = (operation: string, cause: unknown) =>
  new RoomOrderCreateOperationsError({ operation, cause });

const providerRejected = (error: RoomOrderCreateProviderError) =>
  Effect.logWarning("The room-order provider rejected the draft read").pipe(
    Effect.annotateLogs({
      providerOperation: error.operation,
      providerCauseKind: providerCauseKind(error.cause),
    }),
    Effect.andThen(
      Effect.fail(
        error.operation === "read-configuration"
          ? interactiveConfigurationMissing("workspace.sheetConfiguration")
          : interactiveExternalOperationRejected(
              "roomOrders.create.loadRoomOrderDraft",
              "ProviderRejected",
              "The room-order provider rejected the draft read",
            ),
      ),
    ),
  );

const nonEmptySelector = (value: string | undefined): string | undefined => {
  if (Predicate.isUndefined(value)) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const sameStringArray = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

// Exact commit reconciliation must compare every canonical persisted field.
// fallow-ignore-next-line complexity
const recordMatches = (
  row: Option.Option.Value<
    Effect.Success<
      ReturnType<TrustedSheetPersistence["Service"]["roomOrderState"]["getMessageRoomOrder"]>
    >
  >,
  publication: RoomOrderCreatePublication,
) => {
  const draft = publication.draft;
  return (
    row.clientPlatform === publication.message.conversation.workspace.client.platform &&
    row.clientId === publication.message.conversation.workspace.client.clientId &&
    row.messageId === publication.message.messageId &&
    row.workspaceId === draft.context.workspaceId &&
    row.conversationId === publication.message.conversation.conversationId &&
    row.createdByUserId === draft.context.creatorAccountId &&
    row.hour === draft.hour &&
    row.rank === draft.rank &&
    row.tentative === false &&
    row.monitor === draft.monitor &&
    sameStringArray(row.previousFills, draft.previousFills) &&
    sameStringArray(row.fills, draft.fills) &&
    Predicate.isNull(row.deletedAt)
  );
};

const entriesMatch = (
  rows: Effect.Success<
    ReturnType<TrustedSheetPersistence["Service"]["roomOrderState"]["getMessageRoomOrderRange"]>
  >,
  expected: RoomOrderCreateDraft["entries"],
) => {
  if (rows.length !== expected.length) return false;
  const expectedByKey = new Map(
    expected.map((entry) => [`${entry.rank}:${entry.position}`, entry] as const),
  );
  return rows.every((row) => {
    const entry = expectedByKey.get(`${row.rank}:${row.position}`);
    return (
      Predicate.isNotUndefined(entry) &&
      row.hour === entry.hour &&
      row.team === entry.team &&
      row.effectValue === entry.effectValue &&
      sameStringArray(row.tags, entry.tags) &&
      Predicate.isNull(row.deletedAt)
    );
  });
};

const deliveryFailure = (
  policy: string,
  operation: string,
  recoveryRequired: boolean,
  committedReference?: string,
) =>
  mapDeliveryFailure(
    policy,
    operation,
    "room-order message",
    recoveryRequired,
    "The room-order message delivery was rejected",
    operationError,
    committedReference,
  );

const isExplicitMutationRejection = (cause: Cause.Cause<unknown>) =>
  cause.reasons.length > 0 &&
  cause.reasons.every(
    (reason) =>
      Cause.isFailReason(reason) &&
      (Predicate.isTagged("MutatorResultAppError")(reason.error) ||
        Predicate.isTagged("MutatorResultZeroError")(reason.error)),
  );

export const roomOrderCreateOperationsLayer = Layer.effect(
  RoomOrderCreateOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* RoomOrderCreateProvider;
    const delivery = yield* SheetBotDeliveryClient;

    // The pinned load action owns the full trusted read/calculate/render transaction boundary.
    const loadDraft: RoomOrderCreateOperations["Service"]["loadDraft"] = (context, input) =>
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const workspace = yield* persistence.workspaces
          .getWorkspaceConfigByWorkspaceId({ workspaceId: context.workspaceId })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) => operationError("roomOrders.create.resolveWorkspace", cause)),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(interactiveResourceNotFound("workspace", context.workspaceId)),
                onSome: Effect.succeed,
              }),
            ),
          );
        const active = yield* resolveAuthoritativeSheetConfigurationForWorkspace(
          persistence,
          context.workspaceId,
          Option.some(workspace),
        ).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) => operationError("roomOrders.create.resolveSource", cause)),
        );
        if (Option.isNone(active)) {
          return yield* Effect.fail(
            interactiveConfigurationMissing(
              missingConfigurationKey(persistence, workspace.sheetId),
            ),
          );
        }
        const conversationId = nonEmptySelector(input.conversationId);
        const conversationName = nonEmptySelector(input.conversationName);
        if (Predicate.isUndefined(conversationId) && Predicate.isUndefined(conversationName)) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "RunningConversationSelectorRequired",
              "A running conversation ID or name is required",
            ),
          );
        }
        const matchingConversations = Predicate.isNotUndefined(conversationId)
          ? persistence.workspaces
              .getWorkspaceConversationById({
                workspaceId: context.workspaceId,
                conversationId,
                running: true,
              })
              .pipe(Effect.map(Option.toArray))
          : persistence.workspaces
              .getWorkspaceConversations({ workspaceId: context.workspaceId, running: true })
              .pipe(
                Effect.map((conversations) =>
                  conversations.filter(({ name }) => name === conversationName),
                ),
              );
        const conversations = yield* matchingConversations.pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) =>
            operationError("roomOrders.create.resolveRunningConversation", cause),
          ),
        );
        if (conversations.length > 1) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "AmbiguousRunningConversationSelector",
              "The running conversation name matches more than one configured conversation",
            ),
          );
        }
        const conversation = conversations[0];
        if (Predicate.isUndefined(conversation)) {
          return yield* Effect.fail(
            interactiveResourceNotFound("running-conversation", conversationId ?? conversationName),
          );
        }
        if (
          conversation.workspaceId !== context.workspaceId ||
          conversation.running !== true ||
          Predicate.isNotNull(conversation.deletedAt) ||
          Predicate.isNull(conversation.name) ||
          conversation.name.trim().length === 0
        ) {
          return yield* Effect.fail(
            interactiveConfigurationMissing("workspace.runningConversation"),
          );
        }
        const view = yield* provider
          .load(active.value.spreadsheetId, conversation.name.trim(), active.value.configuration)
          .pipe(Effect.catch(providerRejected));
        const hour = Predicate.isNumber(input.hour)
          ? input.hour
          : yield* Clock.currentTimeMillis.pipe(
              Effect.map((now) => DateTime.makeUnsafe(now)),
              Effect.map(DateTime.addDuration(Duration.minutes(20))),
              Effect.map(DateTime.startOf("hour")),
              Effect.map((currentHour) => {
                const startTime = DateTime.makeUnsafe(view.eventStartEpochMs);
                return Math.floor(Duration.toHours(DateTime.distance(startTime, currentHour))) + 1;
              }),
            );
        const schedulesByHour = new Map(
          view.schedules.flatMap((schedule) =>
            Predicate.isNull(schedule.hour) ? [] : ([[schedule.hour, schedule]] as const),
          ),
        );
        const previousFills = schedulesByHour.get(hour - 1)?.fills ?? [];
        const current = schedulesByHour.get(hour);
        const fills = current?.fills ?? [];
        const teamsByPlayer = fills.map((fill) =>
          Predicate.isNull(fill.accountId)
            ? []
            : (view.teamsByPlayerName.get(fill.name) ?? []).map((team) => ({
                ...team,
                encable: fill.enc,
                tierer: team.tags.includes("tierer_hint"),
              })),
        );
        const entries = yield* calculateRoomOrderEntries({
          teamsByPlayer,
          healNeeded: input.healNeeded ?? 0,
          hour,
        });
        if (entries.length === 0) {
          return yield* Effect.fail(
            interactiveBusinessRuleRejected(
              "RoomOrderCalculationEmpty",
              "Cannot calculate room orders with the configured teams",
            ),
          );
        }
        const maxRank = Math.max(...entries.map(({ rank }) => rank));
        const range = { minRank: 0 as const, maxRank };
        const startTime = DateTime.makeUnsafe(view.eventStartEpochMs);
        const { start, end } = hourWindowFor({ startTime }, hour);
        const content = buildRoomOrderContent(
          hour,
          start,
          end,
          current?.monitor ?? null,
          previousFills.map(({ name }) => fillParticipantFromName(name)),
          fills.map(({ name }) => fillParticipantFromName(name)),
          entries.filter(({ rank }) => rank === 0),
        );
        return {
          context,
          spreadsheetId: active.value.spreadsheetId,
          runningConversationId: conversation.conversationId,
          runningConversationName: conversation.name.trim(),
          hour,
          rank: 0 as const,
          range,
          previousFills: previousFills.map(({ name }) => name),
          fills: fills.map(({ name }) => name),
          monitor: current?.monitor ?? null,
          entries,
          generatingMessage: generatingRoomOrderMessage(content),
          finalMessage: roomOrderDraftMessage(content, range, 0),
        };
      });

    const publishDraft: RoomOrderCreateOperations["Service"]["publishDraft"] = (
      draft,
      responseReference,
      { cleanupKey, publishKey },
      policy,
    ) =>
      Effect.gen(function* () {
        const receipt = yield* delivery
          .get()
          .delivery.respond({
            payload: {
              responseReference,
              deliveryKey: publishKey,
              message: draft.generatingMessage,
            },
          })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(
              deliveryFailure(policy, "roomOrders.create.publishRoomOrderDraft", false),
            ),
          );
        const message = receipt.target.message;
        const invalidPublication =
          Predicate.isUndefined(message) ||
          message.conversation.workspace.client.platform !== draft.context.clientPlatform ||
          message.conversation.workspace.client.clientId !== draft.context.clientId ||
          message.conversation.workspace.workspaceId !== draft.context.workspaceId;
        if (invalidPublication) {
          if (Predicate.isNotUndefined(message)) {
            const cleanupExit = yield* delivery
              .get()
              .delivery.deleteMessage({ payload: { message, deliveryKey: cleanupKey } })
              .pipe(Effect.timeout("30 seconds"), Effect.exit);
            if (Exit.isFailure(cleanupExit)) {
              yield* Effect.logError(
                "Failed to delete invalid provisional room-order message",
                cleanupExit.cause,
              ).pipe(
                Effect.annotateLogs({
                  provisionalMessageId: message.messageId,
                  cleanupDeliveryKey: cleanupKey,
                }),
              );
            }
            return yield* Effect.fail(
              interactiveDeliveryRejected(
                "roomOrders.create.publishRoomOrderDraft",
                "The published response message did not belong to the authorized configured client",
                true,
                Exit.isFailure(cleanupExit) ? message.messageId : undefined,
              ),
            );
          }
          return yield* Effect.fail(
            interactiveDeliveryRejected(
              "roomOrders.create.publishRoomOrderDraft",
              "The published response message did not belong to the authorized configured client",
              true,
            ),
          );
        }
        return { draft, message, receipt };
      });

    const reconcileBinding = (publication: RoomOrderCreatePublication) => {
      const key = {
        clientPlatform: publication.message.conversation.workspace.client.platform,
        clientId: publication.message.conversation.workspace.client.clientId,
        messageId: publication.message.messageId,
      };
      return Effect.all(
        {
          row: persistence.roomOrderState.getMessageRoomOrder(key),
          entries: persistence.roomOrderState.getMessageRoomOrderRange(key),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) =>
          operationError("roomOrders.create.bindRoomOrderState.reconcile", cause),
        ),
        Effect.map(({ entries, row }) =>
          Option.match(row, {
            onNone: () => "absent" as const,
            onSome: (persisted) =>
              recordMatches(persisted, publication) &&
              entriesMatch(entries, publication.draft.entries)
                ? ("exact" as const)
                : ("conflict" as const),
          }),
        ),
      );
    };

    const bindState: RoomOrderCreateOperations["Service"]["bindState"] = (publication) => {
      const draft = publication.draft;
      const key = {
        clientPlatform: publication.message.conversation.workspace.client.platform,
        clientId: publication.message.conversation.workspace.client.clientId,
        messageId: publication.message.messageId,
      };
      const mutation = persistence.roomOrderState
        .bindMessageRoomOrderIfAbsent({
          ...key,
          data: {
            previousFills: draft.previousFills,
            fills: draft.fills,
            hour: draft.hour,
            rank: draft.rank,
            tentative: false,
            monitor: draft.monitor,
            workspaceId: draft.context.workspaceId,
            conversationId: publication.message.conversation.conversationId,
            createdByUserId: draft.context.creatorAccountId,
          },
          entries: draft.entries,
        })
        .pipe(Effect.timeout("30 seconds"));
      return Effect.exit(mutation).pipe(
        Effect.flatMap((mutationExit) =>
          reconcileBinding(publication).pipe(
            Effect.flatMap(
              (
                reconciliation,
              ): Effect.Effect<
                RoomOrderCreateBindingOutcome,
                InteractiveDeclaredFailure | RoomOrderCreateOperationsError
              > => {
                if (reconciliation === "exact") return Effect.succeed({ _tag: "Bound" });
                if (reconciliation === "conflict") {
                  return Effect.fail(
                    operationError(
                      "roomOrders.create.bindRoomOrderState.reconcile",
                      "The canonical room-order state conflicts with the intended binding",
                    ),
                  );
                }
                if (
                  Exit.isFailure(mutationExit) &&
                  !isExplicitMutationRejection(mutationExit.cause)
                ) {
                  return Effect.fail(
                    operationError(
                      "roomOrders.create.bindRoomOrderState.ambiguous",
                      mutationExit.cause,
                    ),
                  );
                }
                return Effect.succeed({
                  _tag: "CleanupRequired",
                  failure: interactiveExternalOperationRejected(
                    "roomOrders.create.bindRoomOrderState",
                    "StateBindRejected",
                    "The room-order state was definitively not committed",
                  ),
                });
              },
            ),
            Effect.catch((reconciliationFailure) =>
              Exit.isFailure(mutationExit)
                ? Effect.fail(
                    operationError(
                      "roomOrders.create.bindRoomOrderState.ambiguous",
                      Cause.combine(mutationExit.cause, Cause.fail(reconciliationFailure)),
                    ),
                  )
                : Effect.fail(reconciliationFailure),
            ),
          ),
        ),
      );
    };

    const finalizeMessage: RoomOrderCreateOperations["Service"]["finalizeMessage"] = (
      publication,
      deliveryKey,
      policy,
    ) =>
      delivery
        .get()
        .delivery.editMessage({
          payload: {
            message: publication.message,
            deliveryKey,
            content: publication.draft.finalMessage,
          },
        })
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError(
            deliveryFailure(
              policy,
              "roomOrders.create.finalizeRoomOrderMessage",
              true,
              publication.message.messageId,
            ),
          ),
        );

    const deleteProvisional: RoomOrderCreateOperations["Service"]["deleteProvisional"] = (
      publication,
      deliveryKey,
      policy,
    ) =>
      delivery
        .get()
        .delivery.deleteMessage({ payload: { message: publication.message, deliveryKey } })
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError(
            deliveryFailure(
              policy,
              "roomOrders.create.deleteProvisionalRoomOrder",
              true,
              publication.message.messageId,
            ),
          ),
        );

    return { loadDraft, publishDraft, bindState, finalizeMessage, deleteProvisional };
  }),
);
