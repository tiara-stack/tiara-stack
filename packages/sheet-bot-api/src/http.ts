import {
  HttpApi,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { BotAdmissionPolicies, annotateBotAdmissionPolicy } from "./admission";
import {
  BotApplication,
  BotCollectionPageRequest,
  BotConversation,
  BotConversationPage,
  BotMember,
  BotMemberPage,
  BotRole,
  BotRoles,
  BotUserProfile,
  BotWorkspace,
} from "./cache";
import {
  DeleteMessageInput,
  DeleteMessageReceipt,
  EditMessageInput,
  EditMessageReceipt,
  ReplaceConversationPermissionOverwritesInput,
  ReplaceConversationPermissionOverwritesReceipt,
  RespondInput,
  RespondReceipt,
  SendMessageInput,
  SendMessageReceipt,
  SetMemberRoleInput,
  SetMemberRoleReceipt,
  SetMessagePinnedInput,
  SetMessagePinnedReceipt,
  SetMessageReactionInput,
  SetMessageReactionReceipt,
} from "./delivery";
import { BotCacheReadErrors, BotDeliveryErrors } from "./errors";
import { ClientPlatform, ClientRef, ConversationRef, WorkspaceRef } from "./references";
import { Schema } from "effect";

const ClientParams = Schema.Struct({
  platform: ClientPlatform,
  clientId: ClientRef.fields.clientId,
});

const WorkspaceParams = Schema.Struct({
  ...ClientParams.fields,
  workspaceId: WorkspaceRef.fields.workspaceId,
});

const ConversationParams = Schema.Struct({
  ...WorkspaceParams.fields,
  conversationId: ConversationRef.fields.conversationId,
});

const RoleParams = Schema.Struct({
  ...WorkspaceParams.fields,
  roleId: Schema.String,
});

const MemberParams = Schema.Struct({
  ...WorkspaceParams.fields,
  userId: Schema.String,
});

const UserParams = Schema.Struct({
  ...ClientParams.fields,
  userId: Schema.String,
});

const cacheRead = <Endpoint extends HttpApiEndpoint.AnyWithProps>(endpoint: Endpoint) =>
  annotateBotAdmissionPolicy(endpoint, BotAdmissionPolicies.cacheRead);

const deliveryWrite = <Endpoint extends HttpApiEndpoint.AnyWithProps>(endpoint: Endpoint) =>
  annotateBotAdmissionPolicy(endpoint, BotAdmissionPolicies.deliveryWrite);

export const BotCacheEndpoints = Object.freeze({
  getApplication: cacheRead(
    HttpApiEndpoint.get("getApplication", "/internal/bot/clients/:platform/:clientId/application", {
      params: ClientParams,
      success: BotApplication,
      error: BotCacheReadErrors,
    }),
  ),
  getUserProfile: cacheRead(
    HttpApiEndpoint.get(
      "getUserProfile",
      "/internal/bot/clients/:platform/:clientId/users/:userId/profile",
      {
        params: UserParams,
        success: BotUserProfile,
        error: BotCacheReadErrors,
      },
    ),
  ),
  getWorkspace: cacheRead(
    HttpApiEndpoint.get(
      "getWorkspace",
      "/internal/bot/clients/:platform/:clientId/workspaces/:workspaceId",
      {
        params: WorkspaceParams,
        success: BotWorkspace,
        error: BotCacheReadErrors,
      },
    ),
  ),
  getConversation: cacheRead(
    HttpApiEndpoint.get(
      "getConversation",
      "/internal/bot/clients/:platform/:clientId/workspaces/:workspaceId/conversations/:conversationId",
      {
        params: ConversationParams,
        success: BotConversation,
        error: BotCacheReadErrors,
      },
    ),
  ),
  listConversations: cacheRead(
    HttpApiEndpoint.get(
      "listConversations",
      "/internal/bot/clients/:platform/:clientId/workspaces/:workspaceId/conversations",
      {
        params: WorkspaceParams,
        query: BotCollectionPageRequest,
        success: BotConversationPage,
        error: BotCacheReadErrors,
      },
    ),
  ),
  getRole: cacheRead(
    HttpApiEndpoint.get(
      "getRole",
      "/internal/bot/clients/:platform/:clientId/workspaces/:workspaceId/roles/:roleId",
      {
        params: RoleParams,
        success: BotRole,
        error: BotCacheReadErrors,
      },
    ),
  ),
  listRoles: cacheRead(
    HttpApiEndpoint.get(
      "listRoles",
      "/internal/bot/clients/:platform/:clientId/workspaces/:workspaceId/roles",
      {
        params: WorkspaceParams,
        success: BotRoles,
        error: BotCacheReadErrors,
      },
    ),
  ),
  getMember: cacheRead(
    HttpApiEndpoint.get(
      "getMember",
      "/internal/bot/clients/:platform/:clientId/workspaces/:workspaceId/members/:userId",
      {
        params: MemberParams,
        success: BotMember,
        error: BotCacheReadErrors,
      },
    ),
  ),
  listMembers: cacheRead(
    HttpApiEndpoint.get(
      "listMembers",
      "/internal/bot/clients/:platform/:clientId/workspaces/:workspaceId/members",
      {
        params: WorkspaceParams,
        query: BotCollectionPageRequest,
        success: BotMemberPage,
        error: BotCacheReadErrors,
      },
    ),
  ),
});

export const BotDeliveryEndpoints = Object.freeze({
  respond: deliveryWrite(
    HttpApiEndpoint.post("respond", "/internal/bot/delivery/responses", {
      payload: RespondInput,
      success: RespondReceipt,
      error: BotDeliveryErrors,
    }),
  ),
  sendMessage: deliveryWrite(
    HttpApiEndpoint.post("sendMessage", "/internal/bot/delivery/messages/send", {
      payload: SendMessageInput,
      success: SendMessageReceipt,
      error: BotDeliveryErrors,
    }),
  ),
  editMessage: deliveryWrite(
    HttpApiEndpoint.patch("editMessage", "/internal/bot/delivery/messages/edit", {
      payload: EditMessageInput,
      success: EditMessageReceipt,
      error: BotDeliveryErrors,
    }),
  ),
  deleteMessage: deliveryWrite(
    HttpApiEndpoint.post("deleteMessage", "/internal/bot/delivery/messages/delete", {
      payload: DeleteMessageInput,
      success: DeleteMessageReceipt,
      error: BotDeliveryErrors,
    }),
  ),
  setMessagePinned: deliveryWrite(
    HttpApiEndpoint.post("setMessagePinned", "/internal/bot/delivery/messages/pinned", {
      payload: SetMessagePinnedInput,
      success: SetMessagePinnedReceipt,
      error: BotDeliveryErrors,
    }),
  ),
  setMessageReaction: deliveryWrite(
    HttpApiEndpoint.post("setMessageReaction", "/internal/bot/delivery/messages/reactions", {
      payload: SetMessageReactionInput,
      success: SetMessageReactionReceipt,
      error: BotDeliveryErrors,
    }),
  ),
  setMemberRole: deliveryWrite(
    HttpApiEndpoint.post("setMemberRole", "/internal/bot/delivery/members/roles", {
      payload: SetMemberRoleInput,
      success: SetMemberRoleReceipt,
      error: BotDeliveryErrors,
    }),
  ),
  replaceConversationPermissionOverwrites: deliveryWrite(
    HttpApiEndpoint.put(
      "replaceConversationPermissionOverwrites",
      "/internal/bot/delivery/conversations/permission-overwrites",
      {
        payload: ReplaceConversationPermissionOverwritesInput,
        success: ReplaceConversationPermissionOverwritesReceipt,
        error: BotDeliveryErrors,
      },
    ),
  ),
});

export class BotCacheApi extends HttpApiGroup.make("cache")
  .add(BotCacheEndpoints.getApplication)
  .add(BotCacheEndpoints.getUserProfile)
  .add(BotCacheEndpoints.getWorkspace)
  .add(BotCacheEndpoints.getConversation)
  .add(BotCacheEndpoints.listConversations)
  .add(BotCacheEndpoints.getRole)
  .add(BotCacheEndpoints.listRoles)
  .add(BotCacheEndpoints.getMember)
  .add(BotCacheEndpoints.listMembers)
  .annotate(OpenApi.Title, "Sheet Bot Cache")
  .annotate(OpenApi.Description, "Typed internal bot cache reads") {}

export class BotDeliveryApi extends HttpApiGroup.make("delivery")
  .add(BotDeliveryEndpoints.respond)
  .add(BotDeliveryEndpoints.sendMessage)
  .add(BotDeliveryEndpoints.editMessage)
  .add(BotDeliveryEndpoints.deleteMessage)
  .add(BotDeliveryEndpoints.setMessagePinned)
  .add(BotDeliveryEndpoints.setMessageReaction)
  .add(BotDeliveryEndpoints.setMemberRole)
  .add(BotDeliveryEndpoints.replaceConversationPermissionOverwrites)
  .annotate(OpenApi.Title, "Sheet Bot Delivery")
  .annotate(OpenApi.Description, "Typed, idempotent internal bot delivery writes") {}

export const SheetBotApiId = "sheet-bot";

export class SheetBotApi extends HttpApi.make(SheetBotApiId)
  .add(BotCacheApi)
  .add(BotDeliveryApi)
  .annotate(OpenApi.Title, "Sheet Bot API")
  .annotate(
    OpenApi.Description,
    "Internal cache-read and delivery capabilities implemented by sheet-bot",
  ) {}

export type SheetBotHttpClient = HttpApiClient.ForApi<typeof SheetBotApi>;

export const makeSheetBotHttpClient = (baseUrl: string) =>
  HttpApiClient.make(SheetBotApi, { baseUrl });

export const SheetBotHttpClientMetadata = Object.freeze({
  apiId: SheetBotApiId,
  audience: BotAdmissionPolicies.cacheRead.audience,
  groups: Object.freeze({
    cache: Object.freeze({
      requiredScope: BotAdmissionPolicies.cacheRead.requiredScope,
      operations: Object.freeze(Object.keys(BotCacheEndpoints)),
    }),
    delivery: Object.freeze({
      requiredScope: BotAdmissionPolicies.deliveryWrite.requiredScope,
      operations: Object.freeze(Object.keys(BotDeliveryEndpoints)),
    }),
  }),
} as const);
