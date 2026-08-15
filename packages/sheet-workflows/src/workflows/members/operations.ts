import { DateTime, Effect, Layer, Match, Option, Predicate, Schema } from "effect";
import {
  maximumBotCollectionPageSize,
  type BotCollectionCursor,
  type BotOutboundMessage,
  type RespondReceipt,
  type SetMemberRoleReceipt,
  workspaceRefFrom,
} from "sheet-bot-api";
import { MembersKick, SpreadsheetId, type MembersKickInput } from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { config } from "@/config";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveAuthorizationRevoked,
  interactiveConfigurationMissing,
  interactiveDeliveryRejected,
  interactiveExternalOperationRejected,
  interactiveInvalidRequest,
  interactiveResourceNotFound,
  mapBotCacheFailure,
  mapDeliveryFailure,
} from "../shared/interactive";
import { providerCauseKind } from "../shared/providerFailure";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { makeMemberKickSerializationKey } from "./keys";
import { MemberKickProvider, MemberKickProviderError } from "./provider";
import type { MemberKickContext } from "./schema";
import { MemberKickWorkflowOperations, MemberKickWorkflowOperationsError } from "./service";

const resolveOperation = "members.kick.resolve-member-kick-context";
const scheduleOperation = "members.kick.load-member-kick-schedule";
const discoverOperation = "members.kick.discover-member-kick-targets";
const removeOperation = "members.kick.remove-member-role";
const responseOperation = "members.kick.deliver-member-kick-result";
const maximumMemberPageCount = 10_000;

const operationError = (operation: string, cause: unknown) =>
  new MemberKickWorkflowOperationsError({ operation, cause });

const decodeInput = (input: unknown) =>
  Schema.is(MembersKick.input)(input)
    ? Effect.succeed(input)
    : Schema.decodeUnknownEffect(MembersKick.input)(input).pipe(Effect.orDie);

export const validateMemberKickInput = (
  principalKind: "user" | "service",
  input: MembersKickInput,
) => {
  const hasConversationId = Predicate.isNotUndefined(input.conversationId);
  const hasConversationName = Predicate.isNotUndefined(input.conversationName);
  const hasResponse = Predicate.isNotUndefined(input.responseReference);
  const hasHour = Predicate.isNotUndefined(input.hour);
  const valid = Match.value(principalKind).pipe(
    Match.when("user", () => hasResponse && hasConversationId !== hasConversationName),
    Match.when(
      "service",
      () => !hasResponse && hasConversationId && !hasConversationName && hasHour,
    ),
    Match.exhaustive,
  );
  return valid
    ? Effect.void
    : Effect.fail(
        interactiveInvalidRequest(
          "InvalidMemberKickPrincipalInput",
          principalKind === "user"
            ? "User member cleanup requires a response and exactly one conversation selector"
            : "Autonomous member cleanup requires an immutable conversation id and explicit hour without a response",
        ),
      );
};

export const deriveMemberKickHour = (eventStartEpochMs: number, acceptedAt: number) =>
  Option.all({
    eventStart: DateTime.make(eventStartEpochMs),
    accepted: DateTime.make(acceptedAt),
  }).pipe(
    Option.map(({ accepted, eventStart }) => {
      const acceptedHour = DateTime.toEpochMillis(DateTime.startOf(accepted, "hour"));
      return Math.max(
        0,
        Math.floor((acceptedHour - DateTime.toEpochMillis(eventStart)) / 3_600_000) + 1,
      );
    }),
    Option.match({
      onNone: () =>
        Effect.fail(
          interactiveInvalidRequest(
            "InvalidMemberKickTime",
            "The accepted time or event start time is invalid",
          ),
        ),
      onSome: Effect.succeed,
    }),
  );

const canonicalSort = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

const validateRoleReceipt = (
  receipt: SetMemberRoleReceipt,
  expected: {
    readonly clientId: string;
    readonly workspaceId: string;
    readonly memberId: string;
    readonly roleId: string;
    readonly deliveryKey: SetMemberRoleReceipt["deliveryKey"];
  },
) =>
  receipt.deliveryKey === expected.deliveryKey &&
  receipt.target.workspace.client.platform === "discord" &&
  receipt.target.workspace.client.clientId === expected.clientId &&
  receipt.target.workspace.workspaceId === expected.workspaceId &&
  receipt.target.userId === expected.memberId &&
  receipt.target.roleId === expected.roleId;

const validateResponseReceipt = (
  receipt: RespondReceipt,
  deliveryKey: RespondReceipt["deliveryKey"],
  responseReference: string,
) => receipt.deliveryKey === deliveryKey && receipt.target.responseReference === responseReference;

const providerRejected = (error: MemberKickProviderError) =>
  Effect.logWarning("The Sheets provider rejected the member cleanup read").pipe(
    Effect.annotateLogs({
      providerOperation: error.operation,
      providerCauseKind: providerCauseKind(error.cause),
    }),
    Effect.andThen(
      Effect.fail(
        interactiveExternalOperationRejected(
          scheduleOperation,
          "ProviderRejected",
          "The Sheets provider rejected the member cleanup read",
        ),
      ),
    ),
  );

export const memberKickWorkflowOperationsLayer = Layer.effect(
  MemberKickWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* MemberKickProvider;
    const cache = yield* SheetBotCacheClient;
    const delivery = yield* SheetBotDeliveryClient;
    const authorization = yield* ReadOnlyWorkflowAuthorization;
    const clientId = yield* config.sheetBotClientId;
    const client = { platform: "discord", clientId } as const;

    const reauthorize = (
      execution: {
        readonly principal: Parameters<typeof authorization.authorize>[1];
        readonly input: unknown;
      },
      operation: string,
    ) =>
      authorization
        .authorize(MembersKick, execution.principal, execution.input)
        .pipe(
          Effect.mapError((error) =>
            Predicate.isTagged("WorkflowInvocationUnauthorized")(error)
              ? interactiveAuthorizationRevoked(MembersKick.authorizationPolicy.policy)
              : operationError(`${operation}.authorize`, error),
          ),
        );

    const resolve: typeof MemberKickWorkflowOperations.Service.resolve = (execution) =>
      // Resolution keeps all reauthorization boundaries adjacent to the reads they guard.
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const input = yield* decodeInput(execution.input);
        yield* validateMemberKickInput(execution.principal.kind, input);
        yield* reauthorize(execution, resolveOperation);
        if (execution.principal.kind === "user") {
          const accepted = yield* Option.match(DateTime.make(execution.acceptedAt), {
            onNone: () =>
              Effect.fail(
                interactiveInvalidRequest("InvalidAcceptedAt", "The accepted time is invalid"),
              ),
            onSome: Effect.succeed,
          });
          if (DateTime.getPart(accepted, "minute") >= 40) {
            return {
              clientPlatform: client.platform,
              clientId: client.clientId,
              workspaceId: input.workspaceId,
              spreadsheetId: null,
              runningConversationId: input.conversationId ?? "",
              conversationName: input.conversationName ?? null,
              roleId: null,
              acceptedAt: execution.acceptedAt,
              hour: input.hour ?? 0,
              status: "tooEarly" as const,
              principalKind: execution.principal.kind,
            };
          }
        }

        yield* reauthorize(execution, `${resolveOperation}.conversation`);
        const conversation = yield* (
          Predicate.isNotUndefined(input.conversationName)
            ? persistence.workspaces.getWorkspaceConversationByName({
                workspaceId: input.workspaceId,
                conversationName: input.conversationName,
                running: true,
              })
            : persistence.workspaces.getWorkspaceConversationById({
                workspaceId: input.workspaceId,
                conversationId: input.conversationId ?? "",
                running: true,
              })
        ).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) => operationError(`${resolveOperation}.conversation`, cause)),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  interactiveResourceNotFound(
                    "running conversation",
                    input.conversationId ?? input.conversationName,
                  ),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        const conversationIsCanonical =
          conversation.workspaceId === input.workspaceId &&
          conversation.running === true &&
          Predicate.isNull(conversation.deletedAt) &&
          (Predicate.isNotUndefined(input.conversationName)
            ? conversation.name === input.conversationName
            : conversation.conversationId === input.conversationId);
        if (!conversationIsCanonical) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "NonCanonicalMemberKickConversation",
              "Trusted persistence returned a non-canonical running conversation",
            ),
          );
        }
        if (Predicate.isNull(conversation.name)) {
          return yield* Effect.fail(
            interactiveResourceNotFound("running conversation name", conversation.conversationId),
          );
        }
        yield* reauthorize(execution, `${resolveOperation}.workspace`);
        const workspace = yield* persistence.workspaces
          .getWorkspaceConfigByWorkspaceId({ workspaceId: input.workspaceId })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) => operationError(`${resolveOperation}.workspace`, cause)),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(interactiveResourceNotFound("workspace", input.workspaceId)),
                onSome: Effect.succeed,
              }),
            ),
          );
        if (
          workspace.workspaceId !== input.workspaceId ||
          Predicate.isNotNull(workspace.deletedAt)
        ) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "NonCanonicalMemberKickWorkspace",
              "Trusted persistence returned a non-canonical workspace",
            ),
          );
        }
        const spreadsheetId = yield* Predicate.isNull(workspace.sheetId)
          ? Effect.fail(interactiveConfigurationMissing("workspace.sheetId"))
          : Schema.decodeUnknownEffect(SpreadsheetId)(workspace.sheetId).pipe(
              Effect.mapError(() => interactiveConfigurationMissing("workspace.sheetId")),
            );
        const hour = Predicate.isNotUndefined(input.hour)
          ? input.hour
          : yield* reauthorize(execution, `${resolveOperation}.event`).pipe(
              Effect.andThen(provider.loadEventStart(spreadsheetId)),
              Effect.catchTag("MemberKickProviderError", providerRejected),
              Effect.flatMap((eventStart) =>
                deriveMemberKickHour(eventStart, execution.acceptedAt),
              ),
            );
        if (Predicate.isNull(conversation.roleId)) {
          return {
            clientPlatform: client.platform,
            clientId: client.clientId,
            workspaceId: input.workspaceId,
            spreadsheetId,
            runningConversationId: conversation.conversationId,
            conversationName: conversation.name,
            roleId: null,
            acceptedAt: execution.acceptedAt,
            hour,
            status: "missingRole" as const,
            principalKind: execution.principal.kind,
          };
        }
        return {
          clientPlatform: client.platform,
          clientId: client.clientId,
          workspaceId: input.workspaceId,
          spreadsheetId,
          runningConversationId: conversation.conversationId,
          conversationName: conversation.name,
          roleId: conversation.roleId,
          acceptedAt: execution.acceptedAt,
          hour,
          status: "ready" as const,
          principalKind: execution.principal.kind,
        };
      });

    const loadSchedule: typeof MemberKickWorkflowOperations.Service.loadSchedule = (execution) =>
      Effect.gen(function* () {
        yield* reauthorize(execution, scheduleOperation);
        const { context } = execution;
        if (Predicate.isNull(context.spreadsheetId) || Predicate.isNull(context.conversationName)) {
          return yield* Effect.fail(
            operationError(scheduleOperation, "Resolved member cleanup context is incomplete"),
          );
        }
        return yield* provider
          .loadSchedule(context.spreadsheetId, context.conversationName, context.hour)
          .pipe(
            Effect.catchTag("MemberKickProviderError", providerRejected),
            Effect.map(({ scheduleFound, scheduledMemberIds }) => ({
              scheduleFound,
              scheduledMemberIds: canonicalSort([...new Set(scheduledMemberIds)]),
            })),
          );
      });

    const discoverTargets: typeof MemberKickWorkflowOperations.Service.discoverTargets = (
      execution,
      schedule,
    ) =>
      // The cursor loop keeps validation and per-page reauthorization in one auditable boundary.
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const { context } = execution;
        if (Predicate.isNull(context.roleId)) {
          return yield* Effect.fail(
            operationError(discoverOperation, "Resolved member cleanup role is missing"),
          );
        }
        const scheduledIds = new Set(schedule.scheduledMemberIds);
        const targetIds: Array<string> = [];
        const seenMemberIds = new Set<string>();
        const seenCursors = new Set<string>();
        let cursor: BotCollectionCursor | undefined;
        let pageCount = 0;
        while (true) {
          if (pageCount >= maximumMemberPageCount) {
            return yield* Effect.fail(
              operationError(discoverOperation, "The bot cache returned too many member pages"),
            );
          }
          pageCount += 1;
          yield* reauthorize(execution, `${discoverOperation}.page`);
          const page = yield* cache
            .get()
            .cache.listMembers({
              params: { ...client, workspaceId: context.workspaceId },
              query: {
                limit: maximumBotCollectionPageSize,
                ...(Predicate.isUndefined(cursor) ? {} : { cursor }),
              },
            })
            .pipe(
              Effect.timeout("30 seconds"),
              Effect.mapError(
                mapBotCacheFailure(
                  MembersKick.authorizationPolicy.policy,
                  "workspace members",
                  discoverOperation,
                  operationError,
                ),
              ),
            );
          if (
            page.items.length > maximumBotCollectionPageSize ||
            (page.items.length === 0 && Predicate.isNotUndefined(page.nextCursor))
          ) {
            return yield* Effect.fail(
              operationError(
                discoverOperation,
                "The bot cache returned an inconsistent member page",
              ),
            );
          }
          for (const member of page.items) {
            if (seenMemberIds.has(member.userId)) {
              return yield* Effect.fail(
                operationError(discoverOperation, "The bot cache returned a duplicate member"),
              );
            }
            seenMemberIds.add(member.userId);
            if (member.roleIds.includes(context.roleId) && !scheduledIds.has(member.userId)) {
              targetIds.push(member.userId);
            }
          }
          if (Predicate.isUndefined(page.nextCursor)) {
            return { memberIds: canonicalSort(targetIds) };
          }
          if (seenCursors.has(page.nextCursor)) {
            return yield* Effect.fail(
              operationError(discoverOperation, "The bot cache returned a repeated member cursor"),
            );
          }
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
      });

    const removeRole: typeof MemberKickWorkflowOperations.Service.removeRole = (
      execution,
      memberId,
      deliveryKey,
    ) =>
      Effect.gen(function* () {
        yield* reauthorize(execution, removeOperation);
        const { context } = execution;
        if (Predicate.isNull(context.roleId)) {
          return yield* Effect.fail(
            operationError(removeOperation, "Resolved member cleanup role is missing"),
          );
        }
        const receipt = yield* delivery
          .get()
          .delivery.setMemberRole({
            payload: {
              workspace: workspaceRefFrom(client, context.workspaceId),
              userId: memberId,
              roleId: context.roleId,
              present: false,
              deliveryKey,
            },
          })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(
              mapDeliveryFailure(
                MembersKick.authorizationPolicy.policy,
                removeOperation,
                "member role",
                false,
                "The member role removal was rejected",
                operationError,
              ),
            ),
          );
        return validateRoleReceipt(receipt, {
          clientId,
          workspaceId: context.workspaceId,
          memberId,
          roleId: context.roleId,
          deliveryKey,
        })
          ? receipt
          : yield* Effect.fail(
              interactiveDeliveryRejected(
                removeOperation,
                "The member role removal receipt conflicted with the request",
                false,
              ),
            );
      });

    const respond: typeof MemberKickWorkflowOperations.Service.respond = (
      execution,
      message,
      deliveryKey,
      recoveryRequired,
    ) =>
      Effect.gen(function* () {
        yield* reauthorize(execution, responseOperation);
        const committedReference = recoveryRequired
          ? makeMemberKickSerializationKey(
              execution.context.clientId,
              execution.context.workspaceId,
              execution.context.runningConversationId,
              execution.context.hour,
              execution.context.roleId,
            )
          : undefined;
        const input = yield* decodeInput(execution.input);
        if (Predicate.isUndefined(input.responseReference)) {
          return yield* Effect.fail(
            interactiveInvalidRequest(
              "MissingMemberKickResponse",
              "User member cleanup requires a response reference",
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
            Effect.mapError(
              mapDeliveryFailure(
                MembersKick.authorizationPolicy.policy,
                responseOperation,
                "response",
                recoveryRequired,
                "The member cleanup response was rejected",
                operationError,
                committedReference,
              ),
            ),
          );
        return validateResponseReceipt(receipt, deliveryKey, input.responseReference)
          ? receipt
          : yield* Effect.fail(
              interactiveDeliveryRejected(
                responseOperation,
                "The member cleanup response receipt conflicted with the request",
                recoveryRequired,
                committedReference,
              ),
            );
      });

    return { discoverTargets, loadSchedule, removeRole, resolve, respond };
  }),
);

export const makeMemberKickResultMessage = (
  context: MemberKickContext,
  removedMemberIds: ReadonlyArray<string>,
  failedCount: number,
): typeof BotOutboundMessage.Type => {
  const content = Match.value(context.status).pipe(
    Match.when("tooEarly", () => [
      { type: "text" as const, text: "Cannot kick out until next hour starts" },
    ]),
    Match.when("missingRole", () => [
      { type: "text" as const, text: "No role configured for this conversation" },
    ]),
    Match.when("ready", () => {
      const removalSummary =
        removedMemberIds.length === 0
          ? [{ type: "text" as const, text: "No players were kicked out" }]
          : [
              { type: "text" as const, text: "Kicked out " },
              ...removedMemberIds.flatMap((userId, index) => [
                ...(index === 0 ? [] : [{ type: "text" as const, text: " " }]),
                { type: "userMention" as const, userId },
              ]),
            ];
      return failedCount === 0
        ? removalSummary
        : [
            ...removalSummary,
            { type: "text" as const, text: `; ${failedCount} role removal(s) failed` },
          ];
    }),
    Match.exhaustive,
  );
  return { content, allowedMentions: "none" };
};

export const makeMissingScheduleMemberKickMessage = (): typeof BotOutboundMessage.Type => ({
  content: "No schedule found for this conversation and hour; no players kicked out",
  allowedMentions: "none",
});
