import { runtimeAtom } from "#/lib/runtime";
import { authBaseUrlConfig, appBaseUrlConfig, sheetApisBaseUrlConfig } from "#/lib/config";

// Expose config values as atoms
export const authBaseUrlAtom = runtimeAtom.atom(authBaseUrlConfig);
export const appBaseUrlAtom = runtimeAtom.atom(appBaseUrlConfig);
export const sheetApisBaseUrlAtom = runtimeAtom.atom(sheetApisBaseUrlConfig);
