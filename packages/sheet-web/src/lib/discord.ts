import { useAtomSuspense } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { SheetApisClient } from "#/lib/sheetApis";
import { Duration, Schema } from "effect";
import { ArgumentError, SchemaError } from "typhoon-core/error";
import { QueryResultAppError, QueryResultParseError } from "typhoon-zero/error";
import { Discord } from "sheet-ingress-api/schemas";

const _currentUserAtom = SheetApisClient.query("discord", "getCurrentUser", {});

const DiscordRequestErrorSchema = Schema.revealCodec(
  Schema.Union([SchemaError, QueryResultAppError, QueryResultParseError, ArgumentError]),
);

const CurrentUserAsyncResultSchema = Schema.revealCodec(
  AsyncResult.Schema({
    success: Discord.DiscordUser,
    error: DiscordRequestErrorSchema,
  }),
);

const CurrentUserGuildsAsyncResultSchema = Schema.revealCodec(
  AsyncResult.Schema({
    success: Schema.Array(Discord.DiscordGuild),
    error: DiscordRequestErrorSchema,
  }),
);

export const currentUserAtom = _currentUserAtom.pipe(
  Atom.setIdleTTL(Duration.infinity),
  Atom.serializable({
    key: "discord.getCurrentUser",
    schema: CurrentUserAsyncResultSchema,
  }),
);

export const useCurrentUser = () => {
  const result = useAtomSuspense(currentUserAtom, {
    suspendOnWaiting: false,
    includeFailure: false,
  });

  return result.value;
};

const _currentUserGuildsAtom = SheetApisClient.query("discord", "getCurrentUserGuilds", {});

export const currentUserGuildsAtom = _currentUserGuildsAtom.pipe(
  Atom.setIdleTTL(Duration.infinity),
  Atom.serializable({
    key: "discord.getCurrentUserGuilds",
    schema: CurrentUserGuildsAsyncResultSchema,
  }),
);

export const useCurrentUserGuilds = () => {
  const result = useAtomSuspense(currentUserGuildsAtom, {
    suspendOnWaiting: false,
    includeFailure: false,
  });

  return result.value;
};
