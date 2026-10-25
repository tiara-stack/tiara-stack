import type { BetterAuthClientPlugin } from "better-auth/client";
import type { sheetOAuth } from ".";

export const sheetOAuthClient = () =>
  ({
    id: "sheet-oauth-client",

    $InferServerPlugin:
      {} /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as ReturnType<
        typeof sheetOAuth
      > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
    pathMethods: {
      "/sheet-auth/identity": "GET",
      "/sheet-auth/discord/access-token": "GET",
      "/sheet-auth/trusted-discord-session": "POST",
      "/sheet-auth/internal/subject-token": "POST",
      "/sheet-auth/oauth2/token-exchange": "POST",
    },
  }) satisfies BetterAuthClientPlugin;
