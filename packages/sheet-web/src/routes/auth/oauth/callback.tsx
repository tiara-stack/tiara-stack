import { createFileRoute, redirect } from "@tanstack/react-router";
import { completeSheetWebOAuthAuthorization } from "#/lib/oauth";

export const Route = createFileRoute("/auth/oauth/callback")({
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === "string" ? search.code : undefined,
    state: typeof search.state === "string" ? search.state : undefined,
  }),
  beforeLoad: async ({ search }) => {
    const result = await completeSheetWebOAuthAuthorization({
      data: {
        code: search.code,
        state: search.state,
      },
    });

    throw redirect({ href: result.ok ? "/dashboard" : "/" });
  },
});
