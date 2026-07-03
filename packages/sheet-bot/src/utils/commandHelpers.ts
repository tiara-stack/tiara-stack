import { Ix } from "dfx/index";
import { Effect, Option, Predicate, pipe } from "effect";
import { Interaction, InteractionToken } from "dfx-discord-utils/utils";
import type { NumberOptionBuilder, StringOptionBuilder } from "dfx-discord-utils/utils";
import { config } from "../config";
import { interactionDeadlineEpochMs } from "./interactionDeadline";
import * as Data from "effect/Data";

class SheetBotUtilsCommandHelpersError extends Data.TaggedError(
  "SheetBotUtilsCommandHelpersError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type DiscordUserIdentity = {
  readonly id: string;
  readonly username: string;
};

const isDiscordSnowflakeId = (value: string): boolean => /^\d{17,20}$/.test(value);

const decodeDiscordSnowflakeId = (value: string, label: string): Effect.Effect<string, Error> =>
  isDiscordSnowflakeId(value)
    ? Effect.succeed(value)
    : Effect.fail(
        new SheetBotUtilsCommandHelpersError({
          message: `Invalid ${label}: expected Discord snowflake ID`,
        }),
      );

const getIdFromUnknown = (value: unknown): Option.Option<string> => {
  if (Predicate.hasProperty(value, "id") && Predicate.isString(value.id)) {
    return Option.some(value.id);
  }

  return Option.none();
};

const getStringFromUnknown = (value: unknown, key: string): Option.Option<string> =>
  Predicate.hasProperty(value, key) && Predicate.isString(value[key])
    ? Option.some(value[key])
    : Option.none();

export const requireResolvedId = (value: unknown, label: string): Effect.Effect<string, Error> =>
  pipe(
    getIdFromUnknown(value),
    Option.match({
      onSome: (id) => decodeDiscordSnowflakeId(id, label),
      onNone: () =>
        Effect.fail(new SheetBotUtilsCommandHelpersError({ message: `${label} is missing an id` })),
    }),
  );

export const requireString = (value: unknown, label: string): Effect.Effect<string, Error> =>
  Predicate.isString(value)
    ? Effect.succeed(value)
    : Effect.fail(new SheetBotUtilsCommandHelpersError({ message: `${label} must be a string` }));

export const requireBoolean = (value: unknown, label: string): Effect.Effect<boolean, Error> =>
  Predicate.isBoolean(value)
    ? Effect.succeed(value)
    : Effect.fail(new SheetBotUtilsCommandHelpersError({ message: `${label} must be a boolean` }));

export const requireNumber = (value: unknown, label: string): Effect.Effect<number, Error> =>
  Predicate.isNumber(value)
    ? Effect.succeed(value)
    : Effect.fail(new SheetBotUtilsCommandHelpersError({ message: `${label} must be a number` }));

export const serverIdOption = (description: string) => (option: StringOptionBuilder) =>
  option.setName("server_id").setDescription(description);

export const requiredDayOption = (description: string) => (option: NumberOptionBuilder) =>
  option.setName("day").setDescription(description).setRequired(true);

export const optionalPayloadField = <const Key extends string, Value>(
  key: Key,
  value: Option.Option<Value>,
): Partial<Record<Key, Value>> =>
  pipe(
    value,
    Option.match({
      onSome: (resolved) => ({ [key]: resolved }) as Record<Key, Value>,
      onNone: () => ({}),
    }),
  );

const toDiscordUserIdentity = (value: unknown): Option.Option<DiscordUserIdentity> =>
  Option.all({
    id: getStringFromUnknown(value, "id"),
    username: getStringFromUnknown(value, "username"),
  });

const getInteractionGuildId = Effect.gen(function* () {
  const interactionGuild = yield* Interaction.guild();
  return pipe(
    interactionGuild,
    Option.flatMap(getIdFromUnknown),
    Option.filter(isDiscordSnowflakeId),
  );
});

export const resolveGuildId = (serverId: Option.Option<string>) =>
  Effect.gen(function* () {
    const interactionGuildId = yield* getInteractionGuildId;

    const selectedId = pipe(
      serverId,
      Option.orElse(() => interactionGuildId),
      Option.getOrThrowWith(
        () =>
          new SheetBotUtilsCommandHelpersError({
            message: "Guild not found in interaction or command options",
          }),
      ),
    );

    return yield* decodeDiscordSnowflakeId(selectedId, "guild ID");
  });

const getInteractionChannelId = Effect.gen(function* () {
  const interactionChannel = yield* Interaction.channel();
  return pipe(interactionChannel, Option.flatMap(getIdFromUnknown));
});

export const resolveChannelId = (channelOption: Option.Option<unknown>) =>
  pipe(
    channelOption,
    Option.flatMap(getIdFromUnknown),
    Option.match({
      onSome: (id) => decodeDiscordSnowflakeId(id, "channel ID"),
      onNone: () =>
        pipe(
          getInteractionChannelId,
          Effect.flatMap((id) =>
            pipe(
              id,
              Option.match({
                onSome: (value) => decodeDiscordSnowflakeId(value, "channel ID"),
                onNone: () =>
                  Effect.fail(
                    new SheetBotUtilsCommandHelpersError({
                      message: "Channel not found in interaction",
                    }),
                  ),
              }),
            ),
          ),
        ),
    }),
  );

export const resolveConversationTarget = (
  serverId: Option.Option<string>,
  conversationName: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const workspaceId = yield* resolveGuildId(serverId);

    if (Option.isSome(conversationName)) {
      return {
        workspaceId,
        conversationName: conversationName.value,
      };
    }

    return {
      workspaceId,
      conversationId: yield* resolveChannelId(Option.none()),
    };
  });

const getInteractionUser = Effect.gen(function* () {
  const interactionUser = yield* Interaction.user();
  return yield* pipe(
    toDiscordUserIdentity(interactionUser),
    Option.match({
      onSome: Effect.succeed,
      onNone: () =>
        Effect.fail(
          new SheetBotUtilsCommandHelpersError({
            message: "Interaction user is missing id or username",
          }),
        ),
    }),
  );
});

export const resolveTargetUserIdentity = (
  selectedUser: Option.Option<{ readonly user: unknown }>,
) =>
  Effect.gen(function* () {
    const interactionUser = yield* getInteractionUser;

    return pipe(
      selectedUser,
      Option.flatMap(({ user }) => toDiscordUserIdentity(user)),
      Option.getOrElse(() => interactionUser),
    );
  });

export const makeDispatchBase = Effect.gen(function* () {
  const interactionToken = yield* InteractionToken;
  const interaction = yield* Ix.Interaction;
  const clientId = yield* config.sheetBotClientId;
  return {
    client: { platform: "discord", clientId },
    dispatchRequestId: `discord-interaction:${interaction.id}`,
    interactionResponseToken: interactionToken.token,
    interactionResponseDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
  };
});
