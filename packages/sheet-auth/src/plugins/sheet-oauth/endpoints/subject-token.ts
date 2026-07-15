import { createAuthEndpoint } from "better-auth/api";
import { subjectTokenBody } from "../schemas";
import { createMintedSubjectToken } from "../tokens/subject-token";
import type { SheetOAuthCreateSubjectTokenEndpoint, SheetOAuthOptions } from "../types";
import { jsonNoStore } from "./json-no-store";

export const makeSubjectTokenEndpoint = (
  options: SheetOAuthOptions,
): SheetOAuthCreateSubjectTokenEndpoint =>
  createAuthEndpoint(
    "/sheet-auth/internal/subject-token",
    {
      method: "POST",
      body: subjectTokenBody,
      metadata: {
        allowedMediaTypes: ["application/x-www-form-urlencoded", "application/json"],
      },
    },
    async (ctx) => {
      return jsonNoStore(ctx, await createMintedSubjectToken(ctx, options));
    },
  );
