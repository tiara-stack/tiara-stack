import { createFileRoute, redirect } from "@tanstack/react-router";
import { completeSheetWebOAuthAuthorization } from "#/lib/oauth";

export const Route = createFileRoute("/auth/oauth/callback")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.code === "string" ? { code: search.code } : {}),
    ...(typeof search.state === "string" ? { state: search.state } : {}),
  }),
  beforeLoad: async ({ search }) => {
    const result = await completeSheetWebOAuthAuthorization({
      data: {
        ...(search.code === undefined ? {} : { code: search.code }),
        ...(search.state === undefined ? {} : { state: search.state }),
      },
    });

    throw redirect({ href: result.ok ? "/dashboard" : "/" });
  },
});
