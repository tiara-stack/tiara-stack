import { Ix } from "dfx/index";
import { InteractionToken, type CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { Duration, Effect, Predicate } from "effect";
import type { ResponseReference } from "sheet-bot-api/references";
import { makeWorkflowInvocationId, type WorkflowInvocationId } from "sheet-workflow-http-client";
import { config } from "../config";
import type { BotCapabilityStoreShape } from "../services";
import { SheetWorkflowHttpRequestContext } from "../services";
import { makeResponseReferenceInput } from "./commandHelpers";

const rolloutGateEvaluationTimeout = Duration.seconds(5);

type WorkflowGateEvaluationInput = {
  readonly contractIdentity: string;
  readonly contractWireVersion: string;
  readonly client: {
    readonly platform: string;
    readonly clientId: string;
  };
  readonly invocationId: WorkflowInvocationId;
  readonly workspaceId?: string;
};

type WorkflowGateDecision = {
  readonly executionPath: "legacy" | "replacement";
};

type WorkflowGateEvaluator<GateError> = (
  input: WorkflowGateEvaluationInput,
) => Effect.Effect<WorkflowGateDecision, GateError, never>;

type WorkflowEnqueuer<Input, EnqueueError> = (
  input: Input,
  options: { readonly invocationId: WorkflowInvocationId },
) => Effect.Effect<unknown, EnqueueError, never>;

export interface EnqueueSheetWorkflowOptions<Input, GateError, EnqueueError, LegacyRequirements> {
  readonly response: Pick<CommandInteractionResponseContext, "editReply">;
  readonly operation: string;
  readonly contractIdentity: string;
  readonly contractWireVersion: string;
  readonly workspaceId?: string;
  readonly capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">;
  readonly evaluateGate: WorkflowGateEvaluator<GateError>;
  readonly makeInput: (responseReference: ResponseReference) => Input;
  readonly enqueue: WorkflowEnqueuer<Input, EnqueueError>;
  readonly dispatchLegacy: Effect.Effect<unknown, unknown, LegacyRequirements>;
  readonly rejectedMessage: string;
  readonly unauthorizedMessage: string;
  readonly pendingMessage: string;
}

const unavailableGateDecision: WorkflowGateDecision = {
  executionPath: "legacy",
};

const reportDefinitiveEnqueueFailure = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  operation: string,
  rejectedMessage: string,
  unauthorizedMessage: string,
  error: unknown,
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
        Effect.logWarning(`${operation} workflow enqueue was rejected`, {
          error,
        }),
      ),
    );

const reportResponseReferenceFailure = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  operation: string,
  rejectedMessage: string,
  error: unknown,
) =>
  Effect.gen(function* () {
    yield* Effect.logWarning(`${operation} workflow response reference could not be issued`, {
      error,
    });
    yield* response.editReply({ payload: { content: rejectedMessage } }).pipe(
      Effect.catch((responseError) =>
        Effect.logWarning(`${operation} terminal response could not be delivered`, {
          error: responseError,
        }),
      ),
    );
  });

export const enqueueSheetWorkflow = <Input, GateError, EnqueueError, LegacyRequirements>(
  options: EnqueueSheetWorkflowOptions<Input, GateError, EnqueueError, LegacyRequirements>,
) =>
  Effect.gen(function* () {
    const invocationId = yield* makeWorkflowInvocationId();
    const clientId = yield* config.sheetBotClientId;
    const decision = yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
      options.evaluateGate({
        contractIdentity: options.contractIdentity,
        contractWireVersion: options.contractWireVersion,
        client: { platform: "discord", clientId },
        invocationId,
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      }),
    )().pipe(
      Effect.timeout(rolloutGateEvaluationTimeout),
      Effect.catch((error) =>
        Effect.logWarning("Rollout Gate Control could not be evaluated; using legacy path", {
          error,
          invocationId,
        }).pipe(Effect.as(unavailableGateDecision)),
      ),
    );

    if (decision.executionPath === "legacy") {
      return yield* options.dispatchLegacy;
    }

    const interactionToken = yield* InteractionToken;
    const interaction = yield* Ix.Interaction;
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
                options.response,
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
              yield* options.response.editReply({
                payload: { content: options.pendingMessage },
              });
            })
          : reportDefinitiveEnqueueFailure(
              options.response,
              options.operation,
              options.rejectedMessage,
              options.unauthorizedMessage,
              error,
            ),
      ),
    );
  });
