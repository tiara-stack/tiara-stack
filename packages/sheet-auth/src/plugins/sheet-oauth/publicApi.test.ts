import { expect, it } from "vitest";
import type {
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
} from ".";

type SheetOAuthPublicTypes = [
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
];

it("preserves the sheet OAuth public type surface", () => {
  const publicTypeCount = 12 satisfies SheetOAuthPublicTypes["length"];
  expect(publicTypeCount).toBe(12);
});
