import { createFileRoute } from "@tanstack/react-router";

import { NotificationPreferencesPage } from "#/components/NotificationPreferences";

export const Route = createFileRoute("/_authenticated/settings/notifications")({
  component: NotificationPreferencesPage,
});
