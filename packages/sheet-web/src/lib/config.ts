import { Config, Effect, Schema } from "effect";
import { makeArgumentError } from "typhoon-core/error";

// Config schema definitions using Schema.Config
export const authBaseUrlConfig = Config.schema(Schema.URL, "AUTH_BASE_URL").pipe(
  Effect.mapError((error) => makeArgumentError(error.message, error)),
);
export const appBaseUrlConfig = Config.schema(Schema.URL, "APP_BASE_URL").pipe(
  Effect.mapError((error) => makeArgumentError(error.message, error)),
);
export const sheetZeroBaseUrlConfig = Config.schema(Schema.URL, "SHEET_ZERO_BASE_URL").pipe(
  Effect.mapError((error) => makeArgumentError(error.message, error)),
);
export const sheetWorkflowsBaseUrlConfig = Config.schema(
  Schema.URL,
  "SHEET_WORKFLOWS_BASE_URL",
).pipe(Effect.mapError((error) => makeArgumentError(error.message, error)));
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
    "openid profile email zero.read zero.mutate workflow.observe workflow.enqueue offline_access",
  ),
);
