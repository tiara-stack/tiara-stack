import { Predicate } from "effect";

const administratorPermission = 1n << 3n;
const viewChannelPermission = 1n << 10n;
const sendMessagesPermission = 1n << 11n;

type PermissionOverwrite = {
  readonly id: string;
  readonly type: 0 | 1;
  readonly allow: string;
  readonly deny: string;
};

export type DiscordChannelPermissionInput = {
  readonly permissions?: string | null | undefined;
  readonly permission_overwrites?: ReadonlyArray<PermissionOverwrite> | undefined;
};

type DiscordRolePermissionInput = {
  readonly permissions: string;
};

type DiscordMemberPermissionInput = {
  readonly roles: ReadonlyArray<string>;
};

const parsePermissionBits = (value: string): bigint | undefined => {
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
};

const hasRequiredPermissions = (permissions: bigint): boolean =>
  (permissions & (viewChannelPermission | sendMessagesPermission)) ===
  (viewChannelPermission | sendMessagesPermission);

const applyOverwrite = (
  permissions: bigint,
  overwrite: PermissionOverwrite,
): bigint | undefined => {
  const allow = parsePermissionBits(overwrite.allow);
  const deny = parsePermissionBits(overwrite.deny);
  return Predicate.isUndefined(allow) || Predicate.isUndefined(deny)
    ? undefined
    : (permissions & ~deny) | allow;
};

const parseOverwrite = (overwrite: PermissionOverwrite): readonly [bigint, bigint] | undefined => {
  const allow = parsePermissionBits(overwrite.allow);
  const deny = parsePermissionBits(overwrite.deny);
  return Predicate.isUndefined(allow) || Predicate.isUndefined(deny) ? undefined : [allow, deny];
};

const applyEveryoneOverwrite = (
  permissions: bigint,
  overwrites: ReadonlyArray<PermissionOverwrite>,
  workspaceId: string,
): bigint | undefined => {
  const everyoneOverwrite = overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === workspaceId,
  );
  return Predicate.isUndefined(everyoneOverwrite)
    ? permissions
    : applyOverwrite(permissions, everyoneOverwrite);
};

const applyRoleOverwrites = (
  permissions: bigint,
  overwrites: ReadonlyArray<PermissionOverwrite>,
  workspaceId: string,
  memberRoleIds: ReadonlySet<string>,
): bigint | undefined => {
  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites.filter(
    (candidate) =>
      candidate.type === 0 && candidate.id !== workspaceId && memberRoleIds.has(candidate.id),
  )) {
    const bits = parseOverwrite(overwrite);
    if (Predicate.isUndefined(bits)) return undefined;
    roleAllow |= bits[0];
    roleDeny |= bits[1];
  }
  return (permissions & ~roleDeny) | roleAllow;
};

const applyMemberOverwrite = (
  permissions: bigint,
  overwrites: ReadonlyArray<PermissionOverwrite>,
  memberId: string,
): bigint | undefined => {
  const memberOverwrite = overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === memberId,
  );
  return Predicate.isUndefined(memberOverwrite)
    ? permissions
    : applyOverwrite(permissions, memberOverwrite);
};

const applyOverwrites = (
  permissions: bigint,
  overwrites: ReadonlyArray<PermissionOverwrite>,
  workspaceId: string,
  memberId: string,
  memberRoleIds: ReadonlySet<string>,
): bigint | undefined => {
  const afterEveryone = applyEveryoneOverwrite(permissions, overwrites, workspaceId);
  if (Predicate.isUndefined(afterEveryone)) return undefined;
  const afterRoles = applyRoleOverwrites(afterEveryone, overwrites, workspaceId, memberRoleIds);
  return Predicate.isUndefined(afterRoles)
    ? undefined
    : applyMemberOverwrite(afterRoles, overwrites, memberId);
};

export const canSendMessages = (
  channel: DiscordChannelPermissionInput,
  workspaceId: string,
  memberId: string,
  member: DiscordMemberPermissionInput,
  roles: ReadonlyMap<string, DiscordRolePermissionInput>,
): boolean => {
  if (Predicate.isString(channel.permissions)) {
    const permissions = parsePermissionBits(channel.permissions);
    return !Predicate.isUndefined(permissions) && hasRequiredPermissions(permissions);
  }

  const everyoneRole = roles.get(workspaceId);
  if (Predicate.isUndefined(everyoneRole)) return false;
  let permissions = parsePermissionBits(everyoneRole.permissions);
  if (Predicate.isUndefined(permissions)) return false;

  const memberRoleIds = new Set(member.roles);
  for (const roleId of memberRoleIds) {
    const role = roles.get(roleId);
    if (Predicate.isUndefined(role)) return false;
    const rolePermissions = parsePermissionBits(role.permissions);
    if (Predicate.isUndefined(rolePermissions)) return false;
    permissions |= rolePermissions;
  }

  if ((permissions & administratorPermission) === administratorPermission) return true;

  const afterChannel = applyOverwrites(
    permissions,
    channel.permission_overwrites ?? [],
    workspaceId,
    memberId,
    memberRoleIds,
  );
  return !Predicate.isUndefined(afterChannel) && hasRequiredPermissions(afterChannel);
};
