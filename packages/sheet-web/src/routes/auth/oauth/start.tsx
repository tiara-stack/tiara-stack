import { createFileRoute, redirect } from "@tanstack/react-router";
import { createSheetWebOAuthAuthorizationUrl } from "#/lib/oauth";

export const Route = createFileRoute("/auth/oauth/start")({
  loader: async () => {
    const { redirectTo } = await createSheetWebOAuthAuthorizationUrl();
    throw redirect({ href: redirectTo });
  },
});
