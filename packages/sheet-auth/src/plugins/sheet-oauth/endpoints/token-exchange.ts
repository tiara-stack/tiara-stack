import { createAuthEndpoint } from "better-auth/api";
import { tokenExchangeBody } from "../schemas";
import { exchangeToken } from "../tokens/token-exchange";
import type { SheetOAuthOptions, SheetOAuthTokenExchangeEndpoint } from "../types";
import { jsonNoStore } from "./json-no-store";

export const makeTokenExchangeEndpoint = (
  options: SheetOAuthOptions,
): SheetOAuthTokenExchangeEndpoint =>
  createAuthEndpoint(
    "/sheet-auth/oauth2/token-exchange",
    {
      method: "POST",
      body: tokenExchangeBody,
      metadata: {
        allowedMediaTypes: ["application/x-www-form-urlencoded", "application/json"],
      },
    },
    async (ctx) => {
      return jsonNoStore(ctx, await exchangeToken(ctx, options));
    },
  );
