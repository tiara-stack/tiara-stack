import type { BetterAuthClientPlugin } from "better-auth/client";
import type { sheetOAuth } from ".";

export const sheetOAuthClient = () =>
  ({
    id: "sheet-oauth-client",
    $InferServerPlugin: {} as ReturnType<typeof sheetOAuth>,
    pathMethods: {
      "/sheet-auth/identity": "GET",
      "/sheet-auth/discord/access-token": "GET",
      "/sheet-auth/trusted-discord-session": "POST",
      "/sheet-auth/internal/subject-token": "POST",
      "/sheet-auth/oauth2/token-exchange": "POST",
    },
  }) satisfies BetterAuthClientPlugin;
