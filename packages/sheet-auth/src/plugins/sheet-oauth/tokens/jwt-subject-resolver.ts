import { Predicate } from "effect";
import { jwtVerify, type JWTPayload } from "jose";
import { JwtTokenType } from "../../../oauth";
import { oauthError } from "../errors";
import type {
  SheetOAuthJwtSubjectResolverOptions,
  SheetOAuthTokenExchangeSubjectResolver,
} from "../types";
import { encodeJwtSecret, normalizeJwtIdentifier } from "./jwt";

export const createJwtSubjectTokenResolver =
  (options: SheetOAuthJwtSubjectResolverOptions): SheetOAuthTokenExchangeSubjectResolver =>
  async ({ ctx, actor, subjectToken, subjectTokenType, request }) => {
    if (subjectTokenType !== JwtTokenType) {
      return undefined;
    }

    let payload: JWTPayload;
    try {
      payload = (
        await jwtVerify(subjectToken, encodeJwtSecret(options.secret), {
          issuer: normalizeJwtIdentifier(options.issuer),
          audience: normalizeJwtIdentifier(options.audience),
          algorithms: ["HS256"],
          requiredClaims: ["exp"],
        })
      ).payload;
    } catch {
      throw oauthError("UNAUTHORIZED", "invalid_request", "Invalid subject token");
    }

    if (!Predicate.isString(payload.sub) || payload.sub.length === 0) {
      throw oauthError("BAD_REQUEST", "invalid_request", "Subject token is missing sub");
    }

    return await options.resolveSubject({
      ctx,
      actor,
      payload,
      subject: payload.sub,
      request,
    });
  };
