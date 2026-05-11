import type { HttpClientError } from "effect/unstable/http";
import { Discord, Ix } from "dfx";
import { MessageFlags } from "discord-api-types/v10";
import type { DiscordRESTError } from "dfx/DiscordREST";
import { GlobalApplicationCommand, GuildApplicationCommand } from "dfx/Interactions/definitions";
import { CommandHelper } from "dfx/Interactions/commandHelper";
import {
  SubCommandNotFound,
  type DiscordApplicationCommand,
  type DiscordInteraction,
} from "dfx/Interactions/context";
import { Array, Effect, Fiber, FiberMap, Option, pipe, Record, Scope } from "effect";
import {
  CommandBuilder,
  CommandOptionsOnlyBuilder,
  CommandSubCommandsOnlyBuilder,
  SubCommandBuilder,
  SubCommandGroupBuilder,
} from "./commandBuilder";
import { InteractionToken, provideInteractionToken } from "./interaction";
import { InteractionResponse, provideInteractionResponse } from "./interactionResponse";
import type { CommandInteractionResponseContext } from "./interactionResponse";

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

export class WrappedCommandHelper<A> {
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
  ) {}
  get data(): CommandHelper<A>["data"] {
    return this.helper.data;
  }
  get target(): CommandHelper<A>["target"] {
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
        const user = Option.fromNullishOr(data.users?.[id]);
        const member = Option.fromNullishOr(data.members?.[id]);
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
        const role = Option.fromNullishOr(data.roles?.[id]);
        const user = Option.fromNullishOr(data.users?.[id]);
        const member = Option.fromNullishOr(data.members?.[id]);
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
    Effect.Error<ReturnType<NER[keyof NER]>>,
    Effect.Services<ReturnType<NER[keyof NER]>>
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
            ),
          ),
        onNone: () => new SubCommandNotFound({ data: wrapped.data }),
      });
    })(this) as any;
  }

  get optionsMap() {
    return this.helper.optionsMap;
  }
}

export const wrapCommandHelper = <A>(helper: CommandHelper<A>) =>
  new WrappedCommandHelper(
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
  );

export const makeForkedCommandHandler = Effect.fnUntraced(function* <
  const A extends Discord.ApplicationCommandCreateRequest,
  E = never,
  R = never,
>(handler: (commandHelper: WrappedCommandHelper<A>) => Effect.Effect<unknown, E, R>) {
  const fiberMap = yield* FiberMap.make<Discord.Snowflake>();

  return Effect.fnUntraced(function* (commandHelper: WrappedCommandHelper<A>) {
    const context = yield* Ix.Interaction;

    yield* pipe(
      handler(commandHelper),
      provideInteractionToken,
      FiberMap.run(fiberMap, context.id),
    );
  });
});

const replyWithTimeoutFallback = (response: CommandInteractionResponseContext, content: string) =>
  response.awaitInitialResponse.pipe(
    Effect.raceFirst(
      Effect.sleep(2500).pipe(
        Effect.andThen(response.reply({ content, flags: MessageFlags.Ephemeral })),
      ),
    ),
    Effect.catchCause((cause) => Effect.logError(cause)),
    Effect.asVoid,
  );

const runWithTimeoutFallback = <A, E, R>(
  response: CommandInteractionResponseContext,
  content: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fallbackFiber = yield* replyWithTimeoutFallback(response, content).pipe(
      Effect.forkScoped,
    );
    const handlerCompleted = yield* effect.pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logError(cause).pipe(
          Effect.andThen(response.respondWithError(cause)),
          Effect.as(false),
        ),
      ),
    );

    yield* Fiber.join(fallbackFiber);

    if (!handlerCompleted) {
      return;
    }
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
      const response = yield* InteractionResponse;
      // The outer command owns the timeout fallback so nested command handlers
      // cannot race each other to set the shared initial response.
      yield* handler(commandHelper).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(cause).pipe(Effect.andThen(response.respondWithError(cause))),
        ),
      );
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
      const response = yield* InteractionResponse;
      // The outer command owns the timeout fallback so nested command handlers
      // cannot race each other to set the shared initial response.
      yield* handler(commandHelper).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(cause).pipe(Effect.andThen(response.respondWithError(cause))),
        ),
      );
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
  const forkedHandler = yield* makeForkedCommandHandler(
    Effect.fn("makeCommand.forkedHandler", { attributes: { command: builtData.builder.name } })(
      function* (commandHelper: WrappedCommandHelper<A>) {
        const response = yield* InteractionResponse;
        yield* runWithTimeoutFallback(
          response,
          "The command did not set a response in time.",
          handler(commandHelper),
        );
      },
    ),
  );
  return {
    data: builtData.toJSON(),
    handler: Effect.fnUntraced(function* (commandHelper: CommandHelper<A>) {
      const response = yield* InteractionResponse;
      const wrappedCommandHelper = wrapCommandHelper(commandHelper);
      yield* forkedHandler(wrappedCommandHelper);
      const { files, payload } = yield* response.awaitInitialResponse;
      return {
        files,
        ...payload,
      };
    }),
  };
});

export type GlobalCommand<E, R> = GlobalApplicationCommand<
  Exclude<
    Exclude<Exclude<R, InteractionResponse>, InteractionToken>,
    DiscordApplicationCommand | DiscordInteraction | Scope.Scope
  >,
  E
>;
export type GuildCommand<E, R> = GuildApplicationCommand<
  Exclude<
    Exclude<Exclude<R, InteractionResponse>, InteractionToken>,
    DiscordApplicationCommand | DiscordInteraction | Scope.Scope
  >,
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
): GlobalCommand<E, R> =>
  Ix.global(data, (commandHelper) =>
    provideInteractionToken(provideInteractionResponse("command", handler(commandHelper))),
  ) as GlobalCommand<E, R>;

export const makeGuildCommand = <
  const A extends Discord.ApplicationCommandCreateRequest,
  E = never,
  R = never,
>(
  data: A,
  handler: (
    commandHelper: CommandHelper<A>,
  ) => Effect.Effect<Discord.CreateInteractionResponseRequest, E, R>,
): GuildCommand<E, R> =>
  Ix.guild(data, (commandHelper) =>
    provideInteractionToken(provideInteractionResponse("command", handler(commandHelper))),
  ) as GuildCommand<E, R>;
