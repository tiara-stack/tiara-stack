import { Schema } from "effect";
import { runtimeAtom } from "#/lib/runtime";

// Config schema definitions using Schema.Config
export const authBaseUrlConfig = Schema.Config("VITE_AUTH_BASE_URL", Schema.URL);
export const appBaseUrlConfig = Schema.Config("VITE_APP_BASE_URL", Schema.URL);
export const sheetApisBaseUrlConfig = Schema.Config("VITE_SHEET_APIS_BASE_URL", Schema.URL);

// Expose config values as atoms
export const authBaseUrlAtom = runtimeAtom.atom(authBaseUrlConfig);
export const appBaseUrlAtom = runtimeAtom.atom(appBaseUrlConfig);
export const sheetApisBaseUrlAtom = runtimeAtom.atom(sheetApisBaseUrlConfig);
