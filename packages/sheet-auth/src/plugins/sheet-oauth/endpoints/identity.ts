import { createAuthEndpoint } from "better-auth/api";
import type { SheetOAuthIdentityEndpoint, SheetOAuthOptions } from "../types";
import {
  makeAccessTokenIdentity,
  makeSessionIdentity,
  requireBearerToken,
} from "../verifiers/access-token";
import { jsonNoStore } from "./json-no-store";

export const makeIdentityEndpoint = (options: SheetOAuthOptions): SheetOAuthIdentityEndpoint =>
  createAuthEndpoint(
    "/sheet-auth/identity",
    {
      method: "GET",
    },
    async (ctx) => {
      const sessionIdentity = await makeSessionIdentity(ctx);
      if (sessionIdentity) {
        return jsonNoStore(ctx, sessionIdentity);
      }

      const token = requireBearerToken(ctx);
      return jsonNoStore(ctx, await makeAccessTokenIdentity(ctx, token, options));
    },
  );
