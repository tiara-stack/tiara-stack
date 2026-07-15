import { createAuthEndpoint } from "better-auth/api";
import { getDiscordProviderAccessToken } from "../clients/discord";
import type { SheetOAuthDiscordAccessTokenEndpoint, SheetOAuthOptions } from "../types";
import { jsonNoStore } from "./json-no-store";

export const makeDiscordAccessTokenEndpoint = (
  options: SheetOAuthOptions,
): SheetOAuthDiscordAccessTokenEndpoint =>
  createAuthEndpoint(
    "/sheet-auth/discord/access-token",
    {
      method: "GET",
    },
    async (ctx) => {
      return jsonNoStore(ctx, await getDiscordProviderAccessToken(ctx, options));
    },
  );
