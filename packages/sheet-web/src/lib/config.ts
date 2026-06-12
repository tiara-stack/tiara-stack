import { Config, Effect, Schema } from "effect";
import { makeArgumentError } from "typhoon-core/error";

// Config schema definitions using Schema.Config
export const authBaseUrlConfig = Config.schema(Schema.URL, "AUTH_BASE_URL").pipe(
  Effect.mapError((error) => makeArgumentError(error.message, error)),
);
export const appBaseUrlConfig = Config.schema(Schema.URL, "APP_BASE_URL").pipe(
  Effect.mapError((error) => makeArgumentError(error.message, error)),
);
export const sheetApisBaseUrlConfig = Config.schema(Schema.URL, "SHEET_APIS_BASE_URL").pipe(
  Effect.mapError((error) => makeArgumentError(error.message, error)),
);
export const sheetWebOAuthClientIdConfig = Config.schema(
  Schema.NonEmptyString,
  "SHEET_WEB_OAUTH_CLIENT_ID",
).pipe(Config.withDefault("sheet-web"));
export const sheetWebOAuthRedirectPathConfig = Config.schema(
  Schema.NonEmptyString,
  "SHEET_WEB_OAUTH_REDIRECT_PATH",
).pipe(Config.withDefault("/auth/oauth/callback"));
export const sheetWebOAuthScopesConfig = Config.schema(
  Schema.NonEmptyString,
  "SHEET_WEB_OAUTH_SCOPES",
).pipe(
  Config.withDefault(
    "openid profile email sheet.read sheet.write sheet.manage workflow.dispatch offline_access",
  ),
);
