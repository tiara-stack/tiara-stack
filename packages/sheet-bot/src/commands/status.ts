import { InteractionsRegistry } from "dfx/gateway";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Effect, Layer, Predicate } from "effect";
import {
  CommandHelper,
  InteractionResponse,
  InteractionToken,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { config } from "../config";
import { prefixedUnstorageLayer } from "../discord/cache";
import { discordApplicationLayer } from "../discord/application";
import { discordGatewayLayer } from "../discord/gateway";
import {
  BotCapabilityStore,
  enqueueStatusWorkflow,
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  type ServicesDeliverStatusEnqueueError,
} from "../services";
import { interactionDeadlineEpochMs } from "../utils/interactionDeadline";

const statusEnqueueRejectedMessage = "I couldn't start the service status check. Please try again.";
const statusEnqueuePendingMessage =
  "The service status check is still processing. I'll update this message when it finishes.";

export const makeStatusResponseReferenceInput = ({
  applicationId,
  clientId,
  interactionId,
  interactionToken,
}: {
  readonly applicationId: string;
  readonly clientId: string;
  readonly interactionId: string;
  readonly interactionToken: string;
}) => ({
  applicationId,
  client: { platform: "discord" as const, clientId },
  interactionToken,
  permittedOperations: ["respond" as const],
  expiresAt: interactionDeadlineEpochMs(interactionId),
});

const issueStatusResponseReference = Effect.gen(function* () {
  const capabilityStore = yield* BotCapabilityStore;
  const interactionToken = yield* InteractionToken;
  const interaction = yield* Ix.Interaction;
  const clientId = yield* config.sheetBotClientId;

  return yield* capabilityStore.issueResponseReference(
    makeStatusResponseReferenceInput({
      applicationId: interactionToken.applicationId,
      clientId,
      interactionId: interaction.id,
      interactionToken: interactionToken.token,
    }),
  );
});

const reportDefinitiveEnqueueFailure = (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  error: unknown,
) =>
  response.editReply({ payload: { content: statusEnqueueRejectedMessage } }).pipe(
    Effect.tap(() =>
      Effect.logWarning("Sheet-bot status workflow enqueue was rejected", {
        error,
      }),
    ),
  );

const isTransportUnavailable = (
  error: unknown,
): error is Extract<
  ServicesDeliverStatusEnqueueError,
  { readonly _tag: "WorkflowTransportUnavailable" }
> => Predicate.isTagged("WorkflowTransportUnavailable")(error);

const enqueueStatus = Effect.fn("status.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: typeof SheetWorkflowHttpClient.Service,
) {
  const responseReference = yield* issueStatusResponseReference;

  yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
    enqueueStatusWorkflow(workflowClient, { responseReference }),
  )().pipe(
    Effect.catch((error) =>
      isTransportUnavailable(error)
        ? Effect.gen(function* () {
            yield* Effect.logWarning("Sheet-bot status workflow enqueue outcome is ambiguous", {
              error,
            });
            yield* response.editReply({ payload: { content: statusEnqueuePendingMessage } });
          })
        : reportDefinitiveEnqueueFailure(response, error),
    ),
  );
});

const makeStatusCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("status")
        .setDescription("Show service readiness status")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        ),
    Effect.fn("status")(function* () {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      yield* enqueueStatus(response, workflowClient);
    }),
  );
});

const makeGlobalStatusCommand = Effect.gen(function* () {
  const statusCommand = yield* makeStatusCommand;

  return CommandHelper.makeGlobalCommand(statusCommand.data, statusCommand.handler as never);
});

export const statusCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalStatusCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      discordGatewayLayer,
      discordApplicationLayer,
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
