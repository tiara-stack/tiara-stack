import { Schema } from "effect";

const LooseObject = Schema.Record(Schema.String, Schema.Unknown);
const AllowedMentionType = Schema.Literals(["roles", "users", "everyone"]);

export const DiscordAllowedMentionsRequestSchema = Schema.Struct({
  parse: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(AllowedMentionType)))),
  users: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(Schema.String)))),
  roles: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(Schema.String)))),
  replied_user: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

export const DiscordMessageRequestSchema = Schema.Struct({
  content: Schema.optional(Schema.NullOr(Schema.String)),
  embeds: Schema.optional(Schema.NullOr(Schema.Array(LooseObject))),
  allowed_mentions: Schema.optional(Schema.NullOr(DiscordAllowedMentionsRequestSchema)),
  sticker_ids: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  components: Schema.optional(Schema.NullOr(Schema.Array(LooseObject))),
  flags: Schema.optional(Schema.NullOr(Schema.Number)),
  attachments: Schema.optional(Schema.NullOr(Schema.Array(LooseObject))),
  poll: Schema.optional(Schema.NullOr(LooseObject)),
  shared_client_theme: Schema.optional(Schema.NullOr(LooseObject)),
  message_reference: Schema.optional(Schema.NullOr(LooseObject)),
  nonce: Schema.optional(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
  enforce_nonce: Schema.optional(Schema.NullOr(Schema.Boolean)),
  tts: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const DiscordInteractionMessageDataSchema = Schema.Struct({
  content: Schema.optional(Schema.NullOr(Schema.String)),
  embeds: Schema.optional(Schema.NullOr(Schema.Array(LooseObject))),
  allowed_mentions: Schema.optional(Schema.NullOr(DiscordAllowedMentionsRequestSchema)),
  components: Schema.optional(Schema.NullOr(Schema.Array(LooseObject))),
  attachments: Schema.optional(Schema.NullOr(Schema.Array(LooseObject))),
  poll: Schema.optional(Schema.NullOr(LooseObject)),
  tts: Schema.optional(Schema.NullOr(Schema.Boolean)),
  flags: Schema.optional(Schema.NullOr(Schema.Number)),
});

const DiscordInteractionDeferredMessageDataSchema = Schema.Struct({
  flags: Schema.optional(Schema.NullOr(Schema.Number)),
  content: Schema.optional(Schema.Never),
  embeds: Schema.optional(Schema.Never),
  allowed_mentions: Schema.optional(Schema.Never),
  components: Schema.optional(Schema.Never),
  attachments: Schema.optional(Schema.Never),
  poll: Schema.optional(Schema.Never),
  tts: Schema.optional(Schema.Never),
});

const DiscordInteractionMessageResponseRequestSchema = Schema.Struct({
  type: Schema.Literal(4),
  data: DiscordInteractionMessageDataSchema,
});

const DiscordInteractionDeferredMessageResponseRequestSchema = Schema.Struct({
  type: Schema.Literal(5),
  data: Schema.optional(DiscordInteractionDeferredMessageDataSchema),
});

const DiscordInteractionDeferredUpdateResponseRequestSchema = Schema.Struct({
  type: Schema.Literal(6),
  data: Schema.optional(Schema.Never),
});

const DiscordInteractionUpdateResponseRequestSchema = Schema.Struct({
  type: Schema.Literal(7),
  data: Schema.optional(Schema.NullOr(DiscordInteractionMessageDataSchema)),
});

const DiscordInteractionPongResponseRequestSchema = Schema.Struct({
  type: Schema.Literal(1),
  data: Schema.optional(Schema.Never),
});

const DiscordInteractionAutocompleteResponseRequestSchema = Schema.Struct({
  type: Schema.Literal(8),
  data: Schema.Struct({
    choices: Schema.Array(LooseObject),
  }),
});

const DiscordInteractionModalResponseRequestSchema = Schema.Struct({
  type: Schema.Literal(9),
  data: Schema.Struct({
    custom_id: Schema.String,
    title: Schema.String,
    components: Schema.Array(LooseObject),
  }),
});

const DiscordInteractionPremiumRequiredResponseRequestSchema = Schema.Struct({
  type: Schema.Literal(10),
  data: Schema.optional(Schema.Never),
});

const DiscordInteractionLaunchActivityResponseRequestSchema = Schema.Struct({
  type: Schema.Literal(12),
  data: Schema.optional(Schema.Never),
});

const DiscordInteractionSocialLayerSkuEligibilityResponseRequestSchema = Schema.Struct({
  type: Schema.Literal(13),
  data: Schema.Struct({
    eligible: Schema.Boolean,
    ineligible_reason: Schema.optional(Schema.NullOr(Schema.Number)),
    ineligible_reason_description: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

export const DiscordInteractionResponseRequestSchema = Schema.Union([
  DiscordInteractionPongResponseRequestSchema,
  DiscordInteractionMessageResponseRequestSchema,
  DiscordInteractionDeferredMessageResponseRequestSchema,
  DiscordInteractionDeferredUpdateResponseRequestSchema,
  DiscordInteractionUpdateResponseRequestSchema,
  DiscordInteractionAutocompleteResponseRequestSchema,
  DiscordInteractionModalResponseRequestSchema,
  DiscordInteractionPremiumRequiredResponseRequestSchema,
  DiscordInteractionLaunchActivityResponseRequestSchema,
  DiscordInteractionSocialLayerSkuEligibilityResponseRequestSchema,
]);

export const CreateInteractionResponsePayloadSchema = Schema.Struct({
  interactionId: Schema.String,
  interactionToken: Schema.String,
  payload: DiscordInteractionResponseRequestSchema,
});

export const SendMessagePayloadSchema = Schema.Struct({
  params: Schema.Struct({ channelId: Schema.String }),
  payload: DiscordMessageRequestSchema,
});

export const UpdateMessagePayloadSchema = Schema.Struct({
  params: Schema.Struct({
    channelId: Schema.String,
    messageId: Schema.String,
  }),
  payload: DiscordMessageRequestSchema,
});

export const UpdateOriginalInteractionResponsePayloadSchema = Schema.Struct({
  params: Schema.Struct({
    interactionToken: Schema.String,
  }),
  payload: DiscordMessageRequestSchema,
});

export const CreatePinPayloadSchema = Schema.Struct({
  params: Schema.Struct({
    channelId: Schema.String,
    messageId: Schema.String,
  }),
});

export const AddGuildMemberRolePayloadSchema = Schema.Struct({
  params: Schema.Struct({
    guildId: Schema.String,
    userId: Schema.String,
    roleId: Schema.String,
  }),
});

export const EmptyBotResponseSchema = Schema.Struct({});

export const DiscordMessageSchema = Schema.Struct({
  id: Schema.String,
  channel_id: Schema.String,
  content: Schema.optional(Schema.String),
});

export const DiscordInteractionCallbackResponseSchema = Schema.Struct({
  interaction: Schema.Struct({
    id: Schema.String,
    type: Schema.Number,
    response_message_id: Schema.optional(Schema.String),
    response_message_loading: Schema.optional(Schema.Boolean),
    response_message_ephemeral: Schema.optional(Schema.Boolean),
    channel_id: Schema.optional(Schema.String),
    guild_id: Schema.optional(Schema.String),
  }),
});

const DiscordBotRestErrorFields = {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
};

export class DiscordBotBadRequestError extends Schema.TaggedErrorClass<DiscordBotBadRequestError>()(
  "DiscordBotBadRequestError",
  DiscordBotRestErrorFields,
  { httpApiStatus: 400 },
) {}

export class DiscordBotUnauthorizedError extends Schema.TaggedErrorClass<DiscordBotUnauthorizedError>()(
  "DiscordBotUnauthorizedError",
  DiscordBotRestErrorFields,
  { httpApiStatus: 401 },
) {}

export class DiscordBotForbiddenError extends Schema.TaggedErrorClass<DiscordBotForbiddenError>()(
  "DiscordBotForbiddenError",
  DiscordBotRestErrorFields,
  { httpApiStatus: 403 },
) {}

export class DiscordBotNotFoundError extends Schema.TaggedErrorClass<DiscordBotNotFoundError>()(
  "DiscordBotNotFoundError",
  DiscordBotRestErrorFields,
  { httpApiStatus: 404 },
) {}

export class DiscordBotUnprocessableError extends Schema.TaggedErrorClass<DiscordBotUnprocessableError>()(
  "DiscordBotUnprocessableError",
  DiscordBotRestErrorFields,
  { httpApiStatus: 422 },
) {}

export class DiscordBotRateLimitedError extends Schema.TaggedErrorClass<DiscordBotRateLimitedError>()(
  "DiscordBotRateLimitedError",
  DiscordBotRestErrorFields,
  { httpApiStatus: 429 },
) {}

export class DiscordBotUpstreamError extends Schema.TaggedErrorClass<DiscordBotUpstreamError>()(
  "DiscordBotUpstreamError",
  DiscordBotRestErrorFields,
  { httpApiStatus: 502 },
) {}

const DiscordBotRestErrorClasses = [
  DiscordBotBadRequestError,
  DiscordBotUnauthorizedError,
  DiscordBotForbiddenError,
  DiscordBotNotFoundError,
  DiscordBotUnprocessableError,
  DiscordBotRateLimitedError,
  DiscordBotUpstreamError,
] as const;

export const DiscordBotRestErrorSchema = Schema.Union(DiscordBotRestErrorClasses);

export const DiscordBotRestErrors = DiscordBotRestErrorClasses;

export type DiscordBotRestError = typeof DiscordBotRestErrorSchema.Type;

export const makeDiscordBotRestError = ({
  message,
  status,
}: {
  readonly message: string;
  readonly status?: number;
}): DiscordBotRestError => {
  if (status === 400) {
    return new DiscordBotBadRequestError({ message, status });
  }
  if (status === 401) {
    return new DiscordBotUnauthorizedError({ message, status });
  }
  if (status === 403) {
    return new DiscordBotForbiddenError({ message, status });
  }
  if (status === 404) {
    return new DiscordBotNotFoundError({ message, status });
  }
  if (status === 429) {
    return new DiscordBotRateLimitedError({ message, status });
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return new DiscordBotUnprocessableError({ message, status });
  }

  return new DiscordBotUpstreamError({ message, status });
};
