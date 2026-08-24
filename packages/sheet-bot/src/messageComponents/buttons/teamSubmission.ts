import { InteractionsRegistry } from "dfx/gateway";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Effect, Layer, Option, Schema } from "effect";
import { discordGatewayLayer } from "../../discord/gateway";
import {
  Interaction,
  InteractionToken,
  MessageComponentInteractionResponse,
  makeButton,
  makeButtonData,
  makeMessageComponent,
} from "dfx-discord-utils/utils";
import { discordApplicationLayer } from "../../discord/application";
import {
  BotCapabilityStore,
  enqueueTeamSubmissionsDecideWorkflow,
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  type BotCapabilityStoreShape,
  type TeamSubmissionsDecideInput,
} from "@/services";
import { interactionDeadlineEpochMs } from "@/utils/interactionDeadline";
import { config } from "@/config";
import { prefixedUnstorageLayer } from "@/discord/cache";
import { makeDeterministicWorkflowInvocationId } from "@/utils/workflowInvocationId";

const teamSubmissionConfirmActionId = "interaction:teamSubmission:confirm";
const teamSubmissionRejectActionId = "interaction:teamSubmission:reject";

const TeamSubmissionInteractionGuild = Schema.Struct({
  id: Schema.String,
});

const TeamSubmissionInteractionMessage = Schema.Struct({
  id: Schema.String,
  channel_id: Schema.String,
  message_reference: Schema.optional(
    Schema.Struct({
      message_id: Schema.optional(Schema.String),
      channel_id: Schema.optional(Schema.String),
      guild_id: Schema.optional(Schema.String),
    }),
  ),
});

type TeamSubmissionInteractionMessage = typeof TeamSubmissionInteractionMessage.Type;

const confirmButtonData = makeButtonData((button) =>
  button
    .setCustomId(teamSubmissionConfirmActionId)
    .setLabel("Confirm")
    .setStyle(ButtonStyle.Success),
);

const rejectButtonData = makeButtonData((button) =>
  button.setCustomId(teamSubmissionRejectActionId).setLabel("Reject").setStyle(ButtonStyle.Danger),
);

const optionOrDie = <A>(value: Option.Option<A>, message: string) =>
  Option.match(value, {
    onSome: Effect.succeed,
    onNone: () => Effect.die(new Error(message)),
  });

const decodeOptionOrDie = <A>(
  value: Option.Option<unknown>,
  schema: Schema.Schema<A>,
  message: string,
) =>
  Option.match(value, {
    onSome: Schema.decodeUnknownEffect(schema),
    onNone: () => Effect.die(new Error(message)),
  });

const interactionGuildId = Interaction.guild().pipe(
  Effect.flatMap((guild) =>
    decodeOptionOrDie(
      guild,
      TeamSubmissionInteractionGuild,
      "Guild not found in team submission interaction",
    ),
  ),
  Effect.map((guild) => guild.id),
);

const interactionMessage = Interaction.message().pipe(
  Effect.flatMap((message) =>
    decodeOptionOrDie(
      message,
      TeamSubmissionInteractionMessage,
      "Message not found in team submission interaction",
    ),
  ),
);

const sourceMessageId = (message: TeamSubmissionInteractionMessage) =>
  message.message_reference?.message_id;

const requireSourceMessageId = (message: TeamSubmissionInteractionMessage) =>
  optionOrDie(
    Option.fromNullishOr(sourceMessageId(message)),
    "Team submission reply is missing message reference",
  );

const sourceWorkspaceId = (message: TeamSubmissionInteractionMessage, guildId: string) =>
  Option.getOrElse(Option.fromNullishOr(message.message_reference?.guild_id), () => guildId);

const sourceConversationId = (message: TeamSubmissionInteractionMessage) =>
  Option.getOrElse(
    Option.fromNullishOr(message.message_reference?.channel_id),
    () => message.channel_id,
  );

const makeSourceDetails = (
  message: TeamSubmissionInteractionMessage,
  guildId: string,
  messageId: string,
) => ({
  workspaceId: sourceWorkspaceId(message, guildId),
  conversationId: sourceConversationId(message),
  messageId,
});

export const teamSubmissionButtonSourceDetails = (
  message: TeamSubmissionInteractionMessage,
  guildId: string,
) =>
  Effect.all({
    messageId: requireSourceMessageId(message),
  }).pipe(Effect.map(({ messageId }) => makeSourceDetails(message, guildId, messageId)));

// Interactive commands and buttons intentionally issue the same narrowly scoped capability shape.
// fallow-ignore-next-line code-duplication
export const makeTeamSubmissionResponseReferenceInput = ({
  applicationId,
  clientId,
  interactionId,
  interactionToken,
  workspaceId,
}: {
  readonly applicationId: string;
  readonly clientId: string;
  readonly interactionId: string;
  readonly interactionToken: string;
  readonly workspaceId: string;
}) => ({
  applicationId,
  client: { platform: "discord" as const, clientId },
  interactionToken,
  permittedOperations: ["respond" as const],
  expiresAt: interactionDeadlineEpochMs(interactionId),
  workspaceId,
});

export const makeTeamSubmissionDecideInput = ({
  clientId,
  confirmation,
  decision,
  responseReference,
  source,
}: {
  readonly clientId: string;
  readonly confirmation: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly messageId: string;
  };
  readonly decision: TeamSubmissionsDecideInput["decision"];
  readonly responseReference: TeamSubmissionsDecideInput["responseReference"];
  readonly source: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly messageId: string;
  };
}) =>
  ({
    responseReference,
    sourceMessage: {
      conversation: {
        workspace: {
          client: { platform: "discord", clientId },
          workspaceId: source.workspaceId,
        },
        conversationId: source.conversationId,
      },
      messageId: source.messageId,
    },
    confirmationMessage: {
      conversation: {
        workspace: {
          client: { platform: "discord", clientId },
          workspaceId: confirmation.workspaceId,
        },
        conversationId: confirmation.conversationId,
      },
      messageId: confirmation.messageId,
    },
    decision,
  }) satisfies TeamSubmissionsDecideInput;

const makeTeamSubmissionButtonRequest = Effect.fn("teamSubmissionButton.makeRequest")(function* (
  capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">,
  decision: TeamSubmissionsDecideInput["decision"],
) {
  const guildId = yield* interactionGuildId;
  const message = yield* interactionMessage;
  const source = yield* teamSubmissionButtonSourceDetails(message, guildId);
  const interactionToken = yield* InteractionToken;
  const interaction = yield* Ix.Interaction;
  const clientId = yield* config.sheetBotClientId;
  const responseReference = yield* capabilityStore.issueResponseReference(
    makeTeamSubmissionResponseReferenceInput({
      applicationId: interactionToken.applicationId,
      clientId,
      interactionId: interaction.id,
      interactionToken: interactionToken.token,
      workspaceId: source.workspaceId,
    }),
  );

  return {
    input: makeTeamSubmissionDecideInput({
      clientId,
      source,
      confirmation: {
        workspaceId: guildId,
        conversationId: message.channel_id,
        messageId: message.id,
      },
      decision,
      responseReference,
    }),
    invocationId: makeDeterministicWorkflowInvocationId([
      "discord-team-submission-decision",
      clientId,
      interaction.id,
    ]),
  };
});

const makeTeamSubmissionButtonHandler = (
  data: { readonly toJSON: () => { readonly custom_id: string } },
  decision: TeamSubmissionsDecideInput["decision"],
) =>
  Effect.gen(function* () {
    const capabilityStore = yield* BotCapabilityStore;
    const workflowClient = yield* SheetWorkflowHttpClient;

    return yield* makeButton(
      data.toJSON(),
      SheetWorkflowHttpRequestContext.asInteractionUser(
        Effect.fn(`teamSubmissionButton.${decision}`)(function* () {
          const response = yield* MessageComponentInteractionResponse;
          yield* response.deferReply({ flags: MessageFlags.Ephemeral });
          const request = yield* makeTeamSubmissionButtonRequest(capabilityStore, decision);
          yield* enqueueTeamSubmissionsDecideWorkflow(workflowClient, request.input, {
            invocationId: request.invocationId,
          });
        }),
      )(),
    );
  });

export const teamSubmissionButtonLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const confirm = yield* makeTeamSubmissionButtonHandler(confirmButtonData, "confirm");
    const reject = yield* makeTeamSubmissionButtonHandler(rejectButtonData, "reject");

    yield* registry.register(
      Ix.builder
        .add(makeMessageComponent(confirm.data, confirm.handler as never))
        .add(makeMessageComponent(reject.data, reject.handler as never))
        .catchAllCause(Effect.log),
    );
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
