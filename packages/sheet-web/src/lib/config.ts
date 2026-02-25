import { Schema } from "effect";

// Config schema definitions using Schema.Config
export const authBaseUrlConfig = Schema.Config("AUTH_BASE_URL", Schema.URL);
export const appBaseUrlConfig = Schema.Config("APP_BASE_URL", Schema.URL);
export const sheetApisBaseUrlConfig = Schema.Config("SHEET_APIS_BASE_URL", Schema.URL);
