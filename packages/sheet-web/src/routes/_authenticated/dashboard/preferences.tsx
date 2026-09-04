import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/dashboard/preferences")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/notifications", replace: true });
  },
});
