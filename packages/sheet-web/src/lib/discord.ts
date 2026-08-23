import { useAtomSuspense } from "@effect/atom-react";
import { Duration, Effect, Schema } from "effect";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { DiscordLoadProfileSuccess } from "sheet-workflow-contracts";
import { runSheetWorkflow, sheetZeroClientAtom } from "#/lib/sheetZero";

const DiscordUser = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  global_name: Schema.NullOr(Schema.String),
  avatar: Schema.NullOr(Schema.String),
});

type DiscordUser = Schema.Schema.Type<typeof DiscordUser>;

const DiscordGuild = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.NullOr(Schema.String),
  owner_id: Schema.String,
});

export type DiscordGuild = Schema.Schema.Type<typeof DiscordGuild>;

const DiscordProfile = Schema.Struct({
  user: DiscordUser,
  guilds: Schema.Array(DiscordGuild),
});
type DiscordProfileValue = Schema.Schema.Type<typeof DiscordProfile>;

const DiscordProfileAsyncResultSchema = Schema.revealCodec(
  AsyncResult.Schema({
    success: DiscordProfile,
    error: Schema.Unknown,
  }),
);

const _currentUserProfileAtom = Atom.make<DiscordProfileValue, unknown>(
  Effect.fnUntraced(function* (get) {
    const runtime = yield* get.result(sheetZeroClientAtom);
    const profile = yield* runSheetWorkflow(
      runtime.workflows.discord.loadProfile,
      {},
      DiscordLoadProfileSuccess,
    );
    return {
      user: {
        id: profile.user.id,
        username: profile.user.username,
        global_name: profile.user.displayName,
        avatar: profile.user.avatar,
      },
      guilds: profile.guilds.map((guild) => ({
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        owner_id: guild.ownerId,
      })),
    };
  }),
).pipe(
  Atom.setIdleTTL(Duration.infinity),
  Atom.serializable({
    key: "discord.loadProfile",
    schema: DiscordProfileAsyncResultSchema,
  }),
);

export const currentUserAtom = Atom.make(
  Effect.fnUntraced(function* (get) {
    const profile = yield* get.result(_currentUserProfileAtom);
    return profile.user;
  }),
).pipe(Atom.setIdleTTL(Duration.infinity));

export const useCurrentUser = () => {
  const result = useAtomSuspense(currentUserAtom, {
    suspendOnWaiting: false,
    includeFailure: false,
  });

  return result.value;
};

export const currentUserGuildsAtom = Atom.make(
  Effect.fnUntraced(function* (get) {
    const profile = yield* get.result(_currentUserProfileAtom);
    return profile.guilds;
  }),
).pipe(Atom.setIdleTTL(Duration.infinity));

export const useCurrentUserGuilds = () => {
  const result = useAtomSuspense(currentUserGuildsAtom, {
    suspendOnWaiting: false,
    includeFailure: false,
  });

  return result.value;
};
