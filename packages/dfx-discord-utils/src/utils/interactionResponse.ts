import { Discord, DiscordREST } from "dfx";
import { MessageFlags } from "discord-api-types/v10";
import { Context, Deferred, Effect, Ref } from "effect";
import { formatErrorResponse, makeDiscordErrorMessageResponse } from "./errorResponse";
import { InteractionToken } from "./interaction";

export type AcknowledgementState =
  | "none"
  | "replied"
  | "updated"
  | "deferred-reply"
  | "deferred-update";

export type InteractionResponseMode = "command" | "message-component";

export interface InitialInteractionResponse {
  readonly files: ReadonlyArray<File>;
  readonly payload: Discord.CreateInteractionResponseRequest;
}

export interface CommandInteractionResponseContext {
  readonly getAcknowledgementState: Effect.Effect<AcknowledgementState>;
  readonly reply: (payload?: Discord.IncomingWebhookInteractionRequest) => Effect.Effect<boolean>;
  readonly replyWithFiles: (
    files: ReadonlyArray<File>,
    response?: Discord.IncomingWebhookInteractionRequest,
  ) => Effect.Effect<boolean>;
  readonly deferReply: (
    response?: Discord.IncomingWebhookInteractionRequest,
  ) => Effect.Effect<boolean>;
  readonly followUp: (
    payload: Discord.IncomingWebhookRequestPartial,
    files?: ReadonlyArray<File>,
  ) => Effect.Effect<unknown, unknown, never>;
  readonly editReply: (response: {
    readonly params?: Discord.UpdateOriginalWebhookMessageParams;
    readonly payload: Discord.IncomingWebhookUpdateRequestPartial;
  }) => Effect.Effect<unknown, unknown, never>;
  readonly editReplyWithFiles: (
    files: ReadonlyArray<File>,
    response: {
      readonly params?: Discord.UpdateOriginalWebhookMessageParams;
      readonly payload: Discord.IncomingWebhookUpdateRequestPartial;
    },
  ) => Effect.Effect<unknown, unknown, never>;
  readonly respondWithError: (error: unknown) => Effect.Effect<unknown, unknown, never>;
  readonly awaitInitialResponse: Effect.Effect<InitialInteractionResponse>;
}

export interface MessageComponentInteractionResponseContext extends CommandInteractionResponseContext {
  readonly update: (payload?: Discord.IncomingWebhookInteractionRequest) => Effect.Effect<boolean>;
  readonly updateWithFiles: (
    files: ReadonlyArray<File>,
    payload?: Discord.IncomingWebhookInteractionRequest,
  ) => Effect.Effect<boolean>;
  readonly deferUpdate: (
    response?: Discord.IncomingWebhookInteractionRequest,
  ) => Effect.Effect<boolean>;
}

export type InteractionResponseContext = CommandInteractionResponseContext;

export class InteractionResponse extends Context.Service<
  InteractionResponse,
  CommandInteractionResponseContext
>()("dfx-discord-utils/InteractionResponse") {}

export class MessageComponentInteractionResponse extends Context.Service<
  MessageComponentInteractionResponse,
  MessageComponentInteractionResponseContext
>()("dfx-discord-utils/MessageComponentInteractionResponse") {}

const errorTitleForMode = (mode: InteractionResponseMode) =>
  mode === "command" ? "Command failed" : "Interaction failed";

export const makeInteractionResponse = Effect.fnUntraced(function* (mode: InteractionResponseMode) {
  const rest = yield* DiscordREST;
  const interactionToken = yield* InteractionToken;
  const acknowledgementState = yield* Ref.make<AcknowledgementState>("none");
  const response = yield* Deferred.make<InitialInteractionResponse>();

  const completeInitialResponse = Effect.fn("InteractionResponse.completeInitialResponse")(
    function* (state: AcknowledgementState, initialResponse: InitialInteractionResponse) {
      const sent = yield* Deferred.succeed(response, initialResponse);
      if (sent) {
        yield* Ref.set(acknowledgementState, state);
      }
      return sent;
    },
  );

  const reply = Effect.fn("InteractionResponse.reply")(function* (
    payload?: Discord.IncomingWebhookInteractionRequest,
  ) {
    return yield* completeInitialResponse("replied", {
      files: [],
      payload: {
        type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
        data: payload,
      },
    });
  });

  const replyWithFiles = Effect.fn("InteractionResponse.replyWithFiles")(function* (
    files: ReadonlyArray<File>,
    payload?: Discord.IncomingWebhookInteractionRequest,
  ) {
    return yield* completeInitialResponse("replied", {
      files,
      payload: {
        type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
        data: payload,
      },
    });
  });

  const update = Effect.fn("InteractionResponse.update")(function* (
    payload?: Discord.IncomingWebhookInteractionRequest,
  ) {
    return yield* completeInitialResponse("updated", {
      files: [],
      payload: {
        type: Discord.InteractionCallbackTypes.UPDATE_MESSAGE,
        data: payload,
      },
    });
  });

  const updateWithFiles = Effect.fn("InteractionResponse.updateWithFiles")(function* (
    files: ReadonlyArray<File>,
    payload?: Discord.IncomingWebhookInteractionRequest,
  ) {
    return yield* completeInitialResponse("updated", {
      files,
      payload: {
        type: Discord.InteractionCallbackTypes.UPDATE_MESSAGE,
        data: payload,
      },
    });
  });

  const deferReply = Effect.fn("InteractionResponse.deferReply")(function* (
    payload?: Discord.IncomingWebhookInteractionRequest,
  ) {
    return yield* completeInitialResponse("deferred-reply", {
      files: [],
      payload: {
        type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: payload,
      },
    });
  });

  const deferUpdate = Effect.fn("InteractionResponse.deferUpdate")(function* (
    payload?: Discord.IncomingWebhookInteractionRequest,
  ) {
    return yield* completeInitialResponse("deferred-update", {
      files: [],
      payload: {
        type: Discord.InteractionCallbackTypes.DEFERRED_UPDATE_MESSAGE,
        data: payload,
      },
    });
  });

  const followUp = Effect.fn("InteractionResponse.followUp")(function* (
    payload: Discord.IncomingWebhookRequestPartial,
    files: ReadonlyArray<File> = [],
  ) {
    const request = rest.executeWebhook(interactionToken.applicationId, interactionToken.token, {
      params: { wait: true },
      payload,
    });

    return files.length === 0 ? yield* request : yield* rest.withFiles(files)(request);
  });

  const editReply = Effect.fn("InteractionResponse.editReply")(function* (response: {
    readonly params?: Discord.UpdateOriginalWebhookMessageParams;
    readonly payload: Discord.IncomingWebhookUpdateRequestPartial;
  }) {
    return yield* rest.updateOriginalWebhookMessage(
      interactionToken.applicationId,
      interactionToken.token,
      response,
    );
  });

  const editReplyWithFiles = Effect.fn("InteractionResponse.editReplyWithFiles")(function* (
    files: ReadonlyArray<File>,
    response: {
      readonly params?: Discord.UpdateOriginalWebhookMessageParams;
      readonly payload: Discord.IncomingWebhookUpdateRequestPartial;
    },
  ) {
    return yield* rest.withFiles(files)(
      rest.updateOriginalWebhookMessage(
        interactionToken.applicationId,
        interactionToken.token,
        response,
      ),
    );
  });

  const respondWithError = Effect.fn("InteractionResponse.respondWithError")(function* (
    error: unknown,
  ) {
    const rendered = makeDiscordErrorMessageResponse(
      errorTitleForMode(mode),
      formatErrorResponse(error),
    );
    const payload: Discord.IncomingWebhookRequestPartial = {
      content: rendered.content,
      flags: MessageFlags.Ephemeral,
    };
    const state = yield* Ref.get(acknowledgementState);

    if (state === "deferred-reply") {
      return yield* rendered.files.length === 0
        ? editReply({ payload: { content: rendered.content } })
        : editReplyWithFiles(rendered.files, { payload: { content: rendered.content } });
    }

    if (state === "deferred-update") {
      yield* editReply({ payload: {} });
      return yield* followUp(payload, rendered.files);
    }

    if (state !== "none") {
      return yield* followUp(payload, rendered.files);
    }

    const sent = yield* rendered.files.length === 0
      ? reply(payload)
      : replyWithFiles(rendered.files, payload);
    if (!sent) {
      return yield* followUp(payload, rendered.files);
    }
  });

  const service = {
    getAcknowledgementState: Ref.get(acknowledgementState),
    reply,
    replyWithFiles,
    deferReply,
    followUp,
    editReply,
    editReplyWithFiles,
    respondWithError,
    awaitInitialResponse: Deferred.await(response),
  };

  return mode === "command"
    ? InteractionResponse.of(service)
    : MessageComponentInteractionResponse.of({
        ...service,
        update,
        updateWithFiles,
        deferUpdate,
      });
});

type InteractionResponseEnvironment<
  Mode extends InteractionResponseMode,
  R,
> = Mode extends "command"
  ? Exclude<R, InteractionResponse> | DiscordREST | InteractionToken
  :
      | Exclude<Exclude<R, InteractionResponse>, MessageComponentInteractionResponse>
      | DiscordREST
      | InteractionToken;

export const provideInteractionResponse = <A, E, R, const Mode extends InteractionResponseMode>(
  mode: Mode,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, InteractionResponseEnvironment<Mode, R>> =>
  Effect.gen(function* () {
    const interactionResponse = yield* makeInteractionResponse(mode);
    const withCommandResponse = Effect.provideService(
      effect,
      InteractionResponse,
      interactionResponse,
    );

    if (mode === "command") {
      return yield* withCommandResponse;
    }

    return yield* Effect.provideService(
      withCommandResponse,
      MessageComponentInteractionResponse,
      interactionResponse,
    );
  }) as Effect.Effect<A, E, InteractionResponseEnvironment<Mode, R>>;
