import { Schema } from "effect";
export const BasePermissionValues = ["service", "app_owner"] as const;
export const PermissionValues = BasePermissionValues;

const startsWith = <T extends string>(prefix: T) =>
  Schema.String.pipe(Schema.refine((value): value is `${T}${string}` => value.startsWith(prefix)));

export const DiscordAccountPermission = startsWith("account:discord:");
export const MemberGuildPermission = startsWith("member_guild:");
export const MonitorGuildPermission = startsWith("monitor_guild:");
export const ManageGuildPermission = startsWith("manage_guild:");

export const Permission = Schema.Union([
  Schema.Literals(BasePermissionValues),
  DiscordAccountPermission,
  MemberGuildPermission,
  MonitorGuildPermission,
  ManageGuildPermission,
]);

export type Permission = Schema.Schema.Type<typeof Permission>;

export const PermissionSet = Schema.HashSet(Permission);

export type PermissionSet = Schema.Schema.Type<typeof PermissionSet>;

export const CurrentUserPermissions = Schema.Struct({
  permissions: PermissionSet,
});
