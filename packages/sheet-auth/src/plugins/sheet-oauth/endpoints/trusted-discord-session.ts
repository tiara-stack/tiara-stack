import { APIError } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { resolveUserByDiscordId } from "../accounts";
import { trustedDiscordSessionBody } from "../schemas";
import type { SheetOAuthOptions, SheetOAuthTrustedDiscordSessionEndpoint } from "../types";
import { makeAccessTokenIdentity, requireBearerToken } from "../verifiers/access-token";
import { jsonNoStore } from "./json-no-store";

export const makeTrustedDiscordSessionEndpoint = (
  options: SheetOAuthOptions,
): SheetOAuthTrustedDiscordSessionEndpoint =>
  createAuthEndpoint(
    "/sheet-auth/trusted-discord-session",
    {
      method: "POST",
      body: trustedDiscordSessionBody,
      metadata: {
        allowedMediaTypes: ["application/x-www-form-urlencoded", "application/json"],
      },
    },
    async (ctx) => {
      const token = requireBearerToken(ctx);
      const identity = await makeAccessTokenIdentity(ctx, token, options);
      if (
        !identity.scopes.includes("bot.impersonate") ||
        !identity.permissions.includes("service")
      ) {
        throw new APIError("UNAUTHORIZED", {
          message: "OAuth client cannot create trusted Discord sessions",
        });
      }

      const user = await resolveUserByDiscordId(
        ctx.context.internalAdapter,
        ctx.body.discordUserId,
      );
      ctx.context.logger?.info?.("Trusted Discord session authorized");
      const session = await ctx.context.internalAdapter.createSession(user.id, true);

      await setSessionCookie(ctx, { session, user }, true);

      return jsonNoStore(ctx, { session, user });
    },
  );
