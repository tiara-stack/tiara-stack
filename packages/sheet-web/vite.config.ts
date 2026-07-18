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

const config = browserApp({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    mdx(),
    devtools(),
    nitro({ rollupConfig: { external: [/^@sentry\//, "tslib"] } }),
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
