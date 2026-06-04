export const PermissionValues = ["service", "app_owner"] as const;

export type BasePermission = (typeof PermissionValues)[number];
export type DiscordAccountPermission = `account:discord:${string}`;
export type MemberGuildPermission = `member_guild:${string}`;
export type MonitorGuildPermission = `monitor_guild:${string}`;
export type ManageGuildPermission = `manage_guild:${string}`;
export type Permission =
  | BasePermission
  | DiscordAccountPermission
  | MemberGuildPermission
  | MonitorGuildPermission
  | ManageGuildPermission;
