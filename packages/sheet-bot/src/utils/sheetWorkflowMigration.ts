import { Ix } from "dfx/index";
import { InteractionToken, type CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { Effect, Predicate } from "effect";
import type { ResponseReference } from "sheet-bot-api/references";
import { makeWorkflowInvocationId, type WorkflowInvocationId } from "sheet-workflow-http-client";
import { config } from "../config";
import type { BotCapabilityStoreShape } from "../services";
import { SheetWorkflowHttpRequestContext } from "../services";
import { makeResponseReferenceInput } from "./commandHelpers";

type WorkflowEnqueuer<Input, EnqueueError> = (
  input: Input,
  options: { readonly invocationId: WorkflowInvocationId },
) => Effect.Effect<unknown, EnqueueError, never>;
type WorkflowFailureReporter = (content: string) => Effect.Effect<unknown, unknown, never>;

export interface EnqueueSheetWorkflowOptions<Input, EnqueueError> {
  readonly response: Pick<CommandInteractionResponseContext, "editReply">;
  readonly operation: string;
  readonly workspaceId?: string;
  readonly capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">;
  readonly makeInput: (responseReference: ResponseReference) => Input;
  readonly enqueue: WorkflowEnqueuer<Input, EnqueueError>;
  readonly rejectedMessage: string;
  readonly unauthorizedMessage: string;
  readonly pendingMessage: string;
  readonly report?: WorkflowFailureReporter;
}

const reportFailure = (report: WorkflowFailureReporter, operation: string, content: string) =>
  report(content).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`${operation} terminal response could not be delivered`, {
        error,
      }),
    ),
    Effect.asVoid,
  );

const reportDefinitiveEnqueueFailure = (
  report: WorkflowFailureReporter,
  operation: string,
  rejectedMessage: string,
  unauthorizedMessage: string,
  error: unknown,
) =>
  Effect.gen(function* () {
    yield* reportFailure(
      report,
      operation,
      Predicate.isTagged("WorkflowInvocationUnauthorized")(error)
        ? unauthorizedMessage
        : rejectedMessage,
    );
    yield* Effect.logWarning(`${operation} workflow enqueue was rejected`, {
      error,
    });
  });

const reportResponseReferenceFailure = (
  report: WorkflowFailureReporter,
  operation: string,
  rejectedMessage: string,
  error: unknown,
) =>
  Effect.gen(function* () {
    yield* Effect.logWarning(`${operation} workflow response reference could not be issued`, {
      error,
    });
    yield* reportFailure(report, operation, rejectedMessage);
  });

export const enqueueSheetWorkflow = <Input, EnqueueError>(
  options: EnqueueSheetWorkflowOptions<Input, EnqueueError>,
) =>
  Effect.gen(function* () {
    const invocationId = yield* makeWorkflowInvocationId();
    const report: WorkflowFailureReporter =
      options.report ?? ((content) => options.response.editReply({ payload: { content } }));

    const interactionToken = yield* InteractionToken;
    const interaction = yield* Ix.Interaction;
    const clientId = yield* config.sheetBotClientId;
    const responseReference = yield* options.capabilityStore
      .issueResponseReference(
        makeResponseReferenceInput({
          applicationId: interactionToken.applicationId,
          clientId,
          interactionId: interaction.id,
          interactionToken: interactionToken.token,
          ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
        }),
      )
      .pipe(
        Effect.catch((error) =>
          Predicate.isTagged("BotDependencyUnavailable")(error) ||
          Predicate.isTagged("BotResponseExpired")(error)
            ? reportResponseReferenceFailure(
                report,
                options.operation,
                options.rejectedMessage,
                error,
              ).pipe(Effect.as(undefined))
            : Effect.fail(error),
        ),
      );

    if (responseReference === undefined) return;

    yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
      options.enqueue(options.makeInput(responseReference), { invocationId }),
    )().pipe(
      Effect.catch((error) =>
        Predicate.isTagged("WorkflowTransportUnavailable")(error)
          ? Effect.gen(function* () {
              yield* Effect.logWarning(
                `${options.operation} workflow enqueue outcome is ambiguous`,
                {
                  error,
                },
              );
              yield* reportFailure(report, options.operation, options.pendingMessage);
            })
          : reportDefinitiveEnqueueFailure(
              report,
              options.operation,
              options.rejectedMessage,
              options.unauthorizedMessage,
              error,
            ),
      ),
    );
  });
