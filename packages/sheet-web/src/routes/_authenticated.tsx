import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { Effect, Option } from "effect";
import { ensureResultAtomData } from "#/lib/atomRegistry";
import { sessionAtom } from "#/lib/auth";
import { ensureSheetWebOAuthAccessToken } from "#/lib/oauth";

export const Route = createFileRoute("/_authenticated")({
  component: RouteComponent,
  beforeLoad: async ({ context }) => {
    console.log("before-loading session");
    const session = await Effect.runPromise(
      ensureResultAtomData(context.atomRegistry, sessionAtom, { revalidateIfStale: true }),
    );
    console.log("session before-loaded");
    // Redirect to home if not authenticated
    if (Option.isNone(session)) {
      throw redirect({ to: "/" });
    }

    const oauthAccessToken = await Effect.runPromise(
      ensureSheetWebOAuthAccessToken().pipe(Effect.catch(() => Effect.succeedNone)),
    );
    if (Option.isNone(oauthAccessToken)) {
      throw redirect({ href: "/auth/oauth/start" });
    }
  },
});

function RouteComponent() {
  return <Outlet />;
}
