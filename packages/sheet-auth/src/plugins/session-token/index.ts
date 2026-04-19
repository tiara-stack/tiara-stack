import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/plugins";

type SessionTokenPlugin = BetterAuthPlugin & {
  id: "session-token";
};

const makeSessionToken = (): SessionTokenPlugin => {
  return {
    id: "session-token",
    hooks: {
      after: [
        {
          matcher() {
            return true;
          },
          handler: createAuthMiddleware(async (ctx) => {
            const sessionCookieToken = ctx.getCookie(ctx.context.authCookies.sessionToken.name);

            if (!sessionCookieToken) {
              return null;
            }

            const exposedHeaders =
              ctx.context.responseHeaders?.get("access-control-expose-headers") || "";
            const headersSet = new Set(
              exposedHeaders
                .split(",")
                .map((header) => header.trim())
                .filter(Boolean),
            );
            headersSet.add("set-auth-token");
            ctx.setHeader("set-auth-token", sessionCookieToken);
            ctx.setHeader("Access-Control-Expose-Headers", Array.from(headersSet).join(", "));
          }),
        },
      ],
    },
  } satisfies SessionTokenPlugin;
};

export const sessionToken: typeof makeSessionToken = makeSessionToken;
