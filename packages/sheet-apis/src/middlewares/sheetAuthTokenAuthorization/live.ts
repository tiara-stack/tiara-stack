import { Effect, Layer, pipe, Redacted } from "effect";
import { verifyToken, createSheetAuthClient } from "sheet-auth/client";
import { SheetAuthTokenAuthorization } from "./tag";
import { Unauthorized } from "@/schemas/middlewares/unauthorized";
import { config } from "../../config";

export const SheetAuthTokenAuthorizationLive = Layer.effect(
  SheetAuthTokenAuthorization,
  pipe(
    Effect.Do,
    Effect.bind("issuer", () =>
      Effect.map(config.sheetAuthIssuer, (url) => url.replace(/\/$/, "")),
    ),
    Effect.map(({ issuer }) => {
      // Create Better Auth client with jwtClient plugin for token verification
      const authClient = createSheetAuthClient(issuer);

      return SheetAuthTokenAuthorization.of({
        sheetAuthToken: (token) =>
          pipe(
            verifyToken(authClient, Redacted.value(token)),
            Effect.map((result) => ({
              // Return userId from sub claim and the raw token
              // Use Better Auth client separately to get Discord info if needed
              userId: result.payload.sub,
              email: result.payload.email,
              token: Redacted.value(token),
            })),
            Effect.mapError(
              (error) =>
                new Unauthorized({
                  message: `Invalid sheet-auth token: ${error.message}`,
                  cause: error.cause,
                }),
            ),
            Effect.withSpan("SheetAuthTokenAuthorization.sheetAuthToken", {
              captureStackTrace: true,
            }),
          ),
      });
    }),
  ),
);
