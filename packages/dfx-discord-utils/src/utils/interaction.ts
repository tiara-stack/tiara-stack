import { Ix } from "dfx";
import type * as Discord from "dfx/types";
import { Effect, Option } from "effect";

type InteractionUser = Discord.UserResponse;
type InteractionMember = NonNullable<Discord.APIInteraction["member"]>;
type InteractionGuild = NonNullable<Discord.APIInteraction["guild"]>;
type InteractionChannel = NonNullable<Discord.APIInteraction["channel"]>;
type InteractionMessage = NonNullable<Discord.APIInteraction["message"]>;

export const user = Effect.fn("interaction.user")(function* () {
  const interaction = yield* Ix.Interaction;
  return Option.fromNullishOr(interaction.member?.user).pipe(
    Option.orElse(() => Option.fromNullishOr(interaction.user)),
    Option.getOrThrow,
  ) as InteractionUser;
});

export const member: () => Effect.Effect<Option.Option<InteractionMember>, never, Ix.Interaction> =
  Effect.fn("interaction.member")(function* () {
    const interaction = yield* Ix.Interaction;
    return Option.fromNullishOr(interaction.member);
  });

export const guild: () => Effect.Effect<Option.Option<InteractionGuild>, never, Ix.Interaction> =
  Effect.fn("interaction.guild")(function* () {
    const interaction = yield* Ix.Interaction;
    return Option.fromNullishOr(interaction.guild);
  });

export const channel: () => Effect.Effect<
  Option.Option<InteractionChannel>,
  never,
  Ix.Interaction
> = Effect.fn("interaction.channel")(function* () {
  const interaction = yield* Ix.Interaction;
  return Option.fromNullishOr(interaction.channel);
});

export const message: () => Effect.Effect<
  Option.Option<InteractionMessage>,
  never,
  Ix.Interaction
> = Effect.fn("interaction.message")(function* () {
  const interaction = yield* Ix.Interaction;
  return Option.fromNullishOr(interaction.message);
});
