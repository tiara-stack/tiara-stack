import type { CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { Effect, Predicate } from "effect";

type EnqueueResponse = Pick<CommandInteractionResponseContext, "editReply">;

export const isWorkflowTransportUnavailable = (error: unknown) =>
  Predicate.isTagged("WorkflowTransportUnavailable")(error);

export const reportDefinitiveWorkflowEnqueueFailure = (
  response: EnqueueResponse,
  error: unknown,
  {
    rejectedMessage,
    unauthorizedMessage,
    operation,
  }: {
    readonly rejectedMessage: string;
    readonly unauthorizedMessage: string;
    readonly operation: string;
  },
) =>
  response
    .editReply({
      payload: {
        content: Predicate.isTagged("WorkflowInvocationUnauthorized")(error)
          ? unauthorizedMessage
          : rejectedMessage,
      },
    })
    .pipe(
      Effect.tap(() =>
        Effect.logWarning(`Sheet-bot ${operation} workflow enqueue was rejected`, { error }),
      ),
    );

export const reportAmbiguousWorkflowEnqueueOutcome = (
  response: EnqueueResponse,
  error: unknown,
  {
    pendingMessage,
    operation,
  }: {
    readonly pendingMessage: string;
    readonly operation: string;
  },
) =>
  Effect.gen(function* () {
    yield* Effect.logWarning(`Sheet-bot ${operation} workflow enqueue outcome is ambiguous`, {
      error,
    });
    yield* response.editReply({
      payload: { content: pendingMessage },
    });
  });
