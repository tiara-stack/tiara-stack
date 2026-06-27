import { Predicate } from "effect";

const metadataUrl = (issuer: string, audience: string) =>
  `${issuer.replace(/\/$/, "")}/.well-known/oauth-protected-resource/${encodeURIComponent(audience)}`;

export const oauthResourceMetadataMappings = (
  issuer: string,
  audiences: readonly string[] | string,
) => {
  const audienceList = Predicate.isString(audiences) ? [audiences] : audiences;
  const mappings = Object.fromEntries(
    audienceList
      .filter((audience) => !URL.canParse(audience))
      .map((audience) => [audience, metadataUrl(issuer, audience)]),
  );

  return Object.keys(mappings).length > 0 ? mappings : undefined;
};
