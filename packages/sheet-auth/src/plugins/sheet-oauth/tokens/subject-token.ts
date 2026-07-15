import { SignJWT } from "jose";
import { getBearerToken } from "../../../utils/bearer-token";
import { verifyKubernetesServiceAccountToken } from "../clients/kubernetes";
import { oauthError } from "../errors";
import { MaxSubjectTokenLifetimeSeconds } from "../schemas";
import type {
  SheetOAuthEndpointContext,
  SheetOAuthOptions,
  SheetOAuthSubjectTokenMintingOptions,
  SheetOAuthSubjectTokenResponse,
} from "../types";
import { JwtTokenType } from "../../../oauth";
import { encodeJwtSecret, normalizeJwtIdentifier } from "./jwt";

const assertSubjectTokenMintingConfigured = (
  options: SheetOAuthOptions,
): Required<SheetOAuthSubjectTokenMintingOptions> => {
  const minting = options.tokenExchange?.subjectTokenMinting;
  if (!minting?.secret || !minting.kubernetes) {
    throw oauthError(
      "INTERNAL_SERVER_ERROR",
      "server_error",
      "Subject token minting is not configured",
    );
  }

  return {
    secret: minting.secret,
    issuer: minting.issuer ?? options.issuer,
    audience: minting.audience ?? options.issuer,
    expiresIn: minting.expiresIn ?? 60,
    allowedSubjectPrefixes: minting.allowedSubjectPrefixes ?? ["discord:"],
    kubernetes: minting.kubernetes,
  };
};

const assertTrustedWorkloadSubject = (
  workloadUsername: string,
  subject: string,
  allowedSubjectPrefixes: readonly string[],
) => {
  // TokenReview restricts workloadUsername to the configured service-account allow-list. Every
  // workload in that trust domain may mint only within the configured subject namespaces.
  if (!workloadUsername || !allowedSubjectPrefixes.some((prefix) => subject.startsWith(prefix))) {
    throw oauthError("BAD_REQUEST", "invalid_request", "Requested subject is not allowed");
  }
};

export const createMintedSubjectToken = async (
  ctx: SheetOAuthEndpointContext,
  options: SheetOAuthOptions,
): Promise<SheetOAuthSubjectTokenResponse> => {
  const minting = assertSubjectTokenMintingConfigured(options);

  const kubernetesToken = getBearerToken(ctx.request?.headers.get("authorization"));
  if (!kubernetesToken) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "Missing Kubernetes service account token");
  }

  const workload = await verifyKubernetesServiceAccountToken(kubernetesToken, minting.kubernetes);
  assertTrustedWorkloadSubject(workload.username, ctx.body.subject, minting.allowedSubjectPrefixes);
  const iat = Math.floor(Date.now() / 1000);
  const expiresIn = Math.min(
    Math.max(Math.floor(ctx.body.expiresIn ?? minting.expiresIn), 1),
    MaxSubjectTokenLifetimeSeconds,
  );
  const exp = iat + expiresIn;
  const audience = ctx.body.audience ?? minting.audience;
  const subjectToken = await new SignJWT({
    k8s: {
      sub: workload.username,
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(normalizeJwtIdentifier(minting.issuer))
    .setSubject(ctx.body.subject)
    .setAudience(normalizeJwtIdentifier(audience))
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(encodeJwtSecret(minting.secret));

  return {
    subject_token: subjectToken,
    subject_token_type: JwtTokenType,
    expires_in: expiresIn,
    expires_at: exp,
  };
};
