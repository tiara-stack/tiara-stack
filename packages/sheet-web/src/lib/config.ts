import { Effect, Schema } from "effect";
import { makeArgumentError } from "typhoon-core/error";

// Config schema definitions using Schema.Config
export const authBaseUrlConfig = Schema.Config("AUTH_BASE_URL", Schema.URL).pipe(
  Effect.mapError((error) => makeArgumentError(error.message, error)),
);
export const appBaseUrlConfig = Schema.Config("APP_BASE_URL", Schema.URL).pipe(
  Effect.mapError((error) => makeArgumentError(error.message, error)),
);
export const sheetApisBaseUrlConfig = Schema.Config("SHEET_APIS_BASE_URL", Schema.URL).pipe(
  Effect.mapError((error) => makeArgumentError(error.message, error)),
);
