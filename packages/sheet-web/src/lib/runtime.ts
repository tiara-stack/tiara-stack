import { Atom } from "@effect-atom/atom-react";
import { PlatformConfigProvider } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { createServerFn, createIsomorphicFn } from "@tanstack/react-start";
import { Layer, ConfigProvider, Effect } from "effect";
import { authBaseUrlConfig, appBaseUrlConfig, sheetApisBaseUrlConfig } from "#/lib/config";

// Server-side: Load config directly from .env file
const serverConfigLayer = Layer.provide(
  PlatformConfigProvider.layerDotEnvAdd(".env"),
  NodeContext.layer,
);

// Server function to fetch config from server-side env
const getConfigServerFn = createServerFn({ method: "GET" }).handler(() =>
  Effect.runPromise(
    Effect.all({
      AUTH_BASE_URL: authBaseUrlConfig.pipe(
        Effect.map((url) => url.href),
        Effect.match({
          onSuccess: (value) => value,
          onFailure: () => null,
        }),
      ),
      APP_BASE_URL: appBaseUrlConfig.pipe(
        Effect.map((url) => url.href),
        Effect.match({
          onSuccess: (value) => value,
          onFailure: () => null,
        }),
      ),
      SHEET_APIS_BASE_URL: sheetApisBaseUrlConfig.pipe(
        Effect.map((url) => url.href),
        Effect.match({
          onSuccess: (value) => value,
          onFailure: () => null,
        }),
      ),
    }).pipe(Effect.provide(serverConfigLayer)),
  ),
);

// Client-side: Fetch config from the server function
const fetchConfigLayer = Effect.gen(function* () {
  const config = yield* Effect.tryPromise(() => getConfigServerFn()).pipe(
    Effect.tapError((error) => Effect.logError("Failed to fetch config from server:", error)),
    Effect.catchAll(() => Effect.succeed({} as Record<string, string | null>)),
  );

  return Layer.setConfigProvider(ConfigProvider.fromJson(config));
}).pipe(Layer.unwrapEffect);

// Create a config layer from server function (client) or directly from env (server)
const EnvConfigLive = createIsomorphicFn()
  .server(() => serverConfigLayer)
  .client(() => fetchConfigLayer);

// Create the runtime atom
export const runtimeAtom = Atom.runtime(EnvConfigLive());
