import { Ix } from "dfx/index";
import { Effect, Option, pipe } from "effect";
import { Interaction, InteractionToken } from "dfx-discord-utils/utils";
import { interactionDeadlineEpochMs } from "./interactionDeadline";

export type DiscordUserIdentity = {
  readonly id: string;
  readonly username: string;
};

const isDiscordSnowflakeId = (value: string): boolean => /^\d{17,20}$/.test(value);

const decodeDiscordSnowflakeId = (value: string, label: string): Effect.Effect<string, Error> =>
  isDiscordSnowflakeId(value)
    ? Effect.succeed(value)
    : Effect.fail(new Error(`Invalid ${label}: expected Discord snowflake ID`));

const getIdFromUnknown = (value: unknown): Option.Option<string> => {
  if (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string"
  ) {
    return Option.some(value.id);
  }

  return Option.none();
};

export const requireResolvedId = (value: unknown, label: string): Effect.Effect<string, Error> =>
  pipe(
    getIdFromUnknown(value),
    Option.match({
      onSome: (id) => decodeDiscordSnowflakeId(id, label),
      onNone: () => Effect.fail(new Error(`${label} is missing an id`)),
    }),
  );

export const requireString = (value: unknown, label: string): Effect.Effect<string, Error> =>
  typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new Error(`${label} must be a string`));

export const requireBoolean = (value: unknown, label: string): Effect.Effect<boolean, Error> =>
  typeof value === "boolean"
    ? Effect.succeed(value)
    : Effect.fail(new Error(`${label} must be a boolean`));

export const requireNumber = (value: unknown, label: string): Effect.Effect<number, Error> =>
  typeof value === "number"
    ? Effect.succeed(value)
    : Effect.fail(new Error(`${label} must be a number`));

export const toDiscordUserIdentity = (value: unknown): Option.Option<DiscordUserIdentity> => {
  if (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "username" in value &&
    typeof value.username === "string"
  ) {
    return Option.some({ id: value.id, username: value.username });
  }

  return Option.none();
};

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
      Option.getOrThrowWith(() => new Error("Guild not found in interaction or command options")),
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
                onNone: () => Effect.fail(new Error("Channel not found in interaction")),
              }),
            ),
          ),
        ),
    }),
  );

export const getInteractionUser = Effect.gen(function* () {
  const interactionUser = yield* Interaction.user();
  return yield* pipe(
    toDiscordUserIdentity(interactionUser),
    Option.match({
      onSome: Effect.succeed,
      onNone: () => Effect.fail(new Error("Interaction user is missing id or username")),
    }),
  );
});

export const makeDispatchBase = Effect.gen(function* () {
  const interactionToken = yield* InteractionToken;
  const interaction = yield* Ix.Interaction;
  return {
    dispatchRequestId: `discord-interaction:${interaction.id}`,
    interactionToken: interactionToken.token,
    interactionDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
  };
});
