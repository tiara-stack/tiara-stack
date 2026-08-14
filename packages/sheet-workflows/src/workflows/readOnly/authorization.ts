import { Context, Effect, Layer, Match, Option, Predicate, Schema } from "effect";
import { WorkflowInvocationUnauthorized } from "effect-zero-workflow/contract/transport";
import type { AnyWorkflowContract } from "effect-zero-workflow/contract";
import type { EffectivePrincipal } from "sheet-auth/identity";
import { BotDependencyUnavailable, BotTextPart, type SheetBotHttpClient } from "sheet-bot-api";
import {
  AuthorizationLoadWorkspaceCapabilities,
  CheckinsRespond,
  RoomOrdersNavigate,
  RoomOrdersPinTentative,
  RoomOrdersSend,
  ServicesDeliverStatus,
  SlotsOpen,
  type SheetWorkflowAuthorizationPolicyMetadata,
  WorkspaceId,
} from "sheet-workflow-contracts";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { config } from "@/config";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";

export const ownerKeyForEffectivePrincipal = (principal: EffectivePrincipal): string =>
  Match.type<EffectivePrincipal>().pipe(
    Match.discriminatorsExhaustive("kind")({
      user: ({ userId }) => `user:${userId}`,
      service: ({ serviceId }) => `service:${serviceId}`,
    }),
  )(principal);

interface WorkspaceCapabilitySnapshot {
  readonly member: boolean;
  readonly monitor: boolean;
  readonly manage: boolean;
  readonly participant: boolean;
  readonly appOwner: boolean;
}

export const AuthorizedSlotOpenContext = Schema.Struct({
  clientPlatform: Schema.Literal("discord"),
  clientId: Schema.String,
  messageId: Schema.String,
  workspaceId: WorkspaceId,
  conversationId: Schema.String,
  day: Schema.Number,
});
export type AuthorizedSlotOpenContext = typeof AuthorizedSlotOpenContext.Type;

export const AuthorizedCheckinRespondContext = Schema.Struct({
  clientPlatform: Schema.Literal("discord"),
  clientId: Schema.String,
  messageId: Schema.String,
  workspaceId: WorkspaceId,
  conversationId: Schema.String,
  memberId: Schema.String,
  runningConversationId: Schema.String,
  roleId: Schema.NullOr(Schema.String),
  initialMessage: Schema.Array(BotTextPart),
});
export type AuthorizedCheckinRespondContext = typeof AuthorizedCheckinRespondContext.Type;

export const AuthorizedRoomOrderCreateContext = Schema.Struct({
  clientPlatform: Schema.Literal("discord"),
  clientId: Schema.String,
  workspaceId: WorkspaceId,
  creatorAccountId: Schema.String,
});
export type AuthorizedRoomOrderCreateContext = typeof AuthorizedRoomOrderCreateContext.Type;

export const AuthorizedRoomOrderNavigateContext = Schema.Struct({
  clientPlatform: Schema.Literal("discord"),
  clientId: Schema.String,
  messageId: Schema.String,
  workspaceId: WorkspaceId,
  conversationId: Schema.String,
  previousFills: Schema.Array(Schema.String),
  fills: Schema.Array(Schema.String),
  hour: Schema.Number,
  rank: Schema.Int,
  tentative: Schema.Boolean,
  monitor: Schema.NullOr(Schema.String),
});
export type AuthorizedRoomOrderNavigateContext = typeof AuthorizedRoomOrderNavigateContext.Type;

export const AuthorizedRoomOrderSendContext = Schema.Struct({
  ...AuthorizedRoomOrderNavigateContext.fields,
  sendClaimId: Schema.NullOr(Schema.String),
  sentMessageId: Schema.NullOr(Schema.String),
  sentConversationId: Schema.NullOr(Schema.String),
  tentativeUpdateClaimId: Schema.NullOr(Schema.String),
  tentativePinClaimId: Schema.NullOr(Schema.String),
  tentativePinnedAt: Schema.NullOr(Schema.Number),
});
export type AuthorizedRoomOrderSendContext = typeof AuthorizedRoomOrderSendContext.Type;

export const AuthorizedRoomOrderPinTentativeContext = AuthorizedRoomOrderSendContext;
export type AuthorizedRoomOrderPinTentativeContext =
  typeof AuthorizedRoomOrderPinTentativeContext.Type;

type CanonicalCheckinKey = Pick<
  AuthorizedCheckinRespondContext,
  "clientPlatform" | "clientId" | "messageId" | "memberId"
>;

export const isCanonicalCheckinParticipant = (
  key: CanonicalCheckinKey,
  participant: {
    readonly clientPlatform: string;
    readonly clientId: string;
    readonly messageId: string;
    readonly memberId: string;
    readonly deletedAt: number | null;
  },
): boolean =>
  participant.clientPlatform === key.clientPlatform &&
  participant.clientId === key.clientId &&
  participant.messageId === key.messageId &&
  participant.memberId === key.memberId &&
  Predicate.isNull(participant.deletedAt);

const decodeCheckinInitialMessage = Schema.decodeUnknownOption(Schema.Array(BotTextPart));
const decodeWorkspaceId = Schema.decodeUnknownOption(WorkspaceId);

type MessageCheckinRow = Option.Option.Value<
  Effect.Success<ReturnType<TrustedSheetPersistenceShape["checkinState"]["getMessageCheckinData"]>>
>;
type MessageCheckinMemberRow = Effect.Success<
  ReturnType<TrustedSheetPersistenceShape["checkinState"]["getMessageCheckinMembers"]>
>[number];

const authorizedCheckinContext = (
  key: Pick<AuthorizedCheckinRespondContext, "clientPlatform" | "clientId" | "messageId">,
  memberId: string,
  messageCheckin: MessageCheckinRow,
  members: ReadonlyArray<MessageCheckinMemberRow>,
): Option.Option<AuthorizedCheckinRespondContext> => {
  const participant = members.find((member) => member.memberId === memberId);
  return Option.all({
    workspaceId: decodeWorkspaceId(messageCheckin.workspaceId),
    conversationId: Option.fromNullishOr(messageCheckin.conversationId),
    createdByUserId: Option.fromNullishOr(messageCheckin.createdByUserId),
    initialMessage: decodeCheckinInitialMessage(messageCheckin.initialMessage),
    participant: Option.fromNullishOr(participant),
  }).pipe(
    Option.filter(({ participant: canonicalParticipant }) =>
      [
        messageCheckin.clientPlatform === key.clientPlatform,
        messageCheckin.clientId === key.clientId,
        messageCheckin.messageId === key.messageId,
        messageCheckin.runningConversationId.length > 0,
        isCanonicalCheckinParticipant({ ...key, memberId }, canonicalParticipant),
      ].every(Predicate.isTruthy),
    ),
    Option.map(({ conversationId, initialMessage, workspaceId }) => ({
      ...key,
      workspaceId,
      conversationId,
      memberId,
      runningConversationId: messageCheckin.runningConversationId,
      roleId: messageCheckin.roleId,
      initialMessage,
    })),
  );
};

type MethodError<Method> = Method extends (
  ...args: infer _Args
) => Effect.Effect<infer _Success, infer Error, infer _Requirements>
  ? Error
  : never;

type WorkspaceCapabilityLookupError =
  | MethodError<SheetBotHttpClient["cache"]["getApplication"]>
  | MethodError<TrustedSheetPersistenceShape["workspaces"]["getWorkspaceMonitorRoles"]>;

type CheckinAuthorizationLookupError =
  | WorkspaceCapabilityLookupError
  | MethodError<TrustedSheetPersistenceShape["checkinState"]["getMessageCheckinData"]>;

type RoomOrderAuthorizationLookupError =
  | WorkspaceCapabilityLookupError
  | MethodError<TrustedSheetPersistenceShape["roomOrderState"]["getMessageRoomOrder"]>;

interface ReadOnlyWorkflowAuthorizationShape {
  readonly workspaceCapabilities: (
    principal: EffectivePrincipal,
    workspaceId: string,
  ) => Effect.Effect<WorkspaceCapabilitySnapshot, WorkspaceCapabilityLookupError>;
  readonly authorize: <Contract extends AnyWorkflowContract>(
    contract: Contract,
    principal: EffectivePrincipal,
    input: unknown,
  ) => Effect.Effect<void, WorkflowInvocationUnauthorized | CheckinAuthorizationLookupError>;
  readonly authorizeSlotOpen: (
    principal: EffectivePrincipal,
    input: unknown,
  ) => Effect.Effect<
    AuthorizedSlotOpenContext,
    WorkflowInvocationUnauthorized | WorkspaceCapabilityLookupError
  >;
  readonly authorizeCheckinRespond: (
    principal: EffectivePrincipal,
    input: unknown,
  ) => Effect.Effect<
    AuthorizedCheckinRespondContext,
    WorkflowInvocationUnauthorized | CheckinAuthorizationLookupError
  >;
  readonly authorizeRoomOrdersNavigate: (
    principal: EffectivePrincipal,
    input: unknown,
  ) => Effect.Effect<
    AuthorizedRoomOrderNavigateContext,
    WorkflowInvocationUnauthorized | RoomOrderAuthorizationLookupError
  >;
  readonly authorizeRoomOrdersSend: (
    principal: EffectivePrincipal,
    input: unknown,
  ) => Effect.Effect<
    AuthorizedRoomOrderSendContext,
    WorkflowInvocationUnauthorized | RoomOrderAuthorizationLookupError
  >;
  readonly authorizeRoomOrdersPinTentative: (
    principal: EffectivePrincipal,
    input: unknown,
  ) => Effect.Effect<
    AuthorizedRoomOrderPinTentativeContext,
    WorkflowInvocationUnauthorized | RoomOrderAuthorizationLookupError
  >;
}

export class ReadOnlyWorkflowAuthorization extends Context.Service<
  ReadOnlyWorkflowAuthorization,
  ReadOnlyWorkflowAuthorizationShape
>()("sheet-workflows/ReadOnlyWorkflowAuthorization") {}

const unauthorized = () =>
  new WorkflowInvocationUnauthorized({ message: "Workflow invocation is unauthorized" });

const stringFieldFromInput = (input: unknown, field: string): string | undefined =>
  Predicate.hasProperty(field)(input) && Predicate.isString(input[field])
    ? input[field]
    : undefined;

const hasManageWorkspace = (permissions: string): boolean =>
  Option.liftThrowable((value: string) => BigInt(value))(permissions).pipe(
    Option.exists((value) => value >= 0n && (value & 32n) === 32n),
  );

const noWorkspaceCapabilities = (): WorkspaceCapabilitySnapshot => ({
  member: false,
  monitor: false,
  manage: false,
  participant: false,
  appOwner: false,
});

const hasRequiredCapabilities = (
  requiredCapabilities: SheetWorkflowAuthorizationPolicyMetadata["requiredCapabilities"],
  capabilities: WorkspaceCapabilitySnapshot,
): boolean =>
  requiredCapabilities.every((required) =>
    Match.value(required).pipe(
      Match.when("workspace.member", () => capabilities.member),
      Match.when("workspace.monitor", () => capabilities.monitor),
      Match.when("workspace.manage", () => capabilities.manage),
      Match.when("workspace.participant", () => capabilities.participant),
      Match.when("application.owner", () => capabilities.appOwner),
      Match.when("self", () => false),
      Match.when("service.allowed", () => false),
      Match.exhaustive,
    ),
  );

const authorizeTargetUser = (
  principal: EffectivePrincipal,
  input: unknown,
  policy: SheetWorkflowAuthorizationPolicyMetadata,
  workspaceId: string,
  workspaceCapabilities: ReadOnlyWorkflowAuthorizationShape["workspaceCapabilities"],
) => {
  const targetUserId = stringFieldFromInput(input, policy.targetUserField ?? "targetUserId");
  if (Predicate.isUndefined(targetUserId)) return Effect.fail(unauthorized());
  return Match.type<EffectivePrincipal>().pipe(
    Match.discriminatorsExhaustive("kind")({
      service: () => Effect.fail(unauthorized()),
      user: (userPrincipal) =>
        userPrincipal.discordAccount?.accountId === targetUserId
          ? Effect.void
          : workspaceCapabilities(userPrincipal, workspaceId).pipe(
              Effect.filterOrFail(({ appOwner, monitor }) => appOwner || monitor, unauthorized),
              Effect.asVoid,
            ),
    }),
  )(principal);
};

const isForbiddenEmptyWorkspacePolicy = (
  contractIdentity: string,
  policy: SheetWorkflowAuthorizationPolicyMetadata,
): boolean =>
  policy.resource === "workspace" &&
  policy.requiredCapabilities.length === 0 &&
  Predicate.isUndefined(policy.userRule) &&
  contractIdentity !== AuthorizationLoadWorkspaceCapabilities.identity;

export const readOnlyWorkflowAuthorizationLayer = Layer.effect(
  ReadOnlyWorkflowAuthorization,
  Effect.gen(function* () {
    const bot = yield* SheetBotCacheClient;
    const persistence = yield* TrustedSheetPersistence;
    const clientId = yield* config.sheetBotClientId;
    const client = { platform: "discord", clientId } as const;

    const workspaceCapabilities: ReadOnlyWorkflowAuthorizationShape["workspaceCapabilities"] = (
      principal,
      workspaceId,
    ) =>
      Match.type<EffectivePrincipal>().pipe(
        Match.discriminatorsExhaustive("kind")({
          service: () => Effect.succeed(noWorkspaceCapabilities()),
          user: ({ discordAccount }) => {
            if (Predicate.isUndefined(discordAccount)) {
              return Effect.succeed(noWorkspaceCapabilities());
            }
            const params = { ...client, workspaceId };
            return Effect.all(
              {
                application: bot.get().cache.getApplication({ params: client }),
                member: bot
                  .get()
                  .cache.getMember({ params: { ...params, userId: discordAccount.accountId } })
                  .pipe(
                    Effect.map(Option.some),
                    Effect.catchTag("BotResourceNotFound", () => Effect.succeedNone),
                  ),
              },
              { concurrency: "unbounded" },
            ).pipe(
              Effect.flatMap(({ application, member }) => {
                const appOwner = application.ownerId === discordAccount.accountId;
                return Option.match(member, {
                  onNone: () => Effect.succeed({ ...noWorkspaceCapabilities(), appOwner }),
                  onSome: (workspaceMember) =>
                    Effect.all(
                      {
                        roles: bot.get().cache.listRoles({ params }),
                        workspace: bot.get().cache.getWorkspace({ params }),
                        monitorRoles: persistence.workspaces.getWorkspaceMonitorRoles({
                          workspaceId,
                        }),
                      },
                      { concurrency: "unbounded" },
                    ).pipe(
                      Effect.map(({ monitorRoles, roles, workspace }) => {
                        const memberRoleIds = new Set(workspaceMember.roleIds);
                        const monitorRoleIds = new Set(monitorRoles.map(({ roleId }) => roleId));
                        return {
                          member: true,
                          monitor: workspaceMember.roleIds.some((roleId) =>
                            monitorRoleIds.has(roleId),
                          ),
                          manage:
                            workspace.ownerId === discordAccount.accountId ||
                            roles.some(
                              (role) =>
                                memberRoleIds.has(role.id) && hasManageWorkspace(role.permissions),
                            ),
                          participant: false,
                          appOwner,
                        };
                      }),
                    ),
                });
              }),
            );
          },
        }),
      )(principal);

    const authorizeSlotOpen: ReadOnlyWorkflowAuthorizationShape["authorizeSlotOpen"] = (
      principal,
      input,
    ) => {
      const policy = SlotsOpen.authorizationPolicy;
      const messageId = stringFieldFromInput(input, policy.resourceField ?? "messageId");
      if (
        !policy.principalKinds.includes(principal.kind) ||
        principal.kind !== "user" ||
        Predicate.isUndefined(principal.discordAccount) ||
        Predicate.isUndefined(messageId)
      ) {
        return Effect.fail(unauthorized());
      }
      return persistence.slotState
        .getMessageSlotData({
          clientPlatform: client.platform,
          clientId: client.clientId,
          messageId,
        })
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(unauthorized()),
              onSome: (messageSlot) => {
                if (
                  messageSlot.clientPlatform !== client.platform ||
                  messageSlot.clientId !== client.clientId ||
                  messageSlot.messageId !== messageId ||
                  Predicate.isNull(messageSlot.workspaceId) ||
                  Predicate.isNull(messageSlot.conversationId)
                ) {
                  return Effect.fail(unauthorized());
                }
                const workspaceId = Option.getOrUndefined(
                  Schema.decodeUnknownOption(WorkspaceId)(messageSlot.workspaceId),
                );
                if (Predicate.isUndefined(workspaceId)) return Effect.fail(unauthorized());
                return workspaceCapabilities(principal, workspaceId).pipe(
                  Effect.filterOrFail(({ member }) => member, unauthorized),
                  Effect.as({
                    clientPlatform: client.platform,
                    clientId: client.clientId,
                    messageId,
                    workspaceId,
                    conversationId: messageSlot.conversationId,
                    day: messageSlot.day,
                  }),
                );
              },
            }),
          ),
        );
    };

    const authorizeCheckinRespond: ReadOnlyWorkflowAuthorizationShape["authorizeCheckinRespond"] = (
      principal,
      input,
    ) => {
      const policy = CheckinsRespond.authorizationPolicy;
      const messageId = stringFieldFromInput(input, policy.resourceField ?? "messageId");
      if (
        !policy.principalKinds.includes(principal.kind) ||
        principal.kind !== "user" ||
        Predicate.isUndefined(principal.discordAccount) ||
        Predicate.isUndefined(messageId)
      ) {
        return Effect.fail(unauthorized());
      }
      const memberId = principal.discordAccount.accountId;
      const key = {
        clientPlatform: client.platform,
        clientId: client.clientId,
        messageId,
      } as const;
      return Effect.all(
        {
          checkin: persistence.checkinState.getMessageCheckinData(key),
          members: persistence.checkinState.getMessageCheckinMembers(key),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap(({ checkin, members }) =>
          Option.match(checkin, {
            onNone: () => Effect.fail(unauthorized()),
            onSome: (messageCheckin) =>
              authorizedCheckinContext(key, memberId, messageCheckin, members).pipe(
                Option.match({
                  onNone: () => Effect.fail(unauthorized()),
                  onSome: (authorized) =>
                    workspaceCapabilities(principal, authorized.workspaceId).pipe(
                      Effect.filterOrFail(({ member }) => member, unauthorized),
                      Effect.as(authorized),
                    ),
                }),
              ),
          }),
        ),
      );
    };

    const authorizeRoomOrder = (
      principal: EffectivePrincipal,
      input: unknown,
      policy: SheetWorkflowAuthorizationPolicyMetadata,
    ) => {
      const messageId = stringFieldFromInput(input, policy.resourceField ?? "messageId");
      if (
        !policy.principalKinds.includes(principal.kind) ||
        principal.kind !== "user" ||
        Predicate.isUndefined(principal.discordAccount) ||
        Predicate.isUndefined(messageId)
      ) {
        return Effect.fail(unauthorized());
      }
      const key = {
        clientPlatform: client.platform,
        clientId: client.clientId,
        messageId,
      } as const;
      return persistence.roomOrderState.getMessageRoomOrder(key).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(unauthorized()),
            onSome: (roomOrder) => {
              if (
                roomOrder.clientPlatform !== key.clientPlatform ||
                roomOrder.clientId !== key.clientId ||
                roomOrder.messageId !== key.messageId ||
                Predicate.isNotNull(roomOrder.deletedAt) ||
                Predicate.isNull(roomOrder.workspaceId) ||
                Predicate.isNull(roomOrder.conversationId)
              ) {
                return Effect.fail(unauthorized());
              }
              const workspaceId = Option.getOrUndefined(
                Schema.decodeUnknownOption(WorkspaceId)(roomOrder.workspaceId),
              );
              if (Predicate.isUndefined(workspaceId)) return Effect.fail(unauthorized());
              const authorized = {
                ...key,
                workspaceId,
                conversationId: roomOrder.conversationId,
                roomOrder,
              };
              return workspaceCapabilities(principal, workspaceId).pipe(
                Effect.filterOrFail(
                  (capabilities) =>
                    hasRequiredCapabilities(policy.requiredCapabilities, capabilities),
                  unauthorized,
                ),
                Effect.as(authorized),
              );
            },
          }),
        ),
      );
    };

    const roomOrderNavigateFields = (
      roomOrder: Pick<
        AuthorizedRoomOrderNavigateContext,
        "previousFills" | "fills" | "hour" | "rank" | "tentative" | "monitor"
      >,
    ) => ({
      previousFills: roomOrder.previousFills,
      fills: roomOrder.fills,
      hour: roomOrder.hour,
      rank: roomOrder.rank,
      tentative: roomOrder.tentative,
      monitor: roomOrder.monitor,
    });

    const authorizeRoomOrdersNavigate: ReadOnlyWorkflowAuthorizationShape["authorizeRoomOrdersNavigate"] =
      (principal, input) =>
        authorizeRoomOrder(principal, input, RoomOrdersNavigate.authorizationPolicy).pipe(
          Effect.map(({ roomOrder, ...authorized }) => ({
            ...authorized,
            ...roomOrderNavigateFields(roomOrder),
          })),
        );

    const authorizeRoomOrderSendShape = (
      principal: EffectivePrincipal,
      input: unknown,
      policy: SheetWorkflowAuthorizationPolicyMetadata,
    ) =>
      authorizeRoomOrder(principal, input, policy).pipe(
        Effect.filterOrFail(
          ({ roomOrder }) =>
            Predicate.isNull(roomOrder.sentMessageId) ===
            Predicate.isNull(roomOrder.sentConversationId),
          unauthorized,
        ),
        Effect.map(({ roomOrder, ...authorized }) => ({
          ...authorized,
          ...roomOrderNavigateFields(roomOrder),
          sendClaimId: roomOrder.sendClaimId,
          sentMessageId: roomOrder.sentMessageId,
          sentConversationId: roomOrder.sentConversationId,
          tentativeUpdateClaimId: roomOrder.tentativeUpdateClaimId,
          tentativePinClaimId: roomOrder.tentativePinClaimId,
          tentativePinnedAt: roomOrder.tentativePinnedAt,
        })),
      );

    const authorizeRoomOrdersSend: ReadOnlyWorkflowAuthorizationShape["authorizeRoomOrdersSend"] = (
      principal,
      input,
    ) => authorizeRoomOrderSendShape(principal, input, RoomOrdersSend.authorizationPolicy);

    const authorizeRoomOrdersPinTentative: ReadOnlyWorkflowAuthorizationShape["authorizeRoomOrdersPinTentative"] =
      (principal, input) =>
        authorizeRoomOrderSendShape(principal, input, RoomOrdersPinTentative.authorizationPolicy);

    const authorizeApplicationOwner = (principal: EffectivePrincipal) =>
      Match.type<EffectivePrincipal>().pipe(
        Match.discriminatorsExhaustive("kind")({
          service: () => Effect.fail(unauthorized()),
          user: ({ discordAccount }) =>
            Predicate.isUndefined(discordAccount)
              ? Effect.fail(unauthorized())
              : bot
                  .get()
                  .cache.getApplication({ params: client })
                  .pipe(
                    Effect.timeout("30 seconds"),
                    Effect.catchTag("BotResourceNotFound", () => Effect.fail(unauthorized())),
                    Effect.catchTag("TimeoutError", () =>
                      Effect.fail(
                        new BotDependencyUnavailable({
                          message: "Bot application cache lookup timed out",
                        }),
                      ),
                    ),
                    Effect.filterOrFail(
                      ({ ownerId }) => ownerId === discordAccount.accountId,
                      unauthorized,
                    ),
                    Effect.asVoid,
                  ),
        }),
      )(principal);

    // fallow-ignore-next-line complexity
    const authorize: ReadOnlyWorkflowAuthorizationShape["authorize"] = (
      contract,
      principal,
      input,
    ) => {
      const policy = contract.authorizationPolicy as SheetWorkflowAuthorizationPolicyMetadata;
      const principalAllowed = policy.principalKinds.includes(principal.kind);
      if (!principalAllowed) return Effect.fail(unauthorized());
      if (contract.identity === SlotsOpen.identity) {
        return authorizeSlotOpen(principal, input).pipe(Effect.asVoid);
      }
      if (contract.identity === CheckinsRespond.identity) {
        return authorizeCheckinRespond(principal, input).pipe(Effect.asVoid);
      }
      if (contract.identity === RoomOrdersNavigate.identity) {
        return authorizeRoomOrdersNavigate(principal, input).pipe(Effect.asVoid);
      }
      if (contract.identity === RoomOrdersSend.identity) {
        return authorizeRoomOrdersSend(principal, input).pipe(Effect.asVoid);
      }
      if (contract.identity === RoomOrdersPinTentative.identity) {
        return authorizeRoomOrdersPinTentative(principal, input).pipe(Effect.asVoid);
      }
      if (contract.identity === ServicesDeliverStatus.identity) {
        return authorizeApplicationOwner(principal);
      }
      if (isForbiddenEmptyWorkspacePolicy(contract.identity, policy)) {
        return Effect.fail(unauthorized());
      }
      if (policy.resource === "self") {
        return Match.type<EffectivePrincipal>().pipe(
          Match.discriminatorsExhaustive("kind")({
            service: () => Effect.fail(unauthorized()),
            user: ({ discordAccount }) =>
              Predicate.isNotUndefined(discordAccount) ? Effect.void : Effect.fail(unauthorized()),
          }),
        )(principal);
      }
      if (policy.resource !== "workspace") return Effect.fail(unauthorized());
      const workspaceId = stringFieldFromInput(input, policy.resourceField ?? "workspaceId");
      if (Predicate.isUndefined(workspaceId)) return Effect.fail(unauthorized());
      return Match.value(policy.userRule).pipe(
        Match.when("target-user-or-workspace-monitor-or-application-owner", () =>
          authorizeTargetUser(principal, input, policy, workspaceId, workspaceCapabilities),
        ),
        Match.when(Predicate.isUndefined, () =>
          workspaceCapabilities(principal, workspaceId).pipe(
            Effect.filterOrFail(
              (capabilities) => hasRequiredCapabilities(policy.requiredCapabilities, capabilities),
              unauthorized,
            ),
            Effect.asVoid,
          ),
        ),
        Match.exhaustive,
      );
    };
    return {
      authorize,
      authorizeCheckinRespond,
      authorizeRoomOrdersNavigate,
      authorizeRoomOrdersPinTentative,
      authorizeRoomOrdersSend,
      authorizeSlotOpen,
      workspaceCapabilities,
    };
  }),
);
