import { resolveUserByDiscordId } from "./accounts";
import { verifyKubernetesServiceAccountToken } from "./clients/kubernetes";
import { makeSheetOAuthEndpoints } from "./endpoints";
import { createJwtSubjectTokenResolver } from "./tokens/jwt-subject-resolver";
import type { SheetOAuthOptions, SheetOAuthPlugin } from "./types";
import { sheetOAuthJwksUrl, verifyOAuthAccessToken } from "./verifiers/access-token";

export {
  createJwtSubjectTokenResolver,
  resolveUserByDiscordId,
  sheetOAuthJwksUrl,
  verifyKubernetesServiceAccountToken,
  verifyOAuthAccessToken,
};
export type {
  SheetAuthResolvedIdentity,
  SheetOAuthEndpointContext,
  SheetOAuthJwtSubjectResolverOptions,
  SheetOAuthKubernetesSubjectTokenMintingOptions,
  SheetOAuthOptions,
  SheetOAuthSubjectResolverBaseInput,
  SheetOAuthSubjectTokenMintingOptions,
  SheetOAuthTokenExchangeOptions,
  SheetOAuthTokenExchangeRequest,
  SheetOAuthTokenExchangeSubject,
  SheetOAuthTokenExchangeSubjectResolver,
  SheetOAuthTokenExchangeSubjectResolverInput,
} from "./types";

export const sheetOAuth = (options: SheetOAuthOptions): SheetOAuthPlugin => ({
  id: "sheet-oauth",
  endpoints: makeSheetOAuthEndpoints(options),
});
