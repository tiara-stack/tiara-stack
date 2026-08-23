import { runtimeAtom } from "#/lib/runtime";
import { authBaseUrlConfig, appBaseUrlConfig, sheetZeroBaseUrlConfig } from "#/lib/config";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { Schema } from "effect";
import { ArgumentError } from "typhoon-core/error";

// Expose config values as atoms
export const authBaseUrlAtom = runtimeAtom.atom(authBaseUrlConfig).pipe(
  Atom.serializable({
    key: "authBaseUrl",
    schema: AsyncResult.Schema({ success: Schema.URL, error: ArgumentError }),
  }),
);
export const appBaseUrlAtom = runtimeAtom.atom(appBaseUrlConfig).pipe(
  Atom.serializable({
    key: "appBaseUrl",
    schema: AsyncResult.Schema({ success: Schema.URL, error: ArgumentError }),
  }),
);
export const sheetZeroBaseUrlAtom = runtimeAtom.atom(sheetZeroBaseUrlConfig).pipe(
  Atom.serializable({
    key: "sheetZeroBaseUrl",
    schema: AsyncResult.Schema({ success: Schema.URL, error: ArgumentError }),
  }),
);
