import { createFileRoute } from "@tanstack/react-router";

import {
  guildCapabilities,
  permissionsFromResult,
  useGuildPermissionsResult,
} from "#/lib/guildConfig";
import { ServerSection, SettingsRestrictedNotice } from "./$guildId.settings";

export const Route = createFileRoute("/_authenticated/dashboard/guilds/$guildId/settings/server")({
  component: ServerSettingsPage,
});

function ServerSettingsPage() {
  const { guildId } = Route.useParams();
  const permissionResult = useGuildPermissionsResult(guildId);
  const capabilities = guildCapabilities(permissionsFromResult(permissionResult), guildId);

  if (!capabilities.canManage) return <SettingsRestrictedNotice />;

  return <ServerSection guildId={guildId} />;
}
