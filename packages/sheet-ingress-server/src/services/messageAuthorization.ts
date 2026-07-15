import { Effect, Option } from "effect";

const getModernMessageGuildId = <
  T extends {
    readonly workspaceId: Option.Option<string>;
    readonly conversationId: Option.Option<string>;
  },
>(
  record: T,
) =>
  Option.match(record.workspaceId, {
    onSome: (guildId) =>
      Option.isSome(record.conversationId) ? Option.some(guildId) : Option.none(),
    onNone: () => Option.none(),
  });

export const requireModernMessageGuildId = <
  T extends Parameters<typeof getModernMessageGuildId>[0],
  E,
  R,
>(
  record: T,
  onLegacy: () => Effect.Effect<never, E, R>,
) =>
  Option.match(getModernMessageGuildId(record), {
    onSome: Effect.succeed,
    onNone: onLegacy,
  });
