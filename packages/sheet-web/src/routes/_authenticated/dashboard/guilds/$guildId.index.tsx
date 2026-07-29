import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/dashboard/guilds/$guildId/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/dashboard/guilds/$guildId/schedule",
      params: { guildId: params.guildId },
      replace: true,
    });
  },
});
