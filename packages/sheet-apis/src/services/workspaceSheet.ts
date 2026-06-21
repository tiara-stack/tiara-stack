import { Context, Effect, Option, Predicate, pipe } from "effect";
import { makeArgumentError } from "typhoon-core/error";
import { WorkspaceConfigService } from "./workspaceConfig";

type WorkspaceConfigServiceApi = Context.Service.Shape<typeof WorkspaceConfigService>;

type ConversationPayload = {
  readonly conversationId?: string | undefined;
  readonly conversationName?: string | undefined;
};

const nonEmptyString = (value: unknown): value is string =>
  Predicate.isString(value) && value.trim().length > 0;

export const getSheetIdFromWorkspaceId = (
  workspaceId: string,
  workspaceConfigService: WorkspaceConfigServiceApi,
  action: string,
) =>
  workspaceConfigService.getWorkspaceConfig(workspaceId).pipe(
    Effect.flatMap(
      Option.match({
        onSome: (workspaceConfig) =>
          pipe(
            workspaceConfig.sheetId,
            Option.match({
              onSome: Effect.succeed,
              onNone: () =>
                Effect.fail(makeArgumentError(`Cannot ${action}, the workspace has no sheet id`)),
            }),
          ),
        onNone: () =>
          Effect.fail(makeArgumentError(`Cannot ${action}, the workspace might not be registered`)),
      }),
    ),
  );

export const requireRunningConversation = Effect.fn("workspaceSheet.requireRunningConversation")(
  function* (
    workspaceId: string,
    payload: ConversationPayload,
    workspaceConfigService: WorkspaceConfigServiceApi,
    action: string,
  ) {
    const maybeConversation = nonEmptyString(payload.conversationId)
      ? yield* workspaceConfigService.getWorkspaceConversationById({
          workspaceId,
          conversationId: payload.conversationId.trim(),
          running: true,
        })
      : nonEmptyString(payload.conversationName)
        ? yield* workspaceConfigService.getWorkspaceConversationByName({
            workspaceId,
            conversationName: payload.conversationName.trim(),
            running: true,
          })
        : yield* Effect.fail(
            makeArgumentError(`Cannot ${action}, conversationId or conversationName is required`),
          );

    return yield* pipe(
      maybeConversation,
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Effect.fail(
            makeArgumentError(`Cannot ${action}, the running conversation might not be registered`),
          ),
      }),
    );
  },
);
