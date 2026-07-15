import { setTimeout as delay } from "node:timers/promises";
import type { InternalAdapter } from "better-auth";
import { Predicate } from "effect";

const DiscordSubjectProviderIds = ["discord", "kubernetes:discord"] as const;

const findDiscordSubjectAccount = async (adapter: InternalAdapter, discordUserId: string) =>
  (await adapter.findAccountByProviderId(discordUserId, DiscordSubjectProviderIds[0])) ??
  (await adapter.findAccountByProviderId(discordUserId, DiscordSubjectProviderIds[1]));

export const findSubjectAccountForUser = async (adapter: InternalAdapter, userId: string) => {
  const accounts = await adapter.findAccounts(userId);
  return DiscordSubjectProviderIds.map((providerId) =>
    accounts.find((account) => account.providerId === providerId),
  ).find(Predicate.isNotUndefined);
};

export const findDiscordOAuthAccountForUser = async (adapter: InternalAdapter, userId: string) => {
  const accounts = await adapter.findAccounts(userId);
  return accounts.find((account) => account.providerId === "discord");
};

const createPlaceholderUserWithDiscord = async (
  adapter: InternalAdapter,
  discordUserId: string,
) => {
  const { user } = await adapter.createOAuthUser(
    {
      email: `discord_${discordUserId}@oauth.internal`,
      emailVerified: true,
      name: `Discord User ${discordUserId}`,
    },
    {
      providerId: "discord",
      accountId: discordUserId,
    },
  );

  return user;
};

const isUniqueConstraintConflict = (error: unknown) =>
  Predicate.hasProperty(error, "code") && error.code === "23505";

const findDiscordSubjectUser = async (adapter: InternalAdapter, discordUserId: string) => {
  const account = await findDiscordSubjectAccount(adapter, discordUserId);
  return account?.userId ? await adapter.findUserById(account.userId) : null;
};

export const resolveUserByDiscordId = async (adapter: InternalAdapter, discordUserId: string) => {
  const existingUser = await findDiscordSubjectUser(adapter, discordUserId);
  if (existingUser) {
    return existingUser;
  }

  try {
    return await createPlaceholderUserWithDiscord(adapter, discordUserId);
  } catch (error) {
    if (!isUniqueConstraintConflict(error)) {
      throw error;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await delay(50);
      const concurrentlyCreatedUser = await findDiscordSubjectUser(adapter, discordUserId);
      if (concurrentlyCreatedUser) {
        return concurrentlyCreatedUser;
      }
    }

    throw error;
  }
};
