import { Atom } from "effect/unstable/reactivity";
import { NodeFileSystem } from "@effect/platform-node";
import { createServerFn, createIsomorphicFn } from "@tanstack/react-start";
import { Layer, ConfigProvider, Effect } from "effect";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import { authBaseUrlConfig, appBaseUrlConfig, sheetZeroBaseUrlConfig } from "#/lib/config";

// Server-side: Load config directly from .env file
const serverConfigLayer = dotEnvConfigProviderLayer().pipe(Layer.provide(NodeFileSystem.layer));

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
      SHEET_ZERO_BASE_URL: sheetZeroBaseUrlConfig.pipe(
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
    Effect.catch(() => Effect.succeed({} as Record<string, string | null>)),
  );

  return ConfigProvider.layer(ConfigProvider.fromUnknown(config));
}).pipe(Layer.unwrap);

// Create a config layer from server function (client) or directly from env (server)
const EnvConfigLive = createIsomorphicFn()
  .server(() => serverConfigLayer)
  .client(() => fetchConfigLayer);

// Create the runtime atom
export const runtimeAtom = Atom.runtime(EnvConfigLive());
