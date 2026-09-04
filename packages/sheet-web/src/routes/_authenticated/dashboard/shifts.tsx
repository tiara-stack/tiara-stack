import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/dashboard/shifts")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard/guilds", replace: true });
  },
});
