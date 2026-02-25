import { useAtomSuspense } from "@effect-atom/atom-react";
import { SheetApisClient } from "#/lib/sheetApis";

export const currentUserGuildsAtom = SheetApisClient.query("discord", "getCurrentUserGuilds", {});

export const useCurrentUserGuilds = () => {
  const result = useAtomSuspense(currentUserGuildsAtom, {
    suspendOnWaiting: true,
    includeFailure: false,
  });

  return result.value;
};
