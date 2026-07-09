import { InteractionsRegistry } from "dfx/gateway";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Effect, Layer, Option, Schema } from "effect";
import {
  TEAM_SUBMISSION_CONFIRM_ACTION_ID,
  TEAM_SUBMISSION_REJECT_ACTION_ID,
} from "sheet-ingress-api/clientActions";
import { DispatchTeamSubmissionButtonMethods } from "sheet-ingress-api/sheet-apis-rpc";
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
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "@/services";
import { interactionDeadlineEpochMs } from "@/utils/interactionDeadline";
import { config } from "@/config";

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
    .setCustomId(TEAM_SUBMISSION_CONFIRM_ACTION_ID)
    .setLabel("Confirm")
    .setStyle(ButtonStyle.Success),
);

const rejectButtonData = makeButtonData((button) =>
  button
    .setCustomId(TEAM_SUBMISSION_REJECT_ACTION_ID)
    .setLabel("Reject")
    .setStyle(ButtonStyle.Danger),
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

const makeTeamSubmissionButtonPayload = Effect.fn("teamSubmissionButton.makePayload")(function* () {
  const guildId = yield* interactionGuildId;
  const message = yield* interactionMessage;
  const source = yield* teamSubmissionButtonSourceDetails(message, guildId);
  const interactionToken = yield* InteractionToken;
  const interaction = yield* Ix.Interaction;
  const clientId = yield* config.sheetBotClientId;

  return {
    payload: {
      client: { platform: "discord", clientId },
      dispatchRequestId: interaction.id,
      workspaceId: source.workspaceId,
      conversationId: source.conversationId,
      messageId: source.messageId,
      confirmationMessageId: message.id,
      interactionResponseToken: interactionToken.token,
      interactionResponseDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
    },
  };
});

const makeTeamSubmissionButtonHandler = (
  data: { readonly toJSON: () => { readonly custom_id: string } },
  endpointName:
    | typeof DispatchTeamSubmissionButtonMethods.confirm.endpointName
    | typeof DispatchTeamSubmissionButtonMethods.reject.endpointName,
) =>
  Effect.gen(function* () {
    const sheetWorkflowsClient = yield* SheetWorkflowsClient;

    return yield* makeButton(
      data.toJSON(),
      SheetWorkflowsRequestContext.asInteractionUser(
        Effect.fn(`teamSubmissionButton.${endpointName}`)(function* () {
          const response = yield* MessageComponentInteractionResponse;
          yield* response.deferReply({ flags: MessageFlags.Ephemeral });
          const payload = yield* makeTeamSubmissionButtonPayload();
          yield* sheetWorkflowsClient.get().dispatch[endpointName](payload);
        }),
      )(),
    );
  });

export const teamSubmissionButtonLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const confirm = yield* makeTeamSubmissionButtonHandler(
      confirmButtonData,
      DispatchTeamSubmissionButtonMethods.confirm.endpointName,
    );
    const reject = yield* makeTeamSubmissionButtonHandler(
      rejectButtonData,
      DispatchTeamSubmissionButtonMethods.reject.endpointName,
    );

    yield* registry.register(
      Ix.builder
        .add(makeMessageComponent(confirm.data, confirm.handler as never))
        .add(makeMessageComponent(reject.data, reject.handler as never))
        .catchAllCause(Effect.log),
    );
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetWorkflowsClient.layer),
  ),
);
