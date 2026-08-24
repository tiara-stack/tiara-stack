import type { CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { Duration, Effect, Predicate } from "effect";
import type { ResponseReference } from "sheet-bot-api/references";
import type { WorkflowInvocationId } from "sheet-workflow-http-client";
import { BotCapabilityStore, SheetWorkflowHttpRequestContext } from "../services";
import { issueInteractionResponseReference } from "./commandHelpers";

export const evaluateRolloutGateWithLegacyFallback = <
  A extends { readonly executionPath: "legacy" | "replacement" },
  E,
  R,
>(
  evaluation: Effect.Effect<A, E, R>,
  timeout: Duration.Duration,
  fallback: A,
  invocationId: string,
) =>
  evaluation.pipe(
    Effect.timeout(timeout),
    Effect.catch((error) =>
      Effect.logWarning("Rollout Gate Control could not be evaluated; using legacy path", {
        error,
        invocationId,
      }).pipe(Effect.as(fallback)),
    ),
  );

export const enqueueReplacementWorkflow = <A>(
  response: Pick<CommandInteractionResponseContext, "editReply">,
  capabilityStore: Pick<typeof BotCapabilityStore.Service, "issueResponseReference">,
  workspaceId: string,
  invocationId: WorkflowInvocationId,
  enqueue: (
    responseReference: ResponseReference,
    invocationId: WorkflowInvocationId,
  ) => Effect.Effect<A, unknown, never>,
  logMessage: string,
  pendingMessage: string,
  onDefinitiveFailure: (error: unknown) => Effect.Effect<unknown, unknown, never>,
) =>
  Effect.gen(function* () {
    const responseReference = yield* issueInteractionResponseReference(
      capabilityStore,
      workspaceId,
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning(logMessage, { error }).pipe(
          Effect.andThen(onDefinitiveFailure(error).pipe(Effect.ignore)),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );

    yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
      enqueue(responseReference, invocationId),
    )().pipe(
      Effect.catch((error) =>
        Predicate.isTagged("WorkflowTransportUnavailable")(error)
          ? Effect.gen(function* () {
              yield* Effect.logWarning(logMessage, { error });
              yield* response.editReply({ payload: { content: pendingMessage } });
            })
          : onDefinitiveFailure(error),
      ),
    );
  });
