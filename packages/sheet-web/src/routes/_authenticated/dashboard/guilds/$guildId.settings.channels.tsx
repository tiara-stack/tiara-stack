import { createFileRoute } from "@tanstack/react-router";

import { ChannelsSection } from "./$guildId.settings";
import {
  guildCapabilities,
  permissionsFromResult,
  useGuildPermissionsResult,
} from "#/lib/guildConfig";

export const Route = createFileRoute("/_authenticated/dashboard/guilds/$guildId/settings/channels")(
  {
    component: ChannelSettingsPage,
  },
);

function ChannelSettingsPage() {
  const { guildId } = Route.useParams();
  const permissionResult = useGuildPermissionsResult(guildId);
  const capabilities = guildCapabilities(permissionsFromResult(permissionResult), guildId);

  return <ChannelsSection guildId={guildId} canManage={capabilities.canManage} />;
}
