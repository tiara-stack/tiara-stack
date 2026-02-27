import { runtimeAtom } from "#/lib/runtime";
import { authBaseUrlConfig, appBaseUrlConfig, sheetApisBaseUrlConfig } from "#/lib/config";
import { Atom, Result } from "@effect-atom/atom-react";
import { Schema } from "effect";
import { ArgumentError } from "typhoon-core/error";

// Expose config values as atoms
export const authBaseUrlAtom = runtimeAtom.atom(authBaseUrlConfig).pipe(
  Atom.serializable({
    key: "authBaseUrl",
    schema: Result.Schema({ success: Schema.URL, error: ArgumentError }),
  }),
);
export const appBaseUrlAtom = runtimeAtom.atom(appBaseUrlConfig).pipe(
  Atom.serializable({
    key: "appBaseUrl",
    schema: Result.Schema({ success: Schema.URL, error: ArgumentError }),
  }),
);
export const sheetApisBaseUrlAtom = runtimeAtom.atom(sheetApisBaseUrlConfig).pipe(
  Atom.serializable({
    key: "sheetApisBaseUrl",
    schema: Result.Schema({ success: Schema.URL, error: ArgumentError }),
  }),
);
