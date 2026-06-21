import { AuthorizationService } from "@/services";
import { Context, Effect } from "effect";

type AuthorizationServiceApi = Context.Service.Shape<typeof AuthorizationService>;

export type MessageRecordOverrides = {
  readonly workspaceId?: string | null;
  readonly conversationId?: string | null;
};

export const messageKey = {
  clientPlatform: "discord" as const,
  clientId: "discord-main",
  messageId: "message-1",
};

export const resolveMessageRecordRefs = (
  overrides: MessageRecordOverrides | undefined,
  defaults: { readonly workspaceId: string; readonly conversationId: string },
) => ({
  workspaceId: overrides?.workspaceId !== undefined ? overrides.workspaceId : defaults.workspaceId,
  conversationId:
    overrides?.conversationId !== undefined ? overrides.conversationId : defaults.conversationId,
});

export const withAuthorization = Effect.fnUntraced(function* <A, E, R>(
  f: (authorizationService: AuthorizationServiceApi) => Effect.Effect<A, E, R>,
) {
  const authorizationService = yield* AuthorizationService.make;
  return yield* f(authorizationService);
});
