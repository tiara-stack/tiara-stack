import type { HttpClientError } from "@effect/platform/HttpClientError";
import { Discord, DiscordREST, Ix } from "dfx";
import type { DiscordRESTError } from "dfx/DiscordREST";
import { GlobalApplicationCommand, GuildApplicationCommand } from "dfx/Interactions/definitions";
import { CommandHelper } from "dfx/Interactions/commandHelper";
import { MessageFlags } from "discord-api-types/v10";
import {
  SubCommandNotFound,
  type DiscordApplicationCommand,
  type DiscordInteraction,
} from "dfx/Interactions/context";
import { Array, Deferred, Effect, FiberMap, Option, pipe, Record, Scope } from "effect";
import { DiscordApplication } from "../discord/gateway";
import { formatErrorResponse, makeDiscordErrorMessageResponse } from "./errorResponse";
import {
  CommandBuilder,
  CommandOptionsOnlyBuilder,
  CommandSubCommandsOnlyBuilder,
  SubCommandBuilder,
  SubCommandGroupBuilder,
} from "./commandBuilder";
import { DiscordRestService } from "dfx/DiscordREST";

// Re-export types to ensure they're available in generated d.ts files
export type { HttpClientError, DiscordRESTError };

type CommandOptionType = Exclude<
  Discord.ApplicationCommandOptionType,
  | typeof Discord.ApplicationCommandOptionType.SUB_COMMAND
  | typeof Discord.ApplicationCommandOptionType.SUB_COMMAND_GROUP
>;

interface CommandOption {
  readonly type: any;
  readonly name: string;
  readonly options?: ReadonlyArray<CommandOption>;
}

type StringLiteral<T> = T extends string ? (string extends T ? never : T) : never;

type InferOption<A> = A extends { readonly name: infer N }
  ? N extends StringLiteral<N>
    ? A
    : never
  : never;

type OptionsWithLiteral<A, T> = A extends {
  readonly options: ReadonlyArray<CommandOption>;
}
  ? Extract<A["options"][number], InferOption<A["options"][number]> & T>
  : never;

type SubCommandGroups<A> = A extends { readonly options: ReadonlyArray<CommandOption> }
  ? Extract<
      A["options"][number],
      {
        readonly type: typeof Discord.ApplicationCommandOptionType.SUB_COMMAND_GROUP;
        readonly options?: ReadonlyArray<CommandOption>;
      }
    >
  : never;

type SubCommandGroupNames<A> = InferOption<SubCommandGroups<A>>["name"];

type SubCommands<A> = A extends { readonly options: ReadonlyArray<CommandOption> }
  ? Extract<
      A["options"][number],
      {
        readonly type: typeof Discord.ApplicationCommandOptionType.SUB_COMMAND;
        readonly options?: ReadonlyArray<CommandOption>;
      }
    >
  : never;

type SubCommandNames<A> = InferOption<SubCommands<A>>["name"];

type SubCommandWithName<A, Name extends SubCommandGroupNames<A> | SubCommandNames<A>> = A extends {
  readonly options: ReadonlyArray<CommandOption>;
}
  ? Extract<
      A["options"][number],
      {
        readonly type:
          | typeof Discord.ApplicationCommandOptionType.SUB_COMMAND_GROUP
          | typeof Discord.ApplicationCommandOptionType.SUB_COMMAND;
        readonly options?: ReadonlyArray<CommandOption>;
        readonly name: Name;
      }
    >
  : never;

type CommandOptions<A> = OptionsWithLiteral<
  A,
  {
    readonly type: CommandOptionType;
  }
>;

type RequiredCommandOptions<A> = OptionsWithLiteral<
  A,
  {
    readonly type: CommandOptionType;
    readonly required: true;
  }
>;

type CommandWithName<A, N> = Extract<CommandOptions<A>, { readonly name: N }>;

type ResolvableType =
  | typeof Discord.ApplicationCommandOptionType.ROLE
  | typeof Discord.ApplicationCommandOptionType.USER
  | typeof Discord.ApplicationCommandOptionType.MENTIONABLE
  | typeof Discord.ApplicationCommandOptionType.CHANNEL;

type ResolvableOptions<A> = OptionsWithLiteral<A, { readonly type: ResolvableType }>;
type RoleOptions<A> = OptionsWithLiteral<
  A,
  { readonly type: typeof Discord.ApplicationCommandOptionType.ROLE }
>;
type UserOptions<A> = OptionsWithLiteral<
  A,
  { readonly type: typeof Discord.ApplicationCommandOptionType.USER }
>;
type MentionableOptions<A> = OptionsWithLiteral<
  A,
  { readonly type: typeof Discord.ApplicationCommandOptionType.MENTIONABLE }
>;
type ChannelOptions<A> = OptionsWithLiteral<
  A,
  { readonly type: typeof Discord.ApplicationCommandOptionType.CHANNEL }
>;

type RequiredRoleOptions<A> = OptionsWithLiteral<
  A,
  { readonly type: typeof Discord.ApplicationCommandOptionType.ROLE; readonly required: true }
>;
type RequiredUserOptions<A> = OptionsWithLiteral<
  A,
  { readonly type: typeof Discord.ApplicationCommandOptionType.USER; readonly required: true }
>;
type RequiredMentionableOptions<A> = OptionsWithLiteral<
  A,
  {
    readonly type: typeof Discord.ApplicationCommandOptionType.MENTIONABLE;
    readonly required: true;
  }
>;
type RequiredChannelOptions<A> = OptionsWithLiteral<
  A,
  { readonly type: typeof Discord.ApplicationCommandOptionType.CHANNEL; readonly required: true }
>;

// Type mapping from Discord enum values to TypeScript types
type OptionTypeToTs<T> = T extends typeof Discord.ApplicationCommandOptionType.STRING
  ? string
  : T extends typeof Discord.ApplicationCommandOptionType.INTEGER
    ? number
    : T extends typeof Discord.ApplicationCommandOptionType.NUMBER
      ? number
      : T extends typeof Discord.ApplicationCommandOptionType.BOOLEAN
        ? boolean
        : T extends typeof Discord.ApplicationCommandOptionType.USER
          ? {
              user: Discord.UserResponse;
              member: Option.Option<Omit<Discord.GuildMemberResponse, "user" | "deaf" | "mute">>;
            }
          : T extends typeof Discord.ApplicationCommandOptionType.CHANNEL
            ? Discord.GuildChannelResponse
            : T extends typeof Discord.ApplicationCommandOptionType.ROLE
              ? Discord.GuildRoleResponse
              : T extends typeof Discord.ApplicationCommandOptionType.MENTIONABLE
                ?
                    | Discord.GuildRoleResponse
                    | {
                        user: Discord.UserResponse;
                        member: Option.Option<
                          Omit<Discord.GuildMemberResponse, "user" | "deaf" | "mute">
                        >;
                      }
                : T extends typeof Discord.ApplicationCommandOptionType.ATTACHMENT
                  ? Discord.AttachmentResponse
                  : string | number | boolean;

type CommandRoleValue<A, N> = CommandWithName<
  A,
  N
>["type"] extends typeof Discord.ApplicationCommandOptionType.ROLE
  ? Discord.GuildRoleResponse
  : string;
type CommandUserValue<A, N> = CommandWithName<
  A,
  N
>["type"] extends typeof Discord.ApplicationCommandOptionType.USER
  ? {
      user: Discord.UserResponse;
      member: Option.Option<Omit<Discord.GuildMemberResponse, "user" | "deaf" | "mute">>;
    }
  : string;
type CommandMentionableValue<A, N> = CommandWithName<
  A,
  N
>["type"] extends typeof Discord.ApplicationCommandOptionType.MENTIONABLE
  ?
      | Discord.GuildRoleResponse
      | {
          user: Discord.UserResponse;
          member: Option.Option<Omit<Discord.GuildMemberResponse, "user" | "deaf" | "mute">>;
        }
  : string;
type CommandChannelValue<A, N> = CommandWithName<
  A,
  N
>["type"] extends typeof Discord.ApplicationCommandOptionType.CHANNEL
  ? Discord.GuildChannelResponse
  : string;

type AcknowledgementState = "none" | "replied" | "deferred-reply";

export class WrappedCommandHelper<A> {
  private acknowledgementState: AcknowledgementState = "none";

  constructor(
    readonly helper: CommandHelper<A>,
    private readonly subcommand: Option.Option<
      Discord.APIApplicationCommandInteractionDataOption<
        (typeof Discord.InteractionTypes)["APPLICATION_COMMAND"]
      >
    >,
    private readonly options: ReadonlyArray<
      Discord.APIApplicationCommandInteractionDataOption<
        (typeof Discord.InteractionTypes)["APPLICATION_COMMAND"]
      >
    >,
    readonly rest: DiscordRestService,
    private readonly application: Discord.PrivateApplicationResponse,
    readonly response: Deferred.Deferred<{
      readonly files: ReadonlyArray<File>;
      readonly payload: Discord.CreateInteractionResponseRequest;
    }>,
  ) {}
  get data() {
    return this.helper.data;
  }
  get target() {
    return this.helper.target;
  }

  resolve<T>(
    name: ResolvableOptions<A>["name"],
    f: (id: Discord.Snowflake, data: Discord.InteractionDataResolved) => T | undefined,
  ) {
    return this.helper.resolve(name, f);
  }

  resolvedValues<T>(
    f: (id: Discord.Snowflake, data: Discord.InteractionDataResolved) => T | undefined,
  ) {
    return this.helper.resolvedValues(f);
  }

  option(name: CommandOptions<A>["name"]): OptionTypeToTs<CommandWithName<A, typeof name>["type"]> {
    return this.helper.option(name) as any;
  }

  optionValue<N extends RequiredCommandOptions<A>["name"]>(
    name: N,
  ): OptionTypeToTs<CommandWithName<A, N>["type"]> {
    return this.helper.optionValue(name) as any;
  }

  optionValueOptional<N extends CommandOptions<A>["name"]>(
    name: N,
  ): Option.Option<OptionTypeToTs<CommandWithName<A, N>["type"]>> {
    return this.helper.optionValueOptional(name) as any;
  }

  optionValueOrElse<N extends CommandOptions<A>["name"], const OrElse>(
    name: N,
    orElse: () => OrElse,
  ): OptionTypeToTs<CommandWithName<A, N>["type"]> | OrElse {
    return this.helper.optionValueOrElse(name, orElse) as any;
  }

  optionRoleValue<N extends RequiredRoleOptions<A>["name"]>(name: N): CommandRoleValue<A, N> {
    return Option.getOrThrow(this.optionRoleValueOptional(name));
  }

  optionRoleValueOptional<N extends RoleOptions<A>["name"]>(
    name: N,
  ): Option.Option<CommandRoleValue<A, N>> {
    return this.helper.resolve(name, (id, data) => data.roles?.[id]);
  }

  optionRoleValueOrElse<N extends RoleOptions<A>["name"]>(
    name: N,
    orElse: () => CommandRoleValue<A, N>,
  ): CommandRoleValue<A, N> {
    return this.optionRoleValueOptional(name).pipe(Option.getOrElse(orElse));
  }

  optionUserValue<N extends RequiredUserOptions<A>["name"]>(name: N): CommandUserValue<A, N> {
    return Option.getOrThrow(this.optionUserValueOptional(name));
  }

  optionUserValueOptional<N extends UserOptions<A>["name"]>(
    name: N,
  ): Option.Option<CommandUserValue<A, N>> {
    return Option.flatten(
      this.helper.resolve(name, (id, data) => {
        const user = Option.fromNullable(data.users?.[id]);
        const member = Option.fromNullable(data.members?.[id]);
        return user.pipe(
          Option.map((user) => ({
            user,
            member,
          })),
        );
      }),
    );
  }

  optionUserValueOrElse<N extends UserOptions<A>["name"]>(
    name: N,
    orElse: () => CommandUserValue<A, N>,
  ): CommandUserValue<A, N> {
    return this.optionUserValueOptional(name).pipe(Option.getOrElse(orElse));
  }

  optionMentionableValue<N extends RequiredMentionableOptions<A>["name"]>(
    name: N,
  ): CommandMentionableValue<A, N> {
    return Option.getOrThrow(this.optionMentionableValueOptional(name));
  }

  optionMentionableValueOptional<N extends MentionableOptions<A>["name"]>(
    name: N,
  ): Option.Option<CommandMentionableValue<A, N>> {
    return Option.flatten(
      this.helper.resolve(name, (id, data) => {
        const role = Option.fromNullable(data.roles?.[id]);
        const user = Option.fromNullable(data.users?.[id]);
        const member = Option.fromNullable(data.members?.[id]);
        return Option.orElse(role, () =>
          user.pipe(
            Option.map((user) => ({
              user,
              member,
            })),
          ),
        );
      }),
    );
  }

  optionMentionableValueOrElse<N extends MentionableOptions<A>["name"]>(
    name: N,
    orElse: () => CommandMentionableValue<A, N>,
  ): CommandMentionableValue<A, N> {
    return this.optionMentionableValueOptional(name).pipe(Option.getOrElse(orElse));
  }

  optionChannelValue<N extends RequiredChannelOptions<A>["name"]>(
    name: N,
  ): CommandChannelValue<A, N> {
    return Option.getOrThrow(this.optionChannelValueOptional(name));
  }

  optionChannelValueOptional<N extends ChannelOptions<A>["name"]>(
    name: N,
  ): Option.Option<CommandChannelValue<A, N>> {
    return this.helper.resolve(name, (id, data) => data.channels?.[id]);
  }

  optionChannelValueOrElse<N extends ChannelOptions<A>["name"]>(
    name: N,
    orElse: () => CommandChannelValue<A, N>,
  ): CommandChannelValue<A, N> {
    return this.optionChannelValueOptional(name).pipe(Option.getOrElse(orElse));
  }

  subCommands<
    NER extends SubCommandGroupNames<A> | SubCommandNames<A> extends never
      ? never
      : {
          [Name in SubCommandGroupNames<A> | SubCommandNames<A>]: (
            commandHelper: WrappedCommandHelper<SubCommandWithName<A, Name>>,
          ) => Effect.Effect<unknown, any, any>;
        },
  >(
    commands: NER,
  ): Effect.Effect<
    unknown,
    [ReturnType<NER[keyof NER]>] extends [{ [Effect.EffectTypeId]: { _E: (_: never) => infer E } }]
      ? E
      : never,
    [ReturnType<NER[keyof NER]>] extends [{ [Effect.EffectTypeId]: { _R: (_: never) => infer R } }]
      ? R
      : DiscordInteraction | DiscordApplicationCommand
  > {
    const commands_ = commands as Record<string, any>;

    return Effect.fnUntraced(function* (wrapped: WrappedCommandHelper<A>) {
      yield* Effect.log(wrapped.subcommand, Object.keys(commands_));

      const command = Option.flatMap(wrapped.subcommand, (subcommand) =>
        Record.get(commands_, subcommand.name),
      );

      const options: ReadonlyArray<
        Discord.APIApplicationCommandInteractionDataOption<
          (typeof Discord.InteractionTypes)["APPLICATION_COMMAND"]
        >
      > = Option.map(wrapped.subcommand, (subcommand) =>
        "options" in subcommand && subcommand.options ? subcommand.options : [],
      ).pipe(Option.getOrElse(() => []));

      return yield* Option.match(command, {
        onSome: (command) =>
          command(
            new WrappedCommandHelper(
              wrapped.helper,
              Array.findFirst(
                options,
                (option) => option.type === Discord.ApplicationCommandOptionType.SUB_COMMAND_GROUP,
              ).pipe(
                Option.orElse(() =>
                  Array.findFirst(
                    options,
                    (option) => option.type === Discord.ApplicationCommandOptionType.SUB_COMMAND,
                  ),
                ),
              ),
              options,
              wrapped.rest,
              wrapped.application,
              wrapped.response,
            ),
          ),
        onNone: () => new SubCommandNotFound({ data: wrapped.data }),
      });
    })(this) as any;
  }

  get optionsMap() {
    return this.helper.optionsMap;
  }

  reply(payload?: Discord.IncomingWebhookInteractionRequest) {
    return Effect.sync(() => {
      this.acknowledgementState = "replied";
    }).pipe(
      Effect.zipRight(
        Deferred.succeed(this.response, {
          files: [],
          payload: {
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: payload,
          },
        }),
      ),
    );
  }

  replyWithFiles(files: ReadonlyArray<File>, response?: Discord.IncomingWebhookInteractionRequest) {
    return Effect.sync(() => {
      this.acknowledgementState = "replied";
    }).pipe(
      Effect.zipRight(
        Deferred.succeed(this.response, {
          files,
          payload: {
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: response,
          },
        }),
      ),
    );
  }

  deferReply(response?: Discord.IncomingWebhookInteractionRequest) {
    return Effect.sync(() => {
      this.acknowledgementState = "deferred-reply";
    }).pipe(
      Effect.zipRight(
        Deferred.succeed(this.response, {
          files: [],
          payload: {
            type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
            data: response,
          },
        }),
      ),
    );
  }

  respondWithError(error: unknown): Effect.Effect<unknown, DiscordRESTError, DiscordInteraction> {
    const rendered = makeDiscordErrorMessageResponse("Command failed", formatErrorResponse(error));
    const payload: Discord.IncomingWebhookRequestPartial = {
      content: rendered.content,
      flags: MessageFlags.Ephemeral,
    };

    if (this.acknowledgementState === "deferred-reply") {
      return rendered.files.length === 0
        ? this.editReply({ payload: { content: rendered.content } })
        : this.editReplyWithFiles(rendered.files, { payload: { content: rendered.content } });
    }

    if (this.acknowledgementState === "replied") {
      return this.followUp(payload, rendered.files);
    }

    return Effect.flatMap(
      rendered.files.length === 0
        ? this.reply(payload)
        : this.replyWithFiles(rendered.files, payload),
      (sent) => (sent ? Effect.void : this.followUp(payload, rendered.files)),
    );
  }

  private followUp(
    payload: Discord.IncomingWebhookRequestPartial,
    files: ReadonlyArray<File>,
  ): Effect.Effect<Discord.MessageResponse, DiscordRESTError, DiscordInteraction> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const command = this;

    return Ix.Interaction.pipe(
      Effect.flatMap((context) => {
        const request = command.rest.executeWebhook(command.application.id, context.token, {
          params: { wait: true },
          payload,
        });

        return files.length === 0 ? request : command.rest.withFiles(files)(request);
      }),
    );
  }

  editReply(response: {
    readonly params?: Discord.UpdateOriginalWebhookMessageParams;
    readonly payload: Discord.IncomingWebhookUpdateRequestPartial;
  }): Effect.Effect<Discord.MessageResponse, DiscordRESTError, DiscordInteraction> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const command = this;

    return Effect.gen(function* () {
      const context = yield* Ix.Interaction;

      return yield* command.rest.updateOriginalWebhookMessage(
        command.application.id,
        context.token,
        response,
      );
    });
  }

  editReplyWithFiles(
    files: ReadonlyArray<File>,
    response: {
      readonly params?: Discord.UpdateOriginalWebhookMessageParams;
      readonly payload: Discord.IncomingWebhookUpdateRequestPartial;
    },
  ): Effect.Effect<Discord.MessageResponse, DiscordRESTError, DiscordInteraction> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const command = this;

    return Effect.gen(function* () {
      const context = yield* Ix.Interaction;

      return yield* command.rest.withFiles(files)(
        command.rest.updateOriginalWebhookMessage(command.application.id, context.token, response),
      );
    });
  }
}

export const wrapCommandHelper = Effect.fnUntraced(function* <A>(
  helper: CommandHelper<A>,
  rest: DiscordRestService,
  application: Discord.PrivateApplicationResponse,
) {
  const response = yield* Deferred.make<{
    readonly files: ReadonlyArray<File>;
    readonly payload: Discord.CreateInteractionResponseRequest;
  }>();
  return new WrappedCommandHelper(
    helper,
    Array.findFirst(
      "options" in helper.data ? (helper.data.options ?? []) : [],
      (option) => option.type === Discord.ApplicationCommandOptionType.SUB_COMMAND_GROUP,
    ).pipe(
      Option.orElse(() =>
        Array.findFirst(
          "options" in helper.data ? (helper.data.options ?? []) : [],
          (option) => option.type === Discord.ApplicationCommandOptionType.SUB_COMMAND,
        ),
      ),
    ),
    "options" in helper.data ? (helper.data.options ?? []) : [],
    rest,
    application,
    response,
  );
});

export const makeForkedCommandHandler = Effect.fnUntraced(function* <
  const A extends Discord.ApplicationCommandCreateRequest,
  E = never,
  R = never,
>(handler: (commandHelper: WrappedCommandHelper<A>) => Effect.Effect<unknown, E, R>) {
  const fiberMap = yield* FiberMap.make<Discord.Snowflake>();

  return Effect.fnUntraced(function* (commandHelper: WrappedCommandHelper<A>) {
    const context = yield* Ix.Interaction;

    yield* pipe(handler(commandHelper), FiberMap.run(fiberMap, context.id));
  });
});

export const makeSubCommandGroup = Effect.fnUntraced(function* <
  const A extends Discord.ApplicationCommandSubcommandGroupOption,
  E = never,
  R = never,
>(
  data: (builder: SubCommandGroupBuilder) => SubCommandGroupBuilder<A>,
  handler: (commandHelper: WrappedCommandHelper<A>) => Effect.Effect<unknown, E, R>,
) {
  const builtData = data(new SubCommandGroupBuilder());
  const forkedHandler = yield* makeForkedCommandHandler(
    Effect.fn("makeSubCommandGroup.forkedHandler", {
      attributes: { subCommandGroup: builtData.builder.name },
    })(function* (commandHelper: WrappedCommandHelper<A>) {
      const shouldRunFallback = yield* handler(commandHelper).pipe(
        Effect.as(true),
        Effect.catchAllCause((cause) =>
          Effect.logError(cause).pipe(
            Effect.zipRight(commandHelper.respondWithError(cause)),
            Effect.as(false),
          ),
        ),
      );

      if (!shouldRunFallback) {
        return;
      }

      yield* Effect.sleep(2500);
      yield* commandHelper.reply({
        content: "The subcommand group did not set a response in time.",
      });
    }),
  );
  return {
    data: builtData,
    handler: forkedHandler,
  };
});

export const makeSubCommand = Effect.fnUntraced(function* <
  const A extends Discord.ApplicationCommandSubcommandOption,
  E = never,
  R = never,
>(
  data: (builder: SubCommandBuilder) => SubCommandBuilder<A>,
  handler: (
    commandHelper: WrappedCommandHelper<
      A & { readonly type: typeof Discord.ApplicationCommandOptionType.SUB_COMMAND }
    >,
  ) => Effect.Effect<unknown, E, R>,
) {
  const builtData = data(new SubCommandBuilder());
  const forkedHandler = yield* makeForkedCommandHandler(
    Effect.fn("makeSubCommand.forkedHandler", {
      attributes: { subCommand: builtData.builder.name },
    })(function* (commandHelper: WrappedCommandHelper<A>) {
      const shouldRunFallback = yield* handler(commandHelper).pipe(
        Effect.as(true),
        Effect.catchAllCause((cause) =>
          Effect.logError(cause).pipe(
            Effect.zipRight(commandHelper.respondWithError(cause)),
            Effect.as(false),
          ),
        ),
      );

      if (!shouldRunFallback) {
        return;
      }

      yield* Effect.sleep(2500);
      yield* commandHelper.reply({ content: "The subcommand did not set a response in time." });
    }),
  );
  return {
    data: builtData,
    handler: forkedHandler,
  };
});

export const makeCommand = Effect.fnUntraced(function* <
  const A extends Discord.ApplicationCommandCreateRequest,
  E = never,
  R = never,
>(
  data: (
    builder: CommandBuilder,
  ) => CommandBuilder<A> | CommandOptionsOnlyBuilder<A> | CommandSubCommandsOnlyBuilder<A>,
  handler: (commandHelper: WrappedCommandHelper<A>) => Effect.Effect<unknown, E, R>,
) {
  const builtData = data(new CommandBuilder());
  const rest = yield* DiscordREST;
  const application = yield* DiscordApplication;
  const forkedHandler = yield* makeForkedCommandHandler(
    Effect.fn("makeCommand.forkedHandler", { attributes: { command: builtData.builder.name } })(
      function* (commandHelper: WrappedCommandHelper<A>) {
        const shouldRunFallback = yield* handler(commandHelper).pipe(
          Effect.as(true),
          Effect.catchAllCause((cause) =>
            Effect.logError(cause).pipe(
              Effect.zipRight(commandHelper.respondWithError(cause)),
              Effect.as(false),
            ),
          ),
        );

        if (!shouldRunFallback) {
          return;
        }

        yield* Effect.sleep(2500);
        yield* commandHelper.reply({ content: "The command did not set a response in time." });
      },
    ),
  );
  return {
    data: builtData.toJSON(),
    handler: Effect.fnUntraced(function* (commandHelper: CommandHelper<A>) {
      const wrappedCommandHelper = yield* wrapCommandHelper(commandHelper, rest, application);
      yield* forkedHandler(wrappedCommandHelper);
      const { files, payload } = yield* wrappedCommandHelper.response;
      return {
        files,
        ...payload,
      };
    }),
  };
});

export type GlobalCommand<E, R> = GlobalApplicationCommand<
  Exclude<R, DiscordApplicationCommand | DiscordInteraction | Scope.Scope>,
  E
>;
export type GuildCommand<E, R> = GuildApplicationCommand<
  Exclude<R, DiscordApplicationCommand | DiscordInteraction | Scope.Scope>,
  E
>;

export const makeGlobalCommand = <
  const A extends Discord.ApplicationCommandCreateRequest,
  E = never,
  R = never,
>(
  data: A,
  handler: (
    commandHelper: CommandHelper<A>,
  ) => Effect.Effect<Discord.CreateInteractionResponseRequest, E, R>,
): GlobalCommand<E, R> => Ix.global(data, handler);

export const makeGuildCommand = <
  const A extends Discord.ApplicationCommandCreateRequest,
  E = never,
  R = never,
>(
  data: A,
  handler: (
    commandHelper: CommandHelper<A>,
  ) => Effect.Effect<Discord.CreateInteractionResponseRequest, E, R>,
): GuildCommand<E, R> => Ix.guild(data, handler);
