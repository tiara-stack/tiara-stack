import { useAtomSet, useAtomSuspense } from "@effect/atom-react";
import { Duration } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";
import type {
  SupportedNotificationClient,
  UserPlatformConfig,
} from "sheet-ingress-api/schemas/userConfig";
import { SheetApisClient } from "#/lib/sheetApis";

const userConfigReactivityKey = "userConfig";

const discordUserPlatformConfigAtom = SheetApisClient.query(
  "userConfig",
  "getCurrentUserPlatformConfig",
  {
    params: { platform: "discord" },
    reactivityKeys: [userConfigReactivityKey],
  },
).pipe(Atom.setIdleTTL(Duration.minutes(5)));

const supportedNotificationClientsAtom = SheetApisClient.query(
  "userConfig",
  "listSupportedNotificationClients",
  {
    reactivityKeys: [userConfigReactivityKey],
  },
).pipe(Atom.setIdleTTL(Duration.minutes(5)));

type UpsertCurrentUserPlatformConfigPayload = {
  readonly platform: string;
  readonly checkinDmEnabled: boolean;
  readonly defaultClientId?: string | null | undefined;
};

const upsertCurrentUserPlatformConfigAtom = SheetApisClient.mutation(
  "userConfig",
  "upsertCurrentUserPlatformConfig",
);

export const useDiscordUserPlatformConfigResult = () =>
  useAtomSuspense(discordUserPlatformConfigAtom, {
    suspendOnWaiting: false,
    includeFailure: true,
  });

export const useSupportedNotificationClientsResult = () =>
  useAtomSuspense(supportedNotificationClientsAtom, {
    suspendOnWaiting: false,
    includeFailure: true,
  });

export const useUpsertCurrentUserPlatformConfig = () => {
  const mutate = useAtomSet(upsertCurrentUserPlatformConfigAtom, { mode: "promise" });
  return useCallback(
    (payload: UpsertCurrentUserPlatformConfigPayload) =>
      mutate({
        payload,
        reactivityKeys: [userConfigReactivityKey],
      }) as Promise<UserPlatformConfig>,
    [mutate],
  );
};

export type { SupportedNotificationClient, UserPlatformConfig };
