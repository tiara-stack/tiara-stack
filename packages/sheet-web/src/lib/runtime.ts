import { Atom } from "effect/unstable/reactivity";
import { NodeFileSystem } from "@effect/platform-node";
import { createServerFn, createIsomorphicFn } from "@tanstack/react-start";
import { Layer, ConfigProvider, Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import {
  authBaseUrlConfig,
  appBaseUrlConfig,
  sheetWorkflowsBaseUrlConfig,
  sheetZeroBaseUrlConfig,
} from "#/lib/config";

// Server-side: Load config directly from .env file
const serverConfigLayer = dotEnvConfigProviderLayer().pipe(Layer.provide(NodeFileSystem.layer));

const urlValueOrNull = <E>(name: string, url: Effect.Effect<URL, E>) =>
  url.pipe(
    Effect.map((value) => value.href),
    Effect.tapError((error) => Effect.logError(`Invalid ${name} configuration`, error)),
    Effect.match({
      onSuccess: (value) => value,
      onFailure: () => null,
    }),
  );

// Server function to fetch config from server-side env
const getConfigServerFn = createServerFn({ method: "GET" }).handler(() =>
  Effect.runPromise(
    Effect.all({
      AUTH_BASE_URL: urlValueOrNull("AUTH_BASE_URL", authBaseUrlConfig),
      APP_BASE_URL: urlValueOrNull("APP_BASE_URL", appBaseUrlConfig),
      SHEET_ZERO_BASE_URL: urlValueOrNull("SHEET_ZERO_BASE_URL", sheetZeroBaseUrlConfig),
      SHEET_WORKFLOWS_BASE_URL: urlValueOrNull(
        "SHEET_WORKFLOWS_BASE_URL",
        sheetWorkflowsBaseUrlConfig,
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
export const runtimeAtom = Atom.runtime(Layer.merge(EnvConfigLive(), FetchHttpClient.layer));
