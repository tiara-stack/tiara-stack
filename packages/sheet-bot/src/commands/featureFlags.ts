import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
} from "dfx-discord-utils/utils";
import { Effect, Layer, Match, Option, Predicate, Schema } from "effect";
import { makeWorkflowInvocationId } from "sheet-workflow-http-client";
import { FeatureFlagName, WorkspaceId } from "sheet-workflow-contracts/values";
import {
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  enqueueWorkspacesFeatureFlagsSetAndDeliverWorkflow,
  type SheetWorkflowHttpClientShape,
  type WorkspacesFeatureFlagsSetAndDeliverInput,
} from "../services";
import { requireString, resolveGuildId } from "../utils/commandHelpers";
import { registerGlobalCommandLayer } from "../utils/registerGlobalCommandLayer";

const featureFlagRejectedMessage = "I couldn't update the feature flag. Please try again.";
const featureFlagUnauthorizedMessage = "Only the TiaraBot owner can change feature flags.";
const featureFlagPendingMessage =
  "The feature-flag update is still processing. I'll update the target server when it finishes.";

const featureFlagQueuedMessage = (enabled: boolean) =>
  `Feature flag ${enabled ? "enable" : "disable"} request queued. TiaraBot will announce the change in the target server when a sendable channel is available.`;

export const enqueueFeatureFlag = Effect.fn("featureFlag.enqueueWorkflow")(function* (
  response: Pick<CommandInteractionResponseContext, "editReply">,
  workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueWorkspacesFeatureFlagsSetAndDeliver">,
  input: Omit<WorkspacesFeatureFlagsSetAndDeliverInput, "responseReference">,
) {
  const invocationId = yield* makeWorkflowInvocationId();

  yield* SheetWorkflowHttpRequestContext.asInteractionUser(() =>
    enqueueWorkspacesFeatureFlagsSetAndDeliverWorkflow(workflowClient, input, { invocationId }),
  )().pipe(
    Effect.matchEffect({
      onSuccess: () =>
        response
          .editReply({ payload: { content: featureFlagQueuedMessage(input.enabled) } })
          .pipe(Effect.asVoid),
      onFailure: (error) => {
        const message = Match.value(error).pipe(
          Match.when(
            Predicate.isTagged("WorkflowInvocationUnauthorized"),
            () => featureFlagUnauthorizedMessage,
          ),
          Match.when(
            Predicate.isTagged("WorkflowTransportUnavailable"),
            () => featureFlagPendingMessage,
          ),
          Match.orElse(() => featureFlagRejectedMessage),
        );
        return response.editReply({ payload: { content: message } }).pipe(Effect.asVoid);
      },
    }),
  );
});

const makeToggleSubCommand = (enabled: boolean) =>
  Effect.gen(function* () {
    const workflowClient = yield* SheetWorkflowHttpClient;

    return yield* CommandHelper.makeSubCommand(
      (builder) =>
        builder
          .setName(enabled ? "enable" : "disable")
          .setDescription(`${enabled ? "Enable" : "Disable"} a server feature flag`)
          .addStringOption((option) =>
            option
              .setName("flag_name")
              .setDescription("The feature flag to change")
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("server_id")
              .setDescription("The server to change the feature flag for")
              .setRequired(true),
          ),
      Effect.fn(`featureFlag.${enabled ? "enable" : "disable"}`)(function* (command) {
        const response = yield* InteractionResponse;
        yield* response.deferReply({ flags: MessageFlags.Ephemeral });

        const serverId = yield* requireString(command.optionValue("server_id"), "server ID");
        const guildId = yield* resolveGuildId(Option.some(serverId));
        const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(guildId);
        const flagName = yield* Schema.decodeUnknownEffect(FeatureFlagName)(
          yield* requireString(command.optionValue("flag_name"), "feature flag name"),
        );

        yield* enqueueFeatureFlag(response, workflowClient, {
          workspaceId,
          flagName,
          enabled,
        });
      }),
    );
  });

const makeFeatureFlagCommand = Effect.gen(function* () {
  const enableSubCommand = yield* makeToggleSubCommand(true);
  const disableSubCommand = yield* makeToggleSubCommand(false);

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("feature_flag")
        .setDescription("Enable or disable a server feature flag")
        .addSubcommand(() => enableSubCommand.data)
        .addSubcommand(() => disableSubCommand.data)
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        ),
    (command) =>
      command.subCommands({
        enable: enableSubCommand.handler,
        disable: disableSubCommand.handler,
      }),
  );
});

export const featureFlagCommandLayer = registerGlobalCommandLayer(makeFeatureFlagCommand).pipe(
  Layer.provide(SheetWorkflowHttpClient.layer),
);
