import type { SheetOAuthOptions, SheetOAuthPlugin } from "../types";
import { makeDiscordAccessTokenEndpoint } from "./discord-access-token";
import { makeIdentityEndpoint } from "./identity";
import { makeSubjectTokenEndpoint } from "./subject-token";
import { makeTokenExchangeEndpoint } from "./token-exchange";
import { makeTrustedDiscordSessionEndpoint } from "./trusted-discord-session";

export const makeSheetOAuthEndpoints = (
  options: SheetOAuthOptions,
): SheetOAuthPlugin["endpoints"] => ({
  getSheetAuthIdentity: makeIdentityEndpoint(options),
  getDiscordAccessToken: makeDiscordAccessTokenEndpoint(options),
  createTrustedDiscordSession: makeTrustedDiscordSessionEndpoint(options),
  createSubjectToken: makeSubjectTokenEndpoint(options),
  exchangeOAuthToken: makeTokenExchangeEndpoint(options),
});
