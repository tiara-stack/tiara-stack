import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
// Nitro keeps tslib external to avoid a Rolldown CommonJS interop bug in
// Fumadocs' focus-management dependencies; resolve it here and at runtime.
import "tslib";
import { browserApp } from "tooling-config/vite";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import type { Plugin } from "vite";
import { makePreviewSourceRevisionReporter } from "./src/lib/preview-source-revision";

const previewHmrPath = process.env.TIARA_PREVIEW_HMR_PATH;
const previewAppBaseUrl = process.env.APP_BASE_URL;
const previewRevisionUrl = process.env.TIARA_PREVIEW_REVISION_URL;
const previewRevisionToken = process.env.TIARA_PREVIEW_REVISION_TOKEN;
const previewInitialRevision = process.env.TIARA_PREVIEW_SOURCE_REVISION;
const previewHmr =
  previewHmrPath === undefined
    ? undefined
    : (() => {
        if (
          previewHmrPath !== "/_preview/app/__vite_hmr" ||
          previewAppBaseUrl === undefined ||
          !previewAppBaseUrl.startsWith("https://")
        )
          throw new Error("Connected preview HMR requires its approved HTTPS origin and route");
        return {
          protocol: "wss" as const,
          host: new URL(previewAppBaseUrl).hostname,
          clientPort: 443,
          path: previewHmrPath,
        };
      })();
const previewHostname =
  previewHmr === undefined || previewAppBaseUrl === undefined
    ? undefined
    : new URL(previewAppBaseUrl).hostname;

if (
  (previewRevisionUrl === undefined) !== (previewRevisionToken === undefined) ||
  (previewRevisionUrl !== undefined && previewInitialRevision === undefined)
)
  throw new Error(
    "Connected preview source revision reporting requires its URL, token and initial revision",
  );

const previewSourceRevisionPlugin =
  previewRevisionUrl === undefined || previewRevisionToken === undefined
    ? undefined
    : (() => {
        const reportRevision = makePreviewSourceRevisionReporter({
          url: previewRevisionUrl,
          token: previewRevisionToken,
          initialRevision: previewInitialRevision ?? "",
        });
        return {
          name: "tiara-preview-source-revision",
          apply: "serve" as const,
          applyToEnvironment: (environment) => environment.name === "client",
          hotUpdate: (event) =>
            Effect.runPromise(reportRevision(event).pipe(Effect.provide(FetchHttpClient.layer))),
        } satisfies Plugin;
      })();

const config = browserApp({
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    allowedHosts: [
      "hermes-dev.taile52624.ts.net",
      ...(previewHostname === undefined ? [] : [previewHostname]),
    ],
    ...(previewHmr === undefined ? {} : { hmr: previewHmr }),
  },
  plugins: [
    ...(previewSourceRevisionPlugin === undefined ? [] : [previewSourceRevisionPlugin]),
    mdx(),
    devtools(),
    nitro({
      rollupConfig: { external: [/^@sentry\//] },
      traceDeps: ["tslib"],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact({
      babel: {
        plugins: ["babel-plugin-react-compiler"],
      },
    }),
  ],
});

export default config;
