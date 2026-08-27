import { Equal, Predicate } from "effect";
import type { BotPermissionOverwrite } from "./delivery";

// Discord's channel type values are stable protocol values. Keeping these predicates beside the
// bot capability contract prevents browser and workflow callers from importing a gateway package.
export const isDiscordCategoryChannelType = Equal.equals(4);
export const isDiscordAnnouncementChannelType = Equal.equals(5);
export const isSendableDiscordChannelType = Predicate.or(Equal.equals(0), Equal.equals(5));

const lockdownRoleBits = 330_752;
const monitorRoleBits = 338_960;

export const emptyPermissionBits = "0";
export const lockdownRolePermissionAllow = String(lockdownRoleBits);
export const monitorRolePermissionAllow = String(monitorRoleBits);
export const lockdownWorkspacePermissionDeny = "1024";

export const lockdownEveryoneRoleErrorMessage =
  "The @everyone role cannot be used as the lockdown role";

export const isLockdownRoleIdAllowed = (workspaceId: string, roleId: string): boolean =>
  !Equal.equals(workspaceId)(roleId);

export const makeLockdownPermissionOverwrites = ({
  workspaceId,
  lockdownRoleId,
  monitorRoleIds,
}: {
  readonly workspaceId: string;
  readonly lockdownRoleId: string;
  readonly monitorRoleIds: ReadonlyArray<string>;
}): ReadonlyArray<BotPermissionOverwrite> => {
  if (!isLockdownRoleIdAllowed(workspaceId, lockdownRoleId)) {
    throw new Error(lockdownEveryoneRoleErrorMessage);
  }

  return [
    {
      targetId: lockdownRoleId,
      targetKind: "role",
      allow: lockdownRolePermissionAllow,
      deny: emptyPermissionBits,
    },
    ...Array.from(new Set(monitorRoleIds))
      .filter((monitorRoleId) => monitorRoleId !== lockdownRoleId && monitorRoleId !== workspaceId)
      .map((targetId) => ({
        targetId,
        targetKind: "role" as const,
        allow: monitorRolePermissionAllow,
        deny: emptyPermissionBits,
      })),
    {
      targetId: workspaceId,
      targetKind: "role",
      allow: emptyPermissionBits,
      deny: lockdownWorkspacePermissionDeny,
    },
  ];
};
